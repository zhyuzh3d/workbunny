#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data/dev
chmod 700 .data/dev
echo '开发数据独立保存在 .data/dev。启动后连接 WorkBuddy；语音默认使用系统音色。'
