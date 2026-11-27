import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('loadIndex', () => {
  it('通信が切れた後は索引を取り直し、成功した結果は再利用する', async () => {
    const index = { mate3: { moves: 3, volumes: [1] } };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json(index));
    vi.stubGlobal('fetch', fetchMock);
    const { loadIndex } = await import('../src/problems/loader');

    const first = loadIndex();
    expect(loadIndex()).toBe(first);
    await expect(first).rejects.toThrow('Failed to fetch');
    const retry = loadIndex();
    expect(loadIndex()).toBe(retry);
    await expect(retry).resolves.toEqual(index);
    expect(loadIndex()).toBe(retry);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTTP エラーと不正な JSON の後も索引を取り直せる', async () => {
    const index = { mate5: { moves: 5, volumes: [1] } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('not JSON'))
      .mockResolvedValueOnce(Response.json(index));
    vi.stubGlobal('fetch', fetchMock);
    const { loadIndex } = await import('../src/problems/loader');

    await expect(loadIndex()).rejects.toThrow('503');
    await expect(loadIndex()).rejects.toThrow(SyntaxError);
    await expect(loadIndex()).resolves.toEqual(index);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
