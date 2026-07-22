#!/usr/bin/env bash
set -e

# OpalaTex Community Edition Linux Installer via Terminal (curl | bash)

echo "=========================================="
echo "      Instalador do OpalaTex (Community)  "
echo "=========================================="

INSTALL_DIR="$HOME/.local/share/OpalaTex"
BIN_DIR="$HOME/.local/bin"
TEMP_FILE="/tmp/opalatex_release.tar.gz"

REPO_OWNER="opalatexdev"
REPO_NAME="OpalaTex"

# Determinar URL de Download (Release do GitHub ou customizada)
if [ -n "$OPALATEX_DOWNLOAD_URL" ]; then
    DOWNLOAD_URL="$OPALATEX_DOWNLOAD_URL"
else
    echo "Buscando a última versão no GitHub ($REPO_OWNER/$REPO_NAME)..."
    LATEST_TAG=$(curl -s "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    
    if [ -n "$LATEST_TAG" ]; then
        DOWNLOAD_URL="https://github.com/$REPO_OWNER/$REPO_NAME/releases/download/$LATEST_TAG/OpalaTex-linux-x64.tar.gz"
    else
        # Fallback direto para a release latest
        DOWNLOAD_URL="https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/OpalaTex-linux-x64.tar.gz"
    fi
fi

echo "Baixando OpalaTex de: $DOWNLOAD_URL"
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_FILE"; then
    echo "Erro ao baixar de $DOWNLOAD_URL. Tentando arquivo .zip..."
    DOWNLOAD_URL="${DOWNLOAD_URL%.tar.gz}.zip"
    TEMP_FILE="/tmp/opalatex_release.zip"
    curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_FILE"
fi

echo "Preparando diretório de instalação em $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

echo "Extraindo arquivos..."
if [[ "$TEMP_FILE" == *.tar.gz ]]; then
    tar -xzf "$TEMP_FILE" -C "$INSTALL_DIR" --strip-components=1 2>/dev/null || tar -xzf "$TEMP_FILE" -C "$INSTALL_DIR"
elif [[ "$TEMP_FILE" == *.zip ]]; then
    unzip -q -o "$TEMP_FILE" -d "$INSTALL_DIR"
fi

# Se houver subpasta extraída, mover conteúdo para a raiz do INSTALL_DIR
if [ -d "$INSTALL_DIR/OpalaTex" ] && [ -f "$INSTALL_DIR/OpalaTex/OpalaTex" ]; then
    mv "$INSTALL_DIR/OpalaTex/"* "$INSTALL_DIR/" 2>/dev/null || true
fi

echo "Criando symlink em $BIN_DIR..."
mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/opalatex"
ln -s "$INSTALL_DIR/OpalaTex" "$BIN_DIR/opalatex"
chmod +x "$INSTALL_DIR/OpalaTex" 2>/dev/null || true
chmod +x "$BIN_DIR/opalatex"

# Criar atalho .desktop para iniciadores de aplicativos (GNOME/KDE/XFCE)
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

cat > "$DESKTOP_DIR/opalatex.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=OpalaTex
Comment=OpalaTex Open-Source AI LaTeX IDE
Exec=$INSTALL_DIR/OpalaTex
Icon=$INSTALL_DIR/icon.png
Terminal=false
Categories=Utility;Development;TextEditor;
EOF

chmod +x "$DESKTOP_DIR/opalatex.desktop"

if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

# Adicionar ~/.local/bin ao PATH se necessário
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "Adicionando $BIN_DIR ao PATH..."
    if [ -f "$HOME/.bashrc" ] && ! grep -q "$BIN_DIR" "$HOME/.bashrc"; then
        echo -e "\n# OpalaTex PATH\nexport PATH=\"$BIN_DIR:\$PATH\"" >> "$HOME/.bashrc"
    fi
    if [ -f "$HOME/.zshrc" ] && ! grep -q "$BIN_DIR" "$HOME/.zshrc"; then
        echo -e "\n# OpalaTex PATH\nexport PATH=\"$BIN_DIR:\$PATH\"" >> "$HOME/.zshrc"
    fi
fi

rm -f "$TEMP_FILE"

echo ""
echo "=========================================="
echo "   OpalaTex instalado com sucesso!       "
echo "=========================================="
echo "Comando no terminal: opalatex"
echo "Atalho no menu de aplicativos criado."
