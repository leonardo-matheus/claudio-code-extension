import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', '.nuxt', 'vendor', 'target',
]);

export class ToolExecutor {
  private bypassPermissions = false;

  setBypassPermissions(bypass: boolean) {
    this.bypassPermissions = bypass;
  }

  private getWorkspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) return inputPath;
    return path.join(this.getWorkspacePath(), inputPath);
  }

  async execute(toolName: string, input: any): Promise<string> {
    switch (toolName) {
      case 'Bash':
        return this.executeBash(input);
      case 'Read':
        return this.readFile(input);
      case 'Write':
        return this.writeFile(input);
      case 'Edit':
        return this.editFile(input);
      case 'ListDir':
        return this.listDirectory(input);
      case 'Search':
        return this.search(input);
      case 'Glob':
        return this.glob(input);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async executeBash(input: { command: string; workingDirectory?: string; background?: boolean }): Promise<string> {
    const { command, workingDirectory } = input;
    const cwd = workingDirectory ? this.resolvePath(workingDirectory) : this.getWorkspacePath();

    // Check if should run in background
    const bgPatterns = [/npm\s+(run\s+)?(start|dev|serve)/i, /yarn\s+(start|dev)/i, /vite/i];
    if (input.background || bgPatterns.some(p => p.test(command))) {
      const terminal = vscode.window.createTerminal({ name: command.substring(0, 30), cwd });
      terminal.sendText(command);
      terminal.show();
      return `Started in terminal: ${command}`;
    }

    // Dangerous commands check
    const dangerous = [/rm\s+-rf\s+[/~]/, /sudo/, /chmod\s+777/];
    if (dangerous.some(p => p.test(command)) && !this.bypassPermissions) {
      const confirm = await vscode.window.showWarningMessage(
        `Dangerous command: ${command}`,
        { modal: true },
        'Execute',
        'Cancel'
      );
      if (confirm !== 'Execute') return 'Cancelled by user';
    }

    // Safe commands
    const safe = ['ls', 'cat', 'pwd', 'git status', 'git log', 'git diff', 'npm list', 'echo', 'which'];
    const isSafe = safe.some(s => command.trim().startsWith(s));

    if (!this.bypassPermissions && !isSafe) {
      const confirm = await vscode.window.showInformationMessage(
        `Execute: ${command.substring(0, 80)}...`,
        'Execute',
        'Cancel'
      );
      if (confirm !== 'Execute') return 'Cancelled by user';
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 60000,
        maxBuffer: 5 * 1024 * 1024,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      });
      return (stdout + stderr).trim() || 'Command executed successfully';
    } catch (error: any) {
      throw new Error(error.message);
    }
  }

  private async readFile(input: { path: string; startLine?: number; endLine?: number }): Promise<string> {
    const filePath = this.resolvePath(input.path);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${input.path}`);
    }

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory: ${input.path}`);
    }

    if (stats.size > 1024 * 1024) {
      throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    if (input.startLine || input.endLine) {
      const start = Math.max(0, (input.startLine || 1) - 1);
      const end = Math.min(lines.length, input.endLine || lines.length);
      return lines.slice(start, end).map((l, i) => `${start + i + 1}│ ${l}`).join('\n');
    }

    if (lines.length > 300) {
      return lines.slice(0, 200).map((l, i) => `${i + 1}│ ${l}`).join('\n') +
        `\n\n... (${lines.length} lines total)`;
    }

    return lines.map((l, i) => `${i + 1}│ ${l}`).join('\n');
  }

  private async writeFile(input: { path: string; content: string }): Promise<string> {
    const filePath = this.resolvePath(input.path);
    const dir = path.dirname(filePath);

    if (!this.bypassPermissions) {
      const confirm = await vscode.window.showInformationMessage(
        `Create/overwrite: ${input.path}?`,
        'Yes',
        'No'
      );
      if (confirm !== 'Yes') return 'Cancelled by user';
    }

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, input.content, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

    return `Created: ${input.path} (${input.content.split('\n').length} lines)`;
  }

  private async editFile(input: { path: string; oldText: string; newText: string }): Promise<string> {
    const filePath = this.resolvePath(input.path);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${input.path}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const count = content.split(input.oldText).length - 1;

    if (count === 0) {
      throw new Error('Text not found in file');
    }

    if (count > 1) {
      throw new Error(`Text found ${count} times. Be more specific.`);
    }

    if (!this.bypassPermissions) {
      const confirm = await vscode.window.showInformationMessage(
        `Edit: ${input.path}?`,
        'Yes',
        'No'
      );
      if (confirm !== 'Yes') return 'Cancelled by user';
    }

    const newContent = content.replace(input.oldText, input.newText);
    fs.writeFileSync(filePath, newContent, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

    return `Edited: ${input.path}`;
  }

  private listDirectory(input: { path: string; recursive?: boolean }): string {
    const dirPath = this.resolvePath(input.path);

    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${input.path}`);
    }

    const results: string[] = [];
    const maxDepth = input.recursive ? 3 : 1;

    const list = (dir: string, depth: number, prefix = '') => {
      if (depth > maxDepth || results.length > 200) return;

      try {
        const items = fs.readdirSync(dir).sort();
        for (const item of items) {
          if (IGNORED_DIRS.has(item) || item.startsWith('.')) continue;

          const fullPath = path.join(dir, item);
          const isDir = fs.statSync(fullPath).isDirectory();
          const icon = isDir ? '📁' : '📄';

          results.push(`${prefix}${icon} ${item}`);

          if (isDir && input.recursive) {
            list(fullPath, depth + 1, prefix + '  ');
          }
        }
      } catch {}
    };

    list(dirPath, 0);
    return results.join('\n') || 'Empty directory';
  }

  private search(input: { pattern: string; path?: string }): string {
    const searchPath = input.path ? this.resolvePath(input.path) : this.getWorkspacePath();
    const regex = new RegExp(input.pattern, 'gi');
    const results: string[] = [];

    const searchDir = (dir: string) => {
      if (results.length >= 30) return;

      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (IGNORED_DIRS.has(item) || item.startsWith('.')) continue;

          const fullPath = path.join(dir, item);
          const stats = fs.statSync(fullPath);

          if (stats.isDirectory()) {
            searchDir(fullPath);
          } else if (stats.isFile() && stats.size < 500000) {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length && results.length < 30; i++) {
                if (regex.test(lines[i])) {
                  const rel = path.relative(this.getWorkspacePath(), fullPath);
                  results.push(`${rel}:${i + 1}: ${lines[i].trim().substring(0, 80)}`);
                }
              }
            } catch {}
          }
        }
      } catch {}
    };

    searchDir(searchPath);
    return results.length > 0 ? results.join('\n') : 'No matches found';
  }

  private glob(input: { pattern: string }): string {
    const basePath = this.getWorkspacePath();
    const pattern = new RegExp(
      input.pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
    );

    const results: string[] = [];

    const search = (dir: string, rel: string) => {
      if (results.length >= 50) return;

      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (IGNORED_DIRS.has(item)) continue;

          const fullPath = path.join(dir, item);
          const relPath = rel ? `${rel}/${item}` : item;
          const stats = fs.statSync(fullPath);

          if (stats.isDirectory()) {
            search(fullPath, relPath);
          } else if (pattern.test(relPath)) {
            results.push(relPath);
          }
        }
      } catch {}
    };

    search(basePath, '');
    return results.length > 0 ? results.join('\n') : 'No files found';
  }
}
