/**
 * 魂を食べて育つ幽霊のサンプル。
 *
 * 流れ（連チャン＝アプリを開いている間の連続正解。数字は出さない）
 *   開いたとき   幽霊は攻方の駒台の上にちょこんと座っている
 *   詰ませると   玉から魂が抜け、幽霊が食べる（1問目は駒台から食べに行く）。もぐもぐする瞬間にぐっと大きくなり、それから喜ぶ。
 *                以後は盤の裏（駒の下）に住みつき、正解するたびに大きくなる
 *   次の問題     盤の裏の幽霊が、そのまま次の玉のそばへ移動して隠れる（隠れる側は毎回ランダム）
 *   照明         玉を中心に、連チャンが伸びるほど 青白 → 青 → 紫 → 桃 → 金 と熱くなる。10連で虹色
 *   逃げられた   しょんぼりして駒台へ帰る
 *
 * 詰め方で変わる演出（src/game/finish.ts で、詰ませた手順と局面から判定する）
 *   最後の駒の種類  魂の色（歩は白・香は水色・桂は緑・銀は銀・金は金・角は紫・飛は赤。成駒は色が濃くなる）
 *   成って詰み      魂がくるっと裏返って、成駒の色に変わる
 *   頭金            魂が金色の丸い団子になって、ぽよんと弾む
 *   捨て駒          取らせた駒が、玉方の駒台から小さな魂になって戻ってきて、一緒に食べる
 *   合駒を取る      合駒のあったマスからも、おまけの魂が出る
 *   手数            長いほど玉から出る魂が増える（5手で2つ、7手で3つ…）。7手以上は最初の魂も大きい
 *
 * そのほか
 *   王手のたび      玉の駒がびくっと震え、幽霊が舌なめずりする（攻方の手はすべて王手なので、正解かどうかは分からない）
 *   放っておくと    結果が出た後にしばらく触らないと、幽霊が眠る。どこかに触れると起きる（考えている間は眠らせない）
 *
 * 結果のカードは今と同じタイミング（詰みの演出の後）で出し、幽霊が食べる演出はカードと並行して流す。
 */
import '../../../src/styles.css';
import './bonus.css';
import { finishOf, type Finish } from '../../../src/game/finish';
import { parseProblemLine, type Problem } from '../../../src/game/problem';
import { applyMoves, parseUsiMove } from '../../../src/shogi/move';
import { pieceName } from '../../../src/shogi/notation';
import { parseSfen } from '../../../src/shogi/sfen';
import type { PieceType, Position } from '../../../src/shogi/types';
import { BoardView, type BoardViewModel } from '../../../src/ui/boardView';
import { AnimationScope } from '../../../src/ui/effects/animationScope';
import type { LandSound } from '../../../src/ui/sound';

/** 通しで見せる問題（手数と詰め方がばらけるように選んだ） */
const PROBLEM_IDS = [
  'mate3/001/0', // ふつう（駒台から食べに行く）
  'mate3/001/1', // 捨て駒＋頭金
  'mate5/001/3', // 成って詰み
  'mate3/001/30', // 合駒を取る
  'mate7/001/0', // 捨て駒・竜で詰み
  'mate3/001/52', // 桂で詰み
  'mate5/001/9', // 頭金
  'mate9/001/17', // 成って詰み（馬）
  'mate3/001/38', // 香で詰み
  'mate7/001/20', // 合駒を取る
  'mate11/001/8', // 捨て駒4枚
];
const MAX_STREAK = 10;
/** 結果が出てから眠るまで（サンプルなので短め。本番は 30 秒くらいを想定） */
let SLEEP_MS = 8000;

type Reaction = 'lick' | 'surprised' | 'sparkle' | 'peek' | 'nervous' | 'joy' | 'sad';
type Eat = 'slurp' | 'lunge' | 'chase' | 'catch' | 'split' | 'feast';
const FACES = ['idle', 'surprised', 'sparkle', 'peek', 'nervous', 'joy', 'sad', 'eat', 'munch', 'lick', 'sleep'] as const;
type Face = (typeof FACES)[number];
const faceSrc = (f: Face) => (f === 'idle' ? '/ghost/ghost-idle.webp' : `/ghost/face-${f}.webp`);
const FACE_FALLBACK: Partial<Record<Face, Face>> = { eat: 'surprised', munch: 'joy', lick: 'sparkle', sleep: 'idle' };

const STAND_SIZE = 1.25;
const SIZE = [STAND_SIZE, 2.4, 2.9, 3.4, 3.9, 4.5, 5.1, 5.8, 6.5, 7.3, 8.3];
const HUE = [0, 172, 182, 192, 212, 240, 266, 292, 322, 40, 0];
const eats = (st: number): Eat[] =>
  st >= MAX_STREAK ? ['feast'] : (['slurp', 'lunge', ...(st >= 4 ? ['chase'] : []), ...(st >= 6 ? ['catch'] : []), ...(st >= 7 ? ['split'] : [])] as Eat[]);

// ---- 魂の色（最後に動かした駒の種類） ----

interface SoulLook {
  /** 元の絵（金だけ金の絵を使う） */
  base: 'blue' | 'gold';
  /** 絵に掛ける色の補正 */
  filter: string;
}
const LOOK: Record<string, SoulLook> = {
  P: { base: 'blue', filter: 'saturate(.15) brightness(1.3)' },
  L: { base: 'blue', filter: 'hue-rotate(-28deg) saturate(1.6)' },
  N: { base: 'blue', filter: 'hue-rotate(-95deg) saturate(1.8)' },
  S: { base: 'blue', filter: 'saturate(.35) brightness(1.15)' },
  G: { base: 'gold', filter: 'none' },
  B: { base: 'blue', filter: 'hue-rotate(55deg) saturate(2)' },
  R: { base: 'blue', filter: 'hue-rotate(150deg) saturate(2.2)' },
  'P+': { base: 'blue', filter: 'hue-rotate(115deg) saturate(2.4) brightness(1.1)' },
  'L+': { base: 'gold', filter: 'saturate(.85) brightness(1.05)' },
  'N+': { base: 'gold', filter: 'saturate(.85) brightness(1.05)' },
  'S+': { base: 'gold', filter: 'saturate(.85) brightness(1.05)' },
  'B+': { base: 'blue', filter: 'hue-rotate(80deg) saturate(3) brightness(1.1)' },
  'R+': { base: 'blue', filter: 'hue-rotate(160deg) saturate(3.2) brightness(1.05)' },
};
const lookOf = (type: PieceType, promoted = false): SoulLook => LOOK[`${type}${promoted ? '+' : ''}`] ?? LOOK.P;

// ---- 盤 ----

