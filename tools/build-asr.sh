#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo 'ASR 构建需要 Apple Silicon Mac'; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo '请先安装 Xcode 命令行工具'; exit 1; }
mkdir -p bin
vad_build=$(mktemp -d "${TMPDIR:-/tmp}/workbunny-asr-vad.XXXXXX")
trap 'rm -rf "$vad_build"' EXIT
vad_objects=()
for source in native/vendor/libfvad/src/fvad.c native/vendor/libfvad/src/signal_processing/*.c native/vendor/libfvad/src/vad/*.c; do
  object="$vad_build/$(basename "${source%.c}").o"
  xcrun clang -O2 -std=c11 -target arm64-apple-macos26.0 -I native/vendor/libfvad/include -I native/vendor/libfvad/src -c "$source" -o "$object"
  vad_objects+=("$object")
done
xcrun ar rcs "$vad_build/libfvad.a" "${vad_objects[@]}"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 -I native/vendor/libfvad native/speaker-features.swift native/wake-name.swift native/speech-transcript.swift native/speech-diagnostic.swift native/speech-activity.swift native/speech-endpoint.swift native/asr.swift "$vad_build/libfvad.a" -o bin/asr \
  -framework Accelerate -framework Speech -framework AVFoundation -framework AudioToolbox -framework CoreAudio
chmod +x bin/asr
