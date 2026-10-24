#!/bin/zsh
# 直接给 workbunny 写 TCC 授权（麦克风 + 语音识别），从此不再弹窗。
#
# 前提：跑这个脚本的进程（正常是 WorkBuddy.app）必须有「完全磁盘访问权限」。
#   系统设置 → 隐私与安全性 → 完全磁盘访问权限 → + → /Applications/WorkBuddy.app
# 没有这个权限时 sqlite3 会报 "authorization denied"，脚本会明确告诉你。
#
# 为什么需要它：macOS 的授权弹窗（TCC）不允许任何程序自动点击，
#   唯一的免点击路径就是由有 FDA 的进程直接写用户级 TCC 库。
set -u

DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
BID="cn.haminn.workbunny"
APP="$HOME/Applications/workbunny.app"

if [ ! -f "$DB" ]; then
  echo "✗ 找不到 $DB"
  exit 1
fi

if ! sqlite3 "$DB" "select 1;" >/dev/null 2>&1; then
  echo "✗ 没有「完全磁盘访问权限」，无法写授权库。"
  echo "  请到 系统设置 → 隐私与安全性 → 完全磁盘访问权限，添加 /Applications/WorkBuddy.app 后重跑。"
  exit 2
fi

BK="$DB.bak.$(date +%Y%m%d-%H%M%S)"
cp "$DB" "$BK" && echo "▸ 已备份：$BK"

NOW=$(date +%s)
write() {
  local svc="$1"
  sqlite3 "$DB" "DELETE FROM access WHERE service='$svc' AND client='$BID';" || return 1
  sqlite3 "$DB" "INSERT INTO access
    (service, client, client_type, auth_value, auth_reason, auth_version,
     csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier,
     indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded)
    VALUES
    ('$svc', '$BID', 0, 2, 4, 1,
     NULL, NULL, 0, 'UNUSED',
     NULL, 0, $NOW, NULL, NULL, 'UNUSED', $NOW);" || return 1
  echo "  ✓ $svc"
}

write kTCCServiceMicrophone || { echo "✗ 写麦克风失败"; exit 3; }
write kTCCServiceSpeechRecognition || { echo "✗ 写语音识别失败"; exit 3; }

# 让 tccd 重新读库
killall tccd 2>/dev/null || true
sleep 1

echo "▸ 当前状态："
sqlite3 "$DB" "select service, auth_value from access where client='$BID';"

# 顺手修一下旧名字留下的条目（改名前叫 Buddy Pet，已不再使用）
OLD="cn.haminn.buddypet"
sqlite3 "$DB" "delete from access where client='$OLD';" 2>/dev/null && echo "▸ 已清掉旧应用名 $OLD 的授权记录"

echo "✓ 完成。重启 workbunny 生效："
echo "  pkill -f workbunny.app/Contents/MacOS/workbunny; open -n \"$APP\""
