#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
OUT="${WORKBUNNY_NATIVE_OUT:-$ROOT/build/native}"
SOURCE="$ROOT/native/boper"
[[ "$(uname -m)" == arm64 ]] || { print -u2 'BOPER supports Apple Silicon only'; exit 1; }
mkdir -p "$OUT"
NODE="${WORKBUNNY_NODE_BINARY:-node}"
DESTINATION="$OUT"
LOCK="$DESTINATION/.boper-build-lock"
LOCKED=0
for attempt in {1..60}; do
  if mkdir "$LOCK" 2>/dev/null; then LOCKED=1; break; fi
  sleep 1
done
[[ "$LOCKED" == 1 ]] || { print -u2 'Another BOPER build still owns the output directory'; exit 1; }
STAGE="$(mktemp -d "$DESTINATION/.boper-stage.XXXXXX")"
trap 'rm -rf "$STAGE"; rmdir "$LOCK"' EXIT
OUT="$STAGE"
MANIFEST_TOOL="$ROOT/tools/boper-build-manifest.cjs"
[[ -f "$MANIFEST_TOOL" ]] || { print -u2 'BOPER build provenance tool is required'; exit 1; }
SOURCE_DIGEST_BEFORE="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).sourceDigest())' "$MANIFEST_TOOL")"
NODE_INCLUDE="${WORKBUNNY_NODE_INCLUDE:-/usr/local/include/node}"
[[ -f "$NODE_INCLUDE/node_api.h" ]] || { print -u2 'Set WORKBUNNY_NODE_INCLUDE to the Node-API headers directory'; exit 1; }
CERT="${WORKBUNNY_BOPER_CERT_SHA1:-$(security find-certificate -c "${WORKBUNNY_SIGN_IDENTITY:-workbunny Dev}" -Z 2>/dev/null | awk '/SHA-1 hash:/ {print $3; exit}')}"
[[ "$CERT" =~ '^[A-Fa-f0-9]{40}$' ]] || { print -u2 'BOPER requires a fixed signing certificate SHA1; ad-hoc signing is not authorized'; exit 1; }
python3 - "$OUT/BoperSecurity.h" "$CERT" <<'PY'
import json,sys
path,cert=sys.argv[1:]
identities={'RUNTIME':'cn.haminn.workbunny.boper-runtime','HELPER':'cn.haminn.workbunny.boper-hid'}
with open(path,'w') as f:
    f.write('// Generated signing policy: exact identifier and pinned certificate.\n')
    for role,identity in identities.items():
        requirement=f'identifier "{identity}" and certificate leaf = H"{cert}"'
        f.write(f'#define BOPER_{role}_REQUIREMENT {json.dumps(requirement)}\n')
PY
CXX=(xcrun clang++ -std=c++23 -arch arm64 -mmacosx-version-min=13.0 -O2 -fobjc-arc -fblocks -Wall -Wextra -Wno-unused-parameter -Wno-nullability-completeness -I"$OUT" -I"$SOURCE")
"${CXX[@]}" "$SOURCE/BoperRuntime.mm" -framework Foundation -framework AppKit -framework CoreGraphics -o "$OUT/boper-runtime"
xcrun clang -arch arm64 -mmacosx-version-min=13.0 -O2 -fno-objc-arc -I"$SOURCE/vendor/dependencies/include" -c "$SOURCE/vendor/dependencies/src/PQRSOSXAutoreleasePoolImpl.m" -o "$OUT/boper-autorelease.o"
"${CXX[@]}" -isystem "$SOURCE/vendor/karabiner/include" -isystem "$SOURCE/vendor/dependencies/include" "$SOURCE/BoperHelper.mm" "$OUT/boper-autorelease.o" -framework Foundation -framework Security -framework SystemConfiguration -framework IOKit -o "$OUT/boper-hid-helper"
"${CXX[@]}" -I"$NODE_INCLUDE" -bundle -undefined dynamic_lookup "$SOURCE/BoperControl.mm" -framework Foundation -framework Security -framework ServiceManagement -o "$OUT/boper-control.node"
"${CXX[@]}" "$SOURCE/test-registration.mm" -framework Foundation -framework ServiceManagement -o "$OUT/boper-registration-test"
"$OUT/boper-runtime" --self-test
"$OUT/boper-hid-helper" --self-test
"$NODE" "$SOURCE/test-protocol.cjs" "$OUT/boper-runtime"
"$NODE" "$SOURCE/test-control.cjs" "$OUT/boper-control.node"
"$OUT/boper-registration-test"
SOURCE_DIGEST_AFTER="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).sourceDigest())' "$MANIFEST_TOOL")"
[[ "$SOURCE_DIGEST_BEFORE" == "$SOURCE_DIGEST_AFTER" ]] || { print -u2 'BOPER source changed during compilation; artifacts were not published'; exit 1; }
"$NODE" "$MANIFEST_TOOL" "$OUT"
for artifact in boper-runtime boper-hid-helper boper-control.node BoperSecurity.h boper-autorelease.o; do mv -f "$OUT/$artifact" "$DESTINATION/$artifact"; done
mv -f "$OUT/boper-build.json" "$DESTINATION/boper-build.json"
print "BOPER arm64/macOS13 artifacts: $DESTINATION"
