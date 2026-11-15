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
      // 解答履歴。id は `cf kv namespaces create` で作成した値（デプロイ時に設定）
      HISTORY: bindings.kv(),
      // 問題データ（data/problems/ を scripts/upload-problems.sh でアップロード）
      PROBLEMS: bindings.r2({ name: 'simple-tsumeshogi-problems' }),
      ASSETS: bindings.assets(),
    },
  },
});
