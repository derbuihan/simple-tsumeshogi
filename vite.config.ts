import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vitest/config';

// エンジン（pthread の WASM）は SharedArrayBuffer を使うので、ページをクロスオリジン分離する。
// 本番は public/_headers で同じヘッダーを付ける。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // cloudflare.config.ts の Worker（/api/history, /problems/*）を workerd で動かす。KV・R2 はローカルで再現される
  plugins: [cloudflare()],
  server: { port: 5173, strictPort: true, headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: { include: ['tests/**/*.test.ts'] },
});
