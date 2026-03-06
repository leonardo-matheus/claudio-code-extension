# ClaudioAI VS Code Extension Installer
# Execute com: powershell -ExecutionPolicy Bypass -File install-claudioai.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "       ClaudioAI - VS Code Extension" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$VSIX_NAME = "claudioai-1.0.0.vsix"
$GITHUB_RELEASE_URL = "https://github.com/gustavogouveia1/claudioai-vscode/releases/latest/download/$VSIX_NAME"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$VSIX_LOCAL = Join-Path $SCRIPT_DIR $VSIX_NAME
$TEMP_VSIX = Join-Path $env:TEMP $VSIX_NAME

# Check if VS Code is installed
$codePath = Get-Command code -ErrorAction SilentlyContinue
if (-not $codePath) {
    Write-Host "  [ERRO] VS Code nao encontrado!" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Por favor, instale o VS Code primeiro:" -ForegroundColor Yellow
    Write-Host "  https://code.visualstudio.com/download" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "  Pressione Enter para sair"
    exit 1
}

Write-Host "  [OK] VS Code encontrado" -ForegroundColor Green

# Try to find VSIX file
$vsixPath = $null

# Option 1: Local file in same directory
if (Test-Path $VSIX_LOCAL) {
    Write-Host "  [OK] Arquivo VSIX local encontrado" -ForegroundColor Green
    $vsixPath = $VSIX_LOCAL
}
# Option 2: Download from GitHub
else {
    Write-Host "  [..] Baixando extensao do GitHub..." -ForegroundColor Yellow
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $GITHUB_RELEASE_URL -OutFile $TEMP_VSIX -UseBasicParsing
        Write-Host "  [OK] Download concluido" -ForegroundColor Green
        $vsixPath = $TEMP_VSIX
    }
    catch {
        Write-Host "  [ERRO] Falha no download: $_" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Coloque o arquivo $VSIX_NAME na mesma pasta deste script." -ForegroundColor Yellow
        Write-Host ""
        Read-Host "  Pressione Enter para sair"
        exit 1
    }
}

Write-Host ""
Write-Host "  Instalando ClaudioAI..." -ForegroundColor Cyan
Write-Host ""

# Install extension
try {
    $process = Start-Process -FilePath "code" -ArgumentList "--install-extension", "`"$vsixPath`"", "--force" -Wait -PassThru -NoNewWindow

    if ($process.ExitCode -eq 0) {
        Write-Host ""
        Write-Host "  ========================================" -ForegroundColor Green
        Write-Host "       INSTALACAO CONCLUIDA!" -ForegroundColor Green
        Write-Host "  ========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "  Reinicie o VS Code para usar o ClaudioAI." -ForegroundColor White
        Write-Host ""
        Write-Host "  Acesse: View > ClaudioAI (na barra lateral)" -ForegroundColor White
        Write-Host ""
    }
    else {
        throw "Codigo de saida: $($process.ExitCode)"
    }
}
catch {
    Write-Host ""
    Write-Host "  [ERRO] Falha na instalacao: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Tente instalar manualmente:" -ForegroundColor Yellow
    Write-Host "  1. Abra o VS Code" -ForegroundColor White
    Write-Host "  2. Ctrl+Shift+P" -ForegroundColor White
    Write-Host "  3. Digite: Extensions: Install from VSIX" -ForegroundColor White
    Write-Host "  4. Selecione o arquivo .vsix" -ForegroundColor White
    Write-Host ""
}

# Cleanup temp file
if (Test-Path $TEMP_VSIX) {
    Remove-Item $TEMP_VSIX -Force -ErrorAction SilentlyContinue
}

Read-Host "  Pressione Enter para sair"