const board = new BoardView({ onSquare() {}, onHand() {}, onReplay() {}, onLand: (s) => onLand(s) });
document.querySelector('.app-main')!.appendChild(board.el);
document.querySelector<HTMLElement>('#app')!.style.setProperty('--board-h', 'calc(100dvh - 250px)');
const boardEl = board.el.querySelector<HTMLElement>('.board')!;
const standEl = board.el.querySelector<HTMLElement>('.hand-bottom')!;
const enemyStandEl = board.el.querySelector<HTMLElement>('.hand-top')!;

const img = (cls: string, src: string, fallback = '/ghost/ghost-idle.webp') =>
  `<img class="${cls}" src="${src}" alt="" onerror="this.onerror=null;this.src='${fallback}'" />`;
const haunt = document.createElement('div');
haunt.className = 'haunt';
haunt.innerHTML = `
  <div class="haunt-light"></div>
  <div class="spirit">
    <div class="spirit-flip"><div class="spirit-float"><div class="spirit-pose" data-face="idle">
      ${FACES.map((f) => img(`face face-${f}`, faceSrc(f), faceSrc(FACE_FALLBACK[f] ?? 'idle'))).join('')}
    </div></div></div>
  </div>`;
boardEl.insertBefore(haunt, boardEl.firstChild);
const over = document.createElement('div');
over.className = 'haunt-over';
boardEl.appendChild(over);
const light = haunt.querySelector<HTMLElement>('.haunt-light')!;
const spirit = haunt.querySelector<HTMLElement>('.spirit')!;
const flip = haunt.querySelector<HTMLElement>('.spirit-flip')!;
const pose = haunt.querySelector<HTMLElement>('.spirit-pose')!;

let REST = 0.95;
let PEAK = 1;
const rest = () => ({ transform: 'none', opacity: REST });

// ---- 問題 ----

let problems: Problem[] = [];
let pi = 0;
let problem!: Problem;
let positions: Position[] = [];
let finish!: Finish;
let ply = 0;
const flipped = () => problem.attacker === 'w';
const model = (position: Position, lastMove: string | null): BoardViewModel => ({
  position,
  bottom: problem.attacker,
  selection: null,
  targets: new Set(),
  lastMove,
  interactive: false,
  replay: false,
  replayHint: false,
  missed: false,
});
const disp = (i: number) => {
  const d = flipped() ? 80 - i : i;
  return { x: d % 9, y: Math.floor(d / 9) };
};
const kingIn = (pos: Position) => pos.board.findIndex((p) => p?.type === 'K' && p.color !== problem.attacker);
const kingIndex = () => kingIn(positions.at(-1)!);
const kingSquare = () => disp(kingIndex());
function cellSize() {
  const r = boardEl.querySelector<HTMLElement>('.cell')!.getBoundingClientRect();
  return { w: r.width, h: r.height, W: r.width * 9, H: r.height * 9 };
}
function local(r: DOMRect) {
  const b = boardEl.getBoundingClientRect();
  return { left: r.left - b.left - boardEl.clientLeft, top: r.top - b.top - boardEl.clientTop, width: r.width, height: r.height };
}
const centerOf = (r: DOMRect) => {
  const l = local(r);
  return { x: l.left + l.width / 2, y: l.top + l.height / 2 };
};
const squareCenter = (index: number) => {
  const c = cellSize();
  const d = disp(index);
  return { x: (d.x + 0.5) * c.w, y: (d.y + 0.5) * c.h };
};

/** 詰め方の説明（サンプルの表示用） */
function describe(f: Finish, len: number): string {
  const parts = [`${len}手詰`, `最後は${pieceName(f.lastPiece.type, f.lastPiece.promoted)}`];
  if (f.promote) parts.push('成って詰み');
  if (f.headGold) parts.push('頭金');
  if (f.sacrifices.length) parts.push(`捨て駒（${f.sacrifices.map((t) => pieceName(t)).join('・')}）`);
  if (f.takenInterpositions.length) parts.push('合駒を取る');
  return parts.join('・');
}

// ---- 居場所 ----

interface Spot {
  left: number;
  top: number;
  size: number;
  faceRight: boolean;
}
let where: 'stand' | 'board' = 'stand';
let dir = { x: -1, y: 0 };
const DIRS = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y }))).filter((d) => d.x || d.y);

function standSpot(): Spot {
  const c = cellSize();
  const h = local(standEl.getBoundingClientRect());
  const s = STAND_SIZE * c.w;
  return { left: h.left + h.width - s - c.w * 0.1, top: h.top + h.height - s - 2, size: s, faceRight: false };
}
function spotFor(n: number, d = dir): Spot {
  const c = cellSize();
  const k = kingSquare();
  const kx = (k.x + 0.5) * c.w;
  const ky = (k.y + 0.5) * c.h;
  const s = n * c.w;
  const reach = s / 2 + c.w * 0.4 - s * 0.2;
  const cx = kx + d.x * reach;
  const cy = ky + d.y * reach * 0.9 - (d.y === 0 ? s * 0.08 : 0);
  return { left: cx - s / 2, top: cy - s / 2, size: s, faceRight: kx > cx + 1 };
}
function inside(sp: Spot): number {
  const c = cellSize();
  const w = Math.max(0, Math.min(c.W, sp.left + sp.size) - Math.max(0, sp.left));
  const h = Math.max(0, Math.min(c.H, sp.top + sp.size) - Math.max(0, sp.top));
  return (w * h) / (sp.size * sp.size);
}
function pickDir(n: number): void {
  const scored = DIRS.map((d) => ({ d, f: inside(spotFor(n, d)) })).sort((a, b) => b.f - a.f);
  const good = scored.filter((s) => s.f >= Math.min(0.72, scored[0].f - 0.05));
  dir = good[Math.floor(Math.random() * good.length)].d;
}
function place(sp: Spot, faceRight = sp.faceRight): void {
  Object.assign(spirit.style, { left: `${sp.left}px`, top: `${sp.top}px`, width: `${sp.size}px`, height: `${sp.size}px` });
  flip.classList.toggle('right', faceRight);
}
const clip = (on: boolean) => haunt.classList.toggle('clip', on);
function density(): void {
  if (where === 'stand') {
    spirit.style.opacity = '1';
    REST = 0.95;
    PEAK = 1;
  } else {
    spirit.style.opacity = streak <= 1 ? '0.36' : '0.5';
    REST = 0.44;
    PEAK = 0.85;
  }
}

// ---- 連チャン ----

let streak = 0;
let pending: number | null = null;

