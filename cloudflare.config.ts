import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'tsumeshogi',
    compatibilityDate: '2026-11-01',
    entrypoint: './worker/index.ts',
    // 公開は独自ドメインだけ。ゾーンの WAF・レート制限が効かない workers.dev と、バージョンごとのプレビュー用 URL は止める
    domains: ['tsumeshogi.houchishoujo.com'],
    workersDev: false,
    previewUrls: false,
    // 攻撃やアクセス急増を後から見られるようにする（Free は1日の枠に達すると取り込みが止まるだけで、課金されない）
    observability: { enabled: true, headSamplingRate: 0.2 },
    assets: {
      // API と問題データ（と開発時の投入口）だけ Worker で処理し、それ以外は静的アセットとして返す
      runWorkerFirst: ['/api/*', '/problems/*', '/__dev/*'],
    },
    env: {
      // 解答履歴（KV namespace: simple-tsumeshogi-history）
      HISTORY: bindings.kv({ id: 'be6208de555c42ecb6c92c69beb81c61' }),
      // 問題データ（.cache/minimal-hand/public/data を scripts/upload-problems.sh でアップロード）
      PROBLEMS: bindings.r2({ name: 'simple-tsumeshogi-problems' }),
      // 履歴の書き込み（POST）を IP ごとに60秒30回まで（上限は拠点ごとの概算）
      HISTORY_WRITE_LIMITER: bindings.rateLimit({ namespace: '1001', simple: { limit: 30, period: 60 } }),
      ASSETS: bindings.assets(),
    },
  },
});
