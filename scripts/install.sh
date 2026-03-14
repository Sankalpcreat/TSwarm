#!/usr/bin/env bash
set -euo pipefail

REPO="Sankalpcreat/TSwarm"
PRODUCT="canvas-terminal"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux) PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected. Use PowerShell installer:"
    echo "  powershell -c \"iwr -useb https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex\""
    exit 1
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
 esac

case "$ARCH" in
  arm64|aarch64) ARCH_KEY="arm64" ;;
  x86_64|amd64) ARCH_KEY="x64" ;;
  *)
    echo "Unsupported arch: $ARCH"
    exit 1
    ;;
 esac

API="https://api.github.com/repos/${REPO}/releases/latest"

ASSET_URL=$(curl -fsSL "$API" | python3 - "$PLATFORM" "$ARCH_KEY" <<'PY'
import json, sys
platform = sys.argv[1]
arch = sys.argv[2]
data = json.load(sys.stdin)
assets = [a.get("browser_download_url") for a in data.get("assets", []) if a.get("browser_download_url")]

def pick(exts, arch_tokens):
    for url in assets:
        if any(url.endswith(ext) for ext in exts) and any(tok in url for tok in arch_tokens):
            return url
    for url in assets:
        if any(url.endswith(ext) for ext in exts):
            return url
    return None

arch_map = {
    "x64": ["x86_64", "x64", "amd64"],
    "arm64": ["aarch64", "arm64"],
}

if platform == "macos":
    url = pick([".dmg", ".app.tar.gz"], arch_map[arch])
elif platform == "linux":
    url = pick([".AppImage", ".appimage"], arch_map[arch])
else:
    url = None

if not url:
    raise SystemExit("No matching release asset found")

print(url)
PY
)

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

file="$tmpdir/asset"

curl -fL "$ASSET_URL" -o "$file"

if [[ "$PLATFORM" == "macos" ]]; then
  if [[ "$ASSET_URL" == *.dmg ]]; then
    mnt="$tmpdir/mnt"
    mkdir -p "$mnt"
    hdiutil attach -nobrowse -quiet "$file" -mountpoint "$mnt"
    app_path=$(find "$mnt" -maxdepth 2 -name "*.app" -print | head -n 1)
    if [[ -z "$app_path" ]]; then
      echo "No .app found in dmg"
      hdiutil detach -quiet "$mnt" || true
      exit 1
    fi
    cp -R "$app_path" "/Applications/${PRODUCT}.app" || cp -R "$app_path" /Applications/
    hdiutil detach -quiet "$mnt" || true
  else
    tar -xzf "$file" -C "$tmpdir"
    app_path=$(find "$tmpdir" -maxdepth 3 -name "*.app" -print | head -n 1)
    if [[ -z "$app_path" ]]; then
      echo "No .app found in archive"
      exit 1
    fi
    cp -R "$app_path" "/Applications/${PRODUCT}.app" || cp -R "$app_path" /Applications/
  fi
  echo "Installed to /Applications"
elif [[ "$PLATFORM" == "linux" ]]; then
  mkdir -p "$HOME/.local/bin"
  dest="$HOME/.local/bin/${PRODUCT}"
  mv "$file" "$dest"
  chmod +x "$dest"
  echo "Installed to $dest"
  echo "Ensure ~/.local/bin is in your PATH"
fi
