#!/usr/bin/env bash
# やねうら王 (Fork: derbuihan/YaneuraOu の tsumeshogi-wasm ブランチ。USI拡張 checks 付き) を
# Emscripten で WASM ビルドする。
# 使い方: engine/build.sh [mini|micro|mate]   (既定: mini)
#   mate: 公式やねうら王の詰将棋エンジン版（正誤の判定用）。ソースは npm run prepare:mate-engine で取得したもの
#         （.cache/research/YaneuraOu）を engine/build/mate にコピーし、engine/mate-engine-wasm.patch を当ててビルドする。
# 出力: public/engine/yaneuraou.<variant>.{js,wasm,worker.js}
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/engine/YaneuraOu"
OUT="$ROOT/public/engine"
VARIANT="${1:-mini}"

case "$VARIANT" in
  mini)  ARCH=SFNN_ka2_4096_8_64_progress8 ;;
  micro) ARCH=SFNN_ka2_2048_8_64_progress8 ;;
  mate)  ;;
  *) echo "unknown variant: $VARIANT" >&2; exit 1 ;;
esac

# 公式CI(.github/workflows/make-wasm.yml)と同じ emsdk 3.1.43 を使う。
# .cache/emsdk があればそれを有効化する（無ければ PATH 上の em++ を使う）。
EMSDK_VERSION=3.1.43
if [ -f "$ROOT/.cache/emsdk/emsdk_env.sh" ]; then
  # shellcheck disable=SC1091
  EMSDK_QUIET=1 source "$ROOT/.cache/emsdk/emsdk_env.sh" >/dev/null
fi
echo "using: $(command -v em++) ($(em++ --version | head -1))"
case "$(em++ --version | head -1)" in
  *" $EMSDK_VERSION "*) ;;
  *) echo "warning: emscripten $EMSDK_VERSION 以外は未検証（7.0.0 では Module.print が無視され go が応答しなかった）" >&2 ;;
esac

BUILD="$ROOT/engine/build/$VARIANT"
mkdir -p "$BUILD" "$OUT"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

if [ "$VARIANT" = mate ]; then
  MATE_SRC="$ROOT/.cache/research/YaneuraOu/source"
  if [ ! -f "$MATE_SRC/Makefile" ]; then
    echo "$MATE_SRC がありません: npm run prepare:mate-engine" >&2; exit 1
  fi
  # ネイティブ版（データの変換に使う）のビルド結果を壊さないよう、コピーしてビルドする
  rm -rf "$BUILD/source"
  cp -r "$MATE_SRC" "$BUILD/source"
  patch -d "$BUILD" -p1 < "$ROOT/engine/mate-engine-wasm.patch"
  # ⚠ 一部だけ make normal で作り直すと tournament の残りと設定が食い違い go mate が応答しなくなった。必ず clean tournament。
  # 📝 既定の PTHREAD_POOL_SIZE=32 はブラウザで Worker を32個作るので4にする（Threads 1 で使う）。
  #    書き出し名は mini/micro（YaneuraOu）と同時に読み込めるよう YaneuraOuMate にする。
  cd "$BUILD/source"
  make -j"$JOBS" clean tournament \
    COMPILER=em++ TARGET_CPU=WASM PYTHON=python3 \
    YANEURAOU_EDITION=YANEURAOU_MATE_ENGINE \
    TARGET="$BUILD/yaneuraou.mate.js" \
    EM_EXPORT_NAME=YaneuraOuMate \
    EXTRA_LDFLAGS="-s PTHREAD_POOL_SIZE=4 -s INCOMING_MODULE_JS_API=print,printErr,postRun,wasmBinary,locateFile,instantiateWasm,mainScriptUrlOrBlob,wasmMemory"
  cp "$BUILD"/yaneuraou.mate.* "$OUT/"
  ls -la "$OUT"
  exit 0
fi

cd "$SRC"
# checks コマンド等の追加は Fork (derbuihan/YaneuraOu, branch tsumeshogi-wasm) にコミット済み。
if ! grep -q 'token == "checks"' source/usi.cpp; then
  echo "engine/YaneuraOu が tsumeshogi-wasm ブランチではありません: git submodule update --init" >&2; exit 1
fi

# 📝 emscripten 7 では -s STRICT=1 により Module.print / postRun 等が無視されるため、
#    wasm_pre.js が使う入力APIを INCOMING_MODULE_JS_API で明示する。
cd "$SRC/source"
make -j"$JOBS" clean tournament \
  COMPILER=em++ TARGET_CPU=WASM PYTHON=python3 \
  YANEURAOU_EDITION="YANEURAOU_ENGINE_$ARCH" \
  ENGINE_NAME="YaneuraOu-Tsuyo11$VARIANT" \
  TARGET="$BUILD/yaneuraou.$VARIANT.js" \
  EM_EXPORT_NAME=YaneuraOu \
  EM_INITIAL_MEMORY_SIZE=134217728 \
  EXTRA_LDFLAGS="-s PTHREAD_POOL_SIZE=4 -s INCOMING_MODULE_JS_API=print,printErr,postRun,wasmBinary,locateFile,instantiateWasm,mainScriptUrlOrBlob,wasmMemory"

cp "$BUILD"/yaneuraou.$VARIANT.* "$OUT/"
ls -la "$OUT"
