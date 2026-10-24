#!/bin/zsh
# 开发启动器
#
# 关键：必须用 open 启动，让 Electron 自己成为「责任进程」。
#   从 bash 直接 exec electron，TCC 会把责任归到终端/宿主 App 上，
#   宿主 Info.plist 没有语音识别 usage description → 子进程 SIGABRT。
#   open 由 launchd 拉起，责任进程就是 Electron.app，改过 plist 后权限才生效。
#
# 日志：~/Library/Application Support/buddy-pet/buddy.log
# 想直接看 stdout：./tools/run-dev.sh --direct
set -e
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
EA="$ROOT/node_modules/electron/dist/Electron.app"

if [ "$1" = "--direct" ]; then
  shift
  exec env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
    BUDDY_PET_HOME="${BUDDY_PET_HOME:-$ROOT/.data/dev}" \
    "$EA/Contents/MacOS/Electron" "$ROOT" "$@"
fi

pkill -f "$EA/Contents/MacOS/Electron" 2>/dev/null || true

# open 方式拿不到环境变量，userData 回落到默认目录：把 dev 配置搬过去
UD="$HOME/Library/Application Support/WorkBaby"
if [ -f "$ROOT/.data/dev/config.json" ]; then
  mkdir -p "$UD"
  cp "$ROOT/.data/dev/config.json" "$UD/config.json"
  echo "▸ 已同步配置到 $UD/config.json"
fi

open -n -a "$EA" --args "$ROOT" "$@"
echo "▸ 已启动（open 方式）。日志：$UD/buddy.log"
