#!/usr/bin/env bash
set -e

echo "=========================================="
echo "       OpalaTex - Build do Executavel       "
echo "=========================================="

echo -e "\n[1/4] Instalando dependencias e PyInstaller..."
pip install pyinstaller wheel setuptools

echo -e "\n[2/4] Construindo o frontend (React/Vite)..."
pushd gui_src > /dev/null
npm install
npm run build
popd > /dev/null

echo -e "\n[3/4] Limpando diretorios de build antigos..."
rm -rf build

echo -e "\n[3.5/4] Baixando Tectonic para o empacotamento..."
mkdir -p bin
OS_NAME=$(uname -s)
ARCH_NAME=$(uname -m)

if [ "$OS_NAME" = "Darwin" ]; then
    if [ "$ARCH_NAME" = "arm64" ]; then
        TECTONIC_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-aarch64-apple-darwin.tar.gz"
    else
        TECTONIC_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-apple-darwin.tar.gz"
    fi
else
    # Assuming Linux x86_64
    TECTONIC_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz"
fi

echo "Fazendo download de $TECTONIC_URL"
curl -L $TECTONIC_URL -o tectonic.tar.gz
tar -xzf tectonic.tar.gz -C bin
rm tectonic.tar.gz

echo -e "\n[4/4] Empacotando com PyInstaller..."
# A sintaxe de --add-data no Linux/macOS usa dois pontos (:)
pyinstaller --name "OpalaTex" \
            --windowed \
            --icon="icon.png" \
            --add-data="opalatex/gui:opalatex/gui" \
            --add-data="opalatex/assetstore:opalatex/assetstore" \
            --add-data="opalatex/templates:opalatex/templates" \
            --add-data="config.yaml:." \
            --add-data="skills:skills" \
            --add-data="version_info.txt:." \
            --collect-all "litellm" \
            --collect-all "tiktoken" \
            --collect-all "tiktoken_ext" \
            --copy-metadata "tiktoken" \
            --collect-all "certifi" \
            --collect-all "httpx" \
            --collect-all "aiohttp" \
            --collect-all "requests" \
            --collect-all "chromadb" \
            --collect-all "duckduckgo_search" \
            --collect-all "instructor" \
            --collect-all "agenticblocks" \
            --collect-all "webview" \
            --collect-all "pythonnet" \
            --collect-all "clr_loader" \
            --collect-all "PyQt6" \
            --collect-all "PyQt6-WebEngine" \
            --collect-all "pymupdf" \
            --collect-all "pymupdf4llm" \
            --collect-all "tree_sitter" \
            --collect-all "tree_sitter_language_pack" \
            --noconfirm \
            --clean \
            main.py

echo -e "\n=========================================="
echo "Build concluido com sucesso!"
echo "O executavel pode ser encontrado em: ./dist/OpalaTex/OpalaTex"
echo "=========================================="
