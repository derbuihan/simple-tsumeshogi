# simple-tsumeshogi

ブラウザで動く、個人用の**実戦詰将棋**学習アプリ（開発中）。

正解手順をなぞるのではなく、ブラウザ内の将棋エンジン（やねうら王 WASM）が玉方を指します。
収録された手順と違っても詰みが続く限り続行でき、3手詰を5手で詰ませても成功です。
解き終わったら最短解と自分の手順を見比べて、もう一度挑戦できます。

- PC・スマートフォン対応の1画面UI（TypeScript + Vite、フレームワークなし）
- 問題：3・5・7・9・11手詰 約413万問
- 玉方：やねうら王 + つようら王11mini（設定で11micro）
- 詰み判定：やねうら王の詰将棋エンジン版（df-pn）。結論が出ないときは mini で判定（[docs/engine-tuning.md](docs/engine-tuning.md)）
- 配信：Cloudflare Workers（静的アセット、独自ドメイン `tsumeshogi.houchishoujo.com`）、問題データ：R2、履歴：D1

## セットアップ

```bash
git clone --recurse-submodules https://github.com/derbuihan/simple-tsumeshogi.git
cd simple-tsumeshogi
npm install
npm run dev
```

ビルド済みのエンジン（`public/engine/`）はリポジトリに含まれています。
問題データ（約500MB）はリポジトリに含めず、R2 に置きます。
現在の問題データは、攻方の持ち駒を最低限にし、正解手順を作り直した `.cache/regen-solutions/public/data` です。索引（`public/problems-index.json`）と R2 には同じデータを使います。
`npm run dev` は [`cf dev`](https://developers.cloudflare.com/cf/)（Vite + Cloudflare Vite プラグイン）で、Worker・D1・R2 をローカルで再現して起動します。
開発時も本番と同じく Worker が R2（ローカル）から `/problems/` で返すので、初回だけ問題データをローカルの R2 に入れてください。

```bash
npm run dev                          # 先に起動しておく（投入は起動中の Worker 経由）
npm run upload:problems -- --local   # 別の端末で投入（6分前後）
```

正本を作り直すときは、元データを取得して変換します（全件で数時間以上かかる。詳しくは [docs/minimal-hand.md](docs/minimal-hand.md)）。

```bash
npm run fetch:problems           # shogimate から .cache/shogimate に取得
npm run prepare:mate-engine      # 変換に使う詰み証明エンジンを用意
npm run filter:minimal-hand -- --engine "$PWD/.cache/research/YaneuraOu/source/YaneuraOu-by-gcc"  # .cache/minimal-hand に変換
npm run prepare:native-mini      # 正解手順の作り直しに使うエンジンを用意
npm run regen:solutions          # .cache/regen-solutions に出力
```

### デプロイ

アプリは Workers Builds（GitHub 連携、Worker 名 `tsumeshogi`）で、`main` への push ごとに Cloudflare 側でビルド・デプロイされます（ビルド: `npm run build`、デプロイ: `npx cf deploy --prebuilt`、Node は `.nvmrc` で指定）。

問題データの R2 へのアップロードは、データを変えたときだけ手元から行います。

```bash
npm run build:index       # 索引を作り直し、コミットしてデプロイ
npm run upload:problems   # 同じデータを本番 R2 に投入
```

📝 どちらも既定で `.cache/regen-solutions/public/data` を入力に使う。アップロード先の入力は `PROBLEMS_DIR` で変更できる。`--missing` はサイズが同じで内容が異なるファイルを検出できないため、手順を更新したときの全件反映には使わない。
問題 ID は「手数/巻/行番号」なので、索引と R2 のデータは必ず同じ出力から作ること。問題を足したり除いたりすると行番号がずれ、解答履歴の ID が別の問題を指すようになるので、そのときは D1 の履歴もリセットする。既存ブラウザの問題キャッシュにも注意する。

### エンジンを再ビルドする場合

公式CIと同じ emsdk 3.1.43 が必要です（`.cache/emsdk` に置けば自動で使われます）。

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git .cache/emsdk
.cache/emsdk/emsdk install 3.1.43 && .cache/emsdk/emsdk activate 3.1.43
npm run build:engine -- mini      # micro も同様
npm run prepare:mate-engine && npm run build:engine -- mate   # 詰み専用エンジン
npm run smoke:engine -- mini 3 2000
```

### 評価関数を取り直す場合

```bash
npm run fetch:eval       # つようら王11mini/micro を取得
```

## 構成

| パス | 内容 |
|---|---|
| `engine/YaneuraOu` | やねうら王（submodule: [derbuihan/YaneuraOu](https://github.com/derbuihan/YaneuraOu) の `tsumeshogi-wasm` ブランチ。王手だけを列挙する USI 拡張コマンド `checks` を追加） |
| `engine/build.sh` | WASM ビルド |
| `cloudflare.config.ts` | Worker の設定（D1 `HISTORY`、R2 `PROBLEMS`、静的アセット、独自ドメイン） |
| `worker/index.ts` | Worker 本体（`/api/history` と `/problems/*`） |
| `migrations/` | D1（履歴）のテーブル定義。`npx cf d1 migrations apply <データベース ID>`（ローカルは `--local`）で適用 |
| `public/engine/` | ビルド済みエンジンと評価関数 |
| `.cache/regen-solutions/public/data/` | 現在配信する問題データ（`mate{3,5,7,9,11}/NNN.txt`、1行1問：`<SFEN> moves <手順>`）。Git 管理外 |
| `.cache/minimal-hand/public/data/` | 持ち駒を最低限にした中間データ。正解手順作り直しの入力。Git 管理外 |
| `.cache/shogimate/public/data/` | 正本を作り直すときだけ取得する元データ（形式は同じ）。Git 管理外 |
| `public/problems-index.json` | 手数ごと・巻ごとの問題数 |
| `scripts/` | データ取得・エンジン検証スクリプト |

## クレジットとライセンス

このリポジトリは **GPL-3.0** です（[LICENSE](LICENSE)）。

- [やねうら王](https://github.com/yaneurao/YaneuraOu) — GPL-3.0
- つようら王11mini/micro 評価関数 — MIT License（[public/engine/eval/LICENSE](public/engine/eval/LICENSE)、配布元: [やねうらおのFANBOX](https://yaneurao.fanbox.cc/posts/12761272)）
- 問題データ — [やねうら王 2020年クリスマスプレゼント](https://yaneuraou.yaneu.com/2020/12/25/christmas-present/)の実戦詰将棋。[usumerican/shogimate](https://github.com/usumerican/shogimate)（GPL-3.0）の `public/data` から取得
- UI・エンジン連携の設計は [shogimate](https://github.com/usumerican/shogimate) を参考にしています
