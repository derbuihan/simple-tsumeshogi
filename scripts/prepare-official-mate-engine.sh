#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$ROOT/.cache/research/YaneuraOu"
REV="2bc64b48827a8c4ec4c5418ca3b1dcb25958b7aa"
JOBS="${JOBS:-$(nproc)}"

if [ ! -d "$REPO/.git" ]; then
  mkdir -p "$(dirname "$REPO")"
  git clone --filter=blob:none https://github.com/yaneurao/YaneuraOu.git "$REPO"
fi

git -C "$REPO" fetch --depth 1 origin "$REV"
git -C "$REPO" checkout --detach "$REV"
make -C "$REPO/source" -j"$JOBS" \
  YANEURAOU_EDITION=YANEURAOU_MATE_ENGINE \
  TARGET_CPU=AVX2 tournament

ENGINE="$REPO/source/YaneuraOu-by-gcc"
if [ ! -x "$ENGINE" ]; then
  echo "Expected engine was not built: $ENGINE" >&2
  exit 1
fi
echo "Official mate engine ready: $ENGINE"
