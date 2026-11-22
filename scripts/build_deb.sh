#!/usr/bin/env bash
set -euo pipefail
umask 022

# Build a Debian/Ubuntu/Linux Mint (.deb) package from an already-built
# Linux PyInstaller bundle (dist/OpalaTex).
#
# Intended to run inside an Ubuntu 22.04 (Jammy, glibc 2.35) environment so the
# resulting package runs on Linux Mint 21 as well as newer releases (Mint 22,
# Ubuntu 24.04/26.04).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUNDLE_DIR="$REPO_ROOT/dist/OpalaTex"
OUTPUT_DIR="$REPO_ROOT"
ARCH="amd64"
MAX_GLIBC="2.35"
VERSION=""

usage() {
    cat <<'EOF'
Usage: scripts/build_deb.sh [options]

Options:
  --bundle-dir <dir>    PyInstaller dist directory (default: dist/OpalaTex)
  --output-dir <dir>    Directory to write the .deb file (default: repo root)
  --version <ver>       Package version (default: read from pyproject.toml)
  --arch <arch>         Debian architecture (default: amd64)
  --max-glibc <X.Y>     Maximum allowed GLIBC version in bundled ELFs (default: 2.35)
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bundle-dir)
            BUNDLE_DIR="$2"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --arch)
            ARCH="$2"
            shift 2
            ;;
        --max-glibc)
            MAX_GLIBC="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ ! -d "$BUNDLE_DIR" ]]; then
    echo "ERROR: Bundle directory does not exist: $BUNDLE_DIR" >&2
    exit 1
fi

if [[ ! -f "$BUNDLE_DIR/OpalaTex" ]]; then
    echo "ERROR: Bundle executable not found: $BUNDLE_DIR/OpalaTex" >&2
    exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "ERROR: dpkg-deb is required to build a .deb package." >&2
    exit 1
fi

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
    if command -v python >/dev/null 2>&1; then
        PYTHON_BIN="python"
    elif command -v python3 >/dev/null 2>&1; then
        PYTHON_BIN="python3"
    else
        echo "ERROR: python or python3 is required." >&2
        exit 1
    fi
fi

if [[ -z "$VERSION" ]]; then
    VERSION="$("$PYTHON_BIN" -c '
import pathlib, re
text = pathlib.Path("'"$REPO_ROOT"'/pyproject.toml").read_text(encoding="utf-8")
match = re.search(r"(?m)^version\s*=\s*\"([^\"]+)\"", text)
if not match:
    raise SystemExit("Could not find version in pyproject.toml")
print(match.group(1))
')"
fi

if [[ -z "$VERSION" ]]; then
    echo "ERROR: Package version could not be determined." >&2
    exit 1
fi

echo "Checking bundled ELF binaries against GLIBC_${MAX_GLIBC} ceiling..."
"$PYTHON_BIN" - "$REPO_ROOT/scripts/check_bundle_libraries.py" "$BUNDLE_DIR" "$MAX_GLIBC" <<'PY'
import importlib.util
import sys
from pathlib import Path

gate_path = Path(sys.argv[1])
bundle = Path(sys.argv[2])
max_glibc = tuple(int(part) for part in sys.argv[3].split("."))

spec = importlib.util.spec_from_file_location("check_bundle_libraries", gate_path)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

problems = gate.glibc_problems(bundle, max_glibc=max_glibc)
if problems:
    for problem in problems:
        print(f"ERROR: {problem}", file=sys.stderr)
    sys.exit(1)

print(f"All ELF binaries in {bundle} are within GLIBC_{sys.argv[3]}.")
PY

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
chmod 0755 "$STAGE_DIR"

APP_DIR="$STAGE_DIR/opt/opalatex"
mkdir -p \
    "$STAGE_DIR/DEBIAN" \
    "$APP_DIR" \
    "$STAGE_DIR/usr/bin" \
    "$STAGE_DIR/usr/share/applications" \
    "$STAGE_DIR/usr/share/pixmaps"
chmod 0755 "$STAGE_DIR/DEBIAN"

# Copy PyInstaller payload preserving symlinks and permissions.
cp -a "$BUNDLE_DIR"/. "$APP_DIR/"
chmod 0755 "$APP_DIR/OpalaTex"

# Remove direct-install uninstaller scripts from the .deb payload so removal is
# managed exclusively by dpkg/apt.
rm -f "$APP_DIR/uninstall.sh" "$APP_DIR/_internal/uninstall.sh"

