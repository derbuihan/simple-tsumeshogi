import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'tsumeshogi',
    compatibilityDate: '2026-11-01',
    entrypoint: './worker/index.ts',
    assets: {
      // API と問題データ（と開発時の投入口）だけ Worker で処理し、それ以外は静的アセットとして返す
      runWorkerFirst: ['/api/*', '/problems/*', '/__dev/*'],
    },
    env: {
      // 解答履歴（KV namespace: simple-tsumeshogi-history）
      HISTORY: bindings.kv({ id: 'be6208de555c42ecb6c92c69beb81c61' }),
      // 問題データ（.cache/minimal-hand/public/data を scripts/upload-problems.sh でアップロード）
      PROBLEMS: bindings.r2({ name: 'simple-tsumeshogi-problems' }),
      ASSETS: bindings.assets(),
    },
  },
});
