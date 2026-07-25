#!/usr/bin/env bash
set -euo pipefail

# OpalaTex Community installer for Linux and macOS.

echo "=========================================="
echo "      OpalaTex Installer (Community)      "
echo "=========================================="

INSTALL_DIR="$HOME/.local/share/OpalaTex"
BIN_DIR="$HOME/.local/bin"
REPO_OWNER="opalacoderdev"
REPO_NAME="OpalaTex"

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

case "$OS_NAME" in
    Linux)
        ASSET_NAME="OpalaTex-linux-x64.tar.gz"
        TEMP_FILE="/tmp/opalatex_release.tar.gz"
        ;;
    Darwin)
        ASSET_NAME="OpalaTex-macos-x64.zip"
        TEMP_FILE="/tmp/opalatex_release.zip"
        ;;
    *)
        echo "Unsupported operating system: $OS_NAME" >&2
        exit 1
        ;;
esac

case "$ARCH_NAME" in
    x86_64|amd64)
        ;;
    *)
        echo "Unsupported CPU architecture: $ARCH_NAME. This installer currently requires an x64 release asset." >&2
        exit 1
        ;;
esac

if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install OpalaTex." >&2
    exit 1
fi

if [[ "$ASSET_NAME" == *.zip ]] && ! command -v unzip >/dev/null 2>&1; then
    echo "unzip is required to install OpalaTex on macOS." >&2
    exit 1
fi

download_with_retry() {
    local url="$1"
    local output="$2"
    local max_attempts=3
    local attempt

    for attempt in $(seq 1 "$max_attempts"); do
        rm -f "$output"
        if curl -fL --retry 2 --retry-delay 2 \
            -H "Accept: application/octet-stream" \
            -H "User-Agent: OpalaTex-Installer" \
            "$url" -o "$output"; then
            if [[ -s "$output" ]]; then
                return 0
            fi
        fi

        if [[ "$attempt" -eq "$max_attempts" ]]; then
            echo "Failed to download OpalaTex after $max_attempts attempts." >&2
            return 1
        fi

        echo "Download failed. Retrying ($attempt/$max_attempts)..."
        sleep $((2 * attempt))
    done
}

get_download_url() {
    if [[ -n "${OPALATEX_DOWNLOAD_URL:-}" ]]; then
        if [[ "$OPALATEX_DOWNLOAD_URL" == *"/actions/runs/"*"/artifacts/"* ]]; then
            echo "OPALATEX_DOWNLOAD_URL points to a GitHub Actions artifact. Use a GitHub Release asset URL instead." >&2
            return 1
        fi
        printf '%s\n' "$OPALATEX_DOWNLOAD_URL"
        return 0
    fi

    local latest_url="https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/$ASSET_NAME"
    printf '%s\n' "$latest_url"
}

DOWNLOAD_URL="$(get_download_url)"

echo "Downloading OpalaTex from: $DOWNLOAD_URL"
if ! download_with_retry "$DOWNLOAD_URL" "$TEMP_FILE"; then
    echo "The latest GitHub release must contain $ASSET_NAME before this installer can run." >&2
    exit 1
fi

echo "Preparing install directory at $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

echo "Extracting files..."
case "$TEMP_FILE" in
    *.tar.gz)
        tar -xzf "$TEMP_FILE" -C "$INSTALL_DIR" --strip-components=1 2>/dev/null ||
            tar -xzf "$TEMP_FILE" -C "$INSTALL_DIR"
        ;;
    *.zip)
        unzip -q -o "$TEMP_FILE" -d "$INSTALL_DIR"
        ;;
    *)
        echo "Unsupported archive format: $TEMP_FILE" >&2
        exit 1
        ;;
esac

if [[ -d "$INSTALL_DIR/OpalaTex" && -f "$INSTALL_DIR/OpalaTex/OpalaTex" ]]; then
    find "$INSTALL_DIR/OpalaTex" -mindepth 1 -maxdepth 1 -exec mv -f {} "$INSTALL_DIR/" \;
    rmdir "$INSTALL_DIR/OpalaTex" 2>/dev/null || true
fi

if [[ ! -f "$INSTALL_DIR/OpalaTex" ]]; then
    echo "The downloaded package does not contain the OpalaTex executable." >&2
    exit 1
fi

echo "Creating command symlink in $BIN_DIR..."
mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/OpalaTex" "$BIN_DIR/opalatex"
chmod +x "$INSTALL_DIR/OpalaTex" "$BIN_DIR/opalatex" 2>/dev/null || true

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

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "Adding $BIN_DIR to PATH..."
    if [[ -f "$HOME/.bashrc" ]] && ! grep -q "$BIN_DIR" "$HOME/.bashrc"; then
        printf '\n# OpalaTex PATH\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.bashrc"
    fi
    if [[ -f "$HOME/.zshrc" ]] && ! grep -q "$BIN_DIR" "$HOME/.zshrc"; then
        printf '\n# OpalaTex PATH\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.zshrc"
    fi
fi

rm -f "$TEMP_FILE"

echo ""
echo "=========================================="
echo "   OpalaTex installed successfully!       "
echo "=========================================="
echo "Terminal command: opalatex"
echo "Application launcher created."
