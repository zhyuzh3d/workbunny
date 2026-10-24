#!/bin/zsh
# 把 dist/workbunny.app 安装到 ~/Applications 并启动。
#
# 两个踩过的坑（都别改回去）：
#  1) 不能直接在外置卷上跑。工作区在 /Volumes/...，macOS 对 launchd 启动的
#     「外置卷 + ad-hoc 签名」应用直接拒绝：进程起来几百毫秒就没了，连 JS 都不执行。
#     → 必须 ditto 到本机盘再启动。
#  2) 刚 ditto 完不能立刻 open。LaunchServices 还在认旧记录，open 返回 0 但进程活不过两秒。
#     → 复制完先等 10 秒、再 lsregister 一次，然后才启动；起来后要连查两次才算成功。
set -eu
cd "$(dirname "$0")/.." || exit 1
SRC="$PWD/dist/workbunny.app"
DST="$HOME/Applications/workbunny.app"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -d "$SRC" ] || { echo "✗ 先跑 ./tools/package.sh"; exit 1; }

# 重装期间不能让上一任看门狗把旧版本又拉起来
UD="$HOME/Library/Application Support/workbunny"
mkdir -p "$UD"
: > "$UD/.no-restart"
if [ -f "$UD/watchdog.pid" ]; then
  WPID=$(cat "$UD/watchdog.pid")
  if ps -p "$WPID" -o args= 2>/dev/null | grep -q 'workbunny.app/.*watchdog.sh'; then kill "$WPID" 2>/dev/null || true; fi
fi

pkill -f "workbunny.app/Contents/MacOS/workbunny" 2>/dev/null || true
sleep 1
# 装完要让它能自愈，标记在启动前一瞬去掉


echo "▸ 安装到 $DST"
mkdir -p "$HOME/Applications"

# 关键：不要 rm -rf 再复制。清空重建会让 LaunchServices 丢掉旧记录，
# open 返回 0 但进程活不过两秒（实测）。原位 ditto 覆盖则立即生效。
mkdir -p "$DST"
rsync -a --delete "$SRC/" "$DST/"
codesign --verify --deep --strict "$DST"
rm -f "$UD/.no-restart"
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true
[ -x "$LSR" ] && "$LSR" -f "$DST" 2>/dev/null || true
sleep 2

alive() { pgrep -f "workbunny.app/Contents/MacOS/workbunny" >/dev/null 2>&1; }

echo "▸ 启动"
for i in 1 2 3 4 5 6; do
  open -n "$DST" 2>/dev/null || true
  sleep 3
  if alive; then
    sleep 3
    if alive; then
      echo "✓ 已启动 pid=$(pgrep -f 'workbunny.app/Contents/MacOS/workbunny' | head -1)（第 $i 次）"
      echo "  日志：$HOME/Library/Application Support/workbunny/buddy.log"
      exit 0
    fi
  fi
  [ -x "$LSR" ] && "$LSR" -f "$DST" 2>/dev/null || true
  sleep 2
done

# launchd/LaunchServices 偶尔抽风（ditto 覆盖后缓存过期），open 返回 0 却不起。
# 兜底：直接跑包内可执行文件。它仍在 .app 里，TCC / 本地网络仍按 workbunny 认。
echo "▸ open 不行，直接起包内可执行文件"
env -u ELECTRON_RUN_AS_NODE "$DST/Contents/MacOS/workbunny" >/dev/null 2>&1 &
sleep 6
if alive; then
  echo "✓ 已启动（直接执行）pid=$(pgrep -f 'workbunny.app/Contents/MacOS/workbunny' | head -1)"
  exit 0
fi

echo "✗ 启动失败。手动试一下：open -n \"$DST\""
exit 1
