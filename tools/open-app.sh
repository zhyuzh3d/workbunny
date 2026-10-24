#!/bin/zsh
# 用 open 启动打包好的 App，并确保它真的起来了。
#
# 为什么要重试：package.sh 重建 bundle 后，LaunchServices 偶尔要过一会儿才认新路径，
# open 返回 0 但进程根本没起。所以这里 open 完就查进程，没起来再试。
#
# 用法：./tools/open-app.sh [--quit]
set -u
cd "$(dirname "$0")/.." || exit 1
APP="$PWD/dist/workbunny.app"

if [ "${1:-}" = "--quit" ]; then
  pkill -f "workbunny.app/Contents/MacOS/workbunny" 2>/dev/null
  sleep 0.8
fi

for i in 1 2 3 4 5; do
  open -n "$APP" 2>/dev/null
  sleep 1.6
  if pgrep -f "workbunny.app/Contents/MacOS/workbunny" >/dev/null 2>&1; then
    echo "✓ 已启动（第 $i 次尝试）  pid=$(pgrep -f 'workbunny.app/Contents/MacOS/workbunny' | head -1)"
    echo "  日志：$HOME/Library/Application Support/workbunny/buddy.log"
    exit 0
  fi
done

echo "✗ 启动失败：$APP"
exit 1
