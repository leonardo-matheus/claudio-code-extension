import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Message, TokenUsage } from '../client/claudioClient';

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  inputTokens: number;
  outputTokens: number;
}

export class ChatHistoryManager {
  private storageDir: string;
  private conversationsFile: string;
  private conversations: SavedConversation[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.storageDir = context.globalStorageUri.fsPath;
    this.conversationsFile = path.join(this.storageDir, 'conversations.json');
    this.ensureStorage();
    this.load();
  }

  private ensureStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private load() {
    try {
      if (fs.existsSync(this.conversationsFile)) {
        this.conversations = JSON.parse(fs.readFileSync(this.conversationsFile, 'utf-8'));
      }
    } catch {
      this.conversations = [];
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.conversationsFile, JSON.stringify(this.conversations, null, 2));
    } catch {}
  }

  getConversations(): SavedConversation[] {
    return [...this.conversations].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  getConversation(id: string): SavedConversation | undefined {
    return this.conversations.find(c => c.id === id);
  }

  createConversation(firstMessage?: string): SavedConversation {
    const now = new Date().toISOString();
    const conv: SavedConversation = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      title: firstMessage?.substring(0, 40) || 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    this.conversations.unshift(conv);
    this.save();
    return conv;
  }

  updateConversation(id: string, messages: Message[], tokens: TokenUsage) {
    const conv = this.conversations.find(c => c.id === id);
    if (!conv) return;

    conv.messages = messages;
    conv.updatedAt = new Date().toISOString();
    conv.inputTokens = tokens.inputTokens;
    conv.outputTokens = tokens.outputTokens;

    // Update title from first user message
    const first = messages.find(m => m.role === 'user');
    if (first) {
      let text = '';
      if (typeof first.content === 'string') {
        text = first.content;
      } else if (Array.isArray(first.content)) {
        const tb = first.content.find((b: any) => b.type === 'text');
        if (tb?.text) text = tb.text;
      }
      if (text) conv.title = text.substring(0, 40);
    }

    this.save();
  }

  deleteConversation(id: string) {
    const idx = this.conversations.findIndex(c => c.id === id);
    if (idx !== -1) {
      this.conversations.splice(idx, 1);
      this.save();
    }
  }
}