function paintLight(): void {
  board.el.dataset.streak = String(streak);
  for (const b of document.querySelectorAll<HTMLElement>('[data-streak]')) b.classList.toggle('on', b.dataset.streak === String(streak));
  const st = streak;
  light.classList.toggle('rainbow', st >= MAX_STREAK);
  if (st === 0) {
    light.style.opacity = '0';
    board.el.style.removeProperty('--frame-glow');
    return;
  }
  const k = kingSquare();
  const c = cellSize();
  const kx = ((k.x + 0.5) * c.w * 100) / c.W;
  const ky = ((k.y + 0.5) * c.h * 100) / c.H;
  light.style.opacity = '1';
  light.style.setProperty('--kx', `${kx}%`);
  light.style.setProperty('--ky', `${ky}%`);
  if (st >= MAX_STREAK) {
    light.style.background = '';
    light.style.boxShadow = '';
    board.el.style.setProperty('--frame-glow', '0 0 18px rgba(255, 140, 220, .7), 0 0 4px 1px rgba(160, 230, 255, .9)');
    return;
  }
  const h = HUE[st];
  const a = 0.14 + st * 0.03;
  light.style.background = `radial-gradient(circle at ${kx}% ${ky}%, hsla(${h}, 95%, 72%, ${a + 0.12}) 0, hsla(${h}, 90%, 70%, ${a}) ${18 + st * 3}%, hsla(${h}, 90%, 70%, ${a * 0.25}) 75%)${
    st >= 9 ? `, repeating-conic-gradient(from 0deg at ${kx}% ${ky}%, hsla(${h}, 100%, 80%, .14) 0 7deg, transparent 7deg 21deg)` : ''
  }`;
  light.style.boxShadow = `inset 0 0 ${10 + st * 2.5}px hsla(${h}, 95%, 65%, ${0.25 + st * 0.05})`;
  board.el.style.setProperty('--frame-glow', `0 0 ${6 + st * 2}px hsla(${h}, 95%, 65%, ${0.35 + st * 0.05})`);
}

function grow(): void {
  if (pending === null) return;
  streak = pending;
  pending = null;
  paintLight();
  spirit.classList.add('growing');
  place(spotFor(SIZE[streak]));
  setTimeout(() => spirit.classList.remove('growing'), 900);
}

// ---- リアクション ----

let scope = new AnimationScope();
let faceTimer = 0;
const setFace = (f: Face) => (pose.dataset.face = f);

function takeover() {
  const cs = getComputedStyle(pose);
  const from = { transform: cs.transform, opacity: Number(cs.opacity) };
  scope.cancel();
  scope = new AnimationScope();
  clearTimeout(faceTimer);
  return { s: scope, from };
}

/** 着地の合図。攻方の手（王手）なら玉がびくっとし、幽霊は手の種類で反応する（ふつうの手は舌なめずり） */
function onLand(s: LandSound): void {
  if (!s.own) return react('nervous');
  flinchKing();
  react(s.capture ? 'surprised' : s.promote ? 'sparkle' : s.drop ? 'peek' : 'lick');
}

/** 王手：玉の駒が小さく震えて縮こまる */
function flinchKing(): void {
  const k = board.el.querySelector<HTMLElement>(`.pc[data-index="${kingIn(positions[ply])}"] .pc-face`);
  k?.animate(
    [
      { transform: 'translate(0, 0) scale(1)' },
      { transform: 'translate(-1.5px, 0) scale(.95)', offset: 0.15 },
      { transform: 'translate(1.5px, 0) scale(.95)', offset: 0.3 },
      { transform: 'translate(-1px, 0) scale(.96)', offset: 0.45 },
      { transform: 'translate(1px, 0) scale(.97)', offset: 0.6 },
      { transform: 'translate(0, 0) scale(1)' },
    ],
    { duration: 380, delay: 60, easing: 'ease-out' },
  );
}

function react(kind: Reaction): void {
  const { s, from } = takeover();
  const back = (ms: number) => (faceTimer = window.setTimeout(() => setFace('idle'), ms));
  const play = (frames: Keyframe[], duration: number, easing = 'ease-out') => void s.animate(pose, [from, ...frames, rest()], { duration, easing });
  const toward = () => {
    const d = disp(parseUsiMove(problem.solution[Math.max(0, ply - 1)]).to);
    const c = cellSize();
    const r = local(spirit.getBoundingClientRect());
    const vx = ((d.x + 0.5) * c.w - (r.left + r.width / 2)) / r.width;
    const vy = ((d.y + 0.5) * c.h - (r.top + r.height / 2)) / r.height;
    const len = Math.max(1, Math.hypot(vx, vy) * 2);
    return { x: ((flip.classList.contains('right') ? -1 : 1) * vx) / len, y: vy / len };
  };
  switch (kind) {
    case 'lick':
      // 舌なめずり：少し身を乗り出して、ぺろり
      setFace('lick');
      play(
        [
          { transform: 'scale(1.05, .95)', opacity: PEAK * 0.8, offset: 0.2 },
          { transform: 'scale(.99, 1.02) rotate(-2deg)', opacity: PEAK * 0.75, offset: 0.55 },
        ],
        650,
      );
      back(750);
      break;
    case 'surprised':
      setFace('surprised');
      play(
        [
          { transform: 'translateY(-6%) scale(1.07)', opacity: PEAK, offset: 0.22 },
          { transform: 'translateY(-3%) scale(1.03)', opacity: PEAK * 0.8, offset: 0.6 },
        ],
        800,
        'cubic-bezier(.2,.8,.3,1)',
      );
      back(850);
      break;
    case 'sparkle':
      setFace('sparkle');
      play(
        [
          { transform: 'rotate(-4deg) scale(1.04)', opacity: PEAK, filter: 'brightness(1.5)', offset: 0.3 },
          { transform: 'rotate(0) scale(1.01)', opacity: PEAK * 0.7, filter: 'brightness(1)', offset: 0.7 },
        ],
        950,
      );
      sparkles(s, pose.getBoundingClientRect(), 10, false);
      back(950);
      break;
    case 'peek': {
      setFace('peek');
      const v = toward();
      play(
        [
          { transform: `translate(${v.x * 14}%, ${v.y * 10}%) rotate(${v.x * -6}deg)`, opacity: PEAK * 0.9, offset: 0.35 },
          { transform: `translate(${v.x * 12}%, ${v.y * 8}%) rotate(${v.x * -5}deg)`, opacity: PEAK * 0.8, offset: 0.75 },
        ],
        1100,
        'ease-in-out',
      );
      back(1050);
      break;
    }
    case 'nervous':
      setFace('nervous');
      play(
        [
          { transform: 'translateX(-2.5%)', opacity: PEAK * 0.7, offset: 0.15 },
          { transform: 'translateX(2.5%)', offset: 0.32 },
          { transform: 'translateX(-1.8%)', offset: 0.5 },
          { transform: 'translateX(1.2%)', offset: 0.68 },
        ],
        750,
        'ease-in-out',
      );
      back(800);
      break;
    case 'joy':
      setFace('joy');
      play(
        [
          { transform: 'translateY(-7%) scale(1.06)', opacity: 1, filter: 'brightness(1.3)', offset: 0.25 },
          { transform: 'translateY(0) scale(.98, 1.02)', opacity: 1, offset: 0.5 },
          { transform: 'translateY(-3%) scale(1.03)', opacity: PEAK, filter: 'brightness(1)', offset: 0.7 },
        ],
        1300,
        'ease-in-out',
      );
      back(1300);
      break;
    case 'sad':
      setFace('sad');
      play(
        [
          { transform: 'translateY(4%) scale(.96)', opacity: REST * 0.45, offset: 0.25 },
          { transform: 'translateY(4%) scale(.96)', opacity: REST * 0.45, offset: 0.75 },
        ],
        2000,
        'ease-in-out',
      );
      back(1900);
      break;
  }
}

