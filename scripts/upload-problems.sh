#!/usr/bin/env bash
# 問題データ（scripts/fetch-problems.sh で .cache/shogimate に取得したもの）を R2 にアップロードする。
# キー: mate{N}/NNN.txt
# 使い方:
#   scripts/upload-problems.sh                  # 全ファイルを本番の R2 へ
#   scripts/upload-problems.sh --missing        # R2 に無い（またはサイズが違う）ファイルだけ
#   scripts/upload-problems.sh --local          # ローカル（cf dev 用）の R2 へ全部（API を使わないので速い）
#   scripts/upload-problems.sh --local mate3    # ローカルの R2 へ mate3 だけ
# 環境変数: BUCKET（既定 simple-tsumeshogi-problems）, JOBS（並列数、既定 2・--local は 8）,
#           PROBLEMS_DIR（既定 .cache/shogimate/public/data）
#
# 📝 cf r2 objects put は Cloudflare REST API を1ファイル1回呼ぶ。API には5分あたり1,200リクエストの
#    上限があり、超えると 429 (code 971) で弾かれるので、並列数は小さく保つ（1ファイル約1秒 × 2並列 ≒ 毎秒2件）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-simple-tsumeshogi-problems}"
PROBLEMS_DIR="${PROBLEMS_DIR:-$ROOT/.cache/shogimate/public/data}"
LOCAL_FLAG=""
MISSING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL_FLAG="--local"; shift ;;
    --missing) MISSING=1; shift ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || set -- mate3 mate5 mate7 mate9 mate11
# ローカルは API のレート制限が無いので並列数を上げる
if [ -n "$LOCAL_FLAG" ]; then JOBS="${JOBS:-8}"; else JOBS="${JOBS:-2}"; fi

[ -d "$PROBLEMS_DIR/mate3" ] || { echo "問題データがありません。先に npm run fetch:problems を実行してください: $PROBLEMS_DIR" >&2; exit 1; }
cd "$PROBLEMS_DIR"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
for book in "$@"; do ls "$book"/*.txt; done > "$LIST"

if [ "$MISSING" = 1 ]; then
  # R2 の一覧（キーとサイズ）と比べて、無いもの・サイズが違うものだけ残す
  python3 -I - "$BUCKET" "$LIST" $LOCAL_FLAG <<'PY'
import json, os, subprocess, sys
bucket, list_path, *flags = sys.argv[1:]
remote, cursor = {}, None
while True:
    cmd = ['cf', 'r2', 'objects', 'list', '--bucket-name', bucket, '--per-page', '1000', *flags]
    if cursor: cmd += ['--cursor', cursor]
    r = subprocess.run(cmd, capture_output=True, text=True, check=True)
    # 一覧は stdout、ページ情報（cursor）は stderr の "result_info: {...}" 行に出る
    info = next((json.loads(l.split(':', 1)[1]) for l in r.stderr.splitlines() if l.startswith('result_info:')), {})
    for o in json.loads(r.stdout or '[]'):
        remote[o['key']] = o['size']
    if info.get('is_truncated') and info.get('cursor') == cursor:
        # 📝 ローカル（--local）の一覧はカーソルが進まず同じページを返し続けることがある
        sys.exit('R2 の一覧取得でカーソルが進みません。ローカルの場合は cf dev を起動して /problems/... に直接アクセスして確認してください')
    cursor = info.get('cursor')
    if not info.get('is_truncated'):
        break
files = open(list_path).read().split()
todo = [f for f in files if remote.get(f) != os.path.getsize(f)]
open(list_path, 'w').write(''.join(f + '\n' for f in todo))
print(f'R2 に {len(remote)} 件あり、{len(todo)} 件が未アップロード', file=sys.stderr)
PY
fi

TOTAL="$(wc -l < "$LIST" | tr -d ' ')"
echo "uploading $TOTAL files to r2://$BUCKET ${LOCAL_FLAG:-(remote)}"
[ "$TOTAL" -gt 0 ] || { echo done; exit 0; }

# 各ファイルは間隔を空けて最大3回試す（レート制限が解けるまで待つ）。それでも失敗したものは $FAILED に書き出す
FAILED="$ROOT/.cache/upload-failed.txt"
mkdir -p "$ROOT/.cache"
: > "$FAILED"
export BUCKET FAILED LOCAL_FLAG
# -I {} は置換後の長さに上限があるので使わず、ファイル名は $1 で渡す
xargs -n 1 -P "$JOBS" sh -c '
  for wait in 30 90 0; do
    cf r2 objects put "$1" --bucket-name "$BUCKET" --file "$1" --content-type "text/plain; charset=utf-8" --quiet $LOCAL_FLAG >/dev/null 2>&1 && exit 0
    [ "$wait" = 0 ] || sleep "$wait"
  done
  echo "$1" >> "$FAILED"
' _ < "$LIST"

if [ -s "$FAILED" ]; then
  echo "failed: $(wc -l < "$FAILED" | tr -d ' ') files (see $FAILED; rerun with --missing)" >&2
  exit 1
fi
echo done
