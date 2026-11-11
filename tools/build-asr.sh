#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo 'ASR 构建需要 Apple Silicon Mac'; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo '请先安装 Xcode 命令行工具'; exit 1; }
mkdir -p bin
vad_build=$(mktemp -d "${TMPDIR:-/tmp}/workbunny-asr-vad.XXXXXX")
trap 'rm -rf "$vad_build"' EXIT
# libfvad preserves an older WebRTC SPL. Keep its adaptive VAD implementation
# independent of AEC3's current SPL without editing either pinned vendor tree.
python3 - "$vad_build/fvad-prefix.h" <<'PY'
import pathlib, re, sys
names = set()
for source in pathlib.Path('native/vendor/libfvad/src').rglob('*'):
    if source.suffix in ('.c', '.h'):
        names.update(re.findall(r'\b(?:WebRtc(?:Vad|Spl)_[A-Za-z0-9_]+|kWebRtc[A-Za-z0-9_]+)\b', source.read_text()))
pathlib.Path(sys.argv[1]).write_text(''.join('#define ' + name + ' WBFvad_' + name + '\n' for name in sorted(names)))
PY
vad_objects=()
for source in native/vendor/libfvad/src/fvad.c native/vendor/libfvad/src/signal_processing/*.c native/vendor/libfvad/src/vad/*.c; do
  object="$vad_build/$(basename "${source%.c}").o"
  xcrun clang -O2 -std=c11 -target arm64-apple-macos26.0 -include "$vad_build/fvad-prefix.h" -I native/vendor/libfvad/include -I native/vendor/libfvad/src -c "$source" -o "$object"
  vad_objects+=("$object")
done
xcrun clang -O2 -std=c11 -target arm64-apple-macos26.0 -include "$vad_build/fvad-prefix.h" -I native/vendor/libfvad/src -c native/speech-vad.c -o "$vad_build/speech-vad.o"
vad_objects+=("$vad_build/speech-vad.o")
xcrun ar rcs "$vad_build/libfvad.a" "${vad_objects[@]}"
echo_library=$(zsh tools/build-echo-cancellation.sh "$vad_build/echo")
xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 -import-objc-header native/asr-bridge.h native/speaker-features.swift native/wake-name.swift native/speech-context.swift native/speech-transcript.swift native/speech-diagnostic.swift native/speech-activity.swift native/speech-endpoint.swift native/audio-pcm-stream.swift native/speech-echo-cancellation.swift native/asr.swift "$vad_build/libfvad.a" "$echo_library" -lc++ -o bin/asr \
  -framework Accelerate -framework Speech -framework AVFoundation -framework AudioToolbox -framework CoreAudio
chmod +x bin/asr
