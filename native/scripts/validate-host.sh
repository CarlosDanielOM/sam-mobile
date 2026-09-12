#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$(realpath "$0")")")"
scratch=/tmp/opencode
model="$scratch/LFM2.5-Embedding-350M-Q8_0.gguf"
revision=a80de9c5b941d429104f0038292a0ef5a860e486
sha=6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599
test -d "$scratch"
if [[ ! -f "$model" ]]; then
    curl -fL --retry 3 -o "$model" "https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M-GGUF/resolve/$revision/LFM2.5-Embedding-350M-Q8_0.gguf"
fi
test "$(stat -c %s "$model")" = 379216640
test "$(sha256sum "$model" | cut -d ' ' -f 1)" = "$sha"
bash "$root/scripts/fetch-llama.sh"
cmake="${CMAKE:-${ANDROID_HOME:-/home/dom/Android/Sdk}/cmake/3.31.6/bin/cmake}"
ninja="${NINJA:-$(dirname "$cmake")/ninja}"
"$cmake" -S "$root" -B "$scratch/sam-host-build" -G Ninja \
    -DCMAKE_MAKE_PROGRAM="$ninja" -DCMAKE_BUILD_TYPE=Release
"$cmake" --build "$scratch/sam-host-build" -j "${JOBS:-4}"
"$scratch/sam-host-build/sam-host-smoke" "$model"
"$scratch/sam-host-build/sam-batch-investigate" "$model" separate_kv_8
