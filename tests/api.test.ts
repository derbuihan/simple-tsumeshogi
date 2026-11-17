import { describe, expect, it } from 'vitest';
import { handleHistory } from '../src/history/api';
import { applyEvents, emptyHistory, type HistoryEvent, type Records } from '../src/history/record';
import { memoryD1 } from './d1';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const get = (id?: string) => new Request('http://x/api/history', { headers: id ? { 'x-history-id': id } : {} });
const post = (events: unknown, id: string | undefined = ID_A, body?: string) =>
  new Request('http://x/api/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(id ? { 'x-history-id': id } : {}) },
    body: body ?? JSON.stringify({ events }),
  });
const event = (id: string, outcome = 'shortest', problemId = 'mate3/000/1', at = 1): HistoryEvent =>
  ({ id, problemId, outcome, moves: 3, at }) as HistoryEvent;
const records = async (db: ReturnType<typeof memoryD1>['db'], id = ID_A) =>
  ((await (await handleHistory(get(id), db)).json()) as { records: Records }).records;

describe('/api/history', () => {
  it('POST で追記し、GET で SQL の集計が返る。再送は二重にならない', async () => {
    const { db, count } = memoryD1();
    let res = await handleHistory(post([event('a')]), db);
    expect(await res.json()).toEqual({ received: 1 });
    res = await handleHistory(post([event('a'), event('b', 'fail')]), db);
    expect(res.status).toBe(200);
    expect(count()).toBe(2);
    expect((await records(db))['mate3/000/1']).toMatchObject({ attempts: 2, shortest: 1, fails: 1, bestMoves: 3 });
  });

  it('SQL の集計は、クライアントの applyEvents と同じ結果になる', async () => {
    const { db } = memoryD1();
    const outcomes = ['shortest', 'clear', 'clear-after-viewing', 'fail', 'giveup'];
    // at が前後する・同じ時刻・手数が無い、を含む（at は一意にしない）
    const events: HistoryEvent[] = Array.from({ length: 60 }, (_, i) => ({
      id: `e${i}`,
      problemId: `mate${[3, 5][i % 2]}/000/${i % 4}`,
      outcome: outcomes[(i * 7) % 5],
      moves: (i * 3) % 7 === 0 ? undefined : 3 + 2 * ((i * 5) % 4),
      at: 1000 + ((i * 13) % 17),
    })) as HistoryEvent[];
    await handleHistory(post(events), db);
    const expected = emptyHistory();
    applyEvents(expected, events);
    const actual = await records(db);
    // firstClearAt は「最初に適用した」ではなく「最も早い at」なので、at の最小で比べる
    for (const [problemId, r] of Object.entries(expected.records)) {
      const clears = events.filter((e) => e.problemId === problemId && e.outcome !== 'fail' && e.outcome !== 'giveup');
      const { firstClearAt, ...rest } = r;
      expect(actual[problemId], problemId).toMatchObject(rest);
      expect(actual[problemId].firstClearAt).toBe(clears.length ? Math.min(...clears.map((e) => e.at)) : undefined);
      void firstClearAt;
    }
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected.records).sort());
  });

  it('履歴 ID ごとに分かれ、他の ID からは見えない', async () => {
    const { db } = memoryD1();
    await handleHistory(post([event('a')], ID_A), db);
    expect(await records(db, ID_B)).toEqual({});
  });

  it('履歴 ID が無い・形式が違うと 400（何も書かない）', async () => {
    const { db, count } = memoryD1();
    expect((await handleHistory(post([event('a')], ''), db)).status).toBe(400);
    expect((await handleHistory(post([event('a')], 'default'), db)).status).toBe(400);
    expect((await handleHistory(get(), db)).status).toBe(400);
    expect(count()).toBe(0);
  });

  it('大きすぎる本文は 413、範囲外の値は無視する', async () => {
    const { db, count } = memoryD1();
    expect((await handleHistory(post([], ID_A, 'x'.repeat(200 * 1024)), db)).status).toBe(413);
    const bad = [
      { ...event('a'), problemId: 'mate99999/999/99999999' },
      { ...event('b'), moves: 1e9 },
      { ...event('c'), at: 1e15 },
    ];
    expect(await (await handleHistory(post(bad), db)).json()).toEqual({ received: 0 });
    expect(count()).toBe(0);
  });

  it('不正なリクエストは 400/405', async () => {
    const { db } = memoryD1();
    expect((await handleHistory(post('x'), db)).status).toBe(400);
    expect((await handleHistory(post([], ID_A, 'not json'), db)).status).toBe(400);
    expect((await handleHistory(new Request('http://x/api/history', { method: 'DELETE' }), db)).status).toBe(405);
  });
});
