#!/bin/zsh
# Kept as a compatibility entry; build the pinned portable runtime.
set -euo pipefail
exec zsh "$(dirname "$0")/build-tts-runtime.sh" "$@"
