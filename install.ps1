# =========================================================
# Script de Instalação do OpalaTex para Windows (via PowerShell)
# =========================================================
#
# Atalhos criados:
#   - Desktop do usuário              (~\Desktop\OpalaTex.lnk)
#   - Menu Iniciar do usuário         (~\AppData\...\Programs\OpalaTex.lnk)

$ErrorActionPreference = "Stop"

# 1. Configurações Iniciais
$installDir = "$env:LOCALAPPDATA\OpalaTex"
$tempZip = "$env:TEMP\opalatex_release.zip"

# Link para baixar a release mais recente do repositório oficial
$downloadUrl = "https://github.com/opalacoderdev/OpalaTex/releases/latest/download/OpalaTex-windows-x64.zip"

Write-Host "Iniciando a instalacao do OpalaTex..." -ForegroundColor Cyan

# 2. Criar diretório de instalação
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

# 3. Baixar o arquivo
Write-Host "Baixando a ultima versao do OpalaTex (isso pode levar alguns minutos)..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing

# 4. Extrair os arquivos
Write-Host "Extraindo arquivos para $installDir..." -ForegroundColor Yellow
# O parâmetro -Force sobrescreve versões antigas se o usuário estiver atualizando
Expand-Archive -Path $tempZip -DestinationPath $installDir -Force

# Como o zip gerado na Action foi feito a partir de "dist\OpalaTex",
# o Expand-Archive criará a pasta "$installDir\OpalaTex". Vamos renomear ou ajustar o PATH.
# Se existir $installDir\OpalaTex, o exe estará em $installDir\OpalaTex\OpalaTex.exe
$exeDir = "$installDir\OpalaTex"
if (-not (Test-Path "$exeDir\OpalaTex.exe")) {
    $exeDir = $installDir
}

# 5. Adicionar a pasta do OpalaTex na variável PATH do Windows (se já não estiver)
$userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($userPath -notlike "*$exeDir*") {
    Write-Host "Adicionando OpalaTex ao seu PATH..." -ForegroundColor Yellow
    $newPath = "$userPath;$exeDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, [EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$exeDir"
}

# 6. Criar atalhos (Desktop e Menu Iniciar)
Write-Host "Criando atalhos..." -ForegroundColor Yellow

$exePath  = "$exeDir\OpalaTex.exe"
$wshShell = New-Object -ComObject WScript.Shell

# Atalho no Desktop
# Usa SpecialFolders para obter o caminho real, mesmo que o Desktop esteja
# redirecionado (OneDrive, politicas de grupo, etc.)
$desktopPath          = $wshShell.SpecialFolders("Desktop")
$desktopShortcut      = $wshShell.CreateShortcut("$desktopPath\OpalaTex.lnk")
$desktopShortcut.TargetPath       = $exePath
$desktopShortcut.WorkingDirectory = $exeDir
$desktopShortcut.Description      = "OpalaTex AI Assistant"
$desktopShortcut.IconLocation     = "$exePath,0"
$desktopShortcut.Save()

# Atalho no Menu Iniciar
$startMenuDir = $wshShell.SpecialFolders("Programs")
if (-not (Test-Path $startMenuDir)) {
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
}
$startMenuShortcut      = $wshShell.CreateShortcut("$startMenuDir\OpalaTex.lnk")
$startMenuShortcut.TargetPath       = $exePath
$startMenuShortcut.WorkingDirectory = $exeDir
$startMenuShortcut.Description      = "OpalaTex AI Assistant"
$startMenuShortcut.IconLocation     = "$exePath,0"
$startMenuShortcut.Save()

Write-Host "  -> Desktop: $desktopPath\OpalaTex.lnk" -ForegroundColor DarkGray
Write-Host "  -> Menu Iniciar: $startMenuDir\OpalaTex.lnk" -ForegroundColor DarkGray

# 7. Limpeza
Write-Host "Limpando arquivos temporarios..." -ForegroundColor DarkGray
Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue

# 8. Finalização
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  OpalaTex instalado/atualizado com sucesso!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Atalhos criados:"
Write-Host "  - Desktop" -ForegroundColor Cyan
Write-Host "  - Menu Iniciar" -ForegroundColor Cyan
Write-Host ""
Write-Host "Para abrir o OpalaTex pelo terminal:"
Write-Host "  opalatex" -ForegroundColor Cyan
Write-Host ""
Write-Host "Nota: Se o comando nao for reconhecido, feche este terminal e abra um novo."
