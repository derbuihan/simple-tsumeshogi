#!/usr/bin/env bash
# shogimate リポジトリから実戦詰将棋データ（やねうら王 2020年クリスマスプレゼント）を
# .cache/shogimate/public/data/mate{3,5,7,9,11}/ に取得する。データは Git 管理外。
# 配信するのはこれを npm run filter:minimal-hand で変換した .cache/minimal-hand/public/data で、
# 索引（npm run build:index）と R2（npm run upload:problems）もそちらから作る。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache/shogimate"
BOOKS=(mate3 mate5 mate7 mate9 mate11)

if [ ! -d "$CACHE/.git" ]; then
  mkdir -p "$(dirname "$CACHE")"
  git clone --depth 1 --filter=blob:none --sparse https://github.com/usumerican/shogimate.git "$CACHE"
fi
cd "$CACHE"
git sparse-checkout set $(printf 'public/data/%s ' "${BOOKS[@]}")
