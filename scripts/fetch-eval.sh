#!/usr/bin/env bash
# つようら王11mini/micro (MIT License) を取得し public/engine/eval/<variant>/ に配置する。
# 配布元: https://yaneurao.fanbox.cc/posts/12761272
# 使い方: scripts/fetch-eval.sh [mini] [micro]   (既定: mini micro)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/.cache/eval-dl"
mkdir -p "$DL"
BASE=https://storage.yaneu.com/yaneuraou
[ $# -gt 0 ] || set -- mini micro
for variant in "$@"; do
  case "$variant" in
    mini)  name=TuyouraOu11mini-SFNN_ka2_4096_8_64_progress8-epoch0010-20261003.7z ;;
    micro) name=TuyouraOu11micro-SFNN_ka2_2048_8_64_progress8-epoch0010-20261001.7z ;;
    *) echo "unknown variant: $variant" >&2; exit 1 ;;
  esac
  file="$DL/$name"
  [ -f "$file" ] || curl -fSL -o "$file" "$BASE/$name"
  dest="$ROOT/public/engine/eval/$variant"
  rm -rf "$dest"; mkdir -p "$dest"
  # macOS の bsdtar は 7z を展開できる
  tar -xf "$file" -C "$dest" nn.bin progress.bin eval_options.txt
  ls -la "$dest"
done
