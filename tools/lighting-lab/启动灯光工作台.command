#!/bin/zsh
set -e
cd "${0:A:h}/../.."
if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
  exec /opt/homebrew/opt/node@22/bin/node tools/lighting-lab/server.cjs --open
fi
exec node tools/lighting-lab/server.cjs --open
