#!/bin/zsh
# 手工打包成 .app（不引 electron-builder，保持依赖极轻）
# 产物：dist/workbunny.app
set -e
cd "$(dirname "$0")/.."
ROOT=$PWD
[[ "$(uname -m)" == arm64 ]] || { echo '当前安装包面向 Apple Silicon Mac'; exit 1; }
APPNAME="workbunny"
BUNDLE_ID="cn.haminn.workbunny"
VER=$(/usr/bin/python3 -c "import json;print(json.load(open('package.json'))['version'])")
DIST="$ROOT/dist"
APP="$DIST/$APPNAME.app"

# Ship the matching local TTS engine so downloading weights is sufficient.
if [ ! -x "$ROOT/bin/asr" ] || [ "$ROOT/native/asr.swift" -nt "$ROOT/bin/asr" ]; then
  zsh "$ROOT/tools/build-asr.sh"
fi
if [ ! -x "$ROOT/bin/speech/speech" ]; then
  zsh "$ROOT/tools/fetch-tts-runtime.sh"
fi

echo "▸ 清理"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "▸ 复制 Electron 运行时"
cp -R "$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS" "$APP/Contents/"
cp -R "$ROOT/node_modules/electron/dist/Electron.app/Contents/Frameworks" "$APP/Contents/" 2>/dev/null || true
cp -R "$ROOT/node_modules/electron/dist/Electron.app/Contents/Resources/"* "$APP/Contents/Resources/" 2>/dev/null || true
rm -rf "$APP/Contents/Resources/default_app.asar"

echo "▸ 二进制改名"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$APPNAME"
python3 "$ROOT/tools/set-app-uuid.py" "$APP/Contents/MacOS/$APPNAME" "$BUNDLE_ID"
# 修正 Electron 帮助进程名（可留空，不影响运行）

echo "▸ 放入应用代码（运行时不需要 node_modules）"
mkdir -p "$APP/Contents/Resources/app"
cp "$ROOT/package.json" "$APP/Contents/Resources/app/"
cp -R "$ROOT/src" "$APP/Contents/Resources/app/"
cp -R "$ROOT/res" "$APP/Contents/Resources/app/" 2>/dev/null || true

echo "▸ 放入原生语音识别"
mkdir -p "$APP/Contents/Resources/bin"
cp "$ROOT/bin/asr" "$APP/Contents/Resources/bin/asr"
chmod +x "$APP/Contents/Resources/bin/asr"
cp -R "$ROOT/bin/speech" "$APP/Contents/Resources/bin/speech"

echo "▸ 写入 Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APPNAME</string>
  <key>CFBundleDisplayName</key><string>$APPNAME</string>
  <key>CFBundleExecutable</key><string>$APPNAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>workbunny 需要麦克风，才能听见你说话。</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>workbunny 需要语音识别，才能把你说的话变成文字。</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>workbunny 需要唤起 WorkBuddy 窗口。</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>workbunny 要把你说的话送到局域网里的语音合成设备，才能用那个声音回答你。</string>
</dict>
</plist>
PLIST

if [ -f "$ROOT/res/icon.icns" ]; then
  cp "$ROOT/res/icon.icns" "$APP/Contents/Resources/icon.icns"
fi

# ── 签名 ──────────────────────────────────────────────────────────
# 关键：必须用"固定身份的证书"签，绝不能用 ad-hoc（--sign -）。
# ad-hoc 的指定要求是 cdhash，重打包一次就变，TCC 把它当全新应用 ⇒ 每次启动重弹授权。
# 用固定证书签，指定要求变成 identifier + 证书指纹，重打包多少次都认。
echo "▸ 签名"
IDENTITY="workbunny Dev"
HAVE_ID=0
if security find-certificate -c "$IDENTITY" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  HAVE_ID=1
fi

# 内层可执行文件先签，再签外壳（顺序不能反）
if [ "$HAVE_ID" = "1" ]; then
  codesign --force --sign "$IDENTITY" "$APP/Contents/Resources/bin/speech/speech"
  codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID.asr" "$APP/Contents/Resources/bin/asr" 2>&1 | grep -v "replacing existing signature" || true
  codesign --force --deep --sign "$IDENTITY" "$APP" 2>&1 | grep -v "replacing existing signature" || true
else
  codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true
  echo "  ⚠ 没找到「$IDENTITY」证书，退回 ad-hoc —— 这样每次重打包都会重新弹麦克风授权。"
  echo "    跑一次 ./tools/make-signing-cert.sh 就能修好。"
fi

# 本地构建不该带隔离标记，否则 Gatekeeper 会拦自签名应用
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
codesign --verify --deep --strict "$APP"

codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|Identifier|TeamIdentifier" | sed 's/^/  /'
codesign -d -r- "$APP" 2>&1 | grep "designated" | sed 's/^/  /'

# 重新打包后 LaunchServices 还记着旧 bundle，open 会"成功但没启动"。强制重注册。
echo "▸ 注册到 LaunchServices"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSR" ] && "$LSR" -f "$APP" 2>/dev/null || true

echo "▸ 完成：$APP"
du -sh "$APP"
