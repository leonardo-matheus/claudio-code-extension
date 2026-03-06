# ClaudioAI for VS Code

AI assistant powered by Claude, integrated directly into VS Code.

## Features

- **Chat Interface**: Similar to GitHub Copilot Chat
- **Code Actions**: Right-click on code to explain, refactor, fix, or generate tests
- **Keyboard Shortcuts**: Quick access with `Ctrl+Shift+C`
- **Context Aware**: Automatically includes workspace and file information

## Quick Start

1. Install the extension
2. Open the ClaudioAI panel in the sidebar (or press `Ctrl+Shift+C`)
3. Start chatting!

## Commands

| Command | Description |
|---------|-------------|
| `Ctrl+Shift+C` | Open ClaudioAI Chat |
| Right-click > ClaudioAI > Explain Code | Explain selected code |
| Right-click > ClaudioAI > Refactor Code | Refactor selected code |
| Right-click > ClaudioAI > Fix Code | Fix bugs in selected code |
| Right-click > ClaudioAI > Generate Tests | Generate tests for selected code |
| Right-click > ClaudioAI > Add Documentation | Add comments/docs to code |

## Configuration

- `claudioai.apiKey`: Your API key
- `claudioai.apiUrl`: API endpoint (default: https://claudioai.dev)
- `claudioai.model`: Model to use (default: claude-opus-4-5)

## Building

```bash
npm install
npm run compile
```

## Packaging

```bash
npm run package
```

This creates a `.vsix` file that can be installed in VS Code.
