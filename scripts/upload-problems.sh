#!/usr/bin/env bash
# data/problems/ を R2 バケットにアップロードする（キー: mate{N}/NNN.txt）。
# 使い方:
#   scripts/upload-problems.sh                 # 全手数を本番の R2 へ
#   scripts/upload-problems.sh --local mate3   # ローカル（cf dev 用）の R2 へ mate3 だけ
#   scripts/upload-problems.sh --retry-failed  # 前回失敗したファイルだけ再アップロード
# 環境変数: BUCKET（既定 simple-tsumeshogi-problems）, JOBS（並列数、既定 4。上げすぎると API に弾かれる）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-simple-tsumeshogi-problems}"
JOBS="${JOBS:-4}"
LOCAL=()
RETRY=0
if [ "${1:-}" = "--local" ]; then LOCAL=(--local); shift; fi
if [ "${1:-}" = "--retry-failed" ]; then RETRY=1; shift; fi
[ $# -gt 0 ] || set -- mate3 mate5 mate7 mate9 mate11

cd "$ROOT/data/problems"
FAILED="$ROOT/.cache/upload-failed.txt"
mkdir -p "$ROOT/.cache"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
if [ "$RETRY" = 1 ]; then
  cp "$FAILED" "$LIST"
else
  for book in "$@"; do ls "$book"/*.txt; done > "$LIST"
fi
echo "uploading $(wc -l < "$LIST" | tr -d ' ') files to r2://$BUCKET ${LOCAL[*]:-(remote)}"

# 各ファイルは間隔を空けて最大3回試す。それでも失敗したものは $FAILED に書き出す
: > "$FAILED"
export BUCKET FAILED
export LOCAL_FLAG="${LOCAL[*]:-}"
xargs -P "$JOBS" -I{} sh -c '
  for wait in 2 5 0; do
    cf r2 objects put "{}" --bucket-name "$BUCKET" --file "{}" --content-type "text/plain; charset=utf-8" --quiet $LOCAL_FLAG >/dev/null 2>&1 && exit 0
    [ "$wait" = 0 ] || sleep "$wait"
  done
  echo "{}" >> "$FAILED"
' < "$LIST"

if [ -s "$FAILED" ]; then
  echo "failed: $(wc -l < "$FAILED" | tr -d ' ') files (see $FAILED)" >&2
  exit 1
fi
echo done
