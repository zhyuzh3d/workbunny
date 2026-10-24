#!/bin/zsh
# Pinned speech.cpp CustomVoice runtime. Weights are downloaded separately.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" = arm64 ]] || { echo 'CustomVoice requires an Apple Silicon Mac'; exit 1; }
TAG=0.8.11
SHA=85471d762535cfdb52e962a10542bb6aa6a039f559bee62703c1eb2d274b8125
TEMP_DIR=$(mktemp -d -t workbunny-speech)
trap 'rm -rf "$TEMP_DIR"' EXIT
curl --fail --location --retry 2 --connect-timeout 15 "https://github.com/nyosegawa/speech.cpp/releases/download/v$TAG/speech-$TAG-macos-arm64-metal.zip" -o "$TEMP_DIR/runtime.zip"
ACTUAL=$(shasum -a 256 "$TEMP_DIR/runtime.zip" | cut -d ' ' -f 1)
[[ "$ACTUAL" = "$SHA" ]] || { echo 'Runtime checksum mismatch'; exit 1; }
unzip -q "$TEMP_DIR/runtime.zip" -d "$TEMP_DIR/unpacked"
mkdir -p bin/speech
cp "$TEMP_DIR/unpacked/speech" bin/speech/speech
curl --fail --location --retry 2 "https://raw.githubusercontent.com/nyosegawa/speech.cpp/v$TAG/LICENSE" -o bin/speech/LICENSE
printf '{"upstream":"nyosegawa/speech.cpp","tag":"v%s","arch":"arm64-metal","archiveSha256":"%s"}\n' "$TAG" "$SHA" > bin/speech/runtime.json
chmod +x bin/speech/speech
bin/speech/speech --help >/dev/null
