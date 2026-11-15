#!/usr/bin/env bash
# 公式やねうら王に USI拡張パッチ(checks)を当て、Emscripten で WASM ビルドする。
# 使い方: engine/build.sh [mini|micro]   (既定: mini)
# 出力: public/engine/yaneuraou.<variant>.{js,wasm}
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/engine/YaneuraOu"
OUT="$ROOT/public/engine"
VARIANT="${1:-mini}"

case "$VARIANT" in
  mini)  ARCH=SFNN_ka2_4096_8_64_progress8 ;;
  micro) ARCH=SFNN_ka2_2048_8_64_progress8 ;;
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

cd "$SRC"
# パッチ適用（適用済みならスキップ）
if git apply --check "$ROOT/engine/patches/usi-ext.patch" 2>/dev/null; then
  git apply "$ROOT/engine/patches/usi-ext.patch"
elif ! git apply --reverse --check "$ROOT/engine/patches/usi-ext.patch" 2>/dev/null; then
  echo "patch does not apply cleanly" >&2; exit 1
fi

BUILD="$ROOT/engine/build/$VARIANT"
mkdir -p "$BUILD" "$OUT"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

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
