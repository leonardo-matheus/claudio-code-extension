@echo off
title ClaudioAI - Instalador
color 0A

echo.
echo  ========================================
echo       ClaudioAI - VS Code Extension
echo  ========================================
echo.

:: Check if VS Code is installed
where code >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERRO] VS Code nao encontrado!
    echo.
    echo  Por favor, instale o VS Code primeiro:
    echo  https://code.visualstudio.com/download
    echo.
    pause
    exit /b 1
)

echo  [OK] VS Code encontrado
echo.

:: Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
set "VSIX_FILE=%SCRIPT_DIR%claudioai-1.0.0.vsix"

:: Check if VSIX exists
if not exist "%VSIX_FILE%" (
    echo  [ERRO] Arquivo claudioai-1.0.0.vsix nao encontrado!
    echo  Certifique-se que o arquivo .vsix esta na mesma pasta.
    echo.
    pause
    exit /b 1
)

echo  [OK] Arquivo VSIX encontrado
echo.
echo  Instalando ClaudioAI...
echo.

:: Install the extension
code --install-extension "%VSIX_FILE%" --force

if %errorlevel% equ 0 (
    echo.
    echo  ========================================
    echo       INSTALACAO CONCLUIDA!
    echo  ========================================
    echo.
    echo  Reinicie o VS Code para usar o ClaudioAI.
    echo.
    echo  Acesse: View ^> ClaudioAI (na barra lateral)
    echo.
) else (
    echo.
    echo  [ERRO] Falha na instalacao.
    echo  Tente instalar manualmente:
    echo  1. Abra o VS Code
    echo  2. Ctrl+Shift+P
    echo  3. Digite: Extensions: Install from VSIX
    echo  4. Selecione o arquivo .vsix
    echo.
)

pause
