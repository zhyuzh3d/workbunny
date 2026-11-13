#!/bin/zsh
# Prepare only BOPER's native components; the development Electron stays intact.
set -euo pipefail
cd "$(dirname "$0")/.."
IDENTITY="${WORKBUNNY_SIGN_IDENTITY:-workbunny Dev}"
security find-identity -p codesigning | /usr/bin/grep -F "$IDENTITY" >/dev/null
zsh tools/build-boper.sh
for component in boper-runtime boper-hid-helper boper-control.node; do
  case "$component" in
    boper-runtime) suffix=boper-runtime ;;
    boper-hid-helper) suffix=boper-hid ;;
    boper-control.node) suffix=boper-control ;;
  esac
  codesign --force --sign "$IDENTITY" --identifier "cn.haminn.workbunny.$suffix" "build/native/$component"
  codesign --verify --strict "build/native/$component"
done
"${WORKBUNNY_NODE_BINARY:-node}" tools/boper-build-manifest.cjs "$PWD/build/native"
echo 'BOPER 开发组件已就绪；启动开发版后在键鼠设置中启用或更新后台组件。'
