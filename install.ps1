# =========================================================
# Script de Instalação do OpalaTex (Community) para Windows via PowerShell
# Uso: irm https://raw.githubusercontent.com/opalatexdev/OpalaTex/main/install.ps1 | iex
# =========================================================

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     Instalador do OpalaTex (Community)   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$installDir = "$env:LOCALAPPDATA\OpalaTex"
$tempZip    = "$env:TEMP\opalatex_release.zip"
$repoOwner  = "opalatexdev"
$repoName   = "OpalaTex"

# Determinar URL de download no GitHub Releases
if ($env:OPALATEX_DOWNLOAD_URL) {
    $downloadUrl = $env:OPALATEX_DOWNLOAD_URL
} else {
    Write-Host "Consultando ultima release do GitHub ($repoOwner/$repoName)..." -ForegroundColor Yellow
    try {
        $releaseApi = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/releases/latest" -Headers @{ "User-Agent" = "OpalaTex-Installer" }
        $asset = $releaseApi.assets | Where-Object { $_.name -like "*windows*.zip" } | Select-Object -First 1
        if ($asset) {
            $downloadUrl = $asset.browser_download_url
        } else {
            $downloadUrl = "https://github.com/$repoOwner/$repoName/releases/latest/download/OpalaTex-windows-x64.zip"
        }
    } catch {
        $downloadUrl = "https://github.com/$repoOwner/$repoName/releases/latest/download/OpalaTex-windows-x64.zip"
    }
}

Write-Host "Baixando OpalaTex de: $downloadUrl" -ForegroundColor Yellow

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing

Write-Host "Extraindo arquivos em $installDir..." -ForegroundColor Yellow
Expand-Archive -Path $tempZip -DestinationPath $installDir -Force

$exeDir = "$installDir\OpalaTex"
if (-not (Test-Path "$exeDir\OpalaTex.exe")) {
    $exeDir = $installDir
}

# Adicionar a pasta do OpalaTex no PATH do usuário
$userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($userPath -notlike "*$exeDir*") {
    Write-Host "Adicionando OpalaTex ao PATH..." -ForegroundColor Yellow
    $newPath = "$userPath;$exeDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, [EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$exeDir"
}

# Criar atalhos (Desktop e Menu Iniciar)
Write-Host "Criando atalhos no Desktop e Menu Iniciar..." -ForegroundColor Yellow
$exePath  = "$exeDir\OpalaTex.exe"
$wshShell = New-Object -ComObject WScript.Shell

$desktopPath     = $wshShell.SpecialFolders("Desktop")
$desktopShortcut = $wshShell.CreateShortcut("$desktopPath\OpalaTex.lnk")
$desktopShortcut.TargetPath       = $exePath
$desktopShortcut.WorkingDirectory = $exeDir
$desktopShortcut.Description      = "OpalaTex Open-Source AI LaTeX IDE"
$desktopShortcut.IconLocation     = "$exePath,0"
$desktopShortcut.Save()

$startMenuDir = $wshShell.SpecialFolders("Programs")
if (-not (Test-Path $startMenuDir)) {
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
}
$startMenuShortcut = $wshShell.CreateShortcut("$startMenuDir\OpalaTex.lnk")
$startMenuShortcut.TargetPath       = $exePath
$startMenuShortcut.WorkingDirectory = $exeDir
$startMenuShortcut.Description      = "OpalaTex Open-Source AI LaTeX IDE"
$startMenuShortcut.IconLocation     = "$exePath,0"
$startMenuShortcut.Save()

Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  OpalaTex instalado com sucesso!        " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Comando no terminal: opalatex" -ForegroundColor Cyan
Write-Host "Atalhos criados na Area de Trabalho e Menu Iniciar." -ForegroundColor Cyan
