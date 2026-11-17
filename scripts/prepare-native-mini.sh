#!/usr/bin/env bash
# アプリの玉方（mini）と同じソース・評価関数のネイティブ版を作る。正解手順の作り直し（regen-solutions.py）で使う。
# ソースは engine/YaneuraOu（submodule）をコピーしてビルドし、submodule の WASM 用ビルド結果を壊さない。
# 出力: .cache/research/mini-native/source/YaneuraOu-by-gcc
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/engine/YaneuraOu/source"
BUILD="$ROOT/.cache/research/mini-native"
JOBS="${JOBS:-$(nproc)}"

[ -f "$SRC/Makefile" ] || git -C "$ROOT" submodule update --init engine/YaneuraOu
rm -rf "$BUILD" && mkdir -p "$BUILD"
cp -r "$SRC" "$BUILD/source"
# 📝 Makefile の既定は clang++。g++ しか無い環境に合わせて g++ を使う
make -C "$BUILD/source" -j"$JOBS" clean tournament \
  COMPILER=g++ TARGET_CPU=AVX2 PYTHON=python3 \
  YANEURAOU_EDITION=YANEURAOU_ENGINE_SFNN_ka2_4096_8_64_progress8 > "$BUILD/build.log" 2>&1 \
  || { tail -20 "$BUILD/build.log" >&2; exit 1; }
echo "Native mini ready: $BUILD/source/YaneuraOu-by-gcc"
