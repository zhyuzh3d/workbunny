#!/bin/zsh
# 建一个本机自签名代码签名证书，名字固定，用来给 WorkBaby 签名。
#
# 为什么需要它：ad-hoc 签名（codesign --sign -）的"指定要求"是 cdhash，
# 每次重打包 cdhash 都变，TCC 就认为是新应用 —— 于是每次启动都重新弹麦克风授权。
# 用固定证书签之后，TCC 记的是证书指纹，重打包多少次都认。
#
# 只写 login keychain，不动系统设置，也不需要管理员密码。
set -u

CN="WorkBaby Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$CN" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✓ 证书已存在：$CN"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cs.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = WorkBaby Dev
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cs.cnf" >/dev/null 2>&1 || {
  echo "✗ openssl 生成证书失败"; exit 1; }

openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/id.p12" -passout pass:wbdev -name "$CN" >/dev/null 2>&1 || {
  echo "✗ 打包 p12 失败"; exit 1; }

# -A：允许 codesign 直接用私钥，不再弹"想要使用密钥"的框
security import "$TMP/id.p12" -k "$KEYCHAIN" -P wbdev -T /usr/bin/codesign -A >/dev/null 2>&1 || {
  echo "✗ 导入 login keychain 失败"; exit 1; }

# 让 codesign 不需要每次确认访问私钥
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1 || true

if security find-certificate -c "$CN" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✓ 已创建签名证书：$CN"
else
  echo "✗ 证书导入后仍找不到"; exit 1
fi
