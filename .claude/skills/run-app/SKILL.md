---
name: run-app
description: simple-tsumeshogi を cf dev で起動し、headless Chrome で決めた問題を解いて、駒の移動・着地・詰みの演出と後片付けを計測・スクリーンショットする。アプリを実際に動かして確かめるとき（演出・盤の描画・結果カード・振り返りの変更）に使う。
---

# アプリを起動して動かす

chromium-cli も Playwright も入っていない。`google-chrome` を headless で起動し、
同じディレクトリの `drive.mjs` が Chrome DevTools Protocol を直接使って操作する（Node 22 の組み込みの WebSocket を使う。依存は増やさない）。

## 1. 開発サーバー

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill        # 前のが残っていれば止める
(npm run dev > /tmp/tsume-dev.log 2>&1 &)
timeout 60 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
curl -s -o /dev/null -w '%{http_code}\n' localhost:5173/problems/mate3/001.txt   # 200 であること
```

- 問題データは手元の R2 から配信される。404 なら、cf dev を起動したまま `npm run upload:problems -- --local mate3` で入れる（README 参照）。
- 止めるときは `lsof -ti:5173 -sTCP:LISTEN | xargs -r kill`。`$!` は npm のラッパーなので kill しても止まらない。

## 2. 問題を決めて解く

出す問題は localStorage の `tsume.upcoming.v1` に入れて決め打ちにする（drive.mjs が読み込み前に入れる）。問題 ID は `mate{N}/{巻}/{行番号（0始まり）}`、行は問題データの1行そのもの。

```bash
D=.claude/skills/run-app
LINE=$(curl -s localhost:5173/problems/mate3/001.txt | sed -n 1p)    # 攻方が先手。ふつうの手 → 応手 → 駒打ちで詰み
node $D/drive.mjs full   mate3/001/0 "$LINE"
node $D/drive.mjs cancel mate3/001/0 "$LINE"
LINE=$(curl -s localhost:5173/problems/mate3/001.txt | sed -n 2p)    # 攻方が後手（盤が反転する）
node $D/drive.mjs full   mate3/001/1 "$LINE"
```

- `full`：正解手順を指して詰ませる → カードが出るのを待つ → Escape で閉じて振り返り → ←→ を連打する
- `cancel`：詰ませ、ヒットストップの直後にカードを出して閉じ、振り返りで1手戻す（詰みの演出を途中で止める）
- スクリーンショットは `/tmp/tsume-drive/<scenario>-*.png`（`OUT` で変えられる）。**Read で必ず見る**。`full-2-mate-stamp.png` に「詰」の印、`full-3-dialog.png` に結果カードが出ていること

## 3. 出力の読み方（JSON）

時刻は最後の攻方の手をタップしてからの ms。

| 項目 | 期待 |
|---|---|
| `log` | `moving`（運ぶ）→ 約80ms 後に `+ impact-fx`・`+ impact-fx over`・`+ board-ripple`（着地）→ 約110ms 後に `+ impact-fx`・`+ board-ripple mate`（玉）→ 約220ms 後に `+ mate-stamp` |
| `pauses` | 着地の演出の数（ヒットストップで止めたもの。ふつうの手なら16前後） |
| `dialogAt` | 約790ms（カードが出た時刻） |
| `unresolved` | `mate-stamp` だけ（1.6秒かけて消えるため）。ほかが `pending=true` で残っていたら、終わらないアニメーションがある |
| `leftover` | `impact-fx`（玉のマスを灯し続ける光）と `mate-stamp` だけ |
| `mash.right` / `mash.after1s` | `fx: 0`、`frameAnims: 0`（局面を変えたら演出が残らない） |
| `cancel` の `log` / `after` | `CUT` の直後に演出の DOM がすべて `-` になり、`mate-stamp` が出ない。`fx: 0`、`replay: true` |
| `errors` | 空 |

`failed` が入っていたら `<scenario>-failed.png` を見る。

## 分かっている落とし穴

- **盤に入れる前の要素に `animate()` しない。** 開始待ち（pending）のうちに詰みのヒットストップで pause → play されると、Chrome では `currentTime=0` のまま永久に止まり、`finished` が解決しない（演出の DOM が取り除かれずに残る）。`unresolved` に `pending=true` が出たらこれを疑う。
- エンジン（WASM）の読み込みが間に合わなくても、1手目は保留されて後で指されるので、待ち時間を長くしなくてよい。
- 振り返りの ←→ は、カードを閉じた後（`dialog: 'closed'`）でないと効かない。
- 解くたびに履歴（手元の D1）に記録され、次の問題が `tsume.upcoming.v1` に保存される。drive.mjs は毎回新しいプロファイルで開き、読み込み前に問題を入れ直すので、影響しない。
