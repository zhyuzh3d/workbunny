#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo 'Desktop bridge 构建需要 Apple Silicon Mac'; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo '请先安装 Xcode 命令行工具'; exit 1; }
mkdir -p bin
xcrun swiftc -O -target arm64-apple-macos26.0 native/desktop.swift -o bin/desktop \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework ScreenCaptureKit -framework Vision
chmod 700 bin/desktop
codesign --force --sign - --identifier cn.haminn.workbunny.desktop bin/desktop
codesign --verify --strict bin/desktop
