#!/bin/bash
# Fixed-scope administrator installation. No shared driver or other job is changed.
set -euo pipefail
[[ "$#" = 5 && "$(/usr/bin/id -u)" = 0 ]] || exit 77
BOPER_SOURCE=$1
BOPER_JOB_SOURCE=$2
BOPER_HASH=$3
BOPER_JOB_HASH=$4
BOPER_REQUIREMENT=$5
[[ "$BOPER_HASH" =~ ^[a-f0-9]{64}$ && "$BOPER_JOB_HASH" =~ ^[a-f0-9]{64}$ ]] || exit 65
[[ "$BOPER_REQUIREMENT" =~ ^identifier\ \"cn\.haminn\.workbunny\.boper-hid\"\ and\ certificate\ leaf\ =\ H\"[a-fA-F0-9]{40}\"$ ]] || exit 65
BOPER_LABEL=cn.haminn.workbunny.boper-hid
BOPER_HELPER=/Library/PrivilegedHelperTools/cn.haminn.workbunny.boper-hid
BOPER_JOB=/Library/LaunchDaemons/cn.haminn.workbunny.boper-hid.plist
secure_file() {
  [[ -f "$1" && ! -L "$1" && "$(/usr/bin/stat -f %u "$1")" = 0 ]] || return 1
  local mode;mode=$(/usr/bin/stat -f %Lp "$1")
  (( (8#$mode & 022) == 0 ))
}
for directory in /Library/PrivilegedHelperTools /Library/LaunchDaemons; do
  [[ ! -L "$directory" ]] || exit 65
  [[ -d "$directory" ]] || /usr/bin/install -d -o root -g wheel -m 755 "$directory"
  [[ "$(/usr/bin/stat -f %u "$directory")" = 0 ]] || exit 65
  mode=$(/usr/bin/stat -f %Lp "$directory")
  (( (8#$mode & 022) == 0 )) || exit 65
done
umask 077
BOPER_STAGE=$(/usr/bin/mktemp -d /Library/PrivilegedHelperTools/.boper-install-XXXXXX)
BOPER_CHANGED=0
BOPER_WAS_LOADED=0
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$result" != 0 && "$BOPER_CHANGED" = 1 ]]; then
    /bin/launchctl bootout "system/$BOPER_LABEL" >/dev/null 2>&1 || true
    if [[ -f "$BOPER_STAGE/previous-helper" ]]; then /bin/mv -f "$BOPER_STAGE/previous-helper" "$BOPER_HELPER"; else /bin/rm -f "$BOPER_HELPER"; fi
    if [[ -f "$BOPER_STAGE/previous-job" ]]; then /bin/mv -f "$BOPER_STAGE/previous-job" "$BOPER_JOB"; else /bin/rm -f "$BOPER_JOB"; fi
    if [[ "$BOPER_WAS_LOADED" = 1 && -f "$BOPER_JOB" ]]; then
      /bin/launchctl bootstrap system "$BOPER_JOB" || /bin/echo 'BOPER rollback restored files; service activation remains unconfirmed.' >&2
    fi
  fi
  /bin/rm -rf "$BOPER_STAGE"
  exit "$result"
}
trap cleanup EXIT
# Copy first, then validate the root-owned copies, so source replacement cannot
# race the administrator prompt and substitute different privileged code.
/usr/bin/install -o root -g wheel -m 755 "$BOPER_SOURCE" "$BOPER_STAGE/helper"
/usr/bin/install -o root -g wheel -m 644 "$BOPER_JOB_SOURCE" "$BOPER_STAGE/job"
[[ "$(/usr/bin/shasum -a 256 "$BOPER_STAGE/helper" | /usr/bin/awk '{print $1}')" = "$BOPER_HASH" ]] || exit 65
[[ "$(/usr/bin/shasum -a 256 "$BOPER_STAGE/job" | /usr/bin/awk '{print $1}')" = "$BOPER_JOB_HASH" ]] || exit 65
/usr/bin/codesign --verify --strict -R "=$BOPER_REQUIREMENT" "$BOPER_STAGE/helper"
/usr/bin/plutil -lint "$BOPER_STAGE/job" >/dev/null
[[ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$BOPER_STAGE/job")" = "$BOPER_LABEL" ]] || exit 65
[[ "$(/usr/libexec/PlistBuddy -c 'Print :Program' "$BOPER_STAGE/job")" = "$BOPER_HELPER" ]] || exit 65
if [[ -e "$BOPER_HELPER" || -L "$BOPER_HELPER" ]]; then
  secure_file "$BOPER_HELPER" || exit 65
  /usr/bin/codesign --verify --strict -R "=$BOPER_REQUIREMENT" "$BOPER_HELPER"
  /bin/cp -p "$BOPER_HELPER" "$BOPER_STAGE/previous-helper"
fi
if [[ -e "$BOPER_JOB" || -L "$BOPER_JOB" ]]; then
  secure_file "$BOPER_JOB" || exit 65
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$BOPER_JOB")" = "$BOPER_LABEL" ]] || exit 65
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :Program' "$BOPER_JOB")" = "$BOPER_HELPER" ]] || exit 65
  /bin/cp -p "$BOPER_JOB" "$BOPER_STAGE/previous-job"
fi
if /bin/launchctl print "system/$BOPER_LABEL" >/dev/null 2>&1; then
  BOPER_WAS_LOADED=1
  /bin/launchctl bootout "system/$BOPER_LABEL"
fi
BOPER_CHANGED=1
/bin/mv -f "$BOPER_STAGE/helper" "$BOPER_HELPER"
/bin/mv -f "$BOPER_STAGE/job" "$BOPER_JOB"
/bin/launchctl bootstrap system "$BOPER_JOB"
echo 'BOPER private helper installed; device readiness must be verified separately.'
