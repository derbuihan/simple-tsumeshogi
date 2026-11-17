/**
 * Cloudflare Worker（静的アセット付き）。
 *   /api/history     … 解答履歴（Workers KV）
 *   /problems/*.txt  … 問題データ（R2）。同一オリジンで返すので CORS/COEP の考慮が不要
 *   /__dev/problems  … 開発時（cf dev）だけ。POST で問題データをまとめてローカルの R2 に入れる（scripts/upload-problems-local.mjs）
 *   それ以外          … 静的アセット（Vite のビルド結果。_headers で COOP/COEP を付与）
 */
import { handleHistory, type KVLike } from '../src/history/api';

/** R2 のうち使う部分 */
interface R2ObjectBodyLike {
  body: ReadableStream;
  httpEtag: string;
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

/** Workers の Rate Limiting バインディング */
interface RateLimitLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  HISTORY: KVLike;
  /** 履歴の書き込み（POST）を IP ごとに制限する。KV の書き込み枠（無料は1日1,000回）を使い切られないように */
  HISTORY_WRITE_LIMITER: RateLimitLike;
  PROBLEMS: R2BucketLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const PROBLEM_PATH = /^\/problems\/(mate\d+\/\d{3}\.txt)$/;
const PROBLEM_KEY = /^mate\d+\/\d{3}\.txt$/;

async function serveProblem(request: Request, env: Env, key: string): Promise<Response> {
  const obj = await env.PROBLEMS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  if (request.headers.get('if-none-match') === obj.httpEtag) return new Response(null, { status: 304 });
  return new Response(obj.body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      etag: obj.httpEtag,
      // 問題データは更新しない前提（更新するときはパスを変える）。ブラウザに1年キャッシュさせる
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

/**
 * 開発時だけの投入口。本文は { "mate3/000.txt": "<中身>", ... }。
 * 📝 cf dev はリクエスト1件ごとに約0.1秒かかり並列にしても速くならないので、1リクエストで複数ファイルを受け取る
 */
async function putProblemsForDev(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('not found', { status: 404 });
  const files = (await request.json()) as Record<string, string>;
  const keys = Object.keys(files);
  const bad = keys.find((k) => !PROBLEM_KEY.test(k) || typeof files[k] !== 'string');
  if (bad !== undefined) return new Response(`invalid key: ${bad}`, { status: 400 });
  await Promise.all(keys.map((k) => env.PROBLEMS.put(k, files[k], { httpMetadata: { contentType: 'text/plain; charset=utf-8' } })));
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // 📝 import.meta.env.DEV は Vite が置き換える（cf dev では true、ビルドでは false になり分岐ごと消える）
    if (import.meta.env.DEV && url.pathname === '/__dev/problems') return putProblemsForDev(request, env);
    if (url.pathname === '/api/history') {
      if (request.method === 'POST') {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const { success } = await env.HISTORY_WRITE_LIMITER.limit({ key: ip });
        if (!success) return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
      }
      return handleHistory(request, env.HISTORY);
    }
    if (url.pathname.startsWith('/problems/')) {
      const m = url.pathname.match(PROBLEM_PATH);
      if (!m || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response('not found', { status: 404 });
      return serveProblem(request, env, m[1]);
    }
    return env.ASSETS.fetch(request);
  },
};
