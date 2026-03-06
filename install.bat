@echo off
title ClaudioAI VS Code Extension - Install

echo.
echo ========================================
echo    ClaudioAI VS Code Extension
echo ========================================
echo.

cd /d "%~dp0"

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado!
    echo Instale Node.js de https://nodejs.org
    pause
    exit /b 1
)

echo [1/4] Installing dependencies...
call npm install

echo [2/4] Compiling TypeScript...
call npm run compile

echo [3/4] Installing vsce...
call npm install -g @vscode/vsce

echo [4/4] Packaging extension...
call vsce package

echo.
echo ========================================
echo [SUCESSO] Extension packaged!
echo.
echo Para instalar no VS Code:
echo   1. Abra o VS Code
echo   2. Pressione Ctrl+Shift+P
echo   3. Digite "Install from VSIX"
echo   4. Selecione o arquivo .vsix
echo ========================================
echo.
pause
