#!/bin/zsh
# Reproducible arm64 baseline: no host-specific CPU instructions or macOS 13.3 BLAS API.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo '需要 Apple Silicon Mac'; exit 1; }
TAG=v0.8.11
COMMIT=c4bdcd0e751bd29460cb1353e6d54499828a1d90
CACHE="${WORKBUNNY_BUILD_CACHE:-$HOME/Library/Caches/workbunny-build}"
SOURCE="$CACHE/speech-$TAG"
if [[ ! -d "$SOURCE/.git" ]]; then
  mkdir -p "$CACHE"
  git clone --depth 1 --branch "$TAG" --recurse-submodules --shallow-submodules https://github.com/nyosegawa/speech.cpp.git "$SOURCE"
fi
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$COMMIT" ]] || { echo '源码版本不匹配'; exit 1; }
[[ -z "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ]] || { echo '运行时源码有修改，已停止'; exit 1; }
BUILD="$SOURCE/build-macos13-portable"
cmake -S "$SOURCE" -B "$BUILD" -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a -DGGML_BLAS=OFF "-DCMAKE_C_FLAGS=-ffile-prefix-map=$SOURCE=." "-DCMAKE_CXX_FLAGS=-ffile-prefix-map=$SOURCE=."
cmake --build "$BUILD" --target speech-cli -j 4
mkdir -p bin/speech/licenses
cp "$BUILD/speech" bin/speech/speech
cp "$SOURCE/LICENSE" bin/speech/LICENSE
cp "$SOURCE/ggml/LICENSE" bin/speech/licenses/ggml-LICENSE
cp "$SOURCE/vendor/miniaudio/LICENSE" bin/speech/licenses/miniaudio-LICENSE
cp "$SOURCE/vendor/cpp-httplib/LICENSE" bin/speech/licenses/cpp-httplib-LICENSE
python3 - "$COMMIT" <<'PY'
import hashlib,json,sys
from pathlib import Path
p=Path('bin/speech/speech')
Path('bin/speech/runtime.json').write_text(json.dumps(dict(upstream='nyosegawa/speech.cpp',tag='v0.8.11',commit=sys.argv[1],arch='arm64',minimumMacOS='13.0',cpuArch='armv8.2-a',blas=False,binarySha256=hashlib.sha256(p.read_bytes()).hexdigest()),indent=2)+'\n')
PY
bin/speech/speech --help >/dev/null
