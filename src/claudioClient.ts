import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';

export interface Message {
    role: 'user' | 'assistant';
    content: MessageContent;
}

type MessageContent = string | ContentBlock[];

interface ContentBlock {
    type: string;
    [key: string]: any;
}

export interface AgentMode {
    autoEdit: boolean;
    planMode: boolean;
    bypass: boolean;
}

export interface PlanFile {
    path: string;
    title: string;
    content: string;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    percentUsed: number;
    billingInput: number;
    billingOutput: number;
}

interface ApiConfig {
    apiKey: string;
    apiUrl: string;
    model: string;
}

const CONFIG = {
    MAX_CONTEXT_TOKENS: 200000,
    MAX_ITERATIONS: 20,
    MAX_TRUNCATION_RETRIES: 2,
    REQUEST_TIMEOUT_MS: 90000,
    COMMAND_TIMEOUT_MS: 60000,
    MAX_BUFFER_SIZE: 10 * 1024 * 1024,

    LIMITS: {
        FILE_LINES: 200,
        SEARCH_RESULTS: 20,
        TRUNCATE_OLD_RESULT: 200,
        TRUNCATE_OLD_TEXT: 300,
        COMMAND_OUTPUT: 2000,
        SUMMARY_INPUT: 8000,
        RECENT_MESSAGES: 10,
    },

    VALID_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const,
    READ_ONLY_TOOLS: ['list_files', 'read_file', 'search_files'] as const,
} as const;

let bundledConfig: ApiConfig | null = null;

const TOOLS = [
    {
        name: "list_files",
        description: "List files and directories in a path",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path to list (default: current directory)" }
            },
            required: []
        }
    },
    {
        name: "read_file",
        description: "Read the contents of a file",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path to the file" }
            },
            required: ["path"]
        }
    },
    {
        name: "write_file",
        description: "Write content to a file (creates directories if needed)",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path to the file" },
                content: { type: "string", description: "Content to write" }
            },
            required: ["path", "content"]
        }
    },
    {
        name: "edit_file",
        description: "Edit a file by replacing old_text with new_text",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path to the file" },
                old_text: { type: "string", description: "Text to find and replace" },
                new_text: { type: "string", description: "Replacement text" }
            },
            required: ["path", "old_text", "new_text"]
        }
    },
    {
        name: "run_command",
        description: "Execute a shell command and return the output",
        input_schema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Shell command to execute" },
                background: { type: "boolean", description: "Run in background (for servers)" }
            },
            required: ["command"]
        }
    },
    {
        name: "search_files",
        description: "Search for text in files",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to search for" },
                path: { type: "string", description: "Directory to search in" }
            },
            required: ["query"]
        }
    }
];

export class ClaudioClient {
    private messages: Message[] = [];
    private extensionPath = '';
    private mode: AgentMode = { autoEdit: true, planMode: false, bypass: false };
    private backgroundProcesses = new Map<string, ChildProcess>();

    private currentInputTokens = 0;
    private currentOutputTokens = 0;
    private currentCacheReadTokens = 0;
    private billingInputTokens = 0;
    private billingOutputTokens = 0;

    // Cached values for performance
    private cachedConfig: ApiConfig | null = null;
    private cachedWorkspacePath: string | null = null;

    public onToolStart?: (name: string, params: Record<string, unknown>) => void;
    public onToolEnd?: (name: string, result: string, success: boolean) => void;
    public onText?: (text: string) => void;
    public onThinking?: (thinking: string) => void;
    public onTokenUpdate?: (usage: TokenUsage) => void;
    public onAskPermission?: (action: string, details: string) => Promise<boolean>;
    public onPlanSaved?: (plan: PlanFile) => void;

    setExtensionPath(extensionPath: string) {
        this.extensionPath = extensionPath;
        this.loadBundledConfig();
    }

    private loadBundledConfig() {
        if (bundledConfig) return;
        try {
            const configPath = path.join(this.extensionPath, 'resources', 'config.json');
            if (fs.existsSync(configPath)) {
                const configData = fs.readFileSync(configPath, 'utf-8');
                bundledConfig = JSON.parse(configData);
                console.log('ClaudioAI: Loaded bundled config');
            }
        } catch (err) {
            console.error('ClaudioAI: Failed to load bundled config', err);
        }
    }

    setMode(mode: Partial<AgentMode>) {
        this.mode = { ...this.mode, ...mode };
    }

