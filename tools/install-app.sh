#!/bin/zsh
# Local install with a verified staging bundle and rollback copy. User data stays put.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$PWD/dist/workbunny.app"
DESTINATION="${WORKBUNNY_INSTALL_DIR:-$HOME/Applications}"
DST="$DESTINATION/workbunny.app"
[[ -d "$SRC" ]] || { echo '先运行 tools/package.sh'; exit 1; }
codesign --verify --deep --strict "$SRC"
if [[ -f "$DST/Contents/MacOS/workbunny" ]] && lsof -t "$DST/Contents/MacOS/workbunny" >/dev/null 2>&1; then
  echo '请先正常退出 Bunny，再运行安装；不会强制中断资料库写入。'; exit 2
fi
mkdir -p "$DESTINATION"
STAGE=$(mktemp -d "$DESTINATION/.workbunny-install-XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
ditto "$SRC" "$STAGE/workbunny.app"
codesign --verify --deep --strict "$STAGE/workbunny.app"
# Preserve private models before replacing the old bundle. Do not copy them into the new app.
node - "$DST/Contents/Resources/app/src/renderer/assets/models" "${WORKBUNNY_DATA_DIR:-$HOME/Library/Application Support/workbunny}" <<'JS'
const fs = require('fs'), path = require('path'), library = require('./src/main/asset-library');
const [source, home] = process.argv.slice(2); library.setRoot(home);
if (fs.existsSync(source)) for (const name of fs.readdirSync(source)) {
  if (/\.vrm$/i.test(name) && !/^AvatarSample_[DEFG]\.vrm$/i.test(name)) library.importModel(path.join(source,name));
}
JS
BACKUP=""
if [[ -d "$DST" ]]; then
  BACKUP="$DESTINATION/.workbunny-backup-$(date +%Y%m%d-%H%M%S).app"
  mv "$DST" "$BACKUP"
fi
if ! mv "$STAGE/workbunny.app" "$DST"; then
  [[ -n "$BACKUP" ]] && mv "$BACKUP" "$DST"
  exit 1
fi
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ ! -x "$LSR" ]] || "$LSR" -f "$DST"
echo "已安装：$DST"
[[ -z "$BACKUP" ]] || echo "旧应用保留：$BACKUP"
open "$DST"
