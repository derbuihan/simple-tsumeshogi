import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'simple-tsumeshogi',
    compatibilityDate: '2026-11-01',
    entrypoint: './worker/index.ts',
    assets: {
      // API と問題データだけ Worker で処理し、それ以外は静的アセットとして返す
      runWorkerFirst: ['/api/*', '/problems/*'],
    },
    env: {
      // 解答履歴（KV namespace: simple-tsumeshogi-history）
      HISTORY: bindings.kv({ id: 'be6208de555c42ecb6c92c69beb81c61' }),
      // 問題データ（data/problems/ を scripts/upload-problems.sh でアップロード）
      PROBLEMS: bindings.r2({ name: 'simple-tsumeshogi-problems' }),
      ASSETS: bindings.assets(),
    },
  },
});