# Strip core host system libraries that PyInstaller copies from Ubuntu 22.04.
# Because PyInstaller prepends `_internal` to LD_LIBRARY_PATH, shipping Ubuntu
# 22.04's libstdc++.so.6 (max GLIBCXX_3.4.30) shadows Ubuntu 24.04 / Linux Mint
# 22's GCC 14 libstdc++, breaking host Mesa/LLVM (which needs GLIBCXX_3.4.32)
# and aborting Qt with "Could not initialize GLX". Similarly, bundling GLib 2.72
# shadows Mint 22's GLib 2.80 and breaks host GVFS modules
# (`g_task_set_static_name`). Every library removed here is backward-compatible
# and declared in DEBIAN/control's Depends so apt guarantees it on Mint 21+.
for host_lib in \
    libstdc++.so.6 \
    libgcc_s.so.1 \
    libmvec.so.1 \
    libgbm.so.1 \
    libglib-2.0.so.0 \
    libgio-2.0.so.0 \
    libgobject-2.0.so.0 \
    libgmodule-2.0.so.0 \
    libgthread-2.0.so.0 \
    libexpat.so.1 \
    libffi.so.8 \
    libz.so.1 \
    libzstd.so.1 \
    liblzma.so.5 \
    libpcre2-8.so.0 \
    libmount.so.1 \
    libblkid.so.1 \
    libselinux.so.1 \
    libuuid.so.1 \
    libsystemd.so.0 \
    libudev.so.1 \
    libdbus-1.so.3; do
    rm -f "$APP_DIR/$host_lib" "$APP_DIR/_internal/$host_lib"
done

ln -s /opt/opalatex/OpalaTex "$STAGE_DIR/usr/bin/opalatex"

ICON_SRC=""
for candidate in \
    "$REPO_ROOT/icon.png" \
    "$REPO_ROOT/AppIcons/OpalaTexArt1024.png" \
    "$APP_DIR/_internal/icon.png" \
    "$APP_DIR/icon.png"; do
    if [[ -f "$candidate" ]]; then
        ICON_SRC="$candidate"
        break
    fi
done

if [[ -z "$ICON_SRC" ]]; then
    echo "ERROR: Could not locate application icon (icon.png)." >&2
    exit 1
fi

install -m 0644 "$ICON_SRC" "$STAGE_DIR/usr/share/pixmaps/opalatex.png"

# Install standard hicolor icon sizes when Pillow is available so Cinnamon/Mint
# and other desktop environments pick up sharp theme icons immediately.
"$PYTHON_BIN" - "$ICON_SRC" "$STAGE_DIR/usr/share/icons/hicolor" <<'PY'
import sys
from pathlib import Path

icon_src = Path(sys.argv[1])
hicolor_root = Path(sys.argv[2])

try:
    from PIL import Image
except ImportError:
    sys.exit(0)

with Image.open(icon_src) as img:
    rgba = img.convert("RGBA")
    for size in (128, 256, 512):
        out_dir = hicolor_root / f"{size}x{size}" / "apps"
        out_dir.mkdir(parents=True, exist_ok=True)
        resized = rgba.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(out_dir / "opalatex.png", format="PNG")
PY

cat > "$STAGE_DIR/usr/share/applications/opalatex.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=OpalaTex
Comment=Free, open-source AI agent for your projects
Exec=/usr/bin/opalatex
Icon=opalatex
Terminal=false
Categories=Development;Office;TextEditor;Utility;
StartupNotify=true
EOF
chmod 0644 "$STAGE_DIR/usr/share/applications/opalatex.desktop"

INSTALLED_SIZE="$(du -sk "$STAGE_DIR/opt" "$STAGE_DIR/usr" | awk '{sum += $1} END {print sum}')"

cat > "$STAGE_DIR/DEBIAN/control" <<EOF
Package: opalatex
Version: ${VERSION}
Section: editors
Priority: optional
Architecture: ${ARCH}
Maintainer: Gilzamir Gomes <opalacoderdev@users.noreply.github.com>
Homepage: https://github.com/opalacoderdev/OpalaTex
Installed-Size: ${INSTALLED_SIZE}
Depends: libc6 (>= ${MAX_GLIBC}), libstdc++6, libgcc-s1, zlib1g, libzstd1, liblzma5, libpcre2-8-0, libmount1, libblkid1, libselinux1, libuuid1, libsystemd0, libudev1, libffi8, libgmp10, libgraphite2-3, libssl3 | libssl3t64, libglib2.0-0 | libglib2.0-0t64, libgl1, libegl1, libopengl0, libdrm2, libgbm1, libx11-6, libx11-xcb1, libxcb1, libxcb-dri3-0, libxcb-glx0, libxcomposite1, libxdamage1, libxfixes3, libxi6, libxrandr2, libxrender1, libxshmfence1, libxtst6, libxkbcommon0, libxkbfile1, libwayland-client0, libnss3, libnspr4, libdbus-1-3, libexpat1, libfontconfig1, libfreetype6, libasound2 | libasound2t64, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libcups2 | libcups2t64
Recommends: espeak-ng, libespeak-ng1, git, xdg-utils, libglib2.0-bin
Description: Free, open-source AI agent workspace for your projects
 OpalaTex is a free, open-source AI agent workspace with a desktop editor,
 integrated terminal, Git checkpoints, Markdown/PDF/LaTeX tooling, background
 monitors, and a command-line interface.
EOF
chmod 0644 "$STAGE_DIR/DEBIAN/control"

cat > "$STAGE_DIR/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postinst"

cat > "$STAGE_DIR/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postrm"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DEB="$OUTPUT_DIR/opalatex_${VERSION}_${ARCH}.deb"
rm -f "$OUTPUT_DEB"

echo "Building $OUTPUT_DEB..."
dpkg-deb --root-owner-group -Zxz --build "$STAGE_DIR" "$OUTPUT_DEB"

echo "Built package: $OUTPUT_DEB"
