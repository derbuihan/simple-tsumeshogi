#!/usr/bin/env bash
# shogimate リポジトリから実戦詰将棋データ（やねうら王 2020年クリスマスプレゼント）を取得し
# data/problems/mate{3,5,7,9,11}/ に配置し、public/problems-index.json を生成する。
# 本番では data/problems は jsDelivr（GitHub）から配信し、Cloudflare にはアップロードしない。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache/shogimate"
DEST="$ROOT/data/problems"
BOOKS=(mate3 mate5 mate7 mate9 mate11)

if [ ! -d "$CACHE/.git" ]; then
  mkdir -p "$(dirname "$CACHE")"
  git clone --depth 1 --filter=blob:none --sparse https://github.com/usumerican/shogimate.git "$CACHE"
fi
cd "$CACHE"
git sparse-checkout set $(printf 'public/data/%s ' "${BOOKS[@]}")

mkdir -p "$DEST"
for b in "${BOOKS[@]}"; do
  rsync -a --delete "$CACHE/public/data/$b/" "$DEST/$b/"
done

node "$ROOT/scripts/build-problem-index.mjs" "$DEST" "$ROOT/public/problems-index.json"
