import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/chatViewProvider';
import { ClaudioClient } from './client/claudioClient';
import { ToolExecutor } from './tools/toolExecutor';

let chatViewProvider: ChatViewProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('Claudio Code: Activating...');

  const client = new ClaudioClient();
  const toolExecutor = new ToolExecutor();

  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    client,
    toolExecutor,
    context
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'claudio-code.chatView',
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),

    vscode.commands.registerCommand('claudio-code.openChat', () => {
      vscode.commands.executeCommand('claudio-code.chatView.focus');
    }),

    vscode.commands.registerCommand('claudio-code.newChat', () => {
      chatViewProvider.newChat();
    }),

    vscode.commands.registerCommand('claudio-code.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudioCode');
    })
  );

  // Check for API key
  const config = vscode.workspace.getConfiguration('claudioCode');
  if (!config.get('apiKey')) {
    vscode.window.showWarningMessage(
      'Claudio Code: Configure your API Key in settings.',
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'claudioCode.apiKey');
      }
    });
  }

  console.log('Claudio Code: Activated');
}

export function deactivate() {
  console.log('Claudio Code: Deactivated');
}
