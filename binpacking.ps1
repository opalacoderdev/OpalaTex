$ErrorActionPreference = 'Stop'

Write-Host "=========================================="
Write-Host "       OpalaTex - Gerador de Release      "
Write-Host "=========================================="

$DistDir = Join-Path $PSScriptRoot "dist\OpalaTex"
$ZipName = Join-Path $PSScriptRoot "dist\OpalaTex-windows-x64.zip"
$ReleaseHost = $env:OPALATEX_RELEASE_HOST
$ReleaseUser = $env:OPALATEX_RELEASE_USER
$ReleaseDir = $env:OPALATEX_RELEASE_DIR

if (!$ReleaseHost -or !$ReleaseUser -or !$ReleaseDir) {
    throw "Set OPALATEX_RELEASE_HOST, OPALATEX_RELEASE_USER, and OPALATEX_RELEASE_DIR before publishing."
}

Write-Host "`n[1/3] Verificando se a pasta do executavel foi gerada..."
if (!(Test-Path $DistDir)) {
    Write-Host "Erro: Pasta $DistDir nao encontrada. Rode o build_exe.ps1 primeiro!" -ForegroundColor Red
    exit 1
}

Write-Host "`n[2/3] Compactando o executavel (OpalaTex-windows-x64.zip)..."
if (Test-Path $ZipName) { Remove-Item -Force $ZipName }
# Usamos \* para zipar o CONTEUDO da pasta e garantir que o OpalaTex.exe fique na raiz do ZIP
Compress-Archive -Path "$DistDir\*" -DestinationPath $ZipName -Force

Write-Host "`n[3/3] Fazendo upload para o servidor de releases..."
Write-Host "Isso pode levar alguns minutos. (Digite a senha da VPS quando solicitado)"
ssh "${ReleaseUser}@${ReleaseHost}" "mkdir -p '$ReleaseDir'"
scp $ZipName "${ReleaseUser}@${ReleaseHost}:${ReleaseDir}/"

Write-Host "`n=========================================="
Write-Host "Upload concluido com sucesso!"
Write-Host "Link publico: https://opalacoder.com/downloads/OpalaTex-windows-x64.zip"
Write-Host "O instalador irm https://opalacoder.com/install.ps1 | iex ja esta funcional!"
Write-Host "=========================================="
