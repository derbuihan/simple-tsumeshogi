/**
 * /api/history のハンドラ。Worker（worker/index.ts）から呼ばれる。
 *
 *   GET  /api/history                  → { records }
 *   POST /api/history { events: [...] } → { records, applied }
 *
 * 認証は無い（誰でも呼べる）。履歴は、端末が作る推測できないランダムな ID（ヘッダー x-history-id、UUID）ごとに保存する。
 * ID を知らない人は他人の履歴を読み書きできない。ID が無い・形式が違うリクエストは 400。
 */
import { applyEvents, emptyHistory, type StoredHistory } from './record';

/** Workers KV のうち使う部分 */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const MAX_EVENTS_PER_REQUEST = 500;
/** 500 件のイベントでも約 75KB なので、余裕を見て 128KB を超える本文は読まない */
const MAX_BODY_BYTES = 128 * 1024;
const HISTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** 履歴の保存キー。ID が無い・形式が違うときは null */
export function historyKey(request: Request): string | null {
  const id = request.headers.get('x-history-id')?.trim().toLowerCase();
  return id && HISTORY_ID.test(id) ? `history:v1:${id}` : null;
}

async function load(kv: KVLike, key: string): Promise<StoredHistory> {
  const raw = await kv.get(key);
  if (!raw) return emptyHistory();
  const h = JSON.parse(raw) as StoredHistory;
  return h.version === 1 ? h : emptyHistory();
}

export async function handleHistory(request: Request, kv: KVLike): Promise<Response> {
  const key = historyKey(request);
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!key) return json({ error: 'invalid history id' }, 400);
  if (request.method === 'GET') {
    const h = await load(kv, key);
    return json({ records: h.records });
  }
  if (request.method === 'POST') {
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: 'too large' }, 413);
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413);
      body = JSON.parse(text);
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
