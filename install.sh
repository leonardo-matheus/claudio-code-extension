#!/bin/bash

echo ""
echo "========================================"
echo "   ClaudioAI VS Code Extension"
echo "========================================"
echo ""

cd "$(dirname "$0")"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERRO] Node.js não encontrado!"
    echo "Instale Node.js de https://nodejs.org"
    exit 1
fi

echo "[1/4] Installing dependencies..."
npm install

echo "[2/4] Compiling TypeScript..."
npm run compile

echo "[3/4] Installing vsce..."
npm install -g @vscode/vsce

echo "[4/4] Packaging extension..."
vsce package

echo ""
echo "========================================"
echo "[SUCESSO] Extension packaged!"
echo ""
echo "Para instalar no VS Code:"
echo "  1. Abra o VS Code"
echo "  2. Pressione Ctrl+Shift+P"
echo "  3. Digite 'Install from VSIX'"
echo "  4. Selecione o arquivo .vsix"
echo "========================================"
echo ""
