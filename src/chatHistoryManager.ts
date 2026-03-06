import * as vscode from 'vscode';
import { Message } from './claudioClient';

export interface Chat {
    id: string;
    title: string;
    messages: Message[];
    createdAt: number;
    updatedAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}

export interface ChatHistoryData {
    chats: Chat[];
    activeChatId: string | null;
}

export class ChatHistoryManager {
    private static readonly STORAGE_KEY = 'claudioai.chatHistory';
    private context: vscode.ExtensionContext;
    private data: ChatHistoryData;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.data = this.loadData();
    }

    private loadData(): ChatHistoryData {
        const stored = this.context.globalState.get<ChatHistoryData>(ChatHistoryManager.STORAGE_KEY);
        if (stored) {
            return stored;
        }
        return { chats: [], activeChatId: null };
    }

    private async saveData(): Promise<void> {
        await this.context.globalState.update(ChatHistoryManager.STORAGE_KEY, this.data);
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
    }

    private generateTitle(messages: Message[]): string {
        if (messages.length === 0) {
            return 'New Chat';
        }
        const firstUserMessage = messages.find(m => m.role === 'user');
        if (firstUserMessage) {
            const content = typeof firstUserMessage.content === 'string'
                ? firstUserMessage.content
                : JSON.stringify(firstUserMessage.content);
            return content.substring(0, 50) + (content.length > 50 ? '...' : '');
        }
        return 'New Chat';
    }

    getAllChats(): Chat[] {
        return [...this.data.chats].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getActiveChat(): Chat | null {
        if (!this.data.activeChatId) {
            return null;
        }
        return this.data.chats.find(c => c.id === this.data.activeChatId) || null;
    }

    getActiveChatId(): string | null {
        return this.data.activeChatId;
    }

    async createChat(): Promise<Chat> {
        const chat: Chat = {
            id: this.generateId(),
            title: 'New Chat',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalInputTokens: 0,
            totalOutputTokens: 0
        };
        this.data.chats.push(chat);
        this.data.activeChatId = chat.id;
        await this.saveData();
        return chat;
    }

    async setActiveChat(chatId: string): Promise<Chat | null> {
        const chat = this.data.chats.find(c => c.id === chatId);
        if (chat) {
            this.data.activeChatId = chatId;
            await this.saveData();
            return chat;
        }
        return null;
    }

    async updateChatMessages(chatId: string, messages: Message[], tokens?: { input: number; output: number }): Promise<void> {
        const chat = this.data.chats.find(c => c.id === chatId);
        if (chat) {
            chat.messages = messages;
            chat.updatedAt = Date.now();
            chat.title = this.generateTitle(messages);
            if (tokens) {
                chat.totalInputTokens = tokens.input;
                chat.totalOutputTokens = tokens.output;
            }
            await this.saveData();
        }
    }

    async deleteChat(chatId: string): Promise<void> {
        const index = this.data.chats.findIndex(c => c.id === chatId);
        if (index !== -1) {
            this.data.chats.splice(index, 1);
            if (this.data.activeChatId === chatId) {
                this.data.activeChatId = this.data.chats.length > 0 ? this.data.chats[0].id : null;
            }
            await this.saveData();
        }
    }

    async renameChat(chatId: string, newTitle: string): Promise<void> {
        const chat = this.data.chats.find(c => c.id === chatId);
        if (chat) {
            chat.title = newTitle;
            await this.saveData();
        }
    }

    async clearAllChats(): Promise<void> {
        this.data = { chats: [], activeChatId: null };
        await this.saveData();
    }
}
