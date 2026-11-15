import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { handleHistory, type KVLike } from './src/history/api';

/** 開発サーバーで /api/history を動かす（KV の代わりに .cache/dev-kv.json に保存） */
function devHistoryApi(): Plugin {
  const file = path.resolve('.cache/dev-kv.json');
  const read = (): Record<string, string> => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const kv: KVLike = {
    get: async (k) => read()[k] ?? null,
    put: async (k, v) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...read(), [k]: v }));
    },
  };
  return {
    name: 'dev-history-api',
    configureServer(server) {
      server.middlewares.use('/api/history', async (req, res) => {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
        const request = new Request(`http://localhost${req.originalUrl ?? req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body,
          duplex: 'half',
        } as RequestInit);
        const response = await handleHistory(request, kv);
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await response.text());
      });
    },
  };
}

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [devHistoryApi()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: { include: ['tests/**/*.test.ts'] },
});
