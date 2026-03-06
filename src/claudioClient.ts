import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';

export interface Message {
    role: 'user' | 'assistant';
    content: any;
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
    inputTokens: number;      // Current context size
    outputTokens: number;     // Current output
    cacheReadTokens: number;  // Tokens read from cache
    totalTokens: number;      // Current total (input + output)
    percentUsed: number;      // % of 200K context
    // Billing totals (accumulated)
    billingInput: number;
    billingOutput: number;
}

const MAX_CONTEXT_TOKENS = 200000; // Claude's context window

// Default config (will be overridden by config.json)
let bundledConfig: { apiUrl: string; apiKey: string; model: string } | null = null;

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
    private extensionPath: string = '';
    private mode: AgentMode = { autoEdit: true, planMode: false, bypass: false };
    private backgroundProcesses: Map<string, ChildProcess> = new Map();

    // Token tracking - current context (not accumulated)
    private currentInputTokens: number = 0;
    private currentOutputTokens: number = 0;
    private currentCacheReadTokens: number = 0;
    // Billing totals (accumulated across all calls)
    private billingInputTokens: number = 0;
    private billingOutputTokens: number = 0;

    // Callbacks
    public onToolStart?: (name: string, params: any) => void;
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
    }

    getMessages(): Message[] {
        return [...this.messages];
    }

    setMessages(messages: Message[]) {
        this.messages = [...messages];
    }

    getTokenUsage(): TokenUsage {
        const total = this.currentInputTokens + this.currentOutputTokens;
        return {
            inputTokens: this.currentInputTokens,
            outputTokens: this.currentOutputTokens,
            cacheReadTokens: this.currentCacheReadTokens,
            totalTokens: total,
            percentUsed: Math.round((this.currentInputTokens / MAX_CONTEXT_TOKENS) * 100),
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

    private requestSummary(config: any, conversationText: string): Promise<string> {
        const summaryPrompt = `Summarize this conversation concisely. Include:
- Main topics discussed
- Key decisions made
- Files created/modified (if any)
- Current task status
- Important context for continuing

Conversation:
${conversationText.substring(0, 8000)}

Provide a concise summary in 2-4 paragraphs:`;

        const body = JSON.stringify({
            model: config.model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: summaryPrompt }]
        });

        return new Promise((resolve, reject) => {
            const url = new URL(config.apiUrl + '/v1/messages');
            const lib = url.protocol === 'https:' ? https : http;

            const req = lib.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.apiKey,
                    'anthropic-version': '2023-06-01'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.content && json.content[0]?.text) {
                            resolve(json.content[0].text);
                        } else if (json.error) {
                            reject(new Error(json.error.message));
                        } else {
                            reject(new Error('Invalid response'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(body);
            req.end();
        });
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
        // Keep only the last 10 messages in full, truncate older tool results
        const result: Message[] = [];
        const recentCount = 10;
        const startTruncateIdx = Math.max(0, this.messages.length - recentCount);

        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];

            if (i < startTruncateIdx) {
                // Truncate old messages
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                    // Tool results - truncate heavily
                    const truncatedContent = msg.content.map((item: any) => {
                        if (item.type === 'tool_result' && typeof item.content === 'string') {
                            const content = item.content;
                            if (content.length > 200) {
                                return {
                                    ...item,
                                    content: content.substring(0, 200) + '... [truncated]'
                                };
                            }
                        }
                        return item;
                    });
                    result.push({ role: 'user', content: truncatedContent });
                } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                    // Keep assistant messages but truncate text
                    const truncatedContent = msg.content.map((block: any) => {
                        if (block.type === 'text' && block.text.length > 300) {
                            return { ...block, text: block.text.substring(0, 300) + '...' };
                        }
                        return block;
                    });
                    result.push({ role: 'assistant', content: truncatedContent });
                } else {
                    result.push(msg);
                }
            } else {
                // Recent messages - keep in full
                result.push(msg);
            }
        }

        return result;
    }

    private getConfig() {
        const userConfig = vscode.workspace.getConfiguration('claudioai');

        // User settings override bundled config
        return {
            apiKey: userConfig.get<string>('apiKey') || bundledConfig?.apiKey || '',
            apiUrl: userConfig.get<string>('apiUrl') || bundledConfig?.apiUrl || 'https://claudioai.dev',
            model: userConfig.get<string>('model') || bundledConfig?.model || 'claude-sonnet-4-20250514'
        };
    }

    private getWorkspacePath(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
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
        if (this.onAskPermission) {
            return await this.onAskPermission(action, details);
        }
        return true;
    }

    async executeTool(name: string, params: any): Promise<{ result: string; success: boolean }> {
        const workspacePath = this.getWorkspacePath();

        try {
            switch (name) {
                case "list_files": {
                    const targetPath = path.join(workspacePath, params.path || "");
                    if (!fs.existsSync(targetPath)) {
                        return { result: `Directory not found: ${params.path || "."}`, success: false };
                    }
                    const items = fs.readdirSync(targetPath, { withFileTypes: true });
                    const result = items.map(item => {
                        const prefix = item.isDirectory() ? "📁 " : "📄 ";
                        return prefix + item.name + (item.isDirectory() ? "/" : "");
                    }).join("\n");
                    return { result: result || "(empty directory)", success: true };
                }

                case "read_file": {
                    const filePath = path.join(workspacePath, params.path);
                    if (!fs.existsSync(filePath)) {
                        return { result: `File not found: ${params.path}`, success: false };
                    }
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    // Limit to 200 lines to save tokens
                    if (lines.length > 200) {
                        return { result: lines.slice(0, 200).join('\n') + `\n\n... (${lines.length - 200} more lines, use search_files for specific content)`, success: true };
                    }
                    return { result: content, success: true };
                }

                case "write_file": {
                    if (!this.mode.autoEdit && !this.mode.bypass) {
                        const allowed = await this.checkPermission("Write File", `Write to ${params.path}?`);
                        if (!allowed) return { result: "Permission denied by user", success: false };
                    }
                    const filePath = path.join(workspacePath, params.path);
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(filePath, params.content, 'utf-8');

                    // Open the file in editor
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);

                    return { result: `✓ Written: ${params.path} (${params.content.split('\n').length} lines)`, success: true };
                }

                case "edit_file": {
                    if (!this.mode.autoEdit && !this.mode.bypass) {
                        const allowed = await this.checkPermission("Edit File", `Edit ${params.path}?`);
                        if (!allowed) return { result: "Permission denied by user", success: false };
                    }
                    const filePath = path.join(workspacePath, params.path);
                    if (!fs.existsSync(filePath)) {
                        return { result: `File not found: ${params.path}`, success: false };
                    }
                    let content = fs.readFileSync(filePath, 'utf-8');
                    if (!content.includes(params.old_text)) {
                        return { result: `Text not found in file: "${params.old_text.substring(0, 50)}..."`, success: false };
                    }
                    content = content.replace(params.old_text, params.new_text);
                    fs.writeFileSync(filePath, content, 'utf-8');

                    // Open the file in editor
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);

                    return { result: `✓ Edited: ${params.path}`, success: true };
                }

                case "run_command": {
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
                            timeout: 120000,
                            maxBuffer: 10 * 1024 * 1024
                        }, (error, stdout, stderr) => {
                            const output = (stdout + stderr).trim();
                            const exitCode = error?.code ?? 0;
                            // Reduced from 5000 to 2000 to save tokens
                            const truncated = output.length > 2000
                                ? output.substring(0, 2000) + '\n... (truncated)'
                                : output;
                            resolve({
                                result: truncated + `\n[exit: ${exitCode}]`,
                                success: exitCode === 0
                            });
                        });
                    });
                }

                case "search_files": {
                    const searchPath = path.join(workspacePath, params.path || "");
                    const results: string[] = [];

                    const searchDir = (dir: string) => {
                        if (results.length >= 20) return; // Reduced from 50
                        try {
                            const items = fs.readdirSync(dir, { withFileTypes: true });
                            for (const item of items) {
                                if (results.length >= 20) break;
                                if (item.name.startsWith('.') || item.name === 'node_modules') continue;

                                const fullPath = path.join(dir, item.name);
                                if (item.isDirectory()) {
                                    searchDir(fullPath);
                                } else if (item.isFile()) {
                                    try {
                                        const content = fs.readFileSync(fullPath, 'utf-8');
                                        const lines = content.split('\n');
                                        lines.forEach((line, idx) => {
                                            if (line.toLowerCase().includes(params.query.toLowerCase())) {
                                                const relPath = path.relative(workspacePath, fullPath);
                                                results.push(`${relPath}:${idx + 1}: ${line.trim().substring(0, 100)}`);
                                            }
                                        });
                                    } catch {}
                                }
                            }
                        } catch {}
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

        // Build user message content with images if present
        let userContent: any;
        if (images && images.length > 0) {
            userContent = [
                ...images.map(img => ({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: img.type,
                        data: img.data
                    }
                })),
                { type: 'text', text: userMessage || 'What do you see in this image?' }
            ];
        } else {
            userContent = userMessage;
        }

        this.messages.push({ role: 'user', content: userContent });

        // Check if we need to compact before sending
        this.compactHistory();

        let iterations = 0;
        const maxIterations = 20;

        let lastTextContent = '';

        while (iterations < maxIterations) {
            iterations++;
            console.log(`ClaudioAI: Iteration ${iterations}/${maxIterations}`);

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

                const percentUsed = Math.round((inputTokens / MAX_CONTEXT_TOKENS) * 100);
                console.log(`ClaudioAI Context: ${inputTokens.toLocaleString()} in, ${outputTokens.toLocaleString()} out (${percentUsed}% of 200K) | Cache: ${cacheRead.toLocaleString()} read`);

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

            // Execute tools (with plan mode restrictions)
            const toolResults: any[] = [];
            const readOnlyTools = ['list_files', 'read_file', 'search_files'];

            for (const tool of toolCalls) {
                console.log(`ClaudioAI: Tool requested: ${tool.name}`);

                // In plan mode, only allow read-only tools
                if (this.mode.planMode && !readOnlyTools.includes(tool.name)) {
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

    private makeRequest(config: any): Promise<any> {
        // Build system prompt based on mode
        let modeInstructions = '';
        if (this.mode.planMode) {
            modeInstructions = `

MODE: PLAN MODE (Active)
- You CAN use read-only tools: list_files, read_file, search_files
- You CANNOT execute: write_file, edit_file, run_command (will be simulated)
- Analyze the codebase and create a detailed step-by-step plan
- Explain what changes you WOULD make and why
- Be specific about files and code modifications`;
        }

        const systemPrompt = [
            {
                type: "text",
                text: `You are ClaudioAI, a concise coding assistant with filesystem access.

RULES:
1. Use tools immediately when asked to do something
2. Be brief - summarize results in 1-2 sentences
3. Respond in the user's language${modeInstructions}

WORKSPACE: ${this.getWorkspacePath()}`,
                cache_control: { type: "ephemeral" }
            }
        ];

        // Add cache control to tools
        const cachedTools = TOOLS.map((tool, i) =>
            i === TOOLS.length - 1
                ? { ...tool, cache_control: { type: "ephemeral" } }
                : tool
        );

        // Optimize messages - truncate old tool results
        const optimizedMessages = this.optimizeMessages();

        const body = JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            system: systemPrompt,
            tools: cachedTools,
            messages: optimizedMessages
        });

        return new Promise((resolve, reject) => {
            const url = new URL(config.apiUrl + '/v1/messages');
            const lib = url.protocol === 'https:' ? https : http;

            const req = lib.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'prompt-caching-2024-07-31'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);

                        if (res.statusCode !== 200) {
                            const errorMsg = json.error?.message || `HTTP ${res.statusCode}`;
                            reject(new Error(errorMsg));
                            return;
                        }

                        if (json.error) {
                            reject(new Error(json.error.message || 'API Error'));
                            return;
                        }

                        resolve(json);
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${data.substring(0, 100)}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
            req.write(body);
            req.end();
        });
    }
}
