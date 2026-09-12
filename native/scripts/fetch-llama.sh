#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$(realpath "$0")")")"
revision=465e49b9cea78a68b9c244ffb48d0ee24a82873d
mkdir -p "$root/vendor"
if [[ ! -d "$root/vendor/llama.cpp/.git" ]]; then
    git init "$root/vendor/llama.cpp"
    git -C "$root/vendor/llama.cpp" remote add origin https://github.com/ggml-org/llama.cpp.git
    git -C "$root/vendor/llama.cpp" fetch --depth 1 origin "$revision"
    git -C "$root/vendor/llama.cpp" checkout --detach FETCH_HEAD
fi
test "$(git -C "$root/vendor/llama.cpp" rev-parse HEAD)" = "$revision"
test -z "$(git -C "$root/vendor/llama.cpp" status --porcelain)"
