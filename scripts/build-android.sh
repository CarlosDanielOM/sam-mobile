#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$(realpath "$0")")")"
if [[ "$PWD" != "$root" ]]; then
  printf '%s\n' 'Run this script from the repository root.' >&2
  exit 1
fi
if [[ ! -f platforms/android/gradlew ]]; then
  ns prepare android --no-hmr
fi
bash native/scripts/build-android.sh --console=plain
ns build android --no-hmr "$@"
node scripts/check-embedding-artifacts.mjs
