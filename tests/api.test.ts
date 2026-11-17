import { describe, expect, it } from 'vitest';
import { handleHistory, type KVLike } from '../src/history/api';

const memoryKV = () => {
  const m = new Map<string, string>();
  const kv: KVLike = { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
  return { kv, m };
};
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const get = (id?: string) => new Request('http://x/api/history', { headers: id ? { 'x-history-id': id } : {} });
const post = (events: unknown, id: string | undefined = ID_A, body?: string) =>
  new Request('http://x/api/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(id ? { 'x-history-id': id } : {}) },
    body: body ?? JSON.stringify({ events }),
  });
const event = (id: string, outcome = 'shortest') => ({ id, problemId: 'mate3/000/1', outcome, moves: 3, at: 1 });

describe('/api/history', () => {
  it('POST で追記し GET で取得できる。再送は二重適用しない', async () => {
    const { kv } = memoryKV();
    let res = await handleHistory(post([event('a')]), kv);
    expect(await res.json()).toMatchObject({ applied: 1 });
    res = await handleHistory(post([event('a'), event('b', 'fail')]), kv);
    expect(await res.json()).toMatchObject({ applied: 1 });
    res = await handleHistory(get(ID_A), kv);
    const body = (await res.json()) as { records: Record<string, { attempts: number }> };
    expect(body.records['mate3/000/1'].attempts).toBe(2);
  });

  it('履歴 ID ごとに分けて保存し、他の ID からは見えない', async () => {
    const { kv, m } = memoryKV();
    await handleHistory(post([event('a')], ID_A), kv);
    expect([...m.keys()]).toEqual([`history:v1:${ID_A}`]);
    const res = await handleHistory(get(ID_B), kv);
    expect(await res.json()).toEqual({ records: {} });
  });

  it('履歴 ID が無い・形式が違うと 400（共通キーには書かない）', async () => {
    const { kv, m } = memoryKV();
    expect((await handleHistory(post([event('a')], ''), kv)).status).toBe(400);
    expect((await handleHistory(post([event('a')], 'default'), kv)).status).toBe(400);
    expect((await handleHistory(get(), kv)).status).toBe(400);
    expect(m.size).toBe(0);
  });

  it('大きすぎる本文は 413、範囲外の値は無視する', async () => {
    const { kv, m } = memoryKV();
    expect((await handleHistory(post([], ID_A, 'x'.repeat(200 * 1024)), kv)).status).toBe(413);
    const bad = [
      { ...event('a'), problemId: 'mate99999/999/99999999' },
      { ...event('b'), moves: 1e9 },
      { ...event('c'), at: 1e15 },
    ];
    const res = await handleHistory(post(bad), kv);
    expect(await res.json()).toMatchObject({ applied: 0 });
    expect(m.size).toBe(0);
  });

  it('不正なリクエストは 400/405', async () => {
    const { kv } = memoryKV();
    expect((await handleHistory(post('x'), kv)).status).toBe(400);
    expect((await handleHistory(new Request('http://x/api/history', { method: 'DELETE' }), kv)).status).toBe(405);
  });
});
