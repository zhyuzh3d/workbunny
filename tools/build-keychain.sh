#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -m)" == arm64 ]] || { echo 'Keychain helper 构建需要 Apple Silicon Mac'; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo '请先安装 Xcode 命令行工具'; exit 1; }

BUNDLE="bin/workbunny-keychain.app"
CONTENTS="$BUNDLE/Contents"
EXECUTABLE="$CONTENTS/MacOS/workbunny-keychain"
mkdir -p "$CONTENTS/MacOS"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>workbunny-keychain</string>
  <key>CFBundleIdentifier</key><string>cn.haminn.workbunny.keys</string>
  <key>CFBundleName</key><string>workbunny钥匙</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
PLIST

if [[ ! -x "$EXECUTABLE" || native/keychain.swift -nt "$EXECUTABLE" ]]; then
  xcrun swiftc -O -target arm64-apple-macos13.0 native/keychain.swift -o "$EXECUTABLE" -framework Security
  chmod 755 "$EXECUTABLE"
fi
chmod 755 "$BUNDLE" "$CONTENTS" "$CONTENTS/MacOS"
echo "Built $BUNDLE"
