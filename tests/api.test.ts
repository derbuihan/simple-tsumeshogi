import { describe, expect, it } from 'vitest';
import { handleHistory } from '../src/history/api';
import { memoryD1 } from './d1';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const get = (id?: string, since?: number) =>
  new Request(`http://x/api/history${since === undefined ? '' : `?since=${since}`}`, { headers: id ? { 'x-history-id': id } : {} });
const post = (events: unknown, id: string | undefined = ID_A, since = 0, body?: string) =>
  new Request('http://x/api/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(id ? { 'x-history-id': id } : {}) },
    body: body ?? JSON.stringify({ events, since }),
  });
const event = (id: string, outcome = 'shortest') => ({ id, problemId: 'mate3/000/1', outcome, moves: 3, at: 1 });
type Body = { events: { id: string; moves?: number }[]; next: number; more: boolean };

describe('/api/history', () => {
  it('POST で追記すると、その分が差分として返る。再送は二重にならない', async () => {
    const { db, count } = memoryD1();
    let body = (await (await handleHistory(post([event('a')]), db)).json()) as Body;
    expect(body.events.map((e) => e.id)).toEqual(['a']);
    expect(body.events[0].moves).toBe(3);
    expect(body.more).toBe(false);
    // a は再送、b は新規。since に前回の next を渡すと b だけが返る
    const next = body.next;
    body = (await (await handleHistory(post([event('a'), event('b', 'fail')], ID_A, next), db)).json()) as Body;
    expect(body.events.map((e) => e.id)).toEqual(['b']);
    expect(body.events[0].moves).toBe(3);
    expect(count()).toBe(2);
  });

  it('GET ?since= は、それより後のイベントだけを seq の順に返す', async () => {
    const { db } = memoryD1();
    await handleHistory(post([event('a'), event('b'), event('c')]), db);
    const all = (await (await handleHistory(get(ID_A), db)).json()) as Body;
    expect(all.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    const rest = (await (await handleHistory(get(ID_A, all.next - 1), db)).json()) as Body;
    expect(rest.events.map((e) => e.id)).toEqual(['c']);
    const none = (await (await handleHistory(get(ID_A, all.next), db)).json()) as Body;
    expect(none).toEqual({ events: [], next: all.next, more: false });
  });

  it('多いときはページに分けて返す（more）', async () => {
    const { db } = memoryD1();
    await handleHistory(post(Array.from({ length: 500 }, (_, i) => event(`a${i}`))), db);
    await handleHistory(post(Array.from({ length: 10 }, (_, i) => event(`b${i}`))), db);
    const first = (await (await handleHistory(get(ID_A, 0), db)).json()) as Body;
    expect(first.events).toHaveLength(500);
    expect(first.more).toBe(true);
    const second = (await (await handleHistory(get(ID_A, first.next), db)).json()) as Body;
    expect(second.events).toHaveLength(10);
    expect(second.more).toBe(false);
  });

  it('履歴 ID ごとに分かれ、他の ID からは見えない', async () => {
    const { db } = memoryD1();
    await handleHistory(post([event('a')], ID_A), db);
    const body = (await (await handleHistory(get(ID_B), db)).json()) as Body;
    expect(body.events).toEqual([]);
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
    expect((await handleHistory(post([], ID_A, 0, 'x'.repeat(200 * 1024)), db)).status).toBe(413);
    const bad = [
      { ...event('a'), problemId: 'mate99999/999/99999999' },
      { ...event('b'), moves: 1e9 },
      { ...event('c'), at: 1e15 },
    ];
    const body = (await (await handleHistory(post(bad), db)).json()) as Body;
    expect(body.events).toEqual([]);
    expect(count()).toBe(0);
  });

  it('不正なリクエストは 400/405', async () => {
    const { db } = memoryD1();
    expect((await handleHistory(post('x'), db)).status).toBe(400);
    expect((await handleHistory(post([], ID_A, 0, 'not json'), db)).status).toBe(400);
    expect((await handleHistory(new Request('http://x/api/history', { method: 'DELETE' }), db)).status).toBe(405);
  });
});
