$ErrorActionPreference = "Stop"

Write-Host "=========================================="
Write-Host "       OpalaTex - Build do Executavel       "
Write-Host "=========================================="

Write-Host "`n[1/4] Instalando PyInstaller e dependencias..."
pip install pyinstaller wheel setuptools

Write-Host "`n[2/4] Construindo o frontend (React/Vite)..."
Push-Location gui_src
try {
    npm install
    npm run build
} finally {
    Pop-Location
}

Write-Host "`n[3/4] Limpando diretórios de build antigos..."
if (Test-Path "build") { Remove-Item -Recurse -Force "build" }
# We let PyInstaller handle the dist folder overwriting because Remove-Item fails if File Explorer is open

Write-Host "`n[3.5/4] Baixando Tectonic (Windows) para o empacotamento..."
if (!(Test-Path "bin")) { New-Item -ItemType Directory -Force -Path "bin" | Out-Null }
$tectonicZip = "tectonic-windows.zip"
$tectonicUrl = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip"
Write-Host "Fazendo download de $tectonicUrl"
Invoke-WebRequest -Uri $tectonicUrl -OutFile $tectonicZip
Expand-Archive -Path $tectonicZip -DestinationPath "bin" -Force
Remove-Item -Force $tectonicZip

Write-Host "`n[4/4] Empacotando com PyInstaller..."
# Find winpty-agent.exe dynamically to avoid hardcoding .venv path
$winptyAgentPath = python -c "import winpty, os; print(os.path.join(os.path.dirname(winpty.__file__), 'winpty-agent.exe'))"

# A sintaxe de --add-data no Windows usa ponto-e-virgula (;)
pyinstaller --name "OpalaTex" `
            --windowed `
            --icon="icon.png" `
            --add-data="opalatex/gui;opalatex/gui" `
            --add-data="opalatex/assetstore;opalatex/assetstore" `
            --add-data="config.yaml;." `
            --add-data="skills;skills" `
            --add-data="version_info.txt;." `
            --collect-all "litellm" `
            --collect-all "tiktoken" `
            --collect-all "tiktoken_ext" `
            --copy-metadata "tiktoken" `
            --collect-all "certifi" `
            --collect-all "httpx" `
            --collect-all "aiohttp" `
            --collect-all "requests" `
            --collect-all "chromadb" `
            --collect-all "duckduckgo_search" `
            --collect-all "instructor" `
            --collect-all "agenticblocks" `
            --collect-all "webview" `
            --collect-all "pythonnet" `
            --collect-all "clr_loader" `
            --collect-all "PyQt6" `
            --collect-all "PyQt6-WebEngine" `
            --collect-all "winpty" `
            --collect-all "pymupdf" `
            --collect-all "pymupdf4llm" `
            --collect-all "tree_sitter" `
            --collect-all "tree_sitter_language_pack" `
            --add-binary "$winptyAgentPath;winpty" `
            --noconfirm `
            --clean `
            main.py

Write-Host "`n=========================================="
Write-Host "Build concluido com sucesso!"
Write-Host "O executavel pode ser encontrado em: .\dist\OpalaTex\OpalaTex.exe"
Write-Host "=========================================="
