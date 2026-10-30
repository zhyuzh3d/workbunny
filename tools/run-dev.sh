#!/bin/zsh
# Development uses .data/dev. Never copy settings into the installed app.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
EA="$ROOT/node_modules/electron/dist/Electron.app"
if [[ "${1:-}" == --direct ]]; then
  shift
  exec env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS BUDDY_PET_HOME="${BUDDY_PET_HOME:-$ROOT/.data/dev}" "$EA/Contents/MacOS/Electron" "$ROOT" "$@"
fi
open -n -a "$EA" --args "$ROOT" "$@"
echo "开发数据：$ROOT/.data/dev；正式资料不会被覆盖。"
