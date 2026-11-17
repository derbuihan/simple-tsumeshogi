/**
 * /api/history のハンドラ。Worker（worker/index.ts）から呼ばれる。
 *
 *   GET  /api/history                  → { records }   （問題ごとの集計。D1 の SQL で集計して返す）
 *   POST /api/history { events: [...] } → { received }   （有効なイベントの数。追記済みの再送は無視される）
 *
 * 履歴は追記専用のイベントの表（D1: history_events）1つだけ。集計は読むときに SQL（GROUP BY）で行い、
 * クライアントは返ってきた集計をそのまま使う。同じ (device_id, id) の再送は無視される（二重にならない）。
 *
 * 認証は無い（誰でも呼べる）。履歴は、端末が作る推測できないランダムな ID（ヘッダー x-history-id、UUID）ごとに分ける。
 * ID を知らない人は他人の履歴を読み書きできない。ID が無い・形式が違うリクエストは 400。
 */
import { isValidEvent, type Records } from './record';

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

/**
 * 問題ごとの集計（record.ts の applyEvent と同じ規則）。
 *   clears            : 自力クリア（shortest, clear）。解答を見た後のクリアは clearsAfterViewing に入れる
 *   bestMoves/firstClearAt : 3種のクリア（解答を見た後を含む）の最短手数／最初の時刻
 *   lastAt/lastOutcome: 最も新しい at のイベント（同じ時刻なら後から追記したもの）
 */
const AGGREGATE_SQL = `
WITH t AS (
  SELECT problem_id, outcome, moves, at,
         ROW_NUMBER() OVER (PARTITION BY problem_id ORDER BY at DESC, seq DESC) AS rn
  FROM history_events WHERE device_id = ?1
)
SELECT problem_id AS problemId,
       COUNT(*) AS attempts,
       SUM(outcome IN ('shortest', 'clear')) AS clears,
       SUM(outcome = 'shortest') AS shortest,
       SUM(outcome = 'clear-after-viewing') AS clearsAfterViewing,
       SUM(outcome = 'fail') AS fails,
       SUM(outcome = 'giveup') AS giveups,
       MIN(CASE WHEN outcome IN ('shortest', 'clear', 'clear-after-viewing') THEN moves END) AS bestMoves,
       MIN(CASE WHEN outcome IN ('shortest', 'clear', 'clear-after-viewing') THEN at END) AS firstClearAt,
       MAX(at) AS lastAt,
       MAX(CASE WHEN rn = 1 THEN outcome END) AS lastOutcome
FROM t GROUP BY problem_id`;

interface AggregateRow {
  problemId: string;
  attempts: number;
  clears: number;
  shortest: number;
  clearsAfterViewing: number;
  fails: number;
  giveups: number;
  bestMoves: number | null;
  firstClearAt: number | null;
  lastAt: number;
  lastOutcome: Records[string]['lastOutcome'];
}

export async function handleHistory(request: Request, db: D1Like): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const deviceId = historyId(request);
  if (!deviceId) return json({ error: 'invalid history id' }, 400);

  if (request.method === 'GET') {
    const { results } = await db.prepare(AGGREGATE_SQL).bind(deviceId).all<AggregateRow>();
    const records: Records = {};
    for (const { problemId, bestMoves, firstClearAt, ...r } of results) {
      records[problemId] = {
        ...r,
        ...(bestMoves === null ? {} : { bestMoves }),
        ...(firstClearAt === null ? {} : { firstClearAt }),
      };
    }
    return json({ records });
  }

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: 'too large' }, 413);
  let events: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413);
    events = (JSON.parse(text) as { events?: unknown })?.events;
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_REQUEST) return json({ error: 'invalid events' }, 400);
  const valid = events.filter(isValidEvent);
  if (valid.length) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO history_events (device_id, id, problem_id, outcome, moves, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    );
    await db.batch(valid.map((e) => insert.bind(deviceId, e.id, e.problemId, e.outcome, e.moves ?? null, e.at)));
  }
  return json({ received: valid.length });
}
