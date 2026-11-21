import type { Finish } from '../../game/finish';
import type { PieceType } from '../../shogi/types';

/**
 * 盤の裏の幽霊の決まりごと（DOM を使わない部分）。演出は ghostView.ts。
 *
 * 連チャン＝アプリを開いている間に、自力で初めて解いた問題が続いた数（保存しない・数字は出さない）。
 * 0 のとき幽霊は攻方の駒台の上にいて、初めて詰ませると盤の裏へ移り、以後は詰ませるたびに大きくなる。
 */

/** これ以上は伸ばさない（10連で虹になり、以後は虹のまま） */
export const MAX_STREAK = 10;

/** 駒台の上の大きさ（マス数） */
export const STAND_SIZE = 1.25;
/** 連チャンごとの盤の上の大きさ（マス数）。0 は駒台 */
export const SIZES = [STAND_SIZE, 2.4, 2.9, 3.4, 3.9, 4.5, 5.1, 5.8, 6.5, 7.3, 8.3] as const;
/** 連チャンごとの照明の色相（0 は消灯・10 は虹） */
export const HUES = [0, 172, 182, 192, 212, 240, 266, 292, 322, 40, 0] as const;

export const sizeFor = (streak: number): number => SIZES[clampStreak(streak)];
const clampStreak = (n: number) => Math.max(0, Math.min(MAX_STREAK, n));

/**
 * 正解したあとの連チャン。自力で（解答を見ずに）、この起動中に初めて解いた問題だけ数える。
 * 解答を見た後のクリアや、同じ問題の再挑戦は、伸ばしも切りもしない
 */
export function streakAfterSuccess(streak: number, viewedAnswer: boolean, solvedBefore: boolean): number {
  return viewedAnswer || solvedBefore ? streak : clampStreak(streak + 1);
}

/** 魂の食べ方 */
export type Eat = 'slurp' | 'lunge' | 'chase' | 'catch' | 'split' | 'feast';

/** 食べ方の候補。連チャン（解く前）が伸びるほど増え、10連はたいらげる */
export function eatsFor(streak: number): Eat[] {
  if (streak >= MAX_STREAK) return ['feast'];
  const eats: Eat[] = ['slurp', 'lunge'];
  if (streak >= 4) eats.push('chase');
  if (streak >= 6) eats.push('catch');
  if (streak >= 7) eats.push('split');
  return eats;
}

/** 手数のぶん、玉から余分に出る魂の数（3手は 0、5手は 1、7手は 2 …） */
export const extraSoulsFor = (length: number): number => Math.max(0, Math.floor((length - 3) / 2));

/** 魂の見た目。base: 元の絵（金は金の絵）、filter: 色の補正 */
export interface SoulLook {
  base: 'blue' | 'gold';
  filter: string;
}
const LOOKS: Record<string, SoulLook> = {
  P: { base: 'blue', filter: 'saturate(.15) brightness(1.3)' },
  L: { base: 'blue', filter: 'hue-rotate(-28deg) saturate(1.6)' },
  N: { base: 'blue', filter: 'hue-rotate(-95deg) saturate(1.8)' },
  S: { base: 'blue', filter: 'saturate(.35) brightness(1.15)' },
  G: { base: 'gold', filter: 'none' },
  B: { base: 'blue', filter: 'hue-rotate(55deg) saturate(2)' },
  R: { base: 'blue', filter: 'hue-rotate(150deg) saturate(2.2)' },
  K: { base: 'blue', filter: 'none' },
  'P+': { base: 'blue', filter: 'hue-rotate(115deg) saturate(2.4) brightness(1.1)' },
  'L+': { base: 'gold', filter: 'saturate(.85) brightness(1.05)' },
  'N+': { base: 'gold', filter: 'saturate(.85) brightness(1.05)' },
  'S+': { base: 'gold', filter: 'saturate(.85) brightness(1.05)' },
  'B+': { base: 'blue', filter: 'hue-rotate(80deg) saturate(3) brightness(1.1)' },
  'R+': { base: 'blue', filter: 'hue-rotate(160deg) saturate(3.2) brightness(1.05)' },
};
/** 駒の種類ごとの魂の色（歩は白・香は水色・桂は緑・銀は銀・金は金・角は紫・飛は赤。成駒は色が濃くなる） */
export const soulLookOf = (type: PieceType, promoted = false): SoulLook => LOOKS[`${type}${promoted ? '+' : ''}`] ?? LOOKS[type];
export const GOLD_LOOK = LOOKS.G;
export const PLAIN_LOOK = LOOKS.P;

/**
 * 玉から抜ける魂の見た目。頭金なら金の団子、成って詰みなら成る前の色（抜けてから裏返って成駒の色になる）、
 * それ以外は最後に動かした駒の色
 */
export function kingSoulOf(f: Finish): { start: SoulLook; end: SoulLook; dango: boolean; flip: boolean } {
  const end = soulLookOf(f.lastPiece.type, f.lastPiece.promoted);
  if (f.headGold) return { start: GOLD_LOOK, end: GOLD_LOOK, dango: true, flip: false };
  if (f.promote) return { start: soulLookOf(f.lastPiece.type, false), end, dango: false, flip: true };
  return { start: end, end, dango: false, flip: false };
}

// ---- 隠れ場所 ----

/** 盤の大きさ（px）。w・h は1マス */
export interface Cells {
  w: number;
  h: number;
}
/** 表示上のマス（左上が 0,0） */
export interface Square {
  x: number;
  y: number;
}
/** 幽霊の居場所（.board の中の px）。faceRight: 玉が右にいるので右を向く */
export interface Spot {
  left: number;
  top: number;
  size: number;
  faceRight: boolean;
}
/** 玉から見た、幽霊のいる側 */
export interface Dir {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}
export const DIRS: Dir[] = ([-1, 0, 1] as const).flatMap((x) => ([-1, 0, 1] as const).map((y) => ({ x, y }))).filter((d) => d.x || d.y);

/** 大きさ n マスの幽霊を、玉の d 側に、玉に少し重ねて置く */
export function spotNear(king: Square, n: number, d: Dir, c: Cells): Spot {
  const kx = (king.x + 0.5) * c.w;
  const ky = (king.y + 0.5) * c.h;
  const s = n * c.w;
  const reach = s / 2 + c.w * 0.4 - s * 0.2;
  const cx = kx + d.x * reach;
  const cy = ky + d.y * reach * 0.9 - (d.y === 0 ? s * 0.08 : 0);
  return { left: cx - s / 2, top: cy - s / 2, size: s, faceRight: kx > cx + 1 };
}

/** 居場所のうち、盤の中に入っている割合 */
export function insideRatio(sp: Spot, c: Cells): number {
  const W = c.w * 9;
  const H = c.h * 9;
  const w = Math.max(0, Math.min(W, sp.left + sp.size) - Math.max(0, sp.left));
  const h = Math.max(0, Math.min(H, sp.top + sp.size) - Math.max(0, sp.top));
  return (w * h) / (sp.size * sp.size);
}

/** 隠れる側を選ぶ。盤からはみ出しすぎない側のうちからランダムに（random は 0 以上 1 未満） */
export function pickDir(king: Square, n: number, c: Cells, random: () => number = Math.random): Dir {
  const scored = DIRS.map((d) => ({ d, f: insideRatio(spotNear(king, n, d, c), c) })).sort((a, b) => b.f - a.f);
  const good = scored.filter((s) => s.f >= Math.min(0.72, scored[0].f - 0.05));
  return good[Math.min(good.length - 1, Math.floor(random() * good.length))].d;
}
