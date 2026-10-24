#!/bin/sh
# workbunny 看门狗（脱离父进程运行的那个小影子）
#
# 为什么不用 launchd：试过 `launchctl bootstrap gui/501`，连一个最小 plist 都报
# "Bootstrap failed: 5: Input/output error"，这个环境里根本进不去用户的 launchd
# 域。所以自己带一个：主进程开会时把它 spawn 出来并 unref，它就成了独立进程，
# 主进程崩了、被 -9 了、段错误了，它都还活着。
#
# 参数：watchdog.sh <父pid> <app 图标路径> <userData 目录>
#
# 三种情况不重启（很重要，否则主人点了「退出」它又自己爬回来）：
#   .no-restart   开发/临时停用
#   .clean-exit   主进程正常退出的标记
#   父进程还活着（那就什么都不做，正常结束）
set -u

PARENT="$1"
APP="$2"
UD="$3"
CLEAN="$UD/.clean-exit"
STOP="$UD/.no-restart"
LOG="$UD/watchdog.log"

log() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }

# 一直看着，不设上限。
# 以前写了 900×2s = 30 分钟就自己退，结果跑一夜之后其实没人看着了 ——
# 桌宠是常驻的，看护也必须是常驻的。主进程那边每 20 秒心跳会顺手把
# 掉队的看门狗补上，两边互相兜底。
while :; do
  sleep 2
  kill -0 "$PARENT" 2>/dev/null || break
done

if [ -f "$STOP" ]; then log "有 .no-restart，不重启"; exit 0; fi
if [ -f "$CLEAN" ]; then log "父进程是正常退出，不重启"; exit 0; fi

# 再确认一次：刚收到 SIGKILL 时进程可能还没被回收
sleep 1
if kill -0 "$PARENT" 2>/dev/null; then
  log "父进程回来了，不重启"
  exit 0
fi

# 已经有人在跑了就别添乱（重装期间可能被别的路径拉起）。
# 用 -x 精确匹配进程名：-f 匹配整条命令行，会把看门狗自己/安装脚本一起算进去。
if pgrep -x workbunny >/dev/null 2>&1; then
  log "已有实例在跑，不重复启动"
  exit 0
fi

log "父进程 $PARENT 异常消失 —— 重启"
n=0
while [ "$n" -lt 3 ]; do
  n=$((n + 1))
  open -n "$APP" >/dev/null 2>&1
  sleep 4
  if pgrep -x workbunny >/dev/null 2>&1; then
    log "已重启成功（第 $n 次尝试）"
    exit 0
  fi
  # open 偶尔会被 LaunchServices 静默拒绝（返回 0 但没起），
  # 兜底直接跑包内可执行文件 —— 它仍在 .app 里，权限仍按 workbunny 认
  BIN="$APP/Contents/MacOS/workbunny"
  if [ -x "$BIN" ]; then
    env -u ELECTRON_RUN_AS_NODE "$BIN" >/dev/null 2>&1 &
    sleep 5
    if pgrep -x workbunny >/dev/null 2>&1; then
      log "已重启成功（直接执行，第 $n 次尝试）"
      exit 0
    fi
  fi
done
log "重启失败（3 次都没起来），请看 buddy.log"
