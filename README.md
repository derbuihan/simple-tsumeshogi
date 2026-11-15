# simple-tsumeshogi

ブラウザで動く、個人用の**実戦詰将棋**学習アプリ（開発中）。

正解手順をなぞるのではなく、ブラウザ内の将棋エンジン（やねうら王 WASM）が玉方を指します。
収録された手順と違っても詰みが続く限り続行でき、3手詰を5手で詰ませても成功です。
解き終わったら最短解と自分の手順を見比べて、もう一度挑戦できます。

- PC・スマートフォン対応の1画面UI（TypeScript + Vite、フレームワークなし）
- 問題：3・5・7・9・11手詰 約500万問
- 玉方・詰み判定：やねうら王 + つようら王11mini（設定で11micro）
- 履歴：Cloudflare Workers KV、配信：Cloudflare Pages + Access

## セットアップ

```bash
git clone --recurse-submodules https://github.com/derbuihan/simple-tsumeshogi.git
cd simple-tsumeshogi
npm install
npm run dev
```

ビルド済みのエンジン（`public/engine/`）と問題データ（`data/problems/`）はリポジトリに含まれています。
本番では問題データを Cloudflare にアップロードせず、[jsDelivr](https://www.jsdelivr.com/) 経由で GitHub のタグ固定版（`problems-vN`、`.env.production` で指定）から読み込みます。開発サーバーではローカルの `data/problems/` を読みます。

### エンジンを再ビルドする場合

公式CIと同じ emsdk 3.1.43 が必要です（`.cache/emsdk` に置けば自動で使われます）。

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git .cache/emsdk
.cache/emsdk/emsdk install 3.1.43 && .cache/emsdk/emsdk activate 3.1.43
npm run build:engine -- mini      # micro も同様
npm run smoke:engine -- mini 3 2000
```

### データを取り直す場合

```bash
npm run fetch:problems   # shogimate から問題データを取得し public/problems-index.json を生成
npm run fetch:eval       # つようら王11mini/micro を取得
```

## 構成

| パス | 内容 |
|---|---|
| `engine/YaneuraOu` | やねうら王（submodule: [derbuihan/YaneuraOu](https://github.com/derbuihan/YaneuraOu) の `tsumeshogi-wasm` ブランチ。王手だけを列挙する USI 拡張コマンド `checks` を追加） |
| `engine/build.sh` | WASM ビルド |
| `public/engine/` | ビルド済みエンジンと評価関数 |
| `data/problems/` | 問題データ（`mate{3,5,7,9,11}/NNN.txt`、1行1問：`<SFEN> moves <手順>`）。本番は jsDelivr から配信 |
| `public/problems-index.json` | 手数ごと・巻ごとの問題数 |
| `scripts/` | データ取得・エンジン検証スクリプト |

## クレジットとライセンス

このリポジトリは **GPL-3.0** です（[LICENSE](LICENSE)）。

- [やねうら王](https://github.com/yaneurao/YaneuraOu) — GPL-3.0
- つようら王11mini/micro 評価関数 — MIT License（[public/engine/eval/LICENSE](public/engine/eval/LICENSE)、配布元: [やねうらおのFANBOX](https://yaneurao.fanbox.cc/posts/12761272)）
- 問題データ — [やねうら王 2020年クリスマスプレゼント](https://yaneuraou.yaneu.com/2020/12/25/christmas-present/)の実戦詰将棋。[usumerican/shogimate](https://github.com/usumerican/shogimate)（GPL-3.0）の `public/data` から取得
- UI・エンジン連携の設計は [shogimate](https://github.com/usumerican/shogimate) を参考にしています