// ---- 眠る（結果が出た後、しばらく触らないと） ----

let sleepTimer = 0;
let asleep = false;
let zzz: HTMLElement | null = null;

/** 結果が出たら、眠るまでの時間を数え始める。触るたびに数え直す */
function armSleep(): void {
  clearTimeout(sleepTimer);
  sleepTimer = window.setTimeout(fallAsleep, SLEEP_MS);
}
function disarmSleep(): void {
  clearTimeout(sleepTimer);
  sleepTimer = 0;
}
function fallAsleep(): void {
  const { s, from } = takeover();
  asleep = true;
  setFace('sleep');
  // すうすう：ゆっくり膨らんで縮む
  void s.animate(pose, [from, { transform: 'translateY(2%) scale(1.03, .97)', opacity: REST }], { duration: 900, easing: 'ease-in-out', fill: 'forwards' }).then((ok) => {
    if (ok) void s.animate(pose, [{ transform: 'translateY(2%) scale(1.03, .97)', opacity: REST }, { transform: 'translateY(1%) scale(.99, 1.02)', opacity: REST }], { duration: 1800, easing: 'ease-in-out', iterations: Infinity, direction: 'alternate' });
  });
  // Zzz：頭の横から、小さな z が昇っていく
  const r = local(spirit.getBoundingClientRect());
  zzz = s.track(document.createElement('div'));
  zzz.className = `zzz${where === 'stand' ? ' on-stand' : ''}`;
  zzz.innerHTML = '<span>z</span><span>z</span><span>Z</span>';
  Object.assign(zzz.style, { left: `${r.left + r.width * (flip.classList.contains('right') ? 0.18 : 0.72)}px`, top: `${where === 'stand' ? r.top + r.height * 0.12 : Math.max(r.top + r.height * 0.22, 40)}px` });
  haunt.appendChild(zzz);
}
function wake(): void {
  if (!asleep) return;
  asleep = false;
  zzz?.remove();
  zzz = null;
  react('surprised');
}
// どこかに触れたら起きて、また数え直す
for (const ev of ['pointerdown', 'keydown'] as const)
  window.addEventListener(ev, () => {
    if (asleep) wake();
    if (sleepTimer) armSleep();
  });

// ---- 移動 ----

async function travel(to: Spot, ms = 1300): Promise<void> {
  const { s, from } = takeover();
  const now = local(spirit.getBoundingClientRect());
  spirit.style.setProperty('--travel', `${ms}ms`);
  spirit.classList.add('traveling');
  place(to, to.left > now.left);
  setFace('peek');
  void s.animate(
    pose,
    [from, { transform: 'rotate(-5deg) translateY(-3%)', offset: 0.25 }, { transform: 'rotate(5deg)', offset: 0.5 }, { transform: 'rotate(-4deg) translateY(-3%)', offset: 0.75 }, rest()],
    { duration: ms, easing: 'ease-in-out' },
  );
  await s.wait(ms);
  spirit.classList.remove('traveling');
  flip.classList.toggle('right', to.faceRight);
  await s.wait(300);
  if (s.active) setFace('idle');
}

// ---- 魂 ----

const SOUL_FALLBACK = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="a" cx="55%" cy="60%" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#bff3ff"/><stop offset="1" stop-color="#6fd0ff" stop-opacity="0"/></radialGradient></defs><path d="M50 92c-17 0-28-12-28-27 0-20 22-26 18-52 14 10 18 22 16 32 8-6 9-14 8-20 12 12 14 26 14 40 0 15-11 27-28 27z" fill="url(#a)"/></svg>',
)}`;

type SoulKind = SoulLook | 'rainbow';
function makeSoul(s: AnimationScope, p: { x: number; y: number }, size: number, look: SoulKind, extra = ''): HTMLElement {
  const el = s.track(document.createElement('div'));
  const rainbow = look === 'rainbow';
  el.className = `soul${rainbow ? ' rainbow' : ''}${!rainbow && look.base === 'gold' ? ' gold' : ''}${extra ? ` ${extra}` : ''}`;
  el.innerHTML = img('', !rainbow && look.base === 'gold' ? '/ghost/soul-gold.webp' : '/ghost/soul.webp', SOUL_FALLBACK);
  if (!rainbow) el.style.setProperty('--tint', look.filter);
  Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${size}px`, height: `${size}px` });
  el.dataset.x = String(p.x);
  el.dataset.y = String(p.y);
  over.appendChild(el);
  return el;
}
function setLook(el: HTMLElement, look: SoulLook): void {
  el.classList.toggle('gold', look.base === 'gold');
  el.querySelector('img')!.src = look.base === 'gold' ? '/ghost/soul-gold.webp' : '/ghost/soul.webp';
  el.style.setProperty('--tint', look.filter);
}
async function soulTo(s: AnimationScope, el: HTMLElement, pts: { x: number; y: number; scale?: number; opacity?: number; offset?: number }[], o: KeyframeAnimationOptions): Promise<boolean> {
  const x0 = parseFloat(el.style.left);
  const y0 = parseFloat(el.style.top);
  const ok = await s.animate(
    el,
    pts.map((f) => ({
      transform: `translate(-50%, -50%) translate(${f.x - x0}px, ${f.y - y0}px) scale(${f.scale ?? 1})`,
      opacity: f.opacity ?? 1,
      ...(f.offset !== undefined ? { offset: f.offset } : {}),
    })),
    { fill: 'forwards', ...o },
  );
  const last = pts.at(-1)!;
  el.dataset.x = String(last.x);
  el.dataset.y = String(last.y);
  return ok;
}
const here = (el: HTMLElement) => ({ x: parseFloat(el.dataset.x!), y: parseFloat(el.dataset.y!) });
const mouth = () => {
  const r = local(pose.getBoundingClientRect());
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.56 };
};
const poseTo = (s: AnimationScope, frame: Keyframe, duration: number, easing = 'ease-out') => {
  const cs = getComputedStyle(pose);
  return s.animate(pose, [{ transform: cs.transform, opacity: Number(cs.opacity), filter: cs.filter }, frame], { duration, easing, fill: 'forwards' });
};
async function swallow(s: AnimationScope, soul: HTMLElement, ms: number): Promise<void> {
  const m = mouth();
  await soulTo(s, soul, [here(soul), { x: m.x, y: m.y, scale: 0.25, opacity: 0.6 }], { duration: ms, easing: 'cubic-bezier(.6,0,.9,.6)' });
  soul.remove();
}

