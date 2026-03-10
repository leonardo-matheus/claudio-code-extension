import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

export interface Message {
  role: 'user' | 'assistant';
  content: MessageContent;
}

export type MessageContent = string | ContentBlock[];

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  source?: { type: string; media_type: string; data: string };
  _inputJson?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[] };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  percentUsed: number;
}

interface ApiConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
  maxTokens: number;
}

const MAX_CONTEXT_TOKENS = 200000;

const TOOLS: ToolDefinition[] = [
  {
    name: 'Bash',
    description: 'Execute shell command. Server commands run in background automatically.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        workingDirectory: { type: 'string', description: 'Working directory (optional)' },
        background: { type: 'boolean', description: 'Force background execution' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read file contents',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        startLine: { type: 'number', description: 'Start line (optional)' },
        endLine: { type: 'number', description: 'End line (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    description: 'Create or overwrite a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Edit file by replacing text (oldText must be unique)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldText: { type: 'string', description: 'Text to replace' },
        newText: { type: 'string', description: 'New text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'ListDir',
    description: 'List files and folders',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
        recursive: { type: 'boolean', description: 'List recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Search',
    description: 'Search for pattern in files',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Directory (optional)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by glob pattern',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., **/*.ts)' },
      },
      required: ['pattern'],
    },
  },
];

export class ClaudioClient {
  private messages: Message[] = [];
  private currentTokens = { input: 0, output: 0 };
  private abortController: AbortController | null = null;
  private isProcessing = false;

  // Callbacks
  public onThinkingStart?: () => void;
  public onThinkingUpdate?: (text: string) => void;
  public onThinkingEnd?: () => void;
  public onTextStart?: () => void;
  public onTextDelta?: (delta: string) => void;
  public onTextEnd?: () => void;
  public onToolStart?: (name: string, input: any) => void;
  public onToolEnd?: (name: string, result: string, success: boolean) => void;
  public onTokenUpdate?: (usage: TokenUsage) => void;
  public onError?: (error: string) => void;

  private getConfig(): ApiConfig {
    const config = vscode.workspace.getConfiguration('claudioCode');
    return {
      apiKey: config.get<string>('apiKey') || '',
      apiUrl: config.get<string>('apiUrl') || 'https://claudioai.dev',
      model: config.get<string>('model') || 'claude-opus-4-5',
      maxTokens: config.get<number>('maxTokens') || 8192,
    };
  }

  getModel(): string {
    return this.getConfig().model;
  }

  clearHistory() {
    this.messages = [];
    this.currentTokens = { input: 0, output: 0 };
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]) {
    this.messages = [...messages];
  }

  getTokenUsage(): TokenUsage {
    return {
      inputTokens: this.currentTokens.input,
      outputTokens: this.currentTokens.output,
      totalTokens: this.currentTokens.input + this.currentTokens.output,
      percentUsed: Math.round((this.currentTokens.input / MAX_CONTEXT_TOKENS) * 100),
    };
  }

  setTokens(input: number, output: number) {
    this.currentTokens = { input, output };
  }

  abort(): boolean {
    if (this.abortController && this.isProcessing) {
      this.abortController.abort();
      this.isProcessing = false;
      return true;
    }
    return false;
  }

  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  private getSystemPrompt(): string {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return `You are Claudio Code, an advanced AI coding assistant.

## Tools Available
- **Bash**: Execute terminal commands
- **Read**: Read file contents
- **Write**: Create/overwrite files
- **Edit**: Edit files with search/replace
- **ListDir**: List directory contents
- **Search**: Search in files
- **Glob**: Find files by pattern

## Working Directory
${workspacePath}

## Guidelines
1. Be proactive - execute actions instead of asking
2. Read files before editing
3. Use streaming responses for large outputs
4. Be concise but thorough
5. Show your reasoning process
6. Respond in the user's language`;
  }

  async sendMessage(
    userMessage: string,
    images?: Array<{ data: string; type: string }>,
    toolExecutor?: { execute: (name: string, input: any) => Promise<string> }
  ): Promise<string> {
    const config = this.getConfig();

    if (!config.apiKey) {
      throw new Error('API Key not configured. Go to Settings > Claudio Code > API Key');
    }

    this.abortController = new AbortController();
    this.isProcessing = true;

    // Build user content
    const userContent = this.buildUserContent(userMessage, images);
    this.messages.push({ role: 'user', content: userContent });

    let iterations = 0;
    const maxIterations = 25;
    let finalText = '';

    while (iterations < maxIterations) {
      if (this.abortController?.signal.aborted) {
        this.isProcessing = false;
        return finalText || 'Stopped by user';
      }

      iterations++;

      try {
        const result = await this.streamRequest(config, toolExecutor);
        finalText = result.text;

        if (!result.hasToolCalls) {
          break;
        }
      } catch (err: any) {
        this.onError?.(err.message);
        this.isProcessing = false;
        throw err;
      }
    }

    this.isProcessing = false;
    return finalText;
  }

  private buildUserContent(message: string, images?: Array<{ data: string; type: string }>): MessageContent {
    if (!images?.length) return message;

    const blocks: ContentBlock[] = [];
    for (const img of images) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.type, data: img.data },
      });
    }
    blocks.push({ type: 'text', text: message });
    return blocks;
  }

  private async streamRequest(
    config: ApiConfig,
    toolExecutor?: { execute: (name: string, input: any) => Promise<string> }
  ): Promise<{ text: string; hasToolCalls: boolean }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        stream: true,
        system: this.getSystemPrompt(),
        tools: TOOLS,
        messages: this.messages,
      });

      const url = new URL(`${config.apiUrl}/v1/messages`);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, async (res) => {
        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const err = JSON.parse(data);
              reject(new Error(err.error?.message || `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            }
          });
          return;
        }

        let buffer = '';
        let currentText = '';
        let currentThinking = '';
        let toolCalls: ContentBlock[] = [];
        let assistantContent: ContentBlock[] = [];
        let inThinking = false;
        let inText = false;
        let streamedChars = 0;
        let lastTokenUpdate = 0;

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            // Skip event lines and empty lines
            if (line.startsWith('event:') || line.trim() === '') continue;
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]' || !data) continue;

            try {
              const event = JSON.parse(data);

              switch (event.type) {
                case 'content_block_start':
                  if (event.content_block?.type === 'thinking') {
                    inThinking = true;
                    this.onThinkingStart?.();
                  } else if (event.content_block?.type === 'text') {
                    inText = true;
                    this.onTextStart?.();
                  } else if (event.content_block?.type === 'tool_use') {
                    toolCalls.push({
                      type: 'tool_use',
                      id: event.content_block.id,
                      name: event.content_block.name,
                      input: {},
                    });
                  }
                  break;

                case 'message_start':
                  if (event.message?.usage?.input_tokens) {
                    this.currentTokens.input = event.message.usage.input_tokens;
                    this.onTokenUpdate?.(this.getTokenUsage());
                  }
                  break;

                case 'content_block_delta':
                  if (event.delta?.type === 'thinking_delta') {
                    currentThinking += event.delta.thinking;
                    streamedChars += event.delta.thinking?.length || 0;
                    this.onThinkingUpdate?.(event.delta.thinking);
                    // Throttle token updates (every 500ms)
                    const now = Date.now();
                    if (now - lastTokenUpdate > 500) {
                      this.currentTokens.output = Math.round(streamedChars / 4);
                      this.onTokenUpdate?.(this.getTokenUsage());
                      lastTokenUpdate = now;
                    }
                  } else if (event.delta?.type === 'text_delta') {
                    currentText += event.delta.text;
                    streamedChars += event.delta.text?.length || 0;
                    this.onTextDelta?.(event.delta.text);
                    // Throttle token updates (every 500ms)
                    const nowText = Date.now();
                    if (nowText - lastTokenUpdate > 500) {
                      this.currentTokens.output = Math.round(streamedChars / 4);
                      this.onTokenUpdate?.(this.getTokenUsage());
                      lastTokenUpdate = nowText;
                    }
                  } else if (event.delta?.type === 'input_json_delta' && toolCalls.length > 0) {
                    const lastTool = toolCalls[toolCalls.length - 1];
                    if (!lastTool._inputJson) lastTool._inputJson = '';
                    lastTool._inputJson += event.delta.partial_json;
                  }
                  break;

                case 'content_block_stop':
                  if (inThinking) {
                    inThinking = false;
                    this.onThinkingEnd?.();
                    if (currentThinking) {
                      assistantContent.push({ type: 'thinking', text: currentThinking });
                    }
                    currentThinking = '';
                  } else if (inText) {
                    inText = false;
                    this.onTextEnd?.();
                    if (currentText) {
                      assistantContent.push({ type: 'text', text: currentText });
                    }
                  } else if (toolCalls.length > 0) {
                    const lastTool = toolCalls[toolCalls.length - 1];
                    if (lastTool._inputJson) {
                      try {
                        lastTool.input = JSON.parse(lastTool._inputJson);
                      } catch {}
                      delete lastTool._inputJson;
                    }
                    assistantContent.push(lastTool);
                  }
                  break;

                case 'message_delta':
                  if (event.usage) {
                    this.currentTokens.input = event.usage.input_tokens || this.currentTokens.input;
                    this.currentTokens.output = event.usage.output_tokens || this.currentTokens.output;
                    this.onTokenUpdate?.(this.getTokenUsage());
                  }
                  break;

                case 'message_stop':
                  // Process complete
                  break;
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        });

        res.on('end', async () => {
          // Add assistant message
          if (assistantContent.length > 0) {
            this.messages.push({ role: 'assistant', content: assistantContent });
          }

          // Execute tools if any
          if (toolCalls.length > 0 && toolExecutor) {
            const toolResults: ContentBlock[] = [];

            for (const tool of toolCalls) {
              this.onToolStart?.(tool.name!, tool.input);

              try {
                const result = await toolExecutor.execute(tool.name!, tool.input);
                this.onToolEnd?.(tool.name!, result, true);
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tool.id,
                  content: result.length > 10000 ? result.substring(0, 10000) + '\n...(truncated)' : result,
                });
              } catch (error: any) {
                this.onToolEnd?.(tool.name!, error.message, false);
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tool.id,
                  content: `Error: ${error.message}`,
                  is_error: true,
                });
              }
            }

            this.messages.push({ role: 'user', content: toolResults });
            resolve({ text: currentText, hasToolCalls: true });
          } else {
            resolve({ text: currentText, hasToolCalls: false });
          }
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }
}
