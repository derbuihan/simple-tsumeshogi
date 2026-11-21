import { describe, expect, it } from 'vitest';
import { mateNotes } from '../src/ui/sound';

describe('詰みの響き', () => {
  it('連チャンが無いとき・1連は、元の高さ', () => {
    expect(mateNotes(false)).toEqual([784, 1175]);
    expect(mateNotes(false, 1)).toEqual([784, 1175]);
    expect(mateNotes(true, 0)).toEqual([784, 1175, 1568]);
  });

  it('連チャンが伸びるほど高くなり、8連で5度上に止まる', () => {
    const roots = Array.from({ length: 10 }, (_, i) => mateNotes(false, i + 1)[0]);
    for (let i = 1; i < 8; i++) expect(roots[i]).toBeGreaterThan(roots[i - 1]);
    expect(roots[7]).toBe(Math.round(784 * 2 ** (7 / 12)));
    expect(roots[8]).toBe(roots[7]);
  });

  it('10連は虹に合わせて音が増える', () => {
    expect(mateNotes(false, 10)).toHaveLength(4);
    expect(mateNotes(true, 10)).toHaveLength(4);
  });
});
