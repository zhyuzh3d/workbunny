#!/bin/zsh
set -euo pipefail
task_root="$(cd "$(dirname "$0")" && pwd)"
task_build="$(mktemp -d "${TMPDIR:-/tmp}/workbunny-speech-replay.XXXXXX")"
trap 'rm -rf "$task_build"' EXIT
xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 "$task_root/replay.swift" -framework Speech -framework AVFoundation -o "$task_build/replay"
"$task_build/replay" "$@"
