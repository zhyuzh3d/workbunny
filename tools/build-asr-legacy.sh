#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
xcrun swiftc -O -parse-as-library -target arm64-apple-macos13.0 native/speaker-features.swift native/wake-name.swift native/asr-legacy.swift -o bin/asr-legacy -framework Accelerate -framework Speech -framework AVFoundation
chmod 755 bin/asr-legacy
