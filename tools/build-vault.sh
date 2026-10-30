#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo 'Vault 构建需要 Apple Silicon Mac'; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo '请先安装 Xcode 命令行工具'; exit 1; }
mkdir -p bin
xcrun swiftc -O -target arm64-apple-macos13.0 native/vault.swift -o bin/vault -lsqlite3
chmod 755 bin/vault
