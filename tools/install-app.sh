#!/bin/zsh
# Local install with verified staging and rollback. User data stays put.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$PWD/dist/workbunny.app"
DESTINATION="${WORKBUNNY_INSTALL_DIR:-$HOME/Applications}"
DST="$DESTINATION/workbunny.app"
[[ -d "$SRC" ]] || { echo '先运行 tools/package.sh'; exit 1; }
codesign --verify --deep --strict "$SRC"
node "$PWD/tools/verify-bundle.cjs" "$SRC"
if [[ -f "$DST/Contents/MacOS/workbunny" ]] && lsof -t "$DST/Contents/MacOS/workbunny" >/dev/null 2>&1; then
  echo '请先正常退出 Bunny，再运行安装；不会强制中断资料库写入。'; exit 2
fi
mkdir -p "$DESTINATION"
LOCK="$DESTINATION/.workbunny-install.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "已有安装任务或安装锁未清理：$LOCK" >&2; exit 1
fi
STAGE=""
KEEP_STAGE=0
cleanup() {
  # An interruption between the two moves must not discard the old bundle.
  if [[ -n "$STAGE" && -d "$STAGE/previous.app" && ! -e "$DST" ]]; then
    mv "$STAGE/previous.app" "$DST" || KEEP_STAGE=1
  fi
  if [[ "$KEEP_STAGE" = 1 ]]; then
    echo "回滚未完成，保留现场：$STAGE" >&2
  elif [[ -n "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
  rmdir "$LOCK"
}
trap cleanup EXIT
STAGE=$(mktemp -d "$DESTINATION/.workbunny-install-XXXXXX")
ditto "$SRC" "$STAGE/workbunny.app"
codesign --verify --deep --strict "$STAGE/workbunny.app"
# Preserve private models before replacing the old bundle. Do not copy them into the new app.
node - "$DST/Contents/Resources/app/src/renderer/assets/models" "${WORKBUNNY_DATA_DIR:-$HOME/Library/Application Support/workbunny}" <<'JS'
const fs = require('fs'), path = require('path'), library = require('./src/main/asset-library');
const [source, home] = process.argv.slice(2); library.setRoot(home);
if (fs.existsSync(source)) for (const name of fs.readdirSync(source)) {
  if (/\.vrm$/i.test(name) && !library.STOCK_MODELS.has(name)) library.importModel(path.join(source,name));
}
JS
# Explicitly selected milestone versions may be preserved on the external disk.
# Refuse an absent or internal volume before touching the installed application.
if [[ "${WORKBUNNY_ARCHIVE_PREVIOUS:-0}" = 1 && -d "$DST" ]]; then
  ARCHIVE_VOLUME="${WORKBUNNY_ARCHIVE_VOLUME:-/Volumes/MAC-SSD1T}"
  ARCHIVE_ROOT="$ARCHIVE_VOLUME/WorkBunny备份"
  [[ -d "$ARCHIVE_ROOT" ]] || { echo "外置备份目录不可用：$ARCHIVE_ROOT" >&2; exit 1; }
  [[ "$(cd "$ARCHIVE_ROOT" && pwd -P)" = "$ARCHIVE_VOLUME/WorkBunny备份" ]] || {
    echo '外置备份目录指向了其他位置，已停止安装。' >&2; exit 1
  }
  INFO=$(diskutil info -plist "$ARCHIVE_VOLUME")
  [[ "$(print -r -- "$INFO" | plutil -extract Internal raw -)" = false && \
     "$(print -r -- "$INFO" | plutil -extract MountPoint raw -)" = "$ARCHIVE_VOLUME" ]] || {
    echo '备份目标不是已挂载的指定外置硬盘，已停止安装。' >&2; exit 1
  }
  mkdir -p "$ARCHIVE_ROOT/安装版本"
  ARCHIVE_DIR=$(mktemp -d "$ARCHIVE_ROOT/安装版本/$(date +%Y%m%d-%H%M%S)-XXXXXX")
  ditto "$DST" "$ARCHIVE_DIR/workbunny.app"
  codesign --verify --deep --strict "$ARCHIVE_DIR/workbunny.app"
  echo "关键版本已归档：$ARCHIVE_DIR/workbunny.app"
fi

if [[ -d "$DST" ]]; then
  mv "$DST" "$STAGE/previous.app"
fi
if ! mv "$STAGE/workbunny.app" "$DST"; then
  if [[ -d "$STAGE/previous.app" ]] && ! mv "$STAGE/previous.app" "$DST"; then
    KEEP_STAGE=1
  fi
  exit 1
fi
# The new verified bundle is in place. Remove obsolete installer-created
# backups only after success; rollback data in STAGE is removed by the trap.
for backup in "$DESTINATION"/.workbunny-backup-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].app(N/); do
  [[ -L "$backup" ]] && continue
  rm -rf -- "$backup"
done
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ ! -x "$LSR" ]] || "$LSR" -f "$DST"
echo "已安装：$DST"
echo '旧安装版本已清理；个人资料保留在用户数据目录。'
[[ "${WORKBUNNY_SKIP_OPEN:-0}" = 1 ]] || open "$DST"
