/**
 * /api/history のハンドラ。Worker（worker/index.ts）から呼ばれる。
 *
 *   GET  /api/history?since=N                    → { events, next, more }
 *   POST /api/history { events: [...], since: N } → { events, next, more }   （追記してから、同じ形で差分を返す）
 *
 * 履歴は追記専用のイベントの表（D1: history_events）。集計はクライアントが行う。
 *   - events: seq が N より後のイベント（seq の順、最大 PAGE_SIZE 件）。クライアントは next を次の since に使う
 *   - more: まだ続きがある（続けて取りに来る）
 *   - 同じ (device_id, id) の再送は無視される（二重にならない）
 *
 * 認証は無い（誰でも呼べる）。履歴は、端末が作る推測できないランダムな ID（ヘッダー x-history-id、UUID）ごとに分ける。
 * ID を知らない人は他人の履歴を読み書きできない。ID が無い・形式が違うリクエストは 400。
 */
import { isValidEvent, type HistoryEvent } from './record';

/** D1 のうち使う部分 */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

const MAX_EVENTS_PER_REQUEST = 500;
/** 1回の応答に入れるイベントの最大数。超えるときは more: true で続きを取りに来させる */
const PAGE_SIZE = 500;
/** 500 件のイベントでも約 75KB なので、余裕を見て 128KB を超える本文は読まない */
const MAX_BODY_BYTES = 128 * 1024;
const HISTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** 履歴 ID（小文字の UUID）。無い・形式が違うときは null */
export function historyId(request: Request): string | null {
  const id = request.headers.get('x-history-id')?.trim().toLowerCase();
  return id && HISTORY_ID.test(id) ? id : null;
}

interface Row {
  seq: number;
  id: string;
  problemId: string;
  outcome: HistoryEvent['outcome'];
  moves: number | null;
  at: number;
}

async function eventsSince(db: D1Like, deviceId: string, since: number) {
  const { results } = await db
    .prepare(
      'SELECT seq, id, problem_id AS problemId, outcome, moves, at FROM history_events WHERE device_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3',
    )
    .bind(deviceId, since, PAGE_SIZE + 1)
    .all<Row>();
  const more = results.length > PAGE_SIZE;
  const page = more ? results.slice(0, PAGE_SIZE) : results;
  const events = page.map((r) => ({
    id: r.id,
    problemId: r.problemId,
    outcome: r.outcome,
    ...(r.moves === null ? {} : { moves: r.moves }),
    at: r.at,
  }));
  return { events, next: page.length ? page[page.length - 1].seq : since, more };
}

const toSince = (v: unknown): number => (typeof v === 'number' || typeof v === 'string') && Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0;

export async function handleHistory(request: Request, db: D1Like): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const deviceId = historyId(request);
  if (!deviceId) return json({ error: 'invalid history id' }, 400);

  if (request.method === 'GET') {
    const since = toSince(new URL(request.url).searchParams.get('since'));
    return json(await eventsSince(db, deviceId, since));
  }

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: 'too large' }, 413);
  let body: { events?: unknown; since?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413);
    body = JSON.parse(text) as { events?: unknown; since?: unknown };
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const events = body?.events;
  if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_REQUEST) return json({ error: 'invalid events' }, 400);
  const valid = events.filter(isValidEvent);
  if (valid.length) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO history_events (device_id, id, problem_id, outcome, moves, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    );
    await db.batch(valid.map((e) => insert.bind(deviceId, e.id, e.problemId, e.outcome, e.moves ?? null, e.at)));
  }
  return json(await eventsSince(db, deviceId, toSince(body.since)));
}
