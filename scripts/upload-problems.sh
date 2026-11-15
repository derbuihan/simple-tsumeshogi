#!/usr/bin/env bash
# data/problems/ を R2 バケットにアップロードする（キー: mate{N}/NNN.txt）。
# 使い方:
#   scripts/upload-problems.sh                 # 全手数を本番の R2 へ
#   scripts/upload-problems.sh --local mate3   # ローカル（cf dev 用）の R2 へ mate3 だけ
# 環境変数: BUCKET（既定 simple-tsumeshogi-problems）, JOBS（並列数、既定 16）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-simple-tsumeshogi-problems}"
JOBS="${JOBS:-16}"
LOCAL=()
if [ "${1:-}" = "--local" ]; then LOCAL=(--local); shift; fi
[ $# -gt 0 ] || set -- mate3 mate5 mate7 mate9 mate11

cd "$ROOT/data/problems"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
for book in "$@"; do ls "$book"/*.txt; done > "$LIST"
echo "uploading $(wc -l < "$LIST" | tr -d ' ') files to r2://$BUCKET ${LOCAL[*]:-(remote)}"

# 失敗したファイルは failed.txt に書き出す（再実行すれば上書きアップロードされる）
FAILED="$ROOT/.cache/upload-failed.txt"
mkdir -p "$ROOT/.cache"; : > "$FAILED"
export BUCKET FAILED
export LOCAL_FLAG="${LOCAL[*]:-}"
xargs -P "$JOBS" -I{} sh -c '
  cf r2 objects put "{}" --bucket-name "$BUCKET" --file "{}" --content-type "text/plain; charset=utf-8" --quiet $LOCAL_FLAG >/dev/null 2>&1 \
    || echo "{}" >> "$FAILED"
' < "$LIST"

if [ -s "$FAILED" ]; then
  echo "failed: $(wc -l < "$FAILED" | tr -d ' ') files (see $FAILED)" >&2
  exit 1
fi
echo done
