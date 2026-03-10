"use strict";var R=Object.create;var P=Object.defineProperty;var W=Object.getOwnPropertyDescriptor;var G=Object.getOwnPropertyNames;var J=Object.getPrototypeOf,K=Object.prototype.hasOwnProperty;var V=(d,t)=>{for(var e in t)P(d,e,{get:t[e],enumerable:!0})},N=(d,t,e,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of G(t))!K.call(d,s)&&s!==e&&P(d,s,{get:()=>t[s],enumerable:!(n=W(t,s))||n.enumerable});return d};var k=(d,t,e)=>(e=d!=null?R(J(d)):{},N(t||!d||!d.__esModule?P(e,"default",{value:d,enumerable:!0}):e,d)),Y=d=>N(P({},"__esModule",{value:!0}),d);var it={};V(it,{activate:()=>st,deactivate:()=>nt});module.exports=Y(it);var b=k(require("vscode"));var S=k(require("vscode"));var _=k(require("fs")),O=k(require("path")),D=class{constructor(t){this.conversations=[];this.storageDir=t.globalStorageUri.fsPath,this.conversationsFile=O.join(this.storageDir,"conversations.json"),this.ensureStorage(),this.load()}ensureStorage(){_.existsSync(this.storageDir)||_.mkdirSync(this.storageDir,{recursive:!0})}load(){try{_.existsSync(this.conversationsFile)&&(this.conversations=JSON.parse(_.readFileSync(this.conversationsFile,"utf-8")))}catch{this.conversations=[]}}save(){try{_.writeFileSync(this.conversationsFile,JSON.stringify(this.conversations,null,2))}catch{}}getConversations(){return[...this.conversations].sort((t,e)=>new Date(e.updatedAt).getTime()-new Date(t.updatedAt).getTime())}getConversation(t){return this.conversations.find(e=>e.id===t)}createConversation(t){let e=new Date().toISOString(),n={id:Date.now().toString(36)+Math.random().toString(36).substr(2),title:t?.substring(0,40)||"New chat",createdAt:e,updatedAt:e,messages:[],inputTokens:0,outputTokens:0};return this.conversations.unshift(n),this.save(),n}updateConversation(t,e,n){let s=this.conversations.find(i=>i.id===t);if(!s)return;s.messages=e,s.updatedAt=new Date().toISOString(),s.inputTokens=n.inputTokens,s.outputTokens=n.outputTokens;let o=e.find(i=>i.role==="user");if(o){let i="";if(typeof o.content=="string")i=o.content;else if(Array.isArray(o.content)){let r=o.content.find(h=>h.type==="text");r?.text&&(i=r.text)}i&&(s.title=i.substring(0,40))}this.save()}deleteConversation(t){let e=this.conversations.findIndex(n=>n.id===t);e!==-1&&(this.conversations.splice(e,1),this.save())}};var L=class{constructor(t,e,n,s){this._extensionUri=t;this._client=e;this._toolExecutor=n;this._context=s;this._currentChatId=null;this._isProcessing=!1;this._bypassPermissions=!1;this._historyManager=new D(s),this._bypassPermissions=S.workspace.getConfiguration("claudioCode").get("bypassPermissions")||!1,this.setupClientCallbacks()}setupClientCallbacks(){this._client.onThinkingStart=()=>{this._view?.webview.postMessage({type:"thinkingStart"})},this._client.onThinkingUpdate=t=>{this._view?.webview.postMessage({type:"thinkingUpdate",text:t})},this._client.onThinkingEnd=()=>{this._view?.webview.postMessage({type:"thinkingEnd"})},this._client.onTextStart=()=>{this._view?.webview.postMessage({type:"textStart"})},this._client.onTextDelta=t=>{this._view?.webview.postMessage({type:"textDelta",delta:t})},this._client.onTextEnd=()=>{this._view?.webview.postMessage({type:"textEnd"})},this._client.onToolStart=(t,e)=>{this._view?.webview.postMessage({type:"toolStart",name:t,input:e})},this._client.onToolEnd=(t,e,n)=>{this._view?.webview.postMessage({type:"toolEnd",name:t,result:e.substring(0,500),success:n})},this._client.onTokenUpdate=t=>{this._view?.webview.postMessage({type:"tokenUpdate",usage:t})},this._client.onError=t=>{this._view?.webview.postMessage({type:"error",message:t})}}resolveWebviewView(t){this._view=t,t.webview.options={enableScripts:!0,localResourceRoots:[this._extensionUri]},t.webview.html=this._getHtmlContent(),t.webview.onDidReceiveMessage(async e=>{switch(e.type){case"sendMessage":await this.handleMessage(e.text,e.images);break;case"newChat":this.newChat();break;case"stopGeneration":this._client.abort(),this._view?.webview.postMessage({type:"stopped"});break;case"selectChat":this.selectChat(e.id);break;case"deleteChat":this.deleteChat(e.id);break;case"toggleBypass":this._bypassPermissions=e.enabled,this._toolExecutor.setBypassPermissions(e.enabled);break;case"openSettings":S.commands.executeCommand("workbench.action.openSettings","claudioCode");break;case"attachFile":this.handleAttachFile();break;case"ready":this.sendInitialState();break}})}async handleAttachFile(){let t=await S.window.showOpenDialog({canSelectMany:!0,openLabel:"Attach",filters:{"All Files":["*"]}});if(!t)return;let e=[],n=require("fs");for(let s of t){let o=s.fsPath,i=o.split("/").pop()||"file",r=i.split(".").pop()?.toLowerCase()||"",h=["png","jpg","jpeg","gif","webp"];try{let a=n.readFileSync(o);if(h.includes(r))e.push({name:i,type:r==="jpg"?"image/jpeg":`image/${r}`,content:a.toString("base64"),isImage:!0});else{let c=a.toString("utf-8");e.push({name:i,type:"text",content:c.length>5e4?c.substring(0,5e4)+`
...(truncated)`:c,isImage:!1})}}catch{}}e.length>0&&this._view?.webview.postMessage({type:"filesAttached",attachments:e})}async sendMessage(t){this._view?.webview.postMessage({type:"addUserMessage",text:t}),await this.handleMessage(t)}async handleMessage(t,e){if(!this._isProcessing){if(this._isProcessing=!0,this._view?.webview.postMessage({type:"processingStart"}),!this._currentChatId){let n=this._historyManager.createConversation(t);this._currentChatId=n.id}try{await this._client.sendMessage(t,e,this._toolExecutor),this.saveCurrentChat()}catch(n){this._view?.webview.postMessage({type:"error",message:n.message})}finally{this._isProcessing=!1,this._view?.webview.postMessage({type:"processingEnd"}),this.loadChatHistory()}}}newChat(){this.saveCurrentChat(),this._client.clearHistory(),this._currentChatId=null,this._view?.webview.postMessage({type:"clearChat"}),this.loadChatHistory()}saveCurrentChat(){this._currentChatId&&this._historyManager.updateConversation(this._currentChatId,this._client.getMessages(),this._client.getTokenUsage())}sendInitialState(){this.loadChatHistory(),this._view?.webview.postMessage({type:"setBypass",enabled:this._bypassPermissions});let t=S.window.activeTextEditor;t&&this._view?.webview.postMessage({type:"currentFile",fileName:t.document.fileName.split("/").pop()})}loadChatHistory(){let t=this._historyManager.getConversations();this._view?.webview.postMessage({type:"chatHistory",chats:t.map(e=>({id:e.id,title:e.title})),currentId:this._currentChatId})}selectChat(t){this.saveCurrentChat();let e=this._historyManager.getConversation(t);if(!e)return;this._currentChatId=t,this._client.setMessages(e.messages),this._client.setTokens(e.inputTokens,e.outputTokens);let n=[];for(let s of e.messages){let o="";if(typeof s.content=="string")o=s.content;else if(Array.isArray(s.content))for(let i of s.content)i.type==="text"&&i.text&&(o+=i.text);o&&n.push({role:s.role,content:o})}this._view?.webview.postMessage({type:"loadChat",messages:n,tokens:this._client.getTokenUsage()}),this.loadChatHistory()}deleteChat(t){this._historyManager.deleteConversation(t),this._currentChatId===t&&this.newChat(),this.loadChatHistory()}_getHtmlContent(){return`<!DOCTYPE html>
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
<button class="header-btn" id="settingsBtn" title="Settings">\u2699\uFE0F</button>
</div>
</div>
<div class="chat-selector">
<div class="chat-dropdown" id="chatDropdown">
<span class="chat-dropdown-title" id="chatTitle">New chat</span>
<span class="chat-dropdown-arrow">\u25BC</span>
</div>
<button class="new-chat-btn" id="newChatBtn" title="New chat">+</button>
</div>
<div class="chat-list" id="chatList"></div>
<div class="messages" id="messages">
<div class="empty" id="emptyState">
<div class="empty-title">Ask Claudio to help...</div>
<div class="empty-sub">I can read, write, edit files, run commands and more.</div>
</div>
</div>
<div class="input-area">
<div class="attachments" id="attachments"></div>
<div class="input-wrap">
<textarea class="input-textarea" id="input" placeholder="Ask Claudio to edit..." rows="1"></textarea>
<div class="input-footer">
<div class="input-left">
<div class="bypass" id="bypass"><span>\xBB</span><span>Bypass</span></div>
<div class="cur-file" id="curFile"><span>&lt;/&gt;</span><span id="fileName"></span></div>
</div>
<div class="input-right">
<button class="input-btn" id="attachBtn" title="Attach">\u{1F4CE}</button>
<button class="input-btn" title="Commands">/</button>
<button class="send-btn" id="sendBtn">\u2191</button>
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
bypass.onclick=()=>{bypassOn=!bypassOn;bypass.classList.toggle('on',bypassOn);vscode.postMessage({type:'toggleBypass',enabled:bypassOn})};
attachBtn.onclick=()=>vscode.postMessage({type:'attachFile'});
function renderAtts(){
  if(atts.length===0){attachments.classList.remove('show');attachments.innerHTML='';return}
  attachments.classList.add('show');
  attachments.innerHTML=atts.map((a,i)=>a.isImage?
    '<div class="attach-item"><img src="data:'+a.type+';base64,'+a.content+'"><span>'+a.name+'</span><button class="attach-remove" data-i="'+i+'">\xD7</button></div>':
    '<div class="attach-item"><span>\u{1F4C4}</span><span>'+a.name+'</span><button class="attach-remove" data-i="'+i+'">\xD7</button></div>'
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
      else{const sp=document.createElement('span');sp.style.cssText='background:var(--bg3);padding:4px 8px;border-radius:6px;font-size:11px;';sp.textContent='\u{1F4C4} '+a.name;ad.appendChild(sp)}
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
  b.innerHTML='<div class="think-dot"></div><div class="think-content"><div class="think-header"><span>Thinking</span><span class="think-arrow">\u25BC</span></div><div class="think-text"></div></div>';
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
function formatMD(text){
  if(!text)return'';
  // Code blocks with language
  text=text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,(m,lang,code)=>{
    const highlighted=highlightCode(code,lang);
    return '<pre data-lang="'+(lang||'code')+'"><code>'+highlighted+'</code></pre>';
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
    case'processingStart':isProcessing=true;sendBtn.classList.add('stop');sendBtn.textContent='\u25A0';addLoading();startTimer();break;
    case'processingEnd':case'stopped':isProcessing=false;sendBtn.classList.remove('stop');sendBtn.textContent='\u2191';removeLoading();stopTimer();curThink=null;curText=null;break;
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
      chatList.innerHTML=d.chats.map(c=>'<div class="chat-item '+(c.id===d.currentId?'active':'')+'" data-id="'+c.id+'"><span class="chat-item-title">'+c.title+'</span><button class="chat-item-del" data-id="'+c.id+'">\xD7</button></div>').join('');
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
  }
});
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`}};var B=k(require("vscode")),Z=k(require("https")),X=k(require("http")),Q=2e5,tt=[{name:"Bash",description:"Execute shell command. Server commands run in background automatically.",input_schema:{type:"object",properties:{command:{type:"string",description:"Command to execute"},workingDirectory:{type:"string",description:"Working directory (optional)"},background:{type:"boolean",description:"Force background execution"}},required:["command"]}},{name:"Read",description:"Read file contents",input_schema:{type:"object",properties:{path:{type:"string",description:"File path"},startLine:{type:"number",description:"Start line (optional)"},endLine:{type:"number",description:"End line (optional)"}},required:["path"]}},{name:"Write",description:"Create or overwrite a file",input_schema:{type:"object",properties:{path:{type:"string",description:"File path"},content:{type:"string",description:"File content"}},required:["path","content"]}},{name:"Edit",description:"Edit file by replacing text (oldText must be unique)",input_schema:{type:"object",properties:{path:{type:"string",description:"File path"},oldText:{type:"string",description:"Text to replace"},newText:{type:"string",description:"New text"}},required:["path","oldText","newText"]}},{name:"ListDir",description:"List files and folders",input_schema:{type:"object",properties:{path:{type:"string",description:"Directory path"},recursive:{type:"boolean",description:"List recursively"}},required:["path"]}},{name:"Search",description:"Search for pattern in files",input_schema:{type:"object",properties:{pattern:{type:"string",description:"Search pattern"},path:{type:"string",description:"Directory (optional)"}},required:["pattern"]}},{name:"Glob",description:"Find files by glob pattern",input_schema:{type:"object",properties:{pattern:{type:"string",description:"Glob pattern (e.g., **/*.ts)"}},required:["pattern"]}}],A=class{constructor(){this.messages=[];this.currentTokens={input:0,output:0};this.abortController=null;this.isProcessing=!1}getConfig(){let t=B.workspace.getConfiguration("claudioCode");return{apiKey:t.get("apiKey")||"",apiUrl:t.get("apiUrl")||"https://claudioai.dev",model:t.get("model")||"claude-opus-4-5",maxTokens:t.get("maxTokens")||8192}}getModel(){return this.getConfig().model}clearHistory(){this.messages=[],this.currentTokens={input:0,output:0}}getMessages(){return[...this.messages]}setMessages(t){this.messages=[...t]}getTokenUsage(){return{inputTokens:this.currentTokens.input,outputTokens:this.currentTokens.output,totalTokens:this.currentTokens.input+this.currentTokens.output,percentUsed:Math.round(this.currentTokens.input/Q*100)}}setTokens(t,e){this.currentTokens={input:t,output:e}}abort(){return this.abortController&&this.isProcessing?(this.abortController.abort(),this.isProcessing=!1,!0):!1}getIsProcessing(){return this.isProcessing}getSystemPrompt(){return`You are Claudio Code, an advanced AI coding assistant.

## Tools Available
- **Bash**: Execute terminal commands
- **Read**: Read file contents
- **Write**: Create/overwrite files
- **Edit**: Edit files with search/replace
- **ListDir**: List directory contents
- **Search**: Search in files
- **Glob**: Find files by pattern

## Working Directory
${B.workspace.workspaceFolders?.[0]?.uri.fsPath||process.cwd()}

## Guidelines
1. Be proactive - execute actions instead of asking
2. Read files before editing
3. Use streaming responses for large outputs
4. Be concise but thorough
5. Show your reasoning process
6. Respond in the user's language`}async sendMessage(t,e,n){let s=this.getConfig();if(!s.apiKey)throw new Error("API Key not configured. Go to Settings > Claudio Code > API Key");this.abortController=new AbortController,this.isProcessing=!0;let o=this.buildUserContent(t,e);this.messages.push({role:"user",content:o});let i=0,r=25,h="";for(;i<r;){if(this.abortController?.signal.aborted)return this.isProcessing=!1,h||"Stopped by user";i++;try{let a=await this.streamRequest(s,n);if(h=a.text,!a.hasToolCalls)break}catch(a){throw this.onError?.(a.message),this.isProcessing=!1,a}}return this.isProcessing=!1,h}buildUserContent(t,e){if(!e?.length)return t;let n=[];for(let s of e)n.push({type:"image",source:{type:"base64",media_type:s.type,data:s.data}});return n.push({type:"text",text:t}),n}async streamRequest(t,e){return new Promise((n,s)=>{let o=JSON.stringify({model:t.model,max_tokens:t.maxTokens,stream:!0,system:this.getSystemPrompt(),tools:tt,messages:this.messages}),i=new URL(`${t.apiUrl}/v1/messages`),r=i.protocol==="https:",a=(r?Z:X).request({hostname:i.hostname,port:i.port||(r?443:80),path:i.pathname,method:"POST",headers:{"Content-Type":"application/json","x-api-key":t.apiKey,"anthropic-version":"2023-06-01"}},async c=>{if(c.statusCode!==200){let T="";c.on("data",g=>T+=g),c.on("end",()=>{try{let g=JSON.parse(T);s(new Error(g.error?.message||`HTTP ${c.statusCode}`))}catch{s(new Error(`HTTP ${c.statusCode}: ${T.substring(0,200)}`))}});return}let v="",u="",m="",y=[],E=[],j=!1,F=!1,M=0;c.on("data",T=>{v+=T.toString();let g=v.split(`
`);v=g.pop()||"";for(let f of g){if(f.startsWith("event:")||f.trim()===""||!f.startsWith("data:"))continue;let U=f.slice(5).trim();if(!(U==="[DONE]"||!U))try{let p=JSON.parse(U);switch(p.type){case"content_block_start":p.content_block?.type==="thinking"?(j=!0,this.onThinkingStart?.()):p.content_block?.type==="text"?(F=!0,this.onTextStart?.()):p.content_block?.type==="tool_use"&&y.push({type:"tool_use",id:p.content_block.id,name:p.content_block.name,input:{}});break;case"message_start":p.message?.usage?.input_tokens&&(this.currentTokens.input=p.message.usage.input_tokens,this.onTokenUpdate?.(this.getTokenUsage()));break;case"content_block_delta":if(p.delta?.type==="thinking_delta")m+=p.delta.thinking,M+=p.delta.thinking?.length||0,this.onThinkingUpdate?.(p.delta.thinking),this.currentTokens.output=Math.round(M/4),this.onTokenUpdate?.(this.getTokenUsage());else if(p.delta?.type==="text_delta")u+=p.delta.text,M+=p.delta.text?.length||0,this.onTextDelta?.(p.delta.text),this.currentTokens.output=Math.round(M/4),this.onTokenUpdate?.(this.getTokenUsage());else if(p.delta?.type==="input_json_delta"&&y.length>0){let C=y[y.length-1];C._inputJson||(C._inputJson=""),C._inputJson+=p.delta.partial_json}break;case"content_block_stop":if(j)j=!1,this.onThinkingEnd?.(),m&&E.push({type:"thinking",text:m}),m="";else if(F)F=!1,this.onTextEnd?.(),u&&E.push({type:"text",text:u});else if(y.length>0){let C=y[y.length-1];if(C._inputJson){try{C.input=JSON.parse(C._inputJson)}catch{}delete C._inputJson}E.push(C)}break;case"message_delta":p.usage&&(this.currentTokens.input=p.usage.input_tokens||this.currentTokens.input,this.currentTokens.output=p.usage.output_tokens||this.currentTokens.output,this.onTokenUpdate?.(this.getTokenUsage()));break;case"message_stop":break}}catch{}}}),c.on("end",async()=>{if(E.length>0&&this.messages.push({role:"assistant",content:E}),y.length>0&&e){let T=[];for(let g of y){this.onToolStart?.(g.name,g.input);try{let f=await e.execute(g.name,g.input);this.onToolEnd?.(g.name,f,!0),T.push({type:"tool_result",tool_use_id:g.id,content:f.length>1e4?f.substring(0,1e4)+`
...(truncated)`:f})}catch(f){this.onToolEnd?.(g.name,f.message,!1),T.push({type:"tool_result",tool_use_id:g.id,content:`Error: ${f.message}`,is_error:!0})}}this.messages.push({role:"user",content:T}),n({text:u,hasToolCalls:!0})}else n({text:u,hasToolCalls:!1})}),c.on("error",s)});a.on("error",s),a.setTimeout(12e4,()=>{a.destroy(),s(new Error("Request timeout"))}),a.write(o),a.end()})}};var x=k(require("vscode")),w=k(require("path")),l=k(require("fs")),q=require("child_process"),H=require("util"),et=(0,H.promisify)(q.exec),I=new Set(["node_modules",".git","__pycache__",".venv","venv","dist","build",".next",".nuxt","vendor","target"]),$=class{constructor(){this.bypassPermissions=!1}setBypassPermissions(t){this.bypassPermissions=t}getWorkspacePath(){return x.workspace.workspaceFolders?.[0]?.uri.fsPath||process.cwd()}resolvePath(t){return w.isAbsolute(t)?t:w.join(this.getWorkspacePath(),t)}async execute(t,e){switch(t){case"Bash":return this.executeBash(e);case"Read":return this.readFile(e);case"Write":return this.writeFile(e);case"Edit":return this.editFile(e);case"ListDir":return this.listDirectory(e);case"Search":return this.search(e);case"Glob":return this.glob(e);default:throw new Error(`Unknown tool: ${t}`)}}async executeBash(t){let{command:e,workingDirectory:n}=t,s=n?this.resolvePath(n):this.getWorkspacePath(),o=[/npm\s+(run\s+)?(start|dev|serve)/i,/yarn\s+(start|dev)/i,/vite/i];if(t.background||o.some(a=>a.test(e))){let a=x.window.createTerminal({name:e.substring(0,30),cwd:s});return a.sendText(e),a.show(),`Started in terminal: ${e}`}if([/rm\s+-rf\s+[/~]/,/sudo/,/chmod\s+777/].some(a=>a.test(e))&&!this.bypassPermissions&&await x.window.showWarningMessage(`Dangerous command: ${e}`,{modal:!0},"Execute","Cancel")!=="Execute")return"Cancelled by user";let h=["ls","cat","pwd","git status","git log","git diff","npm list","echo","which"].some(a=>e.trim().startsWith(a));if(!this.bypassPermissions&&!h&&await x.window.showInformationMessage(`Execute: ${e.substring(0,80)}...`,"Execute","Cancel")!=="Execute")return"Cancelled by user";try{let{stdout:a,stderr:c}=await et(e,{cwd:s,timeout:6e4,maxBuffer:5242880,shell:process.platform==="win32"?"cmd.exe":"/bin/bash"});return(a+c).trim()||"Command executed successfully"}catch(a){throw new Error(a.message)}}async readFile(t){let e=this.resolvePath(t.path);if(!l.existsSync(e))throw new Error(`File not found: ${t.path}`);let n=l.statSync(e);if(n.isDirectory())throw new Error(`Path is a directory: ${t.path}`);if(n.size>1024*1024)throw new Error(`File too large (${(n.size/1024/1024).toFixed(1)}MB)`);let o=l.readFileSync(e,"utf-8").split(`
`);if(t.startLine||t.endLine){let i=Math.max(0,(t.startLine||1)-1),r=Math.min(o.length,t.endLine||o.length);return o.slice(i,r).map((h,a)=>`${i+a+1}\u2502 ${h}`).join(`
`)}return o.length>300?o.slice(0,200).map((i,r)=>`${r+1}\u2502 ${i}`).join(`
`)+`

... (${o.length} lines total)`:o.map((i,r)=>`${r+1}\u2502 ${i}`).join(`
`)}async writeFile(t){let e=this.resolvePath(t.path),n=w.dirname(e);if(!this.bypassPermissions&&await x.window.showInformationMessage(`Create/overwrite: ${t.path}?`,"Yes","No")!=="Yes")return"Cancelled by user";l.existsSync(n)||l.mkdirSync(n,{recursive:!0}),l.writeFileSync(e,t.content,"utf-8");let s=await x.workspace.openTextDocument(e);return await x.window.showTextDocument(s,{preview:!1}),`Created: ${t.path} (${t.content.split(`
`).length} lines)`}async editFile(t){let e=this.resolvePath(t.path);if(!l.existsSync(e))throw new Error(`File not found: ${t.path}`);let n=l.readFileSync(e,"utf-8"),s=n.split(t.oldText).length-1;if(s===0)throw new Error("Text not found in file");if(s>1)throw new Error(`Text found ${s} times. Be more specific.`);if(!this.bypassPermissions&&await x.window.showInformationMessage(`Edit: ${t.path}?`,"Yes","No")!=="Yes")return"Cancelled by user";let o=n.replace(t.oldText,t.newText);l.writeFileSync(e,o,"utf-8");let i=await x.workspace.openTextDocument(e);return await x.window.showTextDocument(i,{preview:!1}),`Edited: ${t.path}`}listDirectory(t){let e=this.resolvePath(t.path);if(!l.existsSync(e))throw new Error(`Directory not found: ${t.path}`);let n=[],s=t.recursive?3:1,o=(i,r,h="")=>{if(!(r>s||n.length>200))try{let a=l.readdirSync(i).sort();for(let c of a){if(I.has(c)||c.startsWith("."))continue;let v=w.join(i,c),u=l.statSync(v).isDirectory(),m=u?"\u{1F4C1}":"\u{1F4C4}";n.push(`${h}${m} ${c}`),u&&t.recursive&&o(v,r+1,h+"  ")}}catch{}};return o(e,0),n.join(`
`)||"Empty directory"}search(t){let e=t.path?this.resolvePath(t.path):this.getWorkspacePath(),n=new RegExp(t.pattern,"gi"),s=[],o=i=>{if(!(s.length>=30))try{let r=l.readdirSync(i);for(let h of r){if(I.has(h)||h.startsWith("."))continue;let a=w.join(i,h),c=l.statSync(a);if(c.isDirectory())o(a);else if(c.isFile()&&c.size<5e5)try{let u=l.readFileSync(a,"utf-8").split(`
`);for(let m=0;m<u.length&&s.length<30;m++)if(n.test(u[m])){let y=w.relative(this.getWorkspacePath(),a);s.push(`${y}:${m+1}: ${u[m].trim().substring(0,80)}`)}}catch{}}}catch{}};return o(e),s.length>0?s.join(`
`):"No matches found"}glob(t){let e=this.getWorkspacePath(),n=new RegExp(t.pattern.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*\*/g,".*").replace(/\*/g,"[^/]*")),s=[],o=(i,r)=>{if(!(s.length>=50))try{let h=l.readdirSync(i);for(let a of h){if(I.has(a))continue;let c=w.join(i,a),v=r?`${r}/${a}`:a;l.statSync(c).isDirectory()?o(c,v):n.test(v)&&s.push(v)}}catch{}};return o(e,""),s.length>0?s.join(`
`):"No files found"}};var z;function st(d){console.log("Claudio Code: Activating...");let t=new A,e=new $;z=new L(d.extensionUri,t,e,d),d.subscriptions.push(b.window.registerWebviewViewProvider("claudio-code.chatView",z,{webviewOptions:{retainContextWhenHidden:!0}}),b.commands.registerCommand("claudio-code.openChat",()=>{b.commands.executeCommand("claudio-code.chatView.focus")}),b.commands.registerCommand("claudio-code.newChat",()=>{z.newChat()}),b.commands.registerCommand("claudio-code.openSettings",()=>{b.commands.executeCommand("workbench.action.openSettings","claudioCode")})),b.workspace.getConfiguration("claudioCode").get("apiKey")||b.window.showWarningMessage("Claudio Code: Configure your API Key in settings.","Open Settings").then(s=>{s==="Open Settings"&&b.commands.executeCommand("workbench.action.openSettings","claudioCode.apiKey")}),console.log("Claudio Code: Activated")}function nt(){console.log("Claudio Code: Deactivated")}0&&(module.exports={activate,deactivate});