/** 成って詰み：魂がくるっと裏返って、成駒の色に変わる */
async function flipSoul(s: AnimationScope, soul: HTMLElement, to: SoulLook): Promise<void> {
  const i = soul.querySelector('img')!;
  await s.animate(i, [{ transform: 'rotateY(0)' }, { transform: 'rotateY(90deg) scale(1.1)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
  setLook(soul, to);
  sparkles(s, soul.getBoundingClientRect(), 6, to.base === 'gold');
  await s.animate(i, [{ transform: 'rotateY(-90deg) scale(1.1)' }, { transform: 'rotateY(0) scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.3,1.4)', fill: 'forwards' });
}

/** もぐもぐ：最初のひと噛みで連チャンが伸び、ぐっと大きくなる。大きくなりきってから喜ぶ */
async function munchAndGrow(s: AnimationScope, chews: number): Promise<void> {
  setFace('munch');
  for (let i = 0; i < chews && s.active; i++) {
    if (i === 0) {
      grow();
      sparkles(s, pose.getBoundingClientRect(), 8, streak >= 9);
    }
    await poseTo(s, { transform: 'scale(1.08, .92)', opacity: 1 }, 120);
    await poseTo(s, { transform: 'scale(.97, 1.05)', opacity: 1 }, 150);
  }
  await s.wait(Math.max(0, 950 - chews * 270));
}

async function rejoice(s: AnimationScope, rainbow: boolean, feast: number): Promise<void> {
  setFace('joy');
  sparkles(s, pose.getBoundingClientRect(), 8 + streak * 2 + feast * 2, streak >= 9);
  if (rainbow) rainbowBurst(s);
  else if (streak >= 6 || feast >= 4) confetti(s, Math.max(0, streak - 5) * 8 + feast * 4, streak >= 9 ? 'gold' : 'cool');
  await poseTo(s, { transform: 'translateY(-6%) scale(1.05)', opacity: 1, filter: rainbow ? 'brightness(1.3) hue-rotate(180deg)' : 'brightness(1.25)' }, 280, 'cubic-bezier(.2,.8,.3,1.3)');
  await poseTo(s, { transform: 'none', opacity: 0.95, filter: rainbow ? 'brightness(1.1) hue-rotate(360deg)' : 'brightness(1)' }, 450, 'ease-in-out');
  await s.wait(450);
  await poseTo(s, { transform: 'none', opacity: REST, filter: 'none' }, 600, 'ease-in-out');
  if (s.active) setFace('idle');
}

let forcedEat: Eat | null = null;
const EAT_LABEL: Record<Eat, string> = { slurp: '吸い込む', lunge: '飛びつく', chase: '追いかける', catch: 'キャッチ', split: '3つに分かれる', feast: 'たいらげる' };
let lastEat = '';

// ---- 詰み ----

/** 詰み（玉が沈む瞬間に呼ぶ）。st は、この問題を解く前の連チャン */
async function mateShow(st: number): Promise<void> {
  const { s } = takeover();
  const kingEl = board.el.querySelector<HTMLElement>(`.pc[data-index="${kingIndex()}"]`);
  if (!kingEl) return grow();
  const k = centerOf(kingEl.getBoundingClientRect());
  const c = cellSize();
  const len = problem.solution.length;
  const willRainbow = st + 1 >= MAX_STREAK;
  const kind: Eat = st === 0 ? 'slurp' : (forcedEat ?? eats(st)[Math.floor(Math.random() * eats(st).length)]);
  lastEat = kind;
  document.querySelector('.mock-last')!.textContent = `${st === 0 ? '駒台から食べに行く・' : ''}${EAT_LABEL[kind]}${willRainbow ? '・虹' : ''}`;

  // 魂の見た目：虹（10連）＞ 頭金（金の団子）＞ 最後の駒の色。成って詰みなら、成る前の色から裏返る
  const lp = finish.lastPiece;
  const finalLook = lookOf(lp.type, lp.promoted);
  const startLook: SoulKind = willRainbow ? 'rainbow' : finish.headGold ? LOOK.G : finish.promote ? lookOf(lp.type, false) : finalLook;
  const big = len >= 7 ? 1.25 : 1;

  // 玉から魂が抜け出す（手数が長いほど、あとからいくつも出てくる）
  const up = { x: k.x, y: k.y - c.h * 0.9 };
  const soul = makeSoul(s, k, c.w * (kind === 'feast' ? 1.3 : 1.8) * big, startLook, finish.headGold && !willRainbow ? 'dango' : '');
  const rise = soulTo(
    s,
    soul,
    [
      { x: k.x, y: k.y, scale: 0.2, opacity: 0 },
      { x: k.x + c.w * 0.1, y: k.y - c.h * 0.5, scale: 0.9, opacity: 1, offset: 0.6 },
      { x: up.x, y: up.y, scale: 1 },
    ],
    { duration: 520, easing: 'ease-out' },
  );
  const extras: HTMLElement[] = [];
  // 手数：5手で1つ、7手で2つ…（玉から噴き出して、玉の周りに漂う）
  const more = Math.max(0, Math.floor((len - 3) / 2));
  for (let i = 0; i < more; i++) {
    const e = makeSoul(s, k, c.w * 1.05, willRainbow ? 'rainbow' : finalLook);
    const a = -Math.PI / 2 + (i - (more - 1) / 2) * 0.9;
    const to = { x: k.x + Math.cos(a) * c.w * 1.5, y: k.y + Math.sin(a) * c.h * 1.2 - c.h * 0.3 };
    void soulTo(s, e, [{ ...k, scale: 0.2, opacity: 0 }, { ...to, scale: 1 }], { duration: 480, delay: 120 + i * 110, easing: 'cubic-bezier(.2,.8,.3,1.3)' });
    extras.push(e);
  }
  // 捨て駒：取らせた駒が、玉方の駒台から小さな魂になって戻ってくる（駒の色のまま）
  const es = local(enemyStandEl.getBoundingClientRect());
  finish.sacrifices.forEach((t, i) => {
    const from = { x: es.left + es.width * (0.3 + 0.4 * Math.random()), y: es.top + es.height / 2 };
    const e = makeSoul(s, from, c.w * 0.95, lookOf(t), 'returned');
    const to = { x: k.x + (i - (finish.sacrifices.length - 1) / 2) * c.w * 0.9, y: Math.max(c.h * 0.5, k.y - c.h * 1.7) };
    void soulTo(s, e, [{ ...from, scale: 0.4, opacity: 0 }, { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - c.h * 0.3, scale: 0.8, offset: 0.5 }, { ...to, scale: 1 }], {
      duration: 700,
      delay: 200 + i * 150,
      easing: 'ease-in-out',
    });
    extras.push(e);
  });
  // 合駒を取る：合駒のあったマスからも、おまけの魂が出る
  for (const sq of finish.takenInterpositions) {
    const p = squareCenter(sq);
    const e = makeSoul(s, p, c.w * 1, LOOK.P, 'bonus');
    void soulTo(s, e, [{ ...p, scale: 0.2, opacity: 0 }, { x: p.x, y: p.y - c.h * 0.7, scale: 1.1, offset: 0.6 }, { x: p.x, y: p.y - c.h * 0.5, scale: 1 }], {
      duration: 520,
      delay: 80,
      easing: 'cubic-bezier(.2,.8,.3,1.3)',
    });
    extras.push(e);
  }

  // 1問目：駒台から、魂めがけて飛んで行く
  if (where === 'stand') {
    where = 'board';
    pickDir(SIZE[0]);
    const to = spotFor(STAND_SIZE * 1.4);
    setFace('eat');
    spirit.style.setProperty('--travel', '600ms');
    spirit.classList.add('traveling');
    place(to, to.left > local(spirit.getBoundingClientRect()).left);
    await Promise.all([rise, s.wait(600)]);
    if (!s.active) return;
    spirit.classList.remove('traveling');
    clip(true);
    density();
    flip.classList.toggle('right', to.faceRight);
  } else {
    await rise;
  }
  if (!s.active) return;

  // 成って詰み：くるっと裏返って成駒の色に。頭金：金の団子がぽよんと弾む
  if (finish.promote && !willRainbow && !finish.headGold) await flipSoul(s, soul, finalLook);
  if (finish.headGold && !willRainbow) {
    await s.animate(soul.querySelector('img')!, [{ transform: 'scale(1)' }, { transform: 'scale(1.25, .8)' }, { transform: 'scale(.9, 1.15)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
  }
  if (!s.active) return;

  switch (kind) {
    case 'slurp':
      setFace('eat');
      await poseTo(s, { transform: 'scale(1.05)', opacity: PEAK }, 200);
      await swallow(s, soul, 400);
      break;
    case 'lunge': {
      setFace('eat');
      const m = mouth();
      const r = local(pose.getBoundingClientRect());
      const fx = ((up.x - m.x) / r.width) * 60 * (flip.classList.contains('right') ? -1 : 1);
      const fy = ((up.y - m.y) / r.height) * 60;
      await poseTo(s, { transform: `translate(${-fx * 0.15}%, ${-fy * 0.15}%) scale(.95)`, opacity: PEAK }, 160, 'ease-in');
      void poseTo(s, { transform: `translate(${fx}%, ${fy}%) scale(1.08)`, opacity: 1 }, 200, 'cubic-bezier(.3,1.4,.5,1)');
      await s.wait(120);
      await swallow(s, soul, 120);
      await poseTo(s, { transform: 'none', opacity: 1 }, 300);
      break;
    }
    case 'chase': {
      setFace('peek');
      for (let i = 0; i < 3 && s.active; i++) {
        const p = here(soul);
        const q = { x: Math.max(c.w * 0.5, Math.min(c.W - c.w * 0.5, k.x + (Math.random() - 0.5) * c.w * 3.2)), y: Math.max(c.h * 0.5, Math.min(c.H - c.h * 0.5, k.y - c.h * (0.6 + Math.random() * 1.4))) };
        const mid = { x: (p.x + q.x) / 2, y: Math.min(p.y, q.y) - c.h * 0.7 };
        const r = local(pose.getBoundingClientRect());
        const m = mouth();
        const lx = ((q.x - m.x) / r.width) * 25 * (flip.classList.contains('right') ? -1 : 1);
        void poseTo(s, { transform: `translate(${lx}%, ${((q.y - m.y) / r.height) * 18}%) rotate(${-lx * 0.4}deg)`, opacity: PEAK }, 300, 'ease-in-out');
        await soulTo(s, soul, [p, { ...mid, offset: 0.5 }, q], { duration: 300, easing: 'ease-in-out' });
        await s.wait(90);
      }
      setFace('eat');
      await swallow(s, soul, 260);
      await poseTo(s, { transform: 'none', opacity: 1 }, 250);
      break;
    }
    case 'catch': {
      setFace('surprised');
      const p = here(soul);
      const top = { x: p.x, y: Math.max(c.h * 0.4, p.y - c.h * 2) };
      await soulTo(s, soul, [p, { ...top, scale: 1.1 }], { duration: 380, easing: 'cubic-bezier(.2,.8,.4,1)' });
      setFace('joy');
      void poseTo(s, { transform: 'translateY(-8%) scale(1.04)', opacity: 1 }, 380, 'ease-out');
      await s.wait(200);
      setFace('eat');
      const m = mouth();
      await soulTo(s, soul, [top, { x: m.x, y: m.y, scale: 0.3, opacity: 0.7 }], { duration: 360, easing: 'cubic-bezier(.5,0,1,.6)' });
      soul.remove();
      await poseTo(s, { transform: 'translateY(2%) scale(1.08, .92)', opacity: 1 }, 140);
      break;
    }
    case 'split': {
      const p = here(soul);
      const pts = [-1, 0, 1].map((i) => ({ x: p.x + i * c.w * 1.1, y: p.y - (i === 0 ? c.h * 0.5 : 0) }));
      const kids = pts.map(() => makeSoul(s, p, c.w * 1.2, startLook === 'rainbow' ? 'rainbow' : finalLook));
      soul.remove();
      await Promise.all(kids.map((e, i) => soulTo(s, e, [{ ...p, scale: 0.6 }, pts[i]], { duration: 300, easing: 'cubic-bezier(.2,.8,.3,1.3)' })));
      setFace('eat');
      for (const e of kids) {
        if (!s.active) return;
        await swallow(s, e, 240);
        void poseTo(s, { transform: 'scale(1.07, .93)', opacity: 1 }, 100);
        await s.wait(110);
      }
      break;
    }
    case 'feast': {
      soul.remove();
      const n = 8;
      const g = centerOf(pose.getBoundingClientRect());
      const R = Math.max(c.w * 1.6, pose.getBoundingClientRect().width * 0.45);
      const kids = Array.from({ length: n }, () => makeSoul(s, k, c.w * 1.1, willRainbow ? 'rainbow' : finalLook));
      setFace('surprised');
      await Promise.all(
        kids.map((e, i) => {
          const a0 = (i / n) * Math.PI * 2;
          const pts = Array.from({ length: 9 }, (_, j) => {
            const a = a0 + (j / 8) * Math.PI * 1.6;
            const rr = j === 0 ? 0 : R * (0.6 + 0.4 * Math.sin((j / 8) * Math.PI));
            return { x: (j === 0 ? k.x : g.x) + Math.cos(a) * rr, y: (j === 0 ? k.y : g.y) + Math.sin(a) * rr * 0.8, scale: j === 0 ? 0.3 : 1 };
          });
          return soulTo(s, e, pts, { duration: 1100, delay: i * 40, easing: 'ease-in-out' });
        }),
      );
      setFace('eat');
      await poseTo(s, { transform: 'scale(1.1)', opacity: 1, filter: 'brightness(1.3)' }, 200);
      await Promise.all(kids.map((e, i) => s.wait(i * 35).then(() => swallow(s, e, 260))));
      break;
    }
  }
  if (!s.active) return;
  // ごちそうの残り（手数・捨て駒・合駒の魂）を、口を開けたまま順に吸い込む
  if (extras.length) {
    setFace('eat');
    for (const e of extras) {
      if (!s.active) return;
      await swallow(s, e, 200);
      void poseTo(s, { transform: 'scale(1.06, .94)', opacity: 1 }, 90);
      await s.wait(70);
    }
  }
  await munchAndGrow(s, Math.min(6, 3 + Math.floor(extras.length / 2)));
  if (s.active) await rejoice(s, willRainbow || st >= MAX_STREAK, extras.length);
}

// ---- きらめき・紙吹雪・虹 ----

function sparkles(s: AnimationScope, rect: DOMRect, n: number, gold: boolean): void {
  const r = local(rect);
  const o = local(over.getBoundingClientRect());
  for (let i = 0; i < n; i++) {
    const p = s.track(document.createElement('div'));
    p.className = `haunt-spark${gold ? ' gold' : ''}`;
    const a = Math.random() * Math.PI * 2;
    const d = 0.3 + Math.random() * 0.2;
    p.style.left = `${r.left - o.left + r.width * (0.5 + Math.cos(a) * d)}px`;
    p.style.top = `${r.top - o.top + r.height * (0.45 + Math.sin(a) * d)}px`;
    over.appendChild(p);
    void s
      .animate(
        p,
        [
          { transform: 'translate(-50%,-50%) scale(0) rotate(0)', opacity: 0 },
          { transform: 'translate(-50%,-50%) scale(1.2) rotate(45deg)', opacity: 1, offset: 0.4 },
          { transform: 'translate(-50%,-50%) scale(0) rotate(90deg)', opacity: 0 },
        ],
        { duration: 700 + Math.random() * 400, delay: Math.random() * 300, fill: 'backwards' },
      )
      .then(() => p.remove());
  }
}

const PALETTE = {
  cool: ['#9fe8d6', '#c9f5ff', '#d6a8ff', '#ffb3d9'],
  gold: ['#ffd75e', '#fff3c4', '#ffb347'],
  rainbow: ['#ff6b6b', '#ffb347', '#ffe66d', '#7ee081', '#5ec8ff', '#8b7bff', '#e07bff'],
};
function confetti(s: AnimationScope, n: number, palette: keyof typeof PALETTE): void {
  const colors = PALETTE[palette];
  for (let i = 0; i < n; i++) {
    const p = s.track(document.createElement('div'));
    p.className = 'haunt-confetti';
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    over.appendChild(p);
    void s
      .animate(
        p,
        [
          { transform: 'translate(0, -20px) rotate(0)', opacity: 1 },
          { transform: `translate(${(Math.random() - 0.5) * 60}px, ${over.clientHeight * (0.7 + Math.random() * 0.4)}px) rotate(${360 + Math.random() * 540}deg)`, opacity: 0 },
        ],
        { duration: 1400 + Math.random() * 900, delay: Math.random() * 400, easing: 'cubic-bezier(.2,.5,.5,1)', fill: 'backwards' },
      )
      .then(() => p.remove());
  }
}

function rainbowBurst(s: AnimationScope): void {
  const k = squareCenter(kingIndex());
  const c = cellSize();
  for (let i = 0; i < 3; i++) {
    const ring = s.track(document.createElement('div'));
    ring.className = 'rainbow-ring';
    Object.assign(ring.style, { left: `${k.x}px`, top: `${k.y}px`, width: `${c.W * 2.4}px`, height: `${c.W * 2.4}px` });
    over.appendChild(ring);
    void s
      .animate(ring, [{ transform: 'translate(-50%,-50%) scale(.05) rotate(0)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1) rotate(120deg)', opacity: 0 }], {
        duration: 1300,
        delay: i * 220,
        easing: 'cubic-bezier(.2,.6,.4,1)',
        fill: 'backwards',
      })
      .then(() => ring.remove());
  }
  confetti(s, 70, 'rainbow');
  void s.animate(light, [{ filter: 'brightness(1.8) saturate(1.6)' }, { filter: 'none' }], { duration: 1600, easing: 'ease-out' });
}

// ---- 結果のカード ----

const overlay = document.querySelector<HTMLElement>('.overlay')!;
function showCard(success: boolean, st: number): void {
  const len = problem.solution.length;
  const rare = st + 1 >= 9;
  overlay.innerHTML = success
    ? `<div class="dialog result-card${rare ? ' rare' : ''}" role="dialog" aria-label="正解">
        <p class="result success">✓ ${len}手で詰みました</p>
        <p><span class="tag success">最短</span></p>
        <p class="feats"><span class="feat">初見で最短</span><span class="feat">${len}手詰 ${12 + st}問目</span></p>
        <button type="button" class="btn primary main" data-card="next">次の問題 →</button>
        <div class="actions"><button type="button" class="btn secondary" data-card="retry">再挑戦</button><button type="button" class="btn secondary" data-card="close">振り返る</button></div>
      </div>`
    : `<div class="dialog result-card" role="dialog" aria-label="不正解">
        <p class="result failure">✗ 詰みを逃しました</p>
        <p><span class="tag failure">${len}手目</span></p>
        <button type="button" class="btn primary main" data-card="retry">再挑戦</button>
        <div class="actions"><button type="button" class="btn secondary" data-card="next">次の問題</button><button type="button" class="btn secondary" data-card="close">解答を見る</button></div>
      </div>`;
  overlay.hidden = false;
}
function hideCard(): void {
  overlay.hidden = true;
  overlay.innerHTML = '';
}
overlay.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')?.dataset.card;
  if (e.target === overlay || act === 'close') hideCard();
  else if (act === 'next') void nextProblem();
  else if (act === 'retry') void loadProblem(pi);
});

// ---- 進行 ----

let running = 0;

async function loadProblem(i: number, move = true): Promise<void> {
  running++;
  hideCard();
  // 次の問題を考え始めるので、眠らせない
  disarmSleep();
  if (asleep) {
    asleep = false;
    zzz?.remove();
    zzz = null;
  }
  grow();
  pi = (i + problems.length) % problems.length;
  problem = problems[pi];
  const start = parseSfen(problem.sfen);
  positions = problem.solution.map((_, j) => applyMoves(start, problem.solution.slice(0, j))).concat([applyMoves(start, problem.solution)]);
  finish = finishOf(start, problem.solution);
  ply = 0;
  board.render(model(positions[0], null));
  const [len, vol, line] = problem.id.split('/');
  document.querySelector('.badge')!.textContent = `${len.slice(4)}手詰`;
  document.querySelector('.pid')!.textContent = `問題 ${len.slice(4)}-${vol}-${line}`;
  document.querySelector('.side')!.textContent = `攻方 ${problem.attacker === 'b' ? '先手' : '後手'}`;
  document.querySelector('.mock-finish')!.textContent = describe(finish, problem.solution.length);
  paintLight();
  density();
  if (where === 'stand') {
    clip(false);
    place(standSpot());
    takeover();
    pose.style.opacity = String(REST);
    setFace('idle');
    return;
  }
  clip(true);
  pickDir(SIZE[streak]);
  if (move) await travel(spotFor(SIZE[streak]));
  else place(spotFor(SIZE[streak]));
}
const nextProblem = () => loadProblem(pi + 1);

async function step(): Promise<void> {
  if (ply >= problem.solution.length) return;
  ply++;
  board.render(model(positions[ply], problem.solution[ply - 1]));
  if (ply === problem.solution.length) {
    const run = running;
    const st = streak;
    pending = Math.min(MAX_STREAK, st + 1);
    await board.mate(st + 1 >= 9, () => void mateShow(st));
    if (run === running) {
      showCard(true, st);
      armSleep();
    }
  }
}

async function solve(): Promise<void> {
  const run = running;
  while (ply < problem.solution.length && run === running) {
    await sleep(600);
    if (run !== running) return;
    await step();
  }
}

async function fail(): Promise<void> {
  running++;
  pending = null;
  react('sad');
  setTimeout(() => showCard(false, streak), 700);
  await sleep(1500);
  streak = 0;
  paintLight();
  if (where === 'board') {
    where = 'stand';
    clip(false);
    await travel(standSpot(), 1100);
    density();
    pose.style.opacity = String(REST);
  }
  armSleep();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runMarathon(): Promise<void> {
  const my = ++marathonToken;
  streak = 0;
  pending = null;
  where = 'stand';
  await loadProblem(0);
  for (let i = 0; i <= MAX_STREAK; i++) {
    if (my !== marathonToken) return;
    await solve();
    if (my !== marathonToken) return;
    await sleep(3600);
    if (my !== marathonToken || i === MAX_STREAK) return;
    await loadProblem(pi + 1);
  }
}
let marathonToken = 0;

document.querySelector('[data-act="marathon"]')!.addEventListener('click', () => void runMarathon());
document.querySelector('[data-act="solve"]')!.addEventListener('click', () => void solve());
document.querySelector('[data-act="step"]')!.addEventListener('click', () => void step());
document.querySelector('[data-act="next"]')!.addEventListener('click', () => {
  marathonToken++;
  void nextProblem();
});
document.querySelector('[data-act="fail"]')!.addEventListener('click', () => {
  marathonToken++;
  void fail();
});
document.querySelector('[data-act="sleep"]')!.addEventListener('click', () => fallAsleep());
for (const b of document.querySelectorAll<HTMLElement>('[data-streak]'))
  b.addEventListener('click', () => {
    marathonToken++;
    pending = null;
    streak = Number(b.dataset.streak);
    where = streak === 0 ? 'stand' : 'board';
    void loadProblem(pi, false);
  });
for (const b of document.querySelectorAll<HTMLElement>('[data-react]')) b.addEventListener('click', () => react(b.dataset.react as Reaction));

// ---- 起動・撮影用 ----
// ?streak=N  連チャン（0 は駒台）   ?pi=N  問題（PROBLEM_IDS の番号）
// ?eat=kind  食べ方を決める          ?sleep=ms  結果が出てから眠るまで
// ?flow=mate&hold=ms   最後の手を指して詰ませ、hold ms 後に止める
// ?flow=check&hold=ms  1手目（王手）を指して、hold ms 後に止める
// ?flow=asleep&hold=ms 眠らせて、hold ms 後に止める
const q = new URLSearchParams(location.search);
if (q.has('eat')) forcedEat = q.get('eat') as Eat;
if (q.has('sleep')) SLEEP_MS = Number(q.get('sleep'));
const freeze = () => {
  for (const a of document.getAnimations()) a.pause();
};
(window as unknown as { __done: Promise<unknown> }).__done = (async () => {
  const files = new Map<string, string[]>();
  for (const id of PROBLEM_IDS) {
    const file = id.split('/').slice(0, 2).join('/');
    if (!files.has(file)) files.set(file, (await (await fetch(`/problems/${file}.txt`)).text()).split('\n').filter((l) => l.trim()));
  }
  problems = PROBLEM_IDS.map((id) => parseProblemLine(id, files.get(id.split('/').slice(0, 2).join('/'))![Number(id.split('/')[2])]));
  streak = Math.min(MAX_STREAK, Number(q.get('streak') ?? 0));
  where = streak === 0 ? 'stand' : 'board';
  const flow = q.get('flow');
  const hold = Number(q.get('hold') ?? 300);
  await loadProblem(Number(q.get('pi') ?? 0), false);
  await sleep(900);
  if (flow === 'mate') {
    ply = problem.solution.length - 1;
    board.render(model(positions[ply], null));
    await sleep(150);
    void step();
    await sleep(hold);
    freeze();
    return { eat: lastEat, finish: describe(finish, problem.solution.length) };
  }
  if (flow === 'check') {
    void step();
    await sleep(hold);
    freeze();
    return undefined;
  }
  if (flow === 'asleep') {
    fallAsleep();
    await sleep(hold);
    freeze();
    return undefined;
  }
  await sleep(hold);
  return undefined;
})();

// 調べる用：幽霊の今の位置と濃さ
(window as unknown as { __debug: () => unknown }).__debug = () => ({
  style: spirit.getAttribute('style'),
  cls: spirit.className + ' / ' + haunt.className,
  rect: local(spirit.getBoundingClientRect()),
  spiritOpacity: getComputedStyle(spirit).opacity,
  poseOpacity: getComputedStyle(pose).opacity,
  poseTransform: getComputedStyle(pose).transform,
  face: pose.dataset.face,
  where,
  zzz: !!zzz,
  souls: [...over.querySelectorAll('.soul')].map((e) => ({ cls: e.className, r: e.getBoundingClientRect().toJSON() })),
});
