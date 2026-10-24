#!/bin/zsh
# 开发环境一次性准备：给 Electron.app 补上麦克风/语音识别的 usage description
#
# 为什么必须这么做：
#   TCC 校验的是「责任进程」的 Info.plist。dev 模式跑的是
#   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron，
#   它原本没有 NSSpeechRecognitionUsageDescription，子进程一调 SFSpeechRecognizer
#   就 SIGABRT(134)，stdout 一行都不吐 —— 表现为「点麦克风没反应」。
#
# 用法：./tools/dev-prepare.sh   然后运行 ./tools/run-dev.sh
set -e
cd "$(dirname "$0")/.."
ROOT=$PWD
EA="$ROOT/node_modules/electron/dist/Electron.app"
PL="$EA/Contents/Info.plist"

[ -d "$EA" ] || { echo "✗ 找不到 $EA"; exit 1; }

echo "▸ 备份原 Info.plist"
[ -f "$PL.orig" ] || cp "$PL" "$PL.orig"

echo "▸ 写入 usage description"
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$PL" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSSpeechRecognitionUsageDescription" "$PL" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string workbaby（开发版）需要麦克风才能听见你说话。" "$PL"
/usr/libexec/PlistBuddy -c "Add :NSSpeechRecognitionUsageDescription string workbaby（开发版）需要语音识别才能把你说的话变成文字。" "$PL"
/usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string workbaby 需要唤起 WorkBuddy 窗口。" "$PL" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Buddy Pet Dev" "$PL" 2>/dev/null || true

echo "▸ 重新 ad-hoc 签名（改过 plist 会让签名失效）"
codesign --force --deep --sign - "$EA" 2>&1 | grep -v "replacing existing signature" || true

echo "▸ 校验"
codesign -dv "$EA" 2>&1 | grep -E "Identifier|Signature" | head -3
/usr/libexec/PlistBuddy -c "Print :NSSpeechRecognitionUsageDescription" "$PL"
echo "✓ 完成。用 ./tools/run-dev.sh 启动（它走 open，让 Electron 自己是责任进程）"
