#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo 'ASR 构建需要 Apple Silicon Mac'; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo '请先安装 Xcode 命令行工具'; exit 1; }
mkdir -p bin
xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 native/speaker-features.swift native/wake-name.swift native/asr.swift -o bin/asr \
  -framework Accelerate -framework Speech -framework AVFoundation -framework AudioToolbox -framework CoreAudio
chmod +x bin/asr
