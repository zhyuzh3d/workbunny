#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
xcrun swiftc -O -target arm64-apple-macos13.0 native/asr-legacy.swift -o bin/asr-legacy -framework Speech -framework AVFoundation
chmod 755 bin/asr-legacy
