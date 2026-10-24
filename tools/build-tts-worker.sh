#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
COMMIT=620d2225cc436ab0b001e3200e590e3b286ef9ab
SHA=1d4a987d9bd048f6e93107e838026438df70fbde237fc0c69c63d600512b4bd9
CACHE_DIR="${TMPDIR:-/tmp}/workbunny-llama-source-b11669"
if [[ -n "${WORKBUNNY_LLAMA_SOURCE:-}" ]]; then
  SOURCE_DIR="$WORKBUNNY_LLAMA_SOURCE"
else
  mkdir -p "$CACHE_DIR"
  ARCHIVE="$CACHE_DIR/source.tar.gz"
  if [[ ! -f "$ARCHIVE" ]]; then
    curl --fail --location --retry 2 --connect-timeout 15 "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/$COMMIT" -o "$ARCHIVE.part"
    mv "$ARCHIVE.part" "$ARCHIVE"
  fi
  [[ "$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f 1)" = "$SHA" ]] || { echo 'Source checksum mismatch'; exit 1; }
  SOURCE_DIR="$CACHE_DIR/llama.cpp-$COMMIT"
  [[ -d "$SOURCE_DIR" ]] || tar -xzf "$ARCHIVE" -C "$CACHE_DIR"
fi
[[ -x bin/tts/llama-tts ]] || zsh tools/fetch-tts-runtime.sh
xcrun clang++ -std=c++17 -O3 -mmacosx-version-min=13.3 native/qwen-worker.cpp \
  -I"$SOURCE_DIR/common" -I"$SOURCE_DIR/include" -I"$SOURCE_DIR/ggml/include" \
  -I"$SOURCE_DIR/tools/mtmd" -I"$SOURCE_DIR/vendor" \
  -Lbin/tts -lllama-common -lllama -lmtmd -lggml -lggml-base \
  -Wl,-rpath,@loader_path -o bin/tts/workbunny-qwen-worker
