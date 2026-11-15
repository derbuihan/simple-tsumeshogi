/**
 * /api/history のハンドラ。Pages Functions（本番）と Vite 開発サーバー（ローカル）で共有する。
 *
 *   GET  /api/history                  → { records }
 *   POST /api/history { events: [...] } → { records, applied }
 *
 * 利用者は Cloudflare Access で認証済みの前提。Access が付与するメールアドレスごとに保存する。
 */
import { applyEvents, emptyHistory, type StoredHistory } from './record';

/** Workers KV のうち使う部分 */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const MAX_EVENTS_PER_REQUEST = 500;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export function historyKey(request: Request): string {
  const email = request.headers.get('cf-access-authenticated-user-email')?.trim().toLowerCase();
  return `history:v1:${email || 'default'}`;
}

async function load(kv: KVLike, key: string): Promise<StoredHistory> {
  const raw = await kv.get(key);
  if (!raw) return emptyHistory();
  const h = JSON.parse(raw) as StoredHistory;
  return h.version === 1 ? h : emptyHistory();
}

export async function handleHistory(request: Request, kv: KVLike): Promise<Response> {
  const key = historyKey(request);
  if (request.method === 'GET') {
    const h = await load(kv, key);
    return json({ records: h.records });
  }
  if (request.method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    const events = (body as { events?: unknown }).events;
    if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_REQUEST) return json({ error: 'invalid events' }, 400);
    const h = await load(kv, key);
    const applied = applyEvents(h, events);
    if (applied > 0) await kv.put(key, JSON.stringify(h));
    return json({ records: h.records, applied });
  }
  return json({ error: 'method not allowed' }, 405);
}
