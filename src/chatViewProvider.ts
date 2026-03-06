import * as vscode from 'vscode';
import { ClaudioClient, AgentMode, TokenUsage, Message } from './claudioClient';

interface ChatHistory {
    id: string;
    title: string;
    messages: Message[];
    inputTokens: number;
    outputTokens: number;
    updatedAt: number;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claudioai.chatView';
    private _view?: vscode.WebviewView;
    private _client: ClaudioClient;
    private _context: vscode.ExtensionContext;
    private _currentChatId: string | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        client: ClaudioClient,
        context: vscode.ExtensionContext
    ) {
        this._client = client;
        this._context = context;
    }

    // Chat History Management
    private getChats(): ChatHistory[] {
        return this._context.globalState.get<ChatHistory[]>('claudioai.chats', []);
    }

    private async saveChats(chats: ChatHistory[]): Promise<void> {
        await this._context.globalState.update('claudioai.chats', chats);
    }

    private async saveCurrentChat(): Promise<void> {
        if (!this._currentChatId) return;

        const chats = this.getChats();
        const messages = this._client.getMessages();
        const tokens = this._client.getTokenUsage();

        const idx = chats.findIndex(c => c.id === this._currentChatId);
        const title = this.generateTitle(messages);

        const chatData: ChatHistory = {
            id: this._currentChatId,
            title,
            messages,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            updatedAt: Date.now()
        };

        if (idx >= 0) {
            chats[idx] = chatData;
        } else {
            chats.unshift(chatData);
        }

        // Keep only last 50 chats
        if (chats.length > 50) {
            chats.splice(50);
        }

        await this.saveChats(chats);
        this.sendChatList();
    }

    private generateTitle(messages: Message[]): string {
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg) {
            const content = typeof firstUserMsg.content === 'string'
                ? firstUserMsg.content
                : JSON.stringify(firstUserMsg.content);
            return content.substring(0, 40) + (content.length > 40 ? '...' : '');
        }
        return 'New Chat';
    }

    private async loadChat(chatId: string): Promise<void> {
        const chats = this.getChats();
        const chat = chats.find(c => c.id === chatId);

        if (chat) {
            this._currentChatId = chatId;
            this._client.setMessages(chat.messages);
            this._client.setTokens(chat.inputTokens, chat.outputTokens);

            // Send chat to webview
            this._view?.webview.postMessage({
                type: 'loadChat',
                messages: chat.messages,
                tokens: this._client.getTokenUsage()
            });
        }
    }

    private async deleteChat(chatId: string): Promise<void> {
        const chats = this.getChats().filter(c => c.id !== chatId);
        await this.saveChats(chats);

        if (this._currentChatId === chatId) {
            this._currentChatId = null;
            this._client.clearHistory();
            this._view?.webview.postMessage({ type: 'clearChat' });
        }

        this.sendChatList();
    }

    private sendChatList(): void {
        const chats = this.getChats();
        this._view?.webview.postMessage({
            type: 'chatList',
            chats: chats.map(c => ({
                id: c.id,
                title: c.title,
                updatedAt: c.updatedAt
            })),
            currentChatId: this._currentChatId
        });
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleMessage(data.message);
                    break;
                case 'newChat':
                    this._currentChatId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
                    this._client.clearHistory();
                    this._view?.webview.postMessage({ type: 'clearChat' });
                    this._view?.webview.postMessage({ type: 'tokenUpdate', tokens: this._client.getTokenUsage() });
                    this.sendChatList();
                    break;
                case 'setMode':
                    this._client.setMode(data.mode);
                    break;
                case 'ready':
                    this._client.setMode({ autoEdit: true, planMode: false, bypass: false });
                    this.sendChatList();
                    this._view?.webview.postMessage({ type: 'tokenUpdate', tokens: this._client.getTokenUsage() });
                    break;
                case 'loadChat':
                    await this.loadChat(data.chatId);
                    break;
                case 'deleteChat':
                    await this.deleteChat(data.chatId);
                    break;
                case 'getChats':
                    this.sendChatList();
                    break;
                case 'compactChat':
                    this._view?.webview.postMessage({ type: 'compactStart' });
                    const result = await this._client.forceCompact((status) => {
                        this._view?.webview.postMessage({ type: 'compactProgress', status });
                    });
                    this._view?.webview.postMessage({ type: 'tokenUpdate', tokens: this._client.getTokenUsage() });
                    this._view?.webview.postMessage({
                        type: 'compactResult',
                        success: result.success,
                        message: result.message,
                        summary: result.summary
                    });
                    if (result.success) {
                        await this.saveCurrentChat();
                    }
                    break;
            }
        });
    }

    public async newChat() {
        this._currentChatId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
        this._client.clearHistory();
        this._view?.webview.postMessage({ type: 'clearChat' });
        this._view?.webview.postMessage({ type: 'tokenUpdate', tokens: this._client.getTokenUsage() });
        this.sendChatList();
    }

    private async _handleMessage(message: string) {
        if (!this._view) return;

        // Create chat ID if needed
        if (!this._currentChatId) {
            this._currentChatId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
        }

        this._view.webview.postMessage({ type: 'userMessage', content: message });
        this._view.webview.postMessage({ type: 'thinking', show: true });

        // Setup callbacks
        this._client.onToolStart = (name, params) => {
            this._view?.webview.postMessage({
                type: 'toolStart',
                name,
                params: JSON.stringify(params, null, 2)
            });
        };

        this._client.onToolEnd = (name, result, success) => {
            this._view?.webview.postMessage({
                type: 'toolEnd',
                name,
                result,
                success
            });
        };

        this._client.onText = (text) => {
            this._view?.webview.postMessage({ type: 'streamText', text });
        };

        this._client.onTokenUpdate = (usage: TokenUsage) => {
            this._view?.webview.postMessage({ type: 'tokenUpdate', tokens: usage });
        };

        this._client.onAskPermission = async (action, details) => {
            return true; // Auto-approve for now
        };

        try {
            const response = await this._client.sendMessage(message);
            this._view.webview.postMessage({ type: 'thinking', show: false });
            this._view.webview.postMessage({ type: 'assistantMessage', content: response });
            this._view.webview.postMessage({ type: 'tokenUpdate', tokens: this._client.getTokenUsage() });

            // Save chat after each message
            await this.saveCurrentChat();
        } catch (error) {
            this._view.webview.postMessage({ type: 'thinking', show: false });
            this._view.webview.postMessage({
                type: 'error',
                content: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --glow-color: #6366f1;
            --glow-secondary: #8b5cf6;
            --accent-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
            --dark-bg: #0a0a0f;
            --card-bg: #12121a;
            --border-color: rgba(99, 102, 241, 0.2);
            --text-primary: #f1f5f9;
            --text-secondary: #94a3b8;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--dark-bg);
            color: var(--text-primary);
            height: 100vh;
            display: flex;
            flex-direction: column;
            font-size: 13px;
            overflow: hidden;
        }

        /* Header */
        .header {
            padding: 12px 16px;
            background: linear-gradient(180deg, rgba(99, 102, 241, 0.1) 0%, transparent 100%);
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 10px;
            cursor: pointer;
            flex: 1;
        }

        .logo-icon {
            width: 32px;
            height: 32px;
            background: var(--accent-gradient);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            box-shadow: 0 0 20px rgba(99, 102, 241, 0.4);
        }

        .logo-text {
            font-size: 16px;
            font-weight: 700;
            background: var(--accent-gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        .btn {
            padding: 8px 14px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .btn-ghost {
            background: transparent;
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
        }

        .btn-ghost:hover {
            background: rgba(99, 102, 241, 0.1);
            color: var(--text-primary);
            border-color: var(--glow-color);
        }

        .btn-ghost:disabled {
            opacity: 0.5;
            cursor: wait;
        }

        .btn-primary {
            background: var(--accent-gradient);
            color: white;
            box-shadow: 0 0 20px rgba(99, 102, 241, 0.3);
        }

        .btn-primary:hover {
            box-shadow: 0 0 30px rgba(99, 102, 241, 0.5);
            transform: translateY(-1px);
        }

        /* Token display */
        .token-display {
            padding: 10px 16px;
            background: var(--card-bg);
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .token-stat {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: var(--text-secondary);
        }

        .token-stat .icon {
            font-size: 10px;
            opacity: 0.7;
        }

        .token-stat .value {
            font-weight: 600;
            color: var(--text-primary);
            font-family: 'SF Mono', Monaco, monospace;
        }

        .token-bar-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .token-bar {
            flex: 1;
            height: 6px;
            background: rgba(99, 102, 241, 0.1);
            border-radius: 3px;
            overflow: hidden;
        }

        .token-fill {
            height: 100%;
            background: var(--accent-gradient);
            border-radius: 3px;
            transition: width 0.4s ease;
            box-shadow: 0 0 10px rgba(99, 102, 241, 0.5);
        }

        .token-fill.warning {
            background: linear-gradient(90deg, #f59e0b, #fbbf24);
            box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
        }

        .token-fill.danger {
            background: linear-gradient(90deg, #ef4444, #f87171);
            box-shadow: 0 0 10px rgba(239, 68, 68, 0.5);
        }

        .token-percent {
            font-size: 11px;
            font-weight: 600;
            color: var(--glow-color);
            min-width: 36px;
            text-align: right;
        }

        .compact-btn {
            background: transparent;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 4px 8px;
            font-size: 12px;
            transition: all 0.2s;
        }

        .compact-btn:hover {
            background: rgba(99, 102, 241, 0.1);
            border-color: var(--glow-color);
            color: var(--text-primary);
        }

        /* Sidebar */
        .sidebar {
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            width: 280px;
            background: var(--card-bg);
            border-right: 1px solid var(--border-color);
            transform: translateX(-100%);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 100;
            display: flex;
            flex-direction: column;
            box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
        }

        .sidebar.visible { transform: translateX(0); }

        .sidebar-header {
            padding: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(180deg, rgba(99, 102, 241, 0.05) 0%, transparent 100%);
        }

        .sidebar-header h2 {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .chat-list {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }

        .chat-item {
            padding: 12px 14px;
            border-radius: 10px;
            cursor: pointer;
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 13px;
            transition: all 0.2s;
            border: 1px solid transparent;
        }

        .chat-item:hover {
            background: rgba(99, 102, 241, 0.1);
            border-color: var(--border-color);
        }

        .chat-item.active {
            background: rgba(99, 102, 241, 0.15);
            border-color: var(--glow-color);
            box-shadow: 0 0 15px rgba(99, 102, 241, 0.2);
        }

        .chat-item-title {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text-secondary);
        }

        .chat-item.active .chat-item-title { color: var(--text-primary); }

        .chat-item-delete {
            opacity: 0;
            padding: 4px 8px;
            font-size: 11px;
            background: transparent;
            border: none;
            color: #ef4444;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        .chat-item:hover .chat-item-delete { opacity: 1; }

        /* Main chat container with glow */
        .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            margin: 12px;
            border-radius: 16px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            overflow: hidden;
            position: relative;
            box-shadow:
                0 0 0 1px rgba(99, 102, 241, 0.1),
                0 0 40px rgba(99, 102, 241, 0.15),
                0 0 80px rgba(139, 92, 246, 0.1),
                inset 0 0 60px rgba(99, 102, 241, 0.03);
        }

        .chat-container::before {
            content: '';
            position: absolute;
            top: -2px;
            left: -2px;
            right: -2px;
            bottom: -2px;
            background: var(--accent-gradient);
            border-radius: 18px;
            z-index: -1;
            opacity: 0.15;
            filter: blur(8px);
        }

        /* Chat area */
        .chat {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            scroll-behavior: smooth;
        }

        .chat::-webkit-scrollbar { width: 6px; }
        .chat::-webkit-scrollbar-track { background: transparent; }
        .chat::-webkit-scrollbar-thumb {
            background: rgba(99, 102, 241, 0.3);
            border-radius: 3px;
        }
        .chat::-webkit-scrollbar-thumb:hover { background: rgba(99, 102, 241, 0.5); }

        .message {
            margin-bottom: 16px;
            animation: messageIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes messageIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message-header {
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .message-header.user { color: #60a5fa; }
        .message-header.assistant { color: #a78bfa; }
        .message-header.error { color: #f87171; }

        .message-content {
            padding: 14px 16px;
            border-radius: 12px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .message.user .message-content {
            background: linear-gradient(135deg, rgba(96, 165, 250, 0.1) 0%, rgba(96, 165, 250, 0.05) 100%);
            border: 1px solid rgba(96, 165, 250, 0.2);
        }

        .message.assistant .message-content {
            background: linear-gradient(135deg, rgba(167, 139, 250, 0.1) 0%, rgba(167, 139, 250, 0.05) 100%);
            border: 1px solid rgba(167, 139, 250, 0.2);
        }

        .message.error .message-content {
            background: linear-gradient(135deg, rgba(248, 113, 113, 0.1) 0%, rgba(248, 113, 113, 0.05) 100%);
            border: 1px solid rgba(248, 113, 113, 0.2);
        }

        /* Tool execution */
        .tool-block {
            margin: 12px 0;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid rgba(34, 197, 94, 0.2);
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.05) 0%, transparent 100%);
        }

        .tool-header {
            padding: 10px 14px;
            background: rgba(34, 197, 94, 0.1);
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 12px;
            border-bottom: 1px solid rgba(34, 197, 94, 0.15);
        }

        .tool-icon {
            width: 20px;
            text-align: center;
            font-size: 14px;
        }

        .tool-name {
            font-weight: 600;
            color: #4ade80;
            font-family: 'SF Mono', Monaco, monospace;
        }

        .tool-status {
            margin-left: auto;
            font-size: 11px;
            font-weight: 500;
            padding: 2px 8px;
            border-radius: 4px;
        }

        .tool-status.running {
            color: #fbbf24;
            background: rgba(251, 191, 36, 0.15);
        }

        .tool-status.success {
            color: #4ade80;
            background: rgba(74, 222, 128, 0.15);
        }

        .tool-status.error {
            color: #f87171;
            background: rgba(248, 113, 113, 0.15);
        }

        .tool-params {
            padding: 12px 14px;
            background: rgba(0, 0, 0, 0.3);
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 11px;
            line-height: 1.6;
            overflow-x: auto;
        }

        .tool-params pre { margin: 0; white-space: pre-wrap; word-break: break-word; }

        .json-key { color: #4ade80; }
        .json-string { color: #67e8f9; }
        .json-number { color: #fbbf24; }
        .json-boolean { color: #f472b6; }
        .json-null { color: #f472b6; }
        .json-bracket { color: #6b7280; }

        .tool-result {
            padding: 12px 14px;
            background: rgba(0, 0, 0, 0.2);
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px;
            line-height: 1.5;
            color: #d1d5db;
            max-height: 300px;
            overflow-y: auto;
            border-top: 1px solid rgba(34, 197, 94, 0.1);
            white-space: pre-wrap;
        }

        .terminal-dots { display: flex; gap: 6px; margin-right: 8px; }
        .terminal-dot { width: 10px; height: 10px; border-radius: 50%; }
        .terminal-dot.red { background: #ff5f56; box-shadow: 0 0 6px rgba(255, 95, 86, 0.5); }
        .terminal-dot.yellow { background: #ffbd2e; box-shadow: 0 0 6px rgba(255, 189, 46, 0.5); }
        .terminal-dot.green { background: #27c93f; box-shadow: 0 0 6px rgba(39, 201, 63, 0.5); }

        /* Thinking indicator */
        .thinking {
            padding: 16px;
            display: none;
            align-items: center;
            gap: 12px;
            color: var(--text-secondary);
        }

        .thinking.visible { display: flex; }

        .thinking-dots { display: flex; gap: 6px; }

        .thinking-dot {
            width: 8px;
            height: 8px;
            background: var(--glow-color);
            border-radius: 50%;
            animation: pulse 1.4s infinite;
            box-shadow: 0 0 10px rgba(99, 102, 241, 0.5);
        }

        .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
        .thinking-dot:nth-child(3) { animation-delay: 0.4s; }

        @keyframes pulse {
            0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
            40% { transform: scale(1); opacity: 1; }
        }

        /* Bottom section with glow */
        .bottom-section {
            margin: 0 12px 12px;
            border-radius: 16px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            overflow: hidden;
            box-shadow:
                0 0 40px rgba(99, 102, 241, 0.1),
                inset 0 0 30px rgba(99, 102, 241, 0.02);
        }

        /* Mode toggles */
        .modes {
            display: flex;
            gap: 8px;
            padding: 12px 14px;
            border-bottom: 1px solid var(--border-color);
            justify-content: center;
        }

        .mode-btn {
            padding: 8px 16px;
            border: 1px solid var(--border-color);
            border-radius: 20px;
            background: transparent;
            color: var(--text-secondary);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .mode-btn:hover {
            background: rgba(99, 102, 241, 0.1);
            border-color: var(--glow-color);
            color: var(--text-primary);
        }

        .mode-btn.active {
            background: var(--accent-gradient);
            color: white;
            border-color: transparent;
            box-shadow: 0 0 20px rgba(99, 102, 241, 0.4);
        }

        .mode-btn.bypass.active {
            background: linear-gradient(135deg, #ef4444, #f87171);
            box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);
        }

        /* Input area */
        .input-area {
            padding: 14px;
        }

        .input-wrapper {
            display: flex;
            gap: 10px;
            align-items: flex-end;
        }

        textarea {
            flex: 1;
            padding: 12px 16px;
            background: rgba(0, 0, 0, 0.3);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            resize: none;
            font-family: inherit;
            font-size: 13px;
            line-height: 1.5;
            min-height: 44px;
            max-height: 120px;
            transition: all 0.2s;
        }

        textarea:focus {
            outline: none;
            border-color: var(--glow-color);
            box-shadow: 0 0 20px rgba(99, 102, 241, 0.2);
        }

        textarea::placeholder { color: var(--text-secondary); }

        .send-btn {
            padding: 12px 20px;
            background: var(--accent-gradient);
            color: white;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            transition: all 0.2s;
            box-shadow: 0 0 20px rgba(99, 102, 241, 0.3);
        }

        .send-btn:hover {
            box-shadow: 0 0 30px rgba(99, 102, 241, 0.5);
            transform: translateY(-1px);
        }

        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        code {
            background: rgba(99, 102, 241, 0.15);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 12px;
            color: #a78bfa;
        }

        pre {
            background: rgba(0, 0, 0, 0.4);
            padding: 14px;
            border-radius: 10px;
            overflow-x: auto;
            margin: 10px 0;
            border: 1px solid var(--border-color);
        }

        pre code { padding: 0; background: transparent; color: var(--text-primary); }

        /* Compact Modal */
        .compact-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(4px);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            animation: fadeIn 0.2s ease;
        }

        .compact-overlay.visible { display: flex; }

        .compact-modal {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 24px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 0 60px rgba(99, 102, 241, 0.3);
            animation: scaleIn 0.3s ease;
        }

        @keyframes scaleIn {
            from { transform: scale(0.9); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .compact-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 20px;
        }

        .compact-icon {
            width: 48px;
            height: 48px;
            background: var(--accent-gradient);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            animation: pulse 2s infinite;
        }

        .compact-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .compact-status {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        .compact-progress {
            height: 4px;
            background: rgba(99, 102, 241, 0.2);
            border-radius: 2px;
            overflow: hidden;
            margin: 16px 0;
        }

        .compact-progress-bar {
            height: 100%;
            background: var(--accent-gradient);
            border-radius: 2px;
            animation: progress 2s ease-in-out infinite;
        }

        @keyframes progress {
            0% { width: 0%; margin-left: 0%; }
            50% { width: 60%; margin-left: 20%; }
            100% { width: 0%; margin-left: 100%; }
        }

        .compact-dots {
            display: flex;
            gap: 6px;
            justify-content: center;
            margin: 16px 0;
        }

        .compact-dot {
            width: 8px;
            height: 8px;
            background: var(--glow-color);
            border-radius: 50%;
            animation: bounce 1.4s ease-in-out infinite;
        }

        .compact-dot:nth-child(2) { animation-delay: 0.2s; }
        .compact-dot:nth-child(3) { animation-delay: 0.4s; }

        @keyframes bounce {
            0%, 80%, 100% { transform: translateY(0); }
            40% { transform: translateY(-10px); }
        }

        /* Summary Card */
        .summary-card {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.05) 100%);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 12px;
            padding: 16px;
            margin: 12px 0;
            animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
            from { transform: translateY(-10px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        .summary-header {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 600;
            color: var(--glow-color);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
        }

        .summary-content {
            font-size: 13px;
            line-height: 1.6;
            color: var(--text-secondary);
            white-space: pre-wrap;
        }

        .summary-stats {
            display: flex;
            gap: 16px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
            font-size: 11px;
            color: var(--text-secondary);
        }

        .summary-stat {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .summary-stat .value {
            color: #22c55e;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <h2>Chat History</h2>
            <button class="btn btn-ghost" id="closeSidebarBtn">✕</button>
        </div>
        <div class="chat-list" id="chatList"></div>
    </div>

    <div class="header">
        <div class="logo" id="menuBtn">
            <div class="logo-icon">⚡</div>
            <span class="logo-text">ClaudioAI</span>
        </div>
        <div class="header-actions">
            <button class="btn btn-ghost" id="compactBtn" title="Compact history">🗜️</button>
            <button class="btn btn-primary" id="newChatBtn">+ New Chat</button>
        </div>
    </div>

    <div class="token-display">
        <div class="token-stat">
            <span class="icon">↓</span>
            <span class="value" id="tokenInput">0</span>
            <span>in</span>
        </div>
        <div class="token-stat">
            <span class="icon">↑</span>
            <span class="value" id="tokenOutput">0</span>
            <span>out</span>
        </div>
        <div class="token-bar-wrapper">
            <div class="token-bar">
                <div class="token-fill" id="tokenFill" style="width: 0%"></div>
            </div>
            <span class="token-percent" id="tokenPercent">0%</span>
        </div>
    </div>

    <div class="chat-container">
        <div class="chat" id="chat"></div>
        <div class="thinking" id="thinking">
            <div class="thinking-dots">
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
            </div>
            <span>Thinking...</span>
        </div>
    </div>

    <div class="compact-overlay" id="compactOverlay">
        <div class="compact-modal">
            <div class="compact-header">
                <div class="compact-icon">🗜️</div>
                <div>
                    <div class="compact-title">Compacting Chat</div>
                    <div class="compact-status" id="compactStatus">Initializing...</div>
                </div>
            </div>
            <div class="compact-progress">
                <div class="compact-progress-bar"></div>
            </div>
            <div class="compact-dots">
                <div class="compact-dot"></div>
                <div class="compact-dot"></div>
                <div class="compact-dot"></div>
            </div>
        </div>
    </div>

    <div class="bottom-section">
        <div class="modes">
            <button class="mode-btn active" id="autoEditBtn" data-mode="autoEdit">Auto Edit</button>
            <button class="mode-btn" id="planModeBtn" data-mode="planMode">Plan Mode</button>
            <button class="mode-btn bypass" id="bypassBtn" data-mode="bypass">Bypass</button>
        </div>
        <div class="input-area">
            <div class="input-wrapper">
                <textarea id="input" placeholder="Ask ClaudioAI anything..." rows="1"></textarea>
                <button class="send-btn" id="sendBtn">Send</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('sendBtn');
        const thinking = document.getElementById('thinking');
        const newChatBtn = document.getElementById('newChatBtn');
        const menuBtn = document.getElementById('menuBtn');
        const sidebar = document.getElementById('sidebar');
        const closeSidebarBtn = document.getElementById('closeSidebarBtn');
        const chatList = document.getElementById('chatList');
        const tokenInput = document.getElementById('tokenInput');
        const tokenOutput = document.getElementById('tokenOutput');
        const tokenFill = document.getElementById('tokenFill');
        const tokenPercent = document.getElementById('tokenPercent');

        let currentToolBlock = null;
        let busy = false;

        const modes = { autoEdit: true, planMode: false, bypass: false };

        // Sidebar toggle
        menuBtn.addEventListener('click', () => sidebar.classList.add('visible'));
        closeSidebarBtn.addEventListener('click', () => sidebar.classList.remove('visible'));

        // Mode buttons
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === 'bypass' && !modes.bypass && !confirm('Bypass mode will auto-approve all actions. Continue?')) return;

                modes[mode] = !modes[mode];
                btn.classList.toggle('active', modes[mode]);

                if (mode === 'planMode' && modes.planMode) {
                    modes.autoEdit = false;
                    document.getElementById('autoEditBtn').classList.remove('active');
                } else if (mode === 'autoEdit' && modes.autoEdit) {
                    modes.planMode = false;
                    document.getElementById('planModeBtn').classList.remove('active');
                }

                vscode.postMessage({ type: 'setMode', mode: modes });
            });
        });

        // Auto-resize textarea
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 150) + 'px';
        });

        // Send message
        function send() {
            const msg = input.value.trim();
            if (!msg || busy) return;
            busy = true;
            sendBtn.disabled = true;
            vscode.postMessage({ type: 'sendMessage', message: msg });
            input.value = '';
            input.style.height = 'auto';
        }

        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        });

        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'newChat' });
            sidebar.classList.remove('visible');
        });

        const compactBtn = document.getElementById('compactBtn');
        const compactOverlay = document.getElementById('compactOverlay');
        const compactStatus = document.getElementById('compactStatus');

        compactBtn?.addEventListener('click', () => {
            compactBtn.disabled = true;
            vscode.postMessage({ type: 'compactChat' });
        });

        function esc(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        function highlightJson(jsonStr) {
            try {
                const obj = JSON.parse(jsonStr);
                return formatJsonValue(obj, 0);
            } catch { return esc(jsonStr); }
        }

        function formatJsonValue(value, indent) {
            const spaces = '  '.repeat(indent);
            const nextSpaces = '  '.repeat(indent + 1);

            if (value === null) return '<span class="json-null">null</span>';
            if (typeof value === 'boolean') return '<span class="json-boolean">' + value + '</span>';
            if (typeof value === 'number') return '<span class="json-number">' + value + '</span>';
            if (typeof value === 'string') {
                let displayStr = value.length > 500 ? value.substring(0, 500) + '...' : value;
                displayStr = esc(displayStr).replace(/\\n/g, '<br>' + nextSpaces);
                return '<span class="json-string">"' + displayStr + '"</span>';
            }
            if (Array.isArray(value)) {
                if (value.length === 0) return '<span class="json-bracket">[]</span>';
                let result = '<span class="json-bracket">[</span>\\n';
                value.forEach((item, i) => {
                    result += nextSpaces + formatJsonValue(item, indent + 1);
                    if (i < value.length - 1) result += ',';
                    result += '\\n';
                });
                return result + spaces + '<span class="json-bracket">]</span>';
            }
            if (typeof value === 'object') {
                const keys = Object.keys(value);
                if (keys.length === 0) return '<span class="json-bracket">{}</span>';
                let result = '<span class="json-bracket">{</span>\\n';
                keys.forEach((key, i) => {
                    result += nextSpaces + '<span class="json-key">"' + esc(key) + '"</span>: ';
                    result += formatJsonValue(value[key], indent + 1);
                    if (i < keys.length - 1) result += ',';
                    result += '\\n';
                });
                return result + spaces + '<span class="json-bracket">}</span>';
            }
            return esc(String(value));
        }

        function formatContent(text) {
            let html = esc(text);
            html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
            html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            return html;
        }

        function addMessage(role, content) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            const icon = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '⚠️';
            const label = role === 'user' ? 'You' : role === 'assistant' ? 'ClaudioAI' : 'Error';
            div.innerHTML = '<div class="message-header ' + role + '">' + icon + ' ' + label + '</div>' +
                '<div class="message-content">' + formatContent(content) + '</div>';
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        }

        function addToolStart(name, params) {
            const isTerminal = name === 'run_command';
            currentToolBlock = document.createElement('div');
            currentToolBlock.className = 'tool-block';

            const icons = { list_files: '📁', read_file: '📖', write_file: '📝', edit_file: '✏️', run_command: '💻', search_files: '🔍' };
            let headerContent = isTerminal ? '<div class="terminal-dots"><div class="terminal-dot red"></div><div class="terminal-dot yellow"></div><div class="terminal-dot green"></div></div>' : '';

            currentToolBlock.innerHTML =
                '<div class="tool-header">' + headerContent +
                '<span class="tool-icon">' + (icons[name] || '🔧') + '</span>' +
                '<span class="tool-name">' + esc(name) + '</span>' +
                '<span class="tool-status running">Running...</span></div>' +
                '<div class="tool-params"><pre>' + highlightJson(params) + '</pre></div>' +
                '<div class="tool-result">Executing...</div>';

            chat.appendChild(currentToolBlock);
            chat.scrollTop = chat.scrollHeight;
        }

        function addToolEnd(name, result, success) {
            if (currentToolBlock) {
                currentToolBlock.querySelector('.tool-status').className = 'tool-status ' + (success ? 'success' : 'error');
                currentToolBlock.querySelector('.tool-status').textContent = success ? '✓ Done' : '✗ Failed';
                currentToolBlock.querySelector('.tool-result').textContent = result;
                currentToolBlock = null;
            }
            chat.scrollTop = chat.scrollHeight;
        }

        function updateTokens(tokens) {
            const inp = tokens.inputTokens || 0;
            const out = tokens.outputTokens || 0;
            const percent = tokens.percentUsed || 0;

            tokenInput.textContent = formatTokens(inp);
            tokenInput.title = inp.toLocaleString() + ' input tokens';
            tokenOutput.textContent = formatTokens(out);
            tokenOutput.title = out.toLocaleString() + ' output tokens';
            tokenPercent.textContent = percent + '%';
            tokenFill.style.width = percent + '%';

            tokenFill.classList.remove('warning', 'danger');
            if (percent >= 90) tokenFill.classList.add('danger');
            else if (percent >= 70) tokenFill.classList.add('warning');
        }

        function formatTokens(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toString();
        }

        function renderChatList(chats, currentChatId) {
            chatList.innerHTML = chats.map(c => {
                const isActive = c.id === currentChatId ? ' active' : '';
                const date = new Date(c.updatedAt).toLocaleDateString();
                return '<div class="chat-item' + isActive + '" data-id="' + c.id + '">' +
                    '<span class="chat-item-title">' + esc(c.title) + '</span>' +
                    '<button class="chat-item-delete" data-id="' + c.id + '">🗑️</button></div>';
            }).join('');

            chatList.querySelectorAll('.chat-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.classList.contains('chat-item-delete')) return;
                    vscode.postMessage({ type: 'loadChat', chatId: item.dataset.id });
                    sidebar.classList.remove('visible');
                });
            });

            chatList.querySelectorAll('.chat-item-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('Delete this chat?')) {
                        vscode.postMessage({ type: 'deleteChat', chatId: btn.dataset.id });
                    }
                });
            });
        }

        window.addEventListener('message', e => {
            const msg = e.data;
            switch (msg.type) {
                case 'userMessage': addMessage('user', msg.content); break;
                case 'assistantMessage': addMessage('assistant', msg.content); busy = false; sendBtn.disabled = false; break;
                case 'error': addMessage('error', msg.content); busy = false; sendBtn.disabled = false; break;
                case 'toolStart': addToolStart(msg.name, msg.params); break;
                case 'toolEnd': addToolEnd(msg.name, msg.result, msg.success); break;
                case 'thinking': thinking.classList.toggle('visible', msg.show); break;
                case 'clearChat': chat.innerHTML = ''; busy = false; sendBtn.disabled = false; break;
                case 'tokenUpdate': updateTokens(msg.tokens); break;
                case 'chatList': renderChatList(msg.chats, msg.currentChatId); break;
                case 'loadChat':
                    chat.innerHTML = '';
                    msg.messages.forEach(m => {
                        if (m.role === 'user' && typeof m.content === 'string') addMessage('user', m.content);
                        else if (m.role === 'assistant' && Array.isArray(m.content)) {
                            m.content.forEach(b => { if (b.type === 'text') addMessage('assistant', b.text); });
                        }
                    });
                    updateTokens(msg.tokens);
                    break;
                case 'compactStart':
                    compactOverlay.classList.add('visible');
                    compactStatus.textContent = 'Initializing...';
                    break;

                case 'compactProgress':
                    compactStatus.textContent = msg.status;
                    break;

                case 'compactResult':
                    compactOverlay.classList.remove('visible');
                    compactBtn.disabled = false;

                    if (msg.success) {
                        // Show summary card
                        const summaryHtml =
                            '<div class="summary-card">' +
                            '<div class="summary-header">📋 Conversation Summary</div>' +
                            '<div class="summary-content">' + esc(msg.summary || '') + '</div>' +
                            '<div class="summary-stats">' +
                            '<div class="summary-stat"><span class="value">✓</span> ' + msg.message + '</div>' +
                            '</div></div>';

                        const div = document.createElement('div');
                        div.className = 'message assistant';
                        div.innerHTML = '<div class="message-header assistant">🗜️ COMPACTED</div>' + summaryHtml;
                        chat.appendChild(div);
                        chat.scrollTop = chat.scrollHeight;

                        // Flash token bar
                        tokenFill.style.transition = 'none';
                        tokenFill.style.background = '#22c55e';
                        setTimeout(() => {
                            tokenFill.style.transition = 'all 0.5s ease';
                            tokenFill.style.background = '';
                        }, 300);
                    } else {
                        addMessage('error', '⚠️ ' + msg.message);
                    }
                    break;
            }
        });

        input.focus();
        vscode.postMessage({ type: 'ready' });
        vscode.postMessage({ type: 'setMode', mode: modes });
    </script>
</body>
</html>`;
    }
}
