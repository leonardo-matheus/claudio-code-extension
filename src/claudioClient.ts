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

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    percentUsed: number;
}

const MAX_CONTEXT_TOKENS = 200000; // Claude's context window

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
    private mode: AgentMode = { autoEdit: true, planMode: false, bypass: false };
    private backgroundProcesses: Map<string, ChildProcess> = new Map();

    // Token tracking
    private totalInputTokens: number = 0;
    private totalOutputTokens: number = 0;

    // Callbacks
    public onToolStart?: (name: string, params: any) => void;
    public onToolEnd?: (name: string, result: string, success: boolean) => void;
    public onText?: (text: string) => void;
    public onThinking?: (thinking: string) => void;
    public onTokenUpdate?: (usage: TokenUsage) => void;
    public onAskPermission?: (action: string, details: string) => Promise<boolean>;

    setMode(mode: Partial<AgentMode>) {
        this.mode = { ...this.mode, ...mode };
    }

    getMode(): AgentMode {
        return this.mode;
    }

    clearHistory() {
        this.messages = [];
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
    }

    getMessages(): Message[] {
        return [...this.messages];
    }

    setMessages(messages: Message[]) {
        this.messages = [...messages];
    }

    getTokenUsage(): TokenUsage {
        const total = this.totalInputTokens + this.totalOutputTokens;
        return {
            inputTokens: this.totalInputTokens,
            outputTokens: this.totalOutputTokens,
            totalTokens: total,
            percentUsed: Math.round((total / MAX_CONTEXT_TOKENS) * 100)
        };
    }

    setTokens(input: number, output: number) {
        this.totalInputTokens = input;
        this.totalOutputTokens = output;
    }

    forceCompact(): { success: boolean; message: string } {
        // Need at least 6 messages to compact (keeps 5: first 2 + summary + last 2)
        if (this.messages.length <= 5) {
            console.log('ClaudioAI: Not enough messages to compact');
            return { success: false, message: 'Not enough messages to compact (minimum 6 required)' };
        }

        console.log('ClaudioAI: Manual compaction triggered');

        const previousCount = this.messages.length;

        // Keep first 2 messages and last 2 messages
        const firstMessages = this.messages.slice(0, 2);
        const lastMessages = this.messages.slice(-2);

        const summaryMsg: Message = {
            role: 'user',
            content: '[System: Chat history was manually compacted. Recent context preserved.]'
        };

        this.messages = [...firstMessages, summaryMsg, ...lastMessages];

        // Reset token counts (estimate)
        const previousTokens = this.totalInputTokens + this.totalOutputTokens;
        this.totalInputTokens = Math.floor(this.totalInputTokens * 0.3);
        this.totalOutputTokens = Math.floor(this.totalOutputTokens * 0.3);
        const newTokens = this.totalInputTokens + this.totalOutputTokens;

        if (this.onTokenUpdate) {
            this.onTokenUpdate(this.getTokenUsage());
        }

        const removedMessages = previousCount - this.messages.length;
        const savedTokens = previousTokens - newTokens;

        return {
            success: true,
            message: `Compacted: removed ${removedMessages} messages, saved ~${savedTokens.toLocaleString()} tokens`
        };
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
            this.totalInputTokens = Math.floor(this.totalInputTokens * 0.4);
            this.totalOutputTokens = Math.floor(this.totalOutputTokens * 0.4);

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
        const config = vscode.workspace.getConfiguration('claudioai');
        return {
            apiKey: config.get<string>('apiKey') || 'sk-claudio-2a3841982320fc141083b292d28438ac28e575f231ccdc66',
            apiUrl: config.get<string>('apiUrl') || 'https://claudioai.dev',
            model: config.get<string>('model') || 'claude-opus-4-5'
        };
    }

    private getWorkspacePath(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
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

    async sendMessage(userMessage: string): Promise<string> {
        const config = this.getConfig();

        this.messages.push({ role: 'user', content: userMessage });

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

            // Update token usage (account for cache hits)
            if (response.usage) {
                const inputDelta = response.usage.input_tokens || 0;
                const outputDelta = response.usage.output_tokens || 0;
                const cacheRead = response.usage.cache_read_input_tokens || 0;
                const cacheCreation = response.usage.cache_creation_input_tokens || 0;

                // Only count non-cached input tokens for billing estimate
                const effectiveInput = inputDelta - cacheRead;
                this.totalInputTokens += effectiveInput;
                this.totalOutputTokens += outputDelta;

                console.log(`ClaudioAI Tokens: +${effectiveInput} in (${cacheRead} cached), +${outputDelta} out | Total: ${this.totalInputTokens} in, ${this.totalOutputTokens} out`);

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
                return lastTextContent;
            }

            // In plan mode, just describe but don't execute
            if (this.mode.planMode) {
                return lastTextContent + '\n\n[Plan Mode: Tools not executed]';
            }

            // Execute tools
            const toolResults: any[] = [];
            for (const tool of toolCalls) {
                console.log(`ClaudioAI: Executing tool ${tool.name}`);

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
        // System prompt with cache control for efficiency
        const systemPrompt = [
            {
                type: "text",
                text: `You are ClaudioAI, a concise coding assistant with filesystem access.

RULES:
1. Use tools immediately when asked to do something
2. Be brief - summarize results in 1-2 sentences
3. Respond in the user's language

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
