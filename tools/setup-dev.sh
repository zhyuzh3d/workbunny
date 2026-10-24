#!/bin/zsh
# 首次开发配置：把 A1X TTS 密钥与本机模型写进 dev 配置（不进仓库，只写 userData）
cd "$(dirname "$0")/.." || exit 1
mkdir -p .data/dev
echo "请把密钥写进 .data/dev/config.json（见 README）"
