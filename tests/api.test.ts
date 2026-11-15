import { describe, expect, it } from 'vitest';
import { handleHistory, type KVLike } from '../src/history/api';

const memoryKV = () => {
  const m = new Map<string, string>();
  const kv: KVLike = { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
  return { kv, m };
};
const post = (events: unknown, email?: string) =>
  new Request('http://x/api/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(email ? { 'cf-access-authenticated-user-email': email } : {}) },
    body: JSON.stringify({ events }),
  });
const event = (id: string, outcome = 'shortest') => ({ id, problemId: 'mate3/000/1', outcome, moves: 3, at: 1 });

describe('/api/history', () => {
  it('POST で追記し GET で取得できる。再送は二重適用しない', async () => {
    const { kv } = memoryKV();
    let res = await handleHistory(post([event('a')]), kv);
    expect(await res.json()).toMatchObject({ applied: 1 });
    res = await handleHistory(post([event('a'), event('b', 'fail')]), kv);
    expect(await res.json()).toMatchObject({ applied: 1 });
    res = await handleHistory(new Request('http://x/api/history'), kv);
    const body = (await res.json()) as { records: Record<string, { attempts: number }> };
    expect(body.records['mate3/000/1'].attempts).toBe(2);
  });

  it('Access のユーザーごとに分けて保存する', async () => {
    const { kv, m } = memoryKV();
    await handleHistory(post([event('a')], 'Me@Example.com'), kv);
    expect([...m.keys()]).toEqual(['history:v1:me@example.com']);
  });

  it('不正なリクエストは 400/405', async () => {
    const { kv } = memoryKV();
    expect((await handleHistory(post('x'), kv)).status).toBe(400);
    expect((await handleHistory(new Request('http://x/api/history', { method: 'DELETE' }), kv)).status).toBe(405);
  });
});
