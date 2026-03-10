import * as vscode from 'vscode';
import { ClaudioClient, Message, TokenUsage } from '../client/claudioClient';
import { ToolExecutor } from '../tools/toolExecutor';
import { ChatHistoryManager } from './chatHistory';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _historyManager: ChatHistoryManager;
  private _currentChatId: string | null = null;
  private _isProcessing = false;
  private _bypassPermissions = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: ClaudioClient,
    private readonly _toolExecutor: ToolExecutor,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._historyManager = new ChatHistoryManager(_context);
    this._bypassPermissions = vscode.workspace.getConfiguration('claudioCode').get('bypassPermissions') || false;
    this.setupClientCallbacks();
  }

  private setupClientCallbacks() {
    this._client.onThinkingStart = () => {
      this._view?.webview.postMessage({ type: 'thinkingStart' });
    };
    this._client.onThinkingUpdate = (text) => {
      this._view?.webview.postMessage({ type: 'thinkingUpdate', text });
    };
    this._client.onThinkingEnd = () => {
      this._view?.webview.postMessage({ type: 'thinkingEnd' });
    };
    this._client.onTextStart = () => {
      this._view?.webview.postMessage({ type: 'textStart' });
    };
    this._client.onTextDelta = (delta) => {
      this._view?.webview.postMessage({ type: 'textDelta', delta });
    };
    this._client.onTextEnd = () => {
      this._view?.webview.postMessage({ type: 'textEnd' });
    };
    this._client.onToolStart = (name, input) => {
      this._view?.webview.postMessage({ type: 'toolStart', name, input });
    };
    this._client.onToolEnd = (name, result, success) => {
      this._view?.webview.postMessage({ type: 'toolEnd', name, result: result.substring(0, 500), success });
    };
    this._client.onTokenUpdate = (usage) => {
      this._view?.webview.postMessage({ type: 'tokenUpdate', usage });
    };
    this._client.onError = (error) => {
      this._view?.webview.postMessage({ type: 'error', message: error });
    };
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage': await this.handleMessage(data.text, data.images); break;
        case 'newChat': this.newChat(); break;
        case 'createFile': await this.createFileFromCode(data.code, data.ext); break;
        case 'stopGeneration': this._client.abort(); this._view?.webview.postMessage({ type: 'stopped' }); break;
        case 'selectChat': this.selectChat(data.id); break;
        case 'deleteChat': this.deleteChat(data.id); break;
        case 'toggleBypass': this._bypassPermissions = data.enabled; this._toolExecutor.setBypassPermissions(data.enabled); break;
        case 'openSettings': vscode.commands.executeCommand('workbench.action.openSettings', 'claudioCode'); break;
        case 'openGetKey': vscode.env.openExternal(vscode.Uri.parse('https://claudioai.dev/')); break;
        case 'attachFile': this.handleAttachFile(); break;
        case 'ready': this.sendInitialState(); break;
      }
    });
  }

  private async createFileFromCode(code: string, ext: string) {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const defaultName = `new_file${ext}`;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: workspacePath ? vscode.Uri.file(`${workspacePath}/${defaultName}`) : undefined,
      filters: { 'All Files': ['*'] },
    });

    if (uri) {
      const fs = require('fs');
      fs.writeFileSync(uri.fsPath, code);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`File created: ${uri.fsPath.split('/').pop()}`);
    }
  }

  private async handleAttachFile() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: { 'All Files': ['*'] },
    });
    if (!files) return;

    const attachments: any[] = [];
    const fs = require('fs');

    for (const file of files) {
      const filePath = file.fsPath;
      const fileName = filePath.split('/').pop() || 'file';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

      try {
        const data = fs.readFileSync(filePath);
        if (imageExts.includes(ext)) {
          attachments.push({ name: fileName, type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, content: data.toString('base64'), isImage: true });
        } else {
          const content = data.toString('utf-8');
          attachments.push({ name: fileName, type: 'text', content: content.length > 50000 ? content.substring(0, 50000) + '\n...(truncated)' : content, isImage: false });
        }
      } catch {}
    }

    if (attachments.length > 0) {
      this._view?.webview.postMessage({ type: 'filesAttached', attachments });
    }
  }

  async sendMessage(text: string) {
    this._view?.webview.postMessage({ type: 'addUserMessage', text });
    await this.handleMessage(text);
  }

  private async handleMessage(text: string, images?: any[]) {
    if (this._isProcessing) return;
    this._isProcessing = true;
    this._view?.webview.postMessage({ type: 'processingStart' });

    if (!this._currentChatId) {
      const chat = this._historyManager.createConversation(text);
      this._currentChatId = chat.id;
    }

    try {
      await this._client.sendMessage(text, images, this._toolExecutor);
      this.saveCurrentChat();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: error.message });
    } finally {
      this._isProcessing = false;
      this._view?.webview.postMessage({ type: 'processingEnd' });
      this.loadChatHistory();
    }
  }

  newChat() {
    this.saveCurrentChat();
    this._client.clearHistory();
    this._currentChatId = null;
    this._view?.webview.postMessage({ type: 'clearChat' });
    this.loadChatHistory();
  }

  private saveCurrentChat() {
    if (!this._currentChatId) return;
    this._historyManager.updateConversation(this._currentChatId, this._client.getMessages(), this._client.getTokenUsage());
  }

  private sendInitialState() {
    this.loadChatHistory();
    this._view?.webview.postMessage({ type: 'setBypass', enabled: this._bypassPermissions });
    const editor = vscode.window.activeTextEditor;
    if (editor) this._view?.webview.postMessage({ type: 'currentFile', fileName: editor.document.fileName.split('/').pop() });

    // Check if API key is configured
    const apiKey = vscode.workspace.getConfiguration('claudioCode').get<string>('apiKey') || '';
    this._view?.webview.postMessage({ type: 'apiKeyStatus', hasKey: apiKey.length > 0 });
  }

  private loadChatHistory() {
    const chats = this._historyManager.getConversations();
    this._view?.webview.postMessage({ type: 'chatHistory', chats: chats.map(c => ({ id: c.id, title: c.title })), currentId: this._currentChatId });
  }

  private selectChat(id: string) {
    this.saveCurrentChat();
    const chat = this._historyManager.getConversation(id);
    if (!chat) return;
    this._currentChatId = id;
    this._client.setMessages(chat.messages);
    this._client.setTokens(chat.inputTokens, chat.outputTokens);

    const msgs: any[] = [];
    for (const msg of chat.messages) {
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        for (const b of msg.content) if (b.type === 'text' && b.text) text += b.text;
      }
      if (text) msgs.push({ role: msg.role, content: text });
    }
    this._view?.webview.postMessage({ type: 'loadChat', messages: msgs, tokens: this._client.getTokenUsage() });
    this.loadChatHistory();
  }

  private deleteChat(id: string) {
    this._historyManager.deleteConversation(id);
    if (this._currentChatId === id) this.newChat();
    this.loadChatHistory();
  }

  private _getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claudio Code</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0d0d;--bg2:#161616;--bg3:#1e1e1e;--text:#e8e8e8;--text2:#6b6b6b;--border:#2a2a2a;--accent:#8b5cf6;--accent2:#a78bfa;--success:#10b981;--error:#ef4444;--warn:#f59e0b}
