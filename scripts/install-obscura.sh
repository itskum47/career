#!/usr/bin/env bash
set -euo pipefail

# Install the Obscura headless browser binary (optional backend).
# Obscura is a lightweight Rust browser that speaks CDP, so Playwright can
# drive it unchanged. See https://github.com/itskum47/obscura
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH="aarch64" ;;
  x86_64|amd64)  ARCH="x86_64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

# Use upstream (h4ckf0r0day/obscura) for prebuilt binaries; it is CDP-compatible.
URL="https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-${ARCH}-${PLATFORM}.tar.gz"
echo "Downloading $URL"
curl -LO "$URL"
tar xzf "obscura-${ARCH}-${PLATFORM}.tar.gz"
sudo mv obscura /usr/local/bin/obscura 2>/dev/null || mv obscura "$HOME/.local/bin/obscura"
echo "Installed: $(obscura --version 2>/dev/null || echo obscura)"
echo "Enable with BROWSER_BACKEND=obscura in .env"