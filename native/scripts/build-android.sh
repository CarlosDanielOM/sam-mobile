#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$(realpath "$0")")")"
export ANDROID_HOME="${ANDROID_HOME:-/home/dom/Android/Sdk}"
bash "$root/scripts/fetch-llama.sh"
# A caller can supply any Gradle 8.14.3 executable; no NativeScript code is used.
gradle="${GRADLE:-$root/../platforms/android/gradlew}"
"$gradle" -p "$root" testDebugUnitTest assembleDebugAndroidTest exportAar "$@"
