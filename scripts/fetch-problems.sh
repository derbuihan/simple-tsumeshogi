#!/usr/bin/env bash
# shogimate リポジトリから実戦詰将棋データ（やねうら王 2020年クリスマスプレゼント）を
# .cache/shogimate/public/data/mate{3,5,7,9,11}/ に取得し、public/problems-index.json を生成する。
# データは Git 管理外。scripts/upload-problems.sh で R2（本番・ローカル）に入れて使う。
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

node "$ROOT/scripts/build-problem-index.mjs" "$CACHE/public/data" "$ROOT/public/problems-index.json"