    getMode(): AgentMode {
        return this.mode;
    }

    clearHistory() {
        this.messages = [];
        this.currentInputTokens = 0;
        this.currentOutputTokens = 0;
        this.currentCacheReadTokens = 0;
        this.billingInputTokens = 0;
        this.billingOutputTokens = 0;
        this.cachedConfig = null;
    }

    getMessages(): Message[] {
        return [...this.messages];
    }

    setMessages(messages: Message[]) {
        this.messages = [...messages];
    }

    getTokenUsage(): TokenUsage {
        return {
            inputTokens: this.currentInputTokens,
            outputTokens: this.currentOutputTokens,
            cacheReadTokens: this.currentCacheReadTokens,
            totalTokens: this.currentInputTokens + this.currentOutputTokens,
            percentUsed: Math.round((this.currentInputTokens / CONFIG.MAX_CONTEXT_TOKENS) * 100),
            billingInput: this.billingInputTokens,
            billingOutput: this.billingOutputTokens
        };
    }

    setTokens(input: number, output: number) {
        this.currentInputTokens = input;
        this.currentOutputTokens = output;
        this.billingInputTokens = input;
        this.billingOutputTokens = output;
    }

    async forceCompact(onProgress?: (status: string) => void): Promise<{ success: boolean; message: string; summary?: string }> {
        // Need at least 6 messages to compact
        if (this.messages.length <= 5) {
            console.log('ClaudioAI: Not enough messages to compact');
            return { success: false, message: 'Not enough messages to compact (minimum 6 required)' };
        }

        console.log('ClaudioAI: Smart compaction triggered');
        const config = this.getConfig();
        const previousCount = this.messages.length;
        const previousTokens = this.currentInputTokens;

        onProgress?.('Analyzing conversation...');

        // Get messages to summarize (all except last 4)
        const messagesToSummarize = this.messages.slice(0, -4);
        const recentMessages = this.messages.slice(-4);

        // Build conversation text for summary
        const conversationText = messagesToSummarize.map(msg => {
            if (msg.role === 'user') {
                if (typeof msg.content === 'string') {
                    return `User: ${msg.content}`;
                } else if (Array.isArray(msg.content)) {
                    const text = msg.content
                        .filter((c: any) => c.type === 'tool_result')
                        .map((c: any) => `[Tool Result: ${String(c.content).substring(0, 100)}...]`)
                        .join('\n');
                    return text || '[Tool Results]';
                }
            } else if (msg.role === 'assistant') {
                if (Array.isArray(msg.content)) {
                    const parts: string[] = [];
                    msg.content.forEach((block: any) => {
                        if (block.type === 'text') parts.push(block.text);
                        if (block.type === 'tool_use') parts.push(`[Used tool: ${block.name}]`);
                    });
                    return `Assistant: ${parts.join(' ')}`;
                }
            }
            return '';
        }).filter(Boolean).join('\n\n');

        onProgress?.('Generating intelligent summary...');

        try {
            // Request summary from AI
            const summaryResponse = await this.requestSummary(config, conversationText);

            onProgress?.('Rebuilding context...');

            // Create the compacted history
            const summaryMsg: Message = {
                role: 'user',
                content: `[Conversation Summary]\n${summaryResponse}\n[End of Summary - Recent messages follow]`
            };

            const assistantAck: Message = {
                role: 'assistant',
                content: [{ type: 'text', text: 'I understand the context from the summary. Continuing from where we left off.' }]
            };

            this.messages = [summaryMsg, assistantAck, ...recentMessages];

            // Estimate new token count (~40% of previous after compaction)
            this.currentInputTokens = Math.floor(this.currentInputTokens * 0.4);

            if (this.onTokenUpdate) {
                this.onTokenUpdate(this.getTokenUsage());
            }

            const removedMessages = previousCount - this.messages.length;
            const savedTokens = previousTokens - this.currentInputTokens;

            return {
                success: true,
                message: `Compacted ${removedMessages} messages, saved ~${savedTokens.toLocaleString()} tokens`,
                summary: summaryResponse
            };
        } catch (error) {
            console.error('ClaudioAI: Compaction failed', error);
            return {
                success: false,
                message: `Compaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    private httpPost(url: string, body: string, apiKey: string, extraHeaders?: Record<string, string>): Promise<any> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;

            const req = lib.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    ...extraHeaders
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
                    } catch {
                        reject(new Error(`Failed to parse response: ${data.substring(0, 100)}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
            req.setTimeout(CONFIG.REQUEST_TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error(`Request timeout (${CONFIG.REQUEST_TIMEOUT_MS / 1000}s)`));
            });

            req.write(body);
            req.end();
        });
    }

    private async requestSummary(config: ApiConfig, conversationText: string): Promise<string> {
        const summaryPrompt = `Summarize this conversation concisely. Include:
- Main topics discussed
- Key decisions made
- Files created/modified (if any)
- Current task status
- Important context for continuing

Conversation:
${conversationText.substring(0, CONFIG.LIMITS.SUMMARY_INPUT)}

Provide a concise summary in 2-4 paragraphs:`;

        const body = JSON.stringify({
            model: config.model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: summaryPrompt }]
        });

        const { data } = await this.httpPost(`${config.apiUrl}/v1/messages`, body, config.apiKey);

        if (data.content?.[0]?.text) {
            return data.content[0].text;
        }
        throw new Error(data.error?.message || 'Invalid response');
    }

    private compactHistory(): boolean {
        const usage = this.getTokenUsage();

        // Compact when reaching 90% of context (need > 5 messages to actually remove any)
        if (usage.percentUsed >= 90 && this.messages.length > 5) {
            console.log('ClaudioAI: Auto-compacting chat history (90% context used)');

            // Keep first 2 messages (initial context) and last 4 messages (recent context)
            const firstMessages = this.messages.slice(0, 2);
            const lastMessages = this.messages.slice(-4);

            const summaryMsg: Message = {
                role: 'user',
                content: '[System: Previous conversation was auto-compacted to save context. Recent messages preserved.]'
            };

            this.messages = [...firstMessages, summaryMsg, ...lastMessages];

            // Reduce token count estimate
            this.currentInputTokens = Math.floor(this.currentInputTokens * 0.4);

            if (this.onTokenUpdate) {
                this.onTokenUpdate(this.getTokenUsage());
            }

            return true;
        }

        return false;
    }

    private optimizeMessages(): Message[] {
        const { RECENT_MESSAGES, TRUNCATE_OLD_RESULT, TRUNCATE_OLD_TEXT } = CONFIG.LIMITS;
        const startTruncateIdx = Math.max(0, this.messages.length - RECENT_MESSAGES);

        return this.messages.map((msg, i) => {
            if (i >= startTruncateIdx) return msg;

            if (msg.role === 'user' && Array.isArray(msg.content)) {
                const truncated = msg.content
                    .filter((item: ContentBlock) => item.type !== 'image')
                    .map((item: ContentBlock) => {
                        if (item.type === 'tool_result' && typeof item.content === 'string' && item.content.length > TRUNCATE_OLD_RESULT) {
                            return { ...item, content: item.content.substring(0, TRUNCATE_OLD_RESULT) + '... [truncated]' };
                        }
                        return item;
                    });

                return truncated.length === 0
                    ? { role: 'user' as const, content: '[Previous message contained images]' }
                    : { role: 'user' as const, content: truncated };
            }

            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const truncated = msg.content.map((block: ContentBlock) =>
                    block.type === 'text' && block.text?.length > TRUNCATE_OLD_TEXT
                        ? { ...block, text: block.text.substring(0, TRUNCATE_OLD_TEXT) + '...' }
                        : block
                );
                return { role: 'assistant' as const, content: truncated };
            }

            return msg;
        });
    }

    private getConfig(): ApiConfig {
        if (this.cachedConfig) return this.cachedConfig;

        const userConfig = vscode.workspace.getConfiguration('claudioai');
        this.cachedConfig = {
            apiKey: userConfig.get<string>('apiKey') || bundledConfig?.apiKey || '',
            apiUrl: userConfig.get<string>('apiUrl') || bundledConfig?.apiUrl || 'https://claudioai.dev',
            model: userConfig.get<string>('model') || bundledConfig?.model || 'claude-opus-4-5'
        };
        return this.cachedConfig;
    }

    private getWorkspacePath(): string {
        if (!this.cachedWorkspacePath) {
            this.cachedWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        }
        return this.cachedWorkspacePath;
    }

    private getClaudioDir(): string {
        return path.join(this.getWorkspacePath(), '.claudio-ai');
    }

    private ensureClaudioDir(): void {
        const dirs = [
            this.getClaudioDir(),
            path.join(this.getClaudioDir(), 'plans'),
            path.join(this.getClaudioDir(), 'context')
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        // Create .gitignore if not exists
        const gitignorePath = path.join(this.getClaudioDir(), '.gitignore');
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, `# ClaudioAI generated files
context/
*.log
`);
        }

        // Create README if not exists
        const readmePath = path.join(this.getClaudioDir(), 'README.md');
        if (!fs.existsSync(readmePath)) {
            fs.writeFileSync(readmePath, `# ClaudioAI

This directory contains files generated by the ClaudioAI VS Code extension.

## Structure

- \`plans/\` - Generated plans and task breakdowns
- \`context/\` - Saved conversation context (git-ignored)

## Plans

Plans are created when using Plan Mode. They contain:
- Task analysis
- Step-by-step implementation plan
- Files to be modified
- Estimated changes

---
*Generated by [ClaudioAI](https://github.com/gustavogouveia1/claudioai-vscode)*
`);
        }
    }

    public savePlan(title: string, content: string): PlanFile {
        this.ensureClaudioDir();

        const date = new Date();
        const timestamp = date.toISOString().split('T')[0];
        const time = date.toTimeString().split(' ')[0].replace(/:/g, '-');
        const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
            .substring(0, 50);

        const filename = `${timestamp}-${time}-${slug || 'plan'}.md`;
        const filePath = path.join(this.getClaudioDir(), 'plans', filename);

        const planContent = `# ${title}

> Generated by ClaudioAI on ${date.toLocaleString()}

---

${content}

---
*Plan Mode - Read-only analysis completed*
`;

        fs.writeFileSync(filePath, planContent, 'utf-8');

        return {
            path: filePath,
            title,
            content: planContent
        };
    }

    public saveContext(summary: string): string {
        this.ensureClaudioDir();

        const contextPath = path.join(this.getClaudioDir(), 'context', 'latest.md');
        const content = `# Conversation Context

> Last updated: ${new Date().toLocaleString()}

${summary}
`;

        fs.writeFileSync(contextPath, content, 'utf-8');
        return contextPath;
    }

    private async checkPermission(action: string, details: string): Promise<boolean> {
        if (this.mode.bypass) return true;
        return this.onAskPermission ? this.onAskPermission(action, details) : true;
    }

    private buildImageContent(images: Array<{data: string, type: string}>, message: string): ContentBlock[] {
        const imageBlocks = images.map((img) => {
            let mediaType = img.type.toLowerCase();
            if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
            if (!CONFIG.VALID_IMAGE_TYPES.includes(mediaType as any)) {
                mediaType = 'image/png';
            }

            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: img.data.replace(/\s/g, '')
                }
            };
        });

        return [...imageBlocks, { type: 'text', text: message || 'Descreva esta imagem.' }];
    }

    async executeTool(name: string, params: any): Promise<{ result: string; success: boolean }> {
        const workspacePath = this.getWorkspacePath();

        // Ensure params is always an object
        if (!params || typeof params !== 'object') {
            console.error(`ClaudioAI: Invalid params for ${name}:`, params);
            params = {};
        }

        // Log params for debugging
        console.log(`ClaudioAI: executeTool(${name}) params:`, JSON.stringify(params, null, 2));

        try {
            switch (name) {
                case "list_files": {
                    const targetPath = path.join(workspacePath, params.path || "");
                    if (!fs.existsSync(targetPath)) {
                        return { result: `Directory not found: ${params.path || "."}. Try list_files with path="" to see root.`, success: false };
                    }
                    const items = fs.readdirSync(targetPath, { withFileTypes: true });
                    const result = items.map(item =>
                        (item.isDirectory() ? "📁 " : "📄 ") + item.name + (item.isDirectory() ? "/" : "")
                    ).join("\n");
                    return { result: result || "(empty directory)", success: true };
                }

                case "read_file": {
                    if (!params.path) {
                        return { result: "Error: path is required. Use list_files first to find the correct path.", success: false };
                    }
                    const filePath = path.join(workspacePath, params.path);
                    if (!fs.existsSync(filePath)) {
                        const dir = path.dirname(params.path);
                        return { result: `File not found: ${params.path}. Use list_files with path="${dir || ''}" to verify.`, success: false };
                    }
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    const limit = CONFIG.LIMITS.FILE_LINES;

                    return lines.length > limit
                        ? { result: `${lines.slice(0, limit).join('\n')}\n\n... (${lines.length - limit} more lines)`, success: true }
                        : { result: content, success: true };
                }

                case "write_file": {
                    if (!params.path) {
                        return { result: "Error: path is required", success: false };
                    }
                    if (params.content === undefined || params.content === null) {
                        console.error(`ClaudioAI: write_file missing content. Received params:`, JSON.stringify(params));
                        return {
                            result: `Error: content parameter is missing (response may have been truncated). For large files, use edit_file to make incremental changes instead of rewriting the entire file. Read the file first with read_file, then use edit_file to replace specific sections.`,
                            success: false
                        };
                    }
                    const content = String(params.content);

                    if (!this.mode.autoEdit && !this.mode.bypass) {
                        const allowed = await this.checkPermission("Write File", `Write to ${params.path}?`);
                        if (!allowed) return { result: "Permission denied by user", success: false };
                    }
                    const filePath = path.join(workspacePath, params.path);
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(filePath, content, 'utf-8');

                    // Open the file in editor
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);

                    return { result: `✓ Written: ${params.path} (${content.split('\n').length} lines)`, success: true };
                }

                case "edit_file": {
                    if (!params.path) {
                        return { result: "Error: path is required. Use list_files to find it.", success: false };
                    }
                    if (params.old_text === undefined || params.old_text === null) {
                        return { result: "Error: old_text is required. Use read_file first to see current content.", success: false };
                    }
                    if (params.new_text === undefined || params.new_text === null) {
                        return { result: "Error: new_text is required.", success: false };
                    }
                    const oldText = String(params.old_text);
                    const newText = String(params.new_text);

                    if (!this.mode.autoEdit && !this.mode.bypass) {
                        const allowed = await this.checkPermission("Edit File", `Edit ${params.path}?`);
                        if (!allowed) return { result: "Permission denied by user", success: false };
                    }
                    const filePath = path.join(workspacePath, params.path);
                    if (!fs.existsSync(filePath)) {
                        return { result: `File not found: ${params.path}. Use list_files to verify path.`, success: false };
                    }
                    let content = fs.readFileSync(filePath, 'utf-8');
                    if (!content.includes(oldText)) {
                        return { result: `Text not found. Read the file again - content may have changed. Searched for: "${oldText.substring(0, 80)}..."`, success: false };
                    }
                    content = content.replace(oldText, newText);
                    fs.writeFileSync(filePath, content, 'utf-8');

                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);

                    return { result: `✓ Edited: ${params.path}`, success: true };
                }

                case "run_command": {
                    if (!params.command) {
                        return { result: "Error: command is required", success: false };
                    }

                    if (!this.mode.bypass) {
                        const allowed = await this.checkPermission("Run Command", params.command);
                        if (!allowed) return { result: "Permission denied by user", success: false };
                    }

                    if (params.background) {
                        const child = spawn(params.command, [], {
                            shell: true,
                            cwd: workspacePath,
                            detached: true
                        });
                        this.backgroundProcesses.set(params.command, child);
                        return { result: `✓ Started in background: ${params.command}\nPID: ${child.pid}`, success: true };
                    }

                    return new Promise((resolve) => {
                        exec(params.command, {
                            cwd: workspacePath,
                            timeout: CONFIG.COMMAND_TIMEOUT_MS,
                            maxBuffer: CONFIG.MAX_BUFFER_SIZE
                        }, (error, stdout, stderr) => {
                            const output = (stdout + stderr).trim();
                            const exitCode = error?.code ?? 0;
                            const limit = CONFIG.LIMITS.COMMAND_OUTPUT;
                            const truncated = output.length > limit
                                ? output.substring(0, limit) + '\n... (truncated)'
                                : output;

                            if (exitCode !== 0) {
                                resolve({
                                    result: `Command failed [exit: ${exitCode}]. Output:\n${truncated}\nTry a different approach or verify paths.`,
                                    success: false
                                });
                            } else {
                                resolve({ result: truncated || '(no output)', success: true });
                            }
                        });
                    });
                }

                case "search_files": {
                    if (!params.query) {
                        return { result: "Error: query is required", success: false };
                    }
                    const searchPath = path.join(workspacePath, params.path || "");
                    const results: string[] = [];
                    const maxResults = CONFIG.LIMITS.SEARCH_RESULTS;
                    const queryLower = params.query.toLowerCase();
                    const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__']);

                    const searchDir = (dir: string): void => {
                        if (results.length >= maxResults) return;

                        let items;
                        try {
                            items = fs.readdirSync(dir, { withFileTypes: true });
                        } catch { return; }

                        for (const item of items) {
                            if (results.length >= maxResults) return;
                            if (item.name.startsWith('.') || skipDirs.has(item.name)) continue;

                            const fullPath = path.join(dir, item.name);

                            if (item.isDirectory()) {
                                searchDir(fullPath);
                            } else if (item.isFile()) {
                                try {
                                    const content = fs.readFileSync(fullPath, 'utf-8');
                                    const lines = content.split('\n');
                                    const relPath = path.relative(workspacePath, fullPath);

                                    for (let idx = 0; idx < lines.length && results.length < maxResults; idx++) {
                                        if (lines[idx].toLowerCase().includes(queryLower)) {
                                            results.push(`${relPath}:${idx + 1}: ${lines[idx].trim().substring(0, 100)}`);
                                        }
                                    }
                                } catch {}
                            }
                        }
                    };

                    searchDir(searchPath);
                    return {
                        result: results.length > 0 ? results.join('\n') : 'No matches found',
                        success: true
                    };
                }

                default:
                    return { result: `Unknown tool: ${name}`, success: false };
            }
        } catch (error) {
            return { result: `Error: ${error}`, success: false };
        }
    }

    async sendMessage(userMessage: string, images?: Array<{data: string, type: string}>): Promise<string> {
        const config = this.getConfig();

        const userContent = images?.length
            ? this.buildImageContent(images, userMessage)
            : userMessage;

        this.messages.push({ role: 'user', content: userContent });

        // Check if we need to compact before sending
        this.compactHistory();

        let iterations = 0;
        let truncationRetries = 0;
        let lastTextContent = '';

        while (iterations < CONFIG.MAX_ITERATIONS) {
            iterations++;
            console.log(`ClaudioAI: Iteration ${iterations}/${CONFIG.MAX_ITERATIONS}`);

            let response;
            try {
                response = await this.makeRequest(config);
            } catch (err) {
                console.error('ClaudioAI: Request failed', err);
                throw err;
            }

            if (response.error) {
                throw new Error(response.error.message || 'API Error');
            }

            console.log(`ClaudioAI: Response stop_reason=${response.stop_reason}`);

            // Update token usage
            if (response.usage) {
                const inputTokens = response.usage.input_tokens || 0;
                const outputTokens = response.usage.output_tokens || 0;
                const cacheRead = response.usage.cache_read_input_tokens || 0;

                // Current context = this request's tokens (NOT accumulated)
                this.currentInputTokens = inputTokens;
                this.currentOutputTokens = outputTokens;
                this.currentCacheReadTokens = cacheRead;

                // Billing = accumulated across all API calls
                this.billingInputTokens += inputTokens;
                this.billingOutputTokens += outputTokens;

                const percentUsed = Math.round((inputTokens / CONFIG.MAX_CONTEXT_TOKENS) * 100);
                console.log(`ClaudioAI: ${inputTokens.toLocaleString()} in, ${outputTokens.toLocaleString()} out (${percentUsed}%) | Cache: ${cacheRead.toLocaleString()}`);

                if (this.onTokenUpdate) {
                    this.onTokenUpdate(this.getTokenUsage());
                }
            }

            let textContent = '';
            const toolCalls: any[] = [];

            for (const block of response.content || []) {
                if (block.type === 'text') {
                    textContent += block.text;
                    if (this.onText) this.onText(block.text);
                } else if (block.type === 'tool_use') {
                    toolCalls.push(block);
                }
            }

            // Handle truncated responses that cut off tool parameters
            if (response.stop_reason === 'max_tokens' && toolCalls.length > 0 && truncationRetries < CONFIG.MAX_TRUNCATION_RETRIES) {
                const lastTool = toolCalls[toolCalls.length - 1];

                if (lastTool.name === 'write_file' && !lastTool.input?.content) {
                    truncationRetries++;
                    console.log(`ClaudioAI: Truncated write_file (retry ${truncationRetries}/${CONFIG.MAX_TRUNCATION_RETRIES})`);

                    // Add the truncated response to history
                    this.messages.push({ role: 'assistant', content: response.content });

                    // Ask the model to use edit_file instead
                    this.messages.push({
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: lastTool.id,
                            content: 'Error: Response was truncated. The file content is too large to write at once. Please use edit_file to make incremental changes to the existing file, or split the changes into smaller parts. Do NOT try to write the entire file again.'
                        }]
                    });

                    continue; // Retry with the new instruction
                }
            }

            lastTextContent = textContent || lastTextContent;
            this.messages.push({ role: 'assistant', content: response.content });

            // If stop_reason is end_turn or no tool calls, we're done
            if (response.stop_reason === 'end_turn' || toolCalls.length === 0) {
                this.compactHistory();

                // Save plan if in plan mode
                if (this.mode.planMode && lastTextContent.length > 100) {
                    try {
                        // Extract title from first line or generate one
                        const firstLine = lastTextContent.split('\n')[0];
                        const title = firstLine.replace(/^[#*\-\s]+/, '').substring(0, 60) || 'Plan';
                        const plan = this.savePlan(title, lastTextContent);

                        if (this.onPlanSaved) {
                            this.onPlanSaved(plan);
                        }
                    } catch (err) {
                        console.error('ClaudioAI: Failed to save plan', err);
                    }
                }

                return lastTextContent;
            }

            const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];

            for (const tool of toolCalls) {
                console.log(`ClaudioAI: Tool ${tool.name}`, JSON.stringify(tool.input || {}));

                if (this.mode.planMode && !CONFIG.READ_ONLY_TOOLS.includes(tool.name)) {
                    console.log(`ClaudioAI: Plan mode - blocking ${tool.name}`);

                    if (this.onToolStart) {
                        this.onToolStart(tool.name, tool.input);
                    }

                    if (this.onToolEnd) {
                        this.onToolEnd(tool.name, `[Plan Mode] Would execute: ${tool.name}`, true);
                    }

                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: tool.id,
                        content: `[Plan Mode] This action would be executed: ${tool.name} with params: ${JSON.stringify(tool.input)}`
                    });
                    continue;
                }

                if (this.onToolStart) {
                    this.onToolStart(tool.name, tool.input);
                }

                const { result, success } = await this.executeTool(tool.name, tool.input);

                if (this.onToolEnd) {
                    this.onToolEnd(tool.name, result, success);
                }

                toolResults.push({
                    type: "tool_result",
                    tool_use_id: tool.id,
                    content: result
                });
            }

            this.messages.push({ role: 'user', content: toolResults });
        }

        console.log('ClaudioAI: Max iterations reached');
        return lastTextContent || "Max iterations reached";
    }

    private async makeRequest(config: ApiConfig): Promise<any> {
        const modeInstructions = this.mode.planMode ? `

MODE: PLAN MODE (Active)
- You CAN use read-only tools: list_files, read_file, search_files
- You CANNOT execute: write_file, edit_file, run_command (will be simulated)
- Analyze the codebase and create a detailed step-by-step plan
- Explain what changes you WOULD make and why
- Be specific about files and code modifications` : '';

        const systemPrompt = [{
            type: "text",
            text: `You are ClaudioAI, a concise coding assistant with filesystem access.

RULES:
1. Use tools immediately when asked
2. Be brief - 1-2 sentences max
3. On tool failure: try alternative immediately, don't explain the error
4. Respond in user's language${modeInstructions}

WORKSPACE: ${this.getWorkspacePath()}`,
            cache_control: { type: "ephemeral" }
        }];

        const cachedTools = TOOLS.map((tool, i) =>
            i === TOOLS.length - 1
                ? { ...tool, cache_control: { type: "ephemeral" } }
                : tool
        );

        const body = JSON.stringify({
            model: config.model,
            max_tokens: 8192,
            system: systemPrompt,
            tools: cachedTools,
            messages: this.optimizeMessages()
        });

        console.log(`ClaudioAI: Request size: ${body.length} bytes`);

        const { statusCode, data } = await this.httpPost(
            `${config.apiUrl}/v1/messages`,
            body,
            config.apiKey,
            { 'anthropic-beta': 'prompt-caching-2024-07-31' }
        );

        if (statusCode !== 200) {
            const errorMsg = data.error?.message || data.message || JSON.stringify(data).substring(0, 200);
            throw new Error(`HTTP ${statusCode}: ${errorMsg}`);
        }

        if (data.error) {
            throw new Error(data.error.message || 'API Error');
        }

        return data;
    }
}