body{font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(180deg,var(--bg2) 0%,var(--bg) 100%);border-bottom:1px solid var(--border)}
.header-title{font-size:11px;font-weight:600;letter-spacing:1px;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header-btn{background:none;border:none;color:var(--text2);cursor:pointer;padding:6px;font-size:14px;border-radius:6px;transition:all .2s}
.header-btn:hover{background:var(--bg3);color:var(--text)}
.chat-selector{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--border)}
.chat-dropdown{display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 10px;border-radius:8px;transition:all .2s}
.chat-dropdown:hover{background:var(--bg3)}
.chat-dropdown-title{font-size:13px;font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-dropdown-arrow{font-size:8px;color:var(--text2);transition:transform .2s}
.new-chat-btn{font-size:16px;color:var(--text2);background:none;border:none;cursor:pointer;padding:6px 10px;border-radius:6px;transition:all .2s}
.new-chat-btn:hover{background:var(--bg3);color:var(--accent)}
.chat-list{display:none;position:absolute;top:88px;left:16px;right:16px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;max-height:280px;overflow-y:auto;z-index:100;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.chat-list.open{display:block}
.chat-item{padding:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);transition:all .15s}
.chat-item:last-child{border-bottom:none}
.chat-item:hover{background:var(--bg3)}
.chat-item.active{background:var(--accent);color:#fff}
.chat-item-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.chat-item-del{opacity:0;background:none;border:none;color:var(--error);cursor:pointer;font-size:14px;padding:2px 6px}
.chat-item:hover .chat-item-del{opacity:1}
.messages{flex:1;overflow-y:auto;padding:16px}
.msg-group{margin-bottom:20px}
.user-msg{background:var(--bg3);border-radius:12px;padding:12px 16px;font-size:14px;line-height:1.6;border-left:3px solid var(--accent)}
.file-ctx{font-size:11px;color:var(--text2);margin-top:6px}
.assistant{margin-top:16px}
.think-block{display:flex;gap:12px;margin-bottom:12px}
.think-dot{width:8px;height:8px;background:var(--text2);border-radius:50%;margin-top:6px;flex-shrink:0}
.think-content{flex:1}
.think-header{display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text2);font-size:12px;font-style:italic}
.think-header:hover{color:var(--text)}
.think-arrow{font-size:8px;transition:transform .2s}
.think-arrow.exp{transform:rotate(180deg)}
.think-text{display:none;margin-top:8px;padding-left:16px;font-size:12px;color:var(--text2);line-height:1.6;border-left:2px solid var(--border)}
.think-text.exp{display:block}
.text-block{display:flex;gap:12px;margin-bottom:12px}
.text-dot{width:8px;height:8px;background:var(--text2);border-radius:50%;margin-top:6px;flex-shrink:0}
.text-content{flex:1;font-size:14px;line-height:1.7}
.text-content a{color:var(--accent2)}
.text-content strong{font-weight:600;color:var(--accent2)}
.text-content code{background:var(--bg3);padding:2px 6px;border-radius:4px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px;color:#e879f9}
.code-block{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:12px;margin:12px 0;border:1px solid var(--border);overflow:hidden}
.code-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,.3);border-bottom:1px solid var(--border);cursor:pointer}
.code-header-left{display:flex;align-items:center;gap:8px}
.code-lang{font-size:10px;color:var(--accent2);text-transform:uppercase;letter-spacing:1px}
.code-arrow{font-size:10px;color:var(--text2);transition:transform .2s}
.code-arrow.exp{transform:rotate(180deg)}
.code-actions{display:flex;gap:4px}
.code-btn{background:rgba(255,255,255,.1);border:none;color:var(--text2);padding:4px 8px;border-radius:4px;font-size:10px;cursor:pointer;transition:all .15s}
.code-btn:hover{background:rgba(255,255,255,.2);color:var(--text)}
.code-btn.copied{background:var(--success);color:#fff}
.code-content{max-height:0;overflow:hidden;transition:max-height .3s ease}
.code-content.exp{max-height:2000px}
.code-content pre{margin:0;padding:16px;overflow-x:auto}
.code-content pre code{background:none;padding:0;color:#e8e8e8;font-size:13px;line-height:1.5}
.text-content pre{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:12px;padding:16px;margin:12px 0;overflow-x:auto;border:1px solid var(--border);position:relative}
.text-content pre::before{content:attr(data-lang);position:absolute;top:8px;right:12px;font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:1px}
.text-content pre code{background:none;padding:0;color:#e8e8e8;font-size:13px;line-height:1.5}
.text-content ul,.text-content ol{margin:10px 0;padding-left:24px}
.text-content li{margin:6px 0}
.tool-block{display:flex;gap:12px;margin-bottom:12px}
.tool-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0}
.tool-dot.run{background:var(--warn);animation:pulse 1.5s infinite}
.tool-dot.ok{background:var(--success)}
.tool-dot.err{background:var(--error)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
.tool-content{flex:1}
.tool-header{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500}
.tool-name{color:var(--accent2)}
.tool-file{font-family:monospace;color:var(--text2);font-size:12px}
/* LOADING ANIMATION */
.loading-container{display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;margin:12px 0;background:linear-gradient(135deg,rgba(139,92,246,.05) 0%,rgba(16,185,129,.05) 100%);border-radius:16px;border:1px solid var(--border)}
.loading-spinner{width:48px;height:48px;position:relative}
.loading-spinner::before,.loading-spinner::after{content:'';position:absolute;inset:0;border-radius:50%;border:2px solid transparent}
.loading-spinner::before{border-top-color:var(--accent);animation:spin 1s linear infinite}
.loading-spinner::after{border-right-color:var(--success);animation:spin 1.5s linear infinite reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-ring{position:absolute;inset:4px;border-radius:50%;border:2px dashed var(--border);animation:spin 3s linear infinite}
.loading-stats{display:flex;gap:24px;font-size:12px;color:var(--text2)}
.loading-stat{display:flex;flex-direction:column;align-items:center;gap:4px}
.loading-stat-value{font-size:16px;font-weight:600;font-family:monospace;color:var(--text);background:linear-gradient(90deg,var(--accent),var(--success));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.loading-stat-label{font-size:10px;text-transform:uppercase;letter-spacing:1px}
.loading-text{font-size:13px;color:var(--text2);animation:fade 2s infinite}
@keyframes fade{0%,100%{opacity:.5}50%{opacity:1}}
/* Syntax highlighting */
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#c792ea}
.hljs-string,.hljs-attr{color:#c3e88d}
.hljs-number,.hljs-literal{color:#f78c6c}
.hljs-comment{color:#546e7a;font-style:italic}
.hljs-function,.hljs-title{color:#82aaff}
.hljs-class,.hljs-type{color:#ffcb6b}
.hljs-variable,.hljs-template-variable{color:#f07178}
.hljs-tag{color:#89ddff}
.hljs-name{color:#f07178}
.hljs-attribute{color:#c792ea}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text2);text-align:center;padding:40px}
.empty-title{font-size:18px;font-weight:600;margin-bottom:8px;color:var(--text)}
.empty-sub{font-size:12px;max-width:240px}
.no-key{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text);text-align:center;padding:40px;gap:16px}
.no-key-icon{font-size:48px;margin-bottom:8px}
.no-key-title{font-size:20px;font-weight:600;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.no-key-sub{font-size:13px;color:var(--text2);max-width:260px;line-height:1.5}
.no-key-btn{background:linear-gradient(135deg,var(--accent) 0%,#7c3aed 100%);border:none;color:#fff;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 4px 12px rgba(139,92,246,.3)}
.no-key-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(139,92,246,.4)}
.no-key-btn.secondary{background:var(--bg3);color:var(--text);box-shadow:none;padding:10px 20px;font-size:13px}
.no-key-btn.secondary:hover{background:var(--border)}
.input-area{padding:12px 16px;background:var(--bg);border-top:1px solid var(--border)}
.attachments{display:none;padding:8px 0;flex-wrap:wrap;gap:8px}
.attachments.show{display:flex}
.attach-item{display:flex;align-items:center;gap:6px;background:var(--bg3);padding:4px 10px;border-radius:8px;font-size:11px}
.attach-item img{width:24px;height:24px;object-fit:cover;border-radius:4px}
.attach-remove{background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px}
.attach-remove:hover{color:var(--error)}
.input-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:border-color .2s}
.input-wrap:focus-within{border-color:var(--accent)}
.input-textarea{width:100%;background:transparent;border:none;color:var(--text);padding:14px 16px;font-size:14px;font-family:inherit;resize:none;min-height:48px;max-height:200px;line-height:1.5}
.input-textarea:focus{outline:none}
.input-textarea::placeholder{color:var(--text2)}
.input-footer{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-top:1px solid var(--border)}
.input-left{display:flex;align-items:center;gap:12px}
.bypass{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--text2);transition:color .2s}
.bypass:hover{color:var(--text)}
.bypass.on{color:var(--accent)}
.cur-file{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text2)}
.input-right{display:flex;align-items:center;gap:8px}
.input-btn{background:none;border:none;color:var(--text2);cursor:pointer;padding:6px;font-size:14px;border-radius:6px;transition:all .2s}
.input-btn:hover{background:var(--bg3);color:var(--text)}
.send-btn{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent) 0%,#7c3aed 100%);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:all .2s;box-shadow:0 4px 12px rgba(139,92,246,.3)}
.send-btn:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(139,92,246,.4)}
.send-btn.stop{background:linear-gradient(135deg,var(--error) 0%,#dc2626 100%);box-shadow:0 4px 12px rgba(239,68,68,.3)}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text2)}
</style>
</head>
<body>
<div class="header">
<span class="header-title">CLAUDIO CODE</span>
<div style="display:flex;gap:8px">
<button class="header-btn" id="settingsBtn" title="Settings">⚙️</button>
</div>
</div>
<div class="chat-selector">
<div class="chat-dropdown" id="chatDropdown">
<span class="chat-dropdown-title" id="chatTitle">New chat</span>
<span class="chat-dropdown-arrow">▼</span>
</div>
<button class="new-chat-btn" id="newChatBtn" title="New chat">+</button>
</div>
<div class="chat-list" id="chatList"></div>
<div class="messages" id="messages">
<div class="empty" id="emptyState">
<div class="empty-title">Ask Claudio to help...</div>
<div class="empty-sub">I can read, write, edit files, run commands and more.</div>
</div>
<div class="no-key" id="noKeyState" style="display:none">
<div class="no-key-icon">🔑</div>
<div class="no-key-title">API Key Required</div>
<div class="no-key-sub">Create your free account and get your API key. Model O1 is completely free!</div>
<button class="no-key-btn" id="getKeyBtn">Get API Key</button>
<button class="no-key-btn secondary" id="configKeyBtn">I have a key</button>
</div>
</div>
<div class="input-area">
<div class="attachments" id="attachments"></div>
<div class="input-wrap">
<textarea class="input-textarea" id="input" placeholder="Ask Claudio to edit..." rows="1"></textarea>
<div class="input-footer">
<div class="input-left">
<div class="bypass" id="bypass"><span>»</span><span>Bypass</span></div>
<div class="cur-file" id="curFile"><span>&lt;/&gt;</span><span id="fileName"></span></div>
</div>
<div class="input-right">
<button class="input-btn" id="attachBtn" title="Attach">📎</button>
<button class="input-btn" title="Commands">/</button>
<button class="send-btn" id="sendBtn">↑</button>
</div>
</div>
</div>
</div>
<script>
const vscode=acquireVsCodeApi();
const $=id=>document.getElementById(id);
const messages=$('messages'),input=$('input'),sendBtn=$('sendBtn'),emptyState=$('emptyState');
const chatDropdown=$('chatDropdown'),chatList=$('chatList'),chatTitle=$('chatTitle');
const bypass=$('bypass'),fileName=$('fileName'),attachments=$('attachments'),attachBtn=$('attachBtn');
let isProcessing=false,currentGroup=null,bypassOn=false,atts=[],startTime=0,timerInterval=null,totalTokens=0;
chatDropdown.onclick=()=>chatList.classList.toggle('open');
document.addEventListener('click',e=>{if(!chatDropdown.contains(e.target)&&!chatList.contains(e.target))chatList.classList.remove('open')});
$('newChatBtn').onclick=()=>vscode.postMessage({type:'newChat'});
$('settingsBtn').onclick=()=>vscode.postMessage({type:'openSettings'});
$('getKeyBtn').onclick=()=>vscode.postMessage({type:'openGetKey'});
$('configKeyBtn').onclick=()=>vscode.postMessage({type:'openSettings'});
bypass.onclick=()=>{bypassOn=!bypassOn;bypass.classList.toggle('on',bypassOn);vscode.postMessage({type:'toggleBypass',enabled:bypassOn})};
attachBtn.onclick=()=>vscode.postMessage({type:'attachFile'});
function renderAtts(){
  if(atts.length===0){attachments.classList.remove('show');attachments.innerHTML='';return}
  attachments.classList.add('show');
  attachments.innerHTML=atts.map((a,i)=>a.isImage?
    '<div class="attach-item"><img src="data:'+a.type+';base64,'+a.content+'"><span>'+a.name+'</span><button class="attach-remove" data-i="'+i+'">×</button></div>':
    '<div class="attach-item"><span>📄</span><span>'+a.name+'</span><button class="attach-remove" data-i="'+i+'">×</button></div>'
  ).join('');
  attachments.querySelectorAll('.attach-remove').forEach(b=>b.onclick=()=>{atts.splice(parseInt(b.dataset.i),1);renderAtts()});
}
input.addEventListener('paste',e=>{
  const items=e.clipboardData?.items;if(!items)return;
  for(const item of items){
    if(item.type.startsWith('image/')){
      e.preventDefault();
      const file=item.getAsFile();if(!file)continue;
      const reader=new FileReader();
      reader.onload=()=>{atts.push({name:'pasted.png',type:item.type,content:reader.result.split(',')[1],isImage:true});renderAtts()};
      reader.readAsDataURL(file);
    }
  }
});
function send(){
  const text=input.value.trim();
  if((!text&&atts.length===0)||isProcessing)return;
  let fullText=text;const images=[],textFiles=[];
  for(const a of atts){
    if(a.isImage)images.push({data:a.content,type:a.type});
    else textFiles.push({name:a.name,content:a.content});
  }
  if(textFiles.length>0)for(const tf of textFiles)fullText+='\\n\\n--- File: '+tf.name+' ---\\n'+tf.content;
  addUserMsg(text,atts);
  vscode.postMessage({type:'sendMessage',text:fullText,images:images.length>0?images:undefined});
  input.value='';atts=[];renderAtts();autoResize();
}
sendBtn.onclick=()=>{if(isProcessing)vscode.postMessage({type:'stopGeneration'});else send()};
input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};
function autoResize(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,200)+'px'}
input.oninput=autoResize;
function addUserMsg(text,attachs=[]){
  emptyState.style.display='none';
  currentGroup=document.createElement('div');currentGroup.className='msg-group';
  const um=document.createElement('div');um.className='user-msg';um.textContent=text;currentGroup.appendChild(um);
  if(attachs.length>0){
    const ad=document.createElement('div');ad.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;';
    for(const a of attachs){
      if(a.isImage){const img=document.createElement('img');img.src='data:'+a.type+';base64,'+a.content;img.style.cssText='max-width:120px;max-height:80px;border-radius:8px;';ad.appendChild(img)}
      else{const sp=document.createElement('span');sp.style.cssText='background:var(--bg3);padding:4px 8px;border-radius:6px;font-size:11px;';sp.textContent='📄 '+a.name;ad.appendChild(sp)}
    }
    currentGroup.appendChild(ad);
  }
  if(fileName.textContent){const fc=document.createElement('div');fc.className='file-ctx';fc.textContent=fileName.textContent;currentGroup.appendChild(fc)}
  const ac=document.createElement('div');ac.className='assistant';currentGroup.appendChild(ac);
  messages.appendChild(currentGroup);scroll();
}
function getAC(){return currentGroup?.querySelector('.assistant')}
let curThink=null,curText=null,loadingEl=null,textBuffer='',renderTimer=null;
function addThink(){
  const ac=getAC();if(!ac)return;
  thinkBuffer='';
  const b=document.createElement('div');b.className='think-block';
  b.innerHTML='<div class="think-dot"></div><div class="think-content"><div class="think-header"><span>Thinking</span><span class="think-arrow">▼</span></div><div class="think-text"></div></div>';
  const hdr=b.querySelector('.think-header'),arr=b.querySelector('.think-arrow'),txt=b.querySelector('.think-text');
  hdr.onclick=()=>{arr.classList.toggle('exp');txt.classList.toggle('exp')};
  curThink=txt;ac.appendChild(b);scroll();
}
let thinkBuffer='',thinkTimer=null;
function updateThink(d){
  if(!curThink)return;
  thinkBuffer+=d;
  if(!thinkTimer){
    thinkTimer=requestAnimationFrame(()=>{
      if(curThink)curThink.textContent=thinkBuffer;
      scroll();
      thinkTimer=null;
    });
  }
}
function addText(){
  const ac=getAC();if(!ac)return;
  textBuffer='';
  const b=document.createElement('div');b.className='text-block';
  b.innerHTML='<div class="text-dot"></div><div class="text-content"></div>';
  curText=b.querySelector('.text-content');ac.appendChild(b);scroll();
}
function updateText(d){
  if(!curText)return;
  textBuffer+=d;
  if(!renderTimer){
    renderTimer=requestAnimationFrame(()=>{
      if(curText)curText.innerHTML=formatMD(textBuffer);
      scroll();
      renderTimer=null;
    });
  }
}
function addTool(name,inp,status='run'){
  const ac=getAC();if(!ac)return;
  const file=inp?.path||inp?.pattern||inp?.command?.substring(0,30)||'';
  const b=document.createElement('div');b.className='tool-block';b.id='tool-'+Date.now();
  b.innerHTML='<div class="tool-dot '+status+'"></div><div class="tool-content"><div class="tool-header"><span class="tool-name">'+name+'</span><span class="tool-file">'+file+'</span></div></div>';
  ac.appendChild(b);scroll();return b;
}
function updateTool(ok){
  const blocks=document.querySelectorAll('.tool-block');
  if(blocks.length>0){const last=blocks[blocks.length-1].querySelector('.tool-dot');last.className='tool-dot '+(ok?'ok':'err')}
}
function addLoading(){
  const ac=getAC();if(!ac)return;
  loadingEl=document.createElement('div');loadingEl.className='loading-container';
  loadingEl.innerHTML='<div class="loading-spinner"><div class="loading-ring"></div></div><div class="loading-stats"><div class="loading-stat"><span class="loading-stat-value" id="timerVal">0.0s</span><span class="loading-stat-label">Elapsed</span></div><div class="loading-stat"><span class="loading-stat-value" id="tokenVal">0</span><span class="loading-stat-label">Tokens</span></div></div><div class="loading-text">Processing...</div>';
  ac.appendChild(loadingEl);scroll();
}
function removeLoading(){if(loadingEl){loadingEl.remove();loadingEl=null}}
function startTimer(){
  startTime=Date.now();totalTokens=0;
  timerInterval=setInterval(()=>{
    if(loadingEl){
      const el=loadingEl.querySelector('#timerVal');
      if(el)el.textContent=((Date.now()-startTime)/1000).toFixed(1)+'s';
    }
  },200);
}
function stopTimer(){if(timerInterval){clearInterval(timerInterval);timerInterval=null}}
function updateTokenDisplay(n){
  totalTokens=n;
  if(loadingEl){const el=loadingEl.querySelector('#tokenVal');if(el)el.textContent=n.toLocaleString()}
}
let codeBlockId=0;
function formatMD(text){
  if(!text)return'';
  // Code blocks with language - collapsible
  text=text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,(m,lang,code)=>{
    const id='cb'+(codeBlockId++);
    const highlighted=highlightCode(code,lang);
    const escaped=code.replace(/'/g,"\\'").replace(/\\n/g,'\\\\n');
    const ext=lang==='javascript'||lang==='js'?'.js':lang==='typescript'||lang==='ts'?'.ts':lang==='python'||lang==='py'?'.py':lang==='html'?'.html':lang==='css'?'.css':lang==='json'?'.json':lang==='bash'||lang==='sh'?'.sh':'.txt';
    return '<div class="code-block" id="'+id+'"><div class="code-header" onclick="toggleCode(\\''+id+'\\')"><div class="code-header-left"><span class="code-arrow">▼</span><span class="code-lang">'+(lang||'code')+'</span></div><div class="code-actions"><button class="code-btn" onclick="event.stopPropagation();copyCode(\\''+id+'\\',this)">Copy</button><button class="code-btn" onclick="event.stopPropagation();createFile(\\''+escaped+'\\',\\''+ext+'\\')">Create File</button></div></div><div class="code-content"><pre><code>'+highlighted+'</code></pre></div></div>';
  });
  text=text.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  text=text.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  text=text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2">$1</a>');
  text=text.replace(/^- (.+)$/gm,'<li>$1</li>');
  text=text.replace(/\\n/g,'<br>');
  return text;
}
const kwSet=new Set(['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','try','catch','throw','new','this','true','false','null','undefined','def','print','self','elif','except','lambda','with','as','in','not','and','or','public','private','static','void','int','string','bool','float','double']);
const typeSet=new Set(['String','Number','Boolean','Array','Object','Promise','Map','Set','Date','Error','RegExp','str','list','dict','tuple']);
function highlightCode(code,lang){
  let result=code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  result=result.replace(/(\\/{2}.*$|#.*$)/gm,'<span class="hljs-comment">$1</span>');
  result=result.replace(/(\\/\\*[\\s\\S]*?\\*\\/)/g,'<span class="hljs-comment">$1</span>');
  result=result.replace(/("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)/g,'<span class="hljs-string">$1</span>');
  result=result.replace(/\\b(\\d+\\.?\\d*)\\b/g,'<span class="hljs-number">$1</span>');
  result=result.replace(/\\b([a-zA-Z_][a-zA-Z0-9_]*)\\b/g,(m,w)=>kwSet.has(w)?'<span class="hljs-keyword">'+w+'</span>':typeSet.has(w)?'<span class="hljs-type">'+w+'</span>':w);
  result=result.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(/g,'<span class="hljs-function">$1</span>(');
  return result;
}
function toggleCode(id){
  const block=document.getElementById(id);
  if(!block)return;
  const arrow=block.querySelector('.code-arrow');
  const content=block.querySelector('.code-content');
  arrow.classList.toggle('exp');
  content.classList.toggle('exp');
}
function copyCode(id,btn){
  const block=document.getElementById(id);
  if(!block)return;
  const code=block.querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(()=>{
    btn.textContent='Copied!';
    btn.classList.add('copied');
    setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1500);
  });
}
function createFile(code,ext){
  const decoded=code.replace(/\\\\n/g,'\\n').replace(/\\\\'/g,"'");
  vscode.postMessage({type:'createFile',code:decoded,ext:ext});
}
let scrollTimer=null;
function scroll(){
  if(!scrollTimer){
    scrollTimer=requestAnimationFrame(()=>{
      messages.scrollTop=messages.scrollHeight;
      scrollTimer=null;
    });
  }
}
window.addEventListener('message',e=>{
  const d=e.data;
  switch(d.type){
    case'processingStart':isProcessing=true;sendBtn.classList.add('stop');sendBtn.textContent='■';addLoading();startTimer();break;
    case'processingEnd':case'stopped':isProcessing=false;sendBtn.classList.remove('stop');sendBtn.textContent='↑';removeLoading();stopTimer();curThink=null;curText=null;break;
    case'thinkingStart':removeLoading();addThink();addLoading();break;
    case'thinkingUpdate':updateThink(d.text);break;
    case'thinkingEnd':curThink=null;break;
    case'textStart':removeLoading();addText();break;
    case'textDelta':updateText(d.delta);break;
    case'textEnd':curText=null;break;
    case'toolStart':removeLoading();addTool(d.name,d.input);addLoading();break;
    case'toolEnd':removeLoading();updateTool(d.success);break;
    case'error':removeLoading();stopTimer();const ac=getAC();if(ac){const eb=document.createElement('div');eb.className='text-block';eb.innerHTML='<div class="text-dot" style="background:var(--error)"></div><div class="text-content" style="color:var(--error)">Error: '+d.message+'</div>';ac.appendChild(eb)}break;
    case'addUserMessage':addUserMsg(d.text);break;
    case'clearChat':messages.innerHTML='';emptyState.style.display='flex';messages.appendChild(emptyState);chatTitle.textContent='New chat';currentGroup=null;break;
    case'chatHistory':
      chatList.innerHTML=d.chats.map(c=>'<div class="chat-item '+(c.id===d.currentId?'active':'')+'" data-id="'+c.id+'"><span class="chat-item-title">'+c.title+'</span><button class="chat-item-del" data-id="'+c.id+'">×</button></div>').join('');
      chatList.querySelectorAll('.chat-item').forEach(it=>it.onclick=ev=>{if(!ev.target.classList.contains('chat-item-del')){vscode.postMessage({type:'selectChat',id:it.dataset.id});chatList.classList.remove('open')}});
      chatList.querySelectorAll('.chat-item-del').forEach(b=>b.onclick=ev=>{ev.stopPropagation();vscode.postMessage({type:'deleteChat',id:b.dataset.id})});
      const cur=d.chats.find(c=>c.id===d.currentId);if(cur)chatTitle.textContent=cur.title;
      break;
    case'loadChat':
      messages.innerHTML='';emptyState.style.display='none';
      for(const m of d.messages){if(m.role==='user')addUserMsg(m.content);else{addText();if(curText)curText.innerHTML=formatMD(m.content)}}
      break;
    case'currentFile':fileName.textContent=d.fileName;break;
    case'setBypass':bypassOn=d.enabled;bypass.classList.toggle('on',bypassOn);break;
    case'tokenUpdate':updateTokenDisplay(d.usage.totalTokens);break;
    case'filesAttached':for(const a of d.attachments)atts.push(a);renderAtts();break;
    case'apiKeyStatus':
      const noKey=$('noKeyState'),empty=$('emptyState');
      if(d.hasKey){noKey.style.display='none';empty.style.display='flex'}
      else{noKey.style.display='flex';empty.style.display='none'}
      break;
  }
});
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
  }
}
