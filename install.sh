#!/usr/bin/env bash
set -e

# Atalhos criados:
#   - Symlink em ~/.local/bin/opalatex             (acesso pelo terminal)
#   - Arquivo .desktop em ~/.local/share/applications/opalatex.desktop
#     (launcher gráfico: GNOME / KDE / XFCE)

echo "=========================================="
echo "Instalador do OpalaTex para Linux"
echo "=========================================="

INSTALL_DIR="$HOME/.local/share/OpalaTex"
BIN_DIR="$HOME/.local/bin"
TEMP_FILE="/tmp/opalatex_release.tar.gz"
DOWNLOAD_URL="https://opalacoder.com/downloads/OpalaTex-linux-x64.tar.gz"

echo "Baixando a última versão do OpalaTex..."
curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_FILE"

echo "Preparando diretórios em $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

echo "Extraindo arquivos..."
tar -xzf "$TEMP_FILE" -C "$INSTALL_DIR" --strip-components=1

echo "Criando symlink em $BIN_DIR..."
mkdir -p "$BIN_DIR"
# Remove o symlink se existir e recria
rm -f "$BIN_DIR/opalatex"
ln -s "$INSTALL_DIR/OpalaTex" "$BIN_DIR/opalatex"
chmod +x "$BIN_DIR/opalatex"

# Criar arquivo .desktop para launchers gráficos (GNOME / KDE / XFCE)
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

cat > "$DESKTOP_DIR/opalatex.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=OpalaTex
Comment=OpalaTex AI Assistant
Exec=$INSTALL_DIR/OpalaTex
Icon=$INSTALL_DIR/icon.png
Terminal=true
Categories=Utility;Development;
EOF

chmod +x "$DESKTOP_DIR/opalatex.desktop"

# Registrar a entrada imediatamente (se disponivel)
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$DESKTOP_DIR"
fi

echo "  -> Terminal: $BIN_DIR/opalatex"
echo "  -> Launcher: $DESKTOP_DIR/opalatex.desktop"

# Verifica se ~/.local/bin está no PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "Adicionando $BIN_DIR ao seu PATH automaticamente..."
    
    # Adiciona no ~/.bashrc
    if [ -f "$HOME/.bashrc" ]; then
        if ! grep -q "$BIN_DIR" "$HOME/.bashrc"; then
            echo -e "\n# Adicionado pelo instalador do OpalaTex\nexport PATH=\"$BIN_DIR:\$PATH\"" >> "$HOME/.bashrc"
        fi
    fi
    
    # Adiciona no ~/.zshrc se existir
    if [ -f "$HOME/.zshrc" ]; then
        if ! grep -q "$BIN_DIR" "$HOME/.zshrc"; then
            echo -e "\n# Adicionado pelo instalador do OpalaTex\nexport PATH=\"$BIN_DIR:\$PATH\"" >> "$HOME/.zshrc"
        fi
    fi
    
    echo "PATH atualizado com sucesso!"
fi

echo "Limpando arquivos temporários..."
rm -f "$TEMP_FILE"

echo ""
echo "=========================================="
echo "OpalaTex instalado com sucesso!"
echo ""
echo "Atalhos criados:"
echo "  - Terminal (symlink):  opalatex"
echo "  - Launcher gráfico:   Procure por 'OpalaTex' no seu menu de aplicativos"
echo ""
echo "Para iniciar pelo terminal, abra um novo terminal e digite:"
echo "  opalatex"
echo "=========================================="
