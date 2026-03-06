import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { ClaudioClient } from './claudioClient';

let chatViewProvider: ChatViewProvider;

export function activate(context: vscode.ExtensionContext) {
    const client = new ClaudioClient();
    chatViewProvider = new ChatViewProvider(context.extensionUri, client, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'claudioai.chatView',
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.commands.registerCommand('claudioai.openChat', () => {
            vscode.commands.executeCommand('claudioai.chatView.focus');
        }),
        vscode.commands.registerCommand('claudioai.newChat', () => {
            chatViewProvider.newChat();
        })
    );
}

export function deactivate() {}
