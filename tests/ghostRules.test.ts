import { describe, expect, it } from 'vitest';
import type { Finish } from '../src/game/finish';
import {
  DIRS,
  eatsFor,
  extraSoulsFor,
  GOLD_LOOK,
  insideRatio,
  kingSoulOf,
  MAX_STREAK,
  pickDir,
  sizeFor,
  soulLookOf,
  spotNear,
  streakAfterSuccess,
  type Cells,
} from '../src/ui/ghost/rules';

const cells: Cells = { w: 40, h: 43.6 };
const finish = (over: Partial<Finish>): Finish => ({
  promote: false,
  headGold: false,
  sacrifices: [],
  takenInterpositions: [],
  lastPiece: { color: 'b', type: 'S', promoted: false },
  ...over,
});

describe('連チャン', () => {
  it('自力で初めて解いたら伸び、10 で止まる', () => {
    expect(streakAfterSuccess(0, false, false)).toBe(1);
    expect(streakAfterSuccess(MAX_STREAK, false, false)).toBe(MAX_STREAK);
  });

  it('解答を見た後のクリアや、同じ問題の再挑戦は、伸ばしも切りもしない', () => {
    expect(streakAfterSuccess(3, true, false)).toBe(3);
    expect(streakAfterSuccess(3, false, true)).toBe(3);
  });

  it('大きさは連チャンで単調に大きくなる（0 は駒台）', () => {
    for (let i = 1; i <= MAX_STREAK; i++) expect(sizeFor(i)).toBeGreaterThan(sizeFor(i - 1));
    expect(sizeFor(99)).toBe(sizeFor(MAX_STREAK));
  });
});

describe('食べ方と魂', () => {
  it('食べ方の候補は連チャンで増え、10連はたいらげる', () => {
    expect(eatsFor(1)).toEqual(['slurp', 'lunge']);
    expect(eatsFor(4)).toContain('chase');
    expect(eatsFor(6)).toContain('catch');
    expect(eatsFor(7)).toContain('split');
    expect(eatsFor(MAX_STREAK)).toEqual(['feast']);
  });

  it('手数が長いほど魂が増える', () => {
    expect([3, 5, 7, 9, 11].map(extraSoulsFor)).toEqual([0, 1, 2, 3, 4]);
  });

  it('魂の色は最後に動かした駒の種類（成駒は別の色）', () => {
    expect(soulLookOf('G')).toBe(GOLD_LOOK);
    expect(soulLookOf('R', true)).not.toEqual(soulLookOf('R'));
  });

  it('頭金は金の団子、成って詰みは成る前の色から裏返る', () => {
    expect(kingSoulOf(finish({ headGold: true, lastPiece: { color: 'b', type: 'G', promoted: false } }))).toEqual({ start: GOLD_LOOK, end: GOLD_LOOK, dango: true, flip: false });
    const promoted = kingSoulOf(finish({ promote: true, lastPiece: { color: 'b', type: 'B', promoted: true } }));
    expect(promoted.flip).toBe(true);
    expect(promoted.start).toEqual(soulLookOf('B'));
    expect(promoted.end).toEqual(soulLookOf('B', true));
  });
});

describe('隠れ場所', () => {
  it('玉の左に隠れると、右（玉のほう）を向く', () => {
    const sp = spotNear({ x: 4, y: 4 }, 3, { x: -1, y: 0 }, cells);
    expect(sp.faceRight).toBe(true);
    expect(sp.left + sp.size / 2).toBeLessThan(4.5 * cells.w);
  });

  it('盤の隅の玉では、盤の外へはみ出しすぎる側を選ばない', () => {
    const king = { x: 0, y: 0 };
    for (let i = 0; i < 20; i++) {
      const d = pickDir(king, 3, cells, () => i / 20);
      expect(insideRatio(spotNear(king, 3, d, cells), cells)).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('真ん中の玉なら、どの側も選ばれうる', () => {
    const seen = new Set(Array.from({ length: 16 }, (_, i) => JSON.stringify(pickDir({ x: 4, y: 4 }, 2.4, cells, () => i / 16))));
    expect(seen.size).toBe(DIRS.length);
  });
});
