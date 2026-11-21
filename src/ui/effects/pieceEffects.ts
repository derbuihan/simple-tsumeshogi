import type { Color, HandType, Piece, Position } from '../../shogi/types';
import { fragment, pieceHtml, setFace } from '../pieceDom';
import type { LandSound } from '../sound';
import type { Step } from '../step';
import type { AnimationScope } from './animationScope';

/** 演出に渡す盤の情報。値は読むたびに今の盤から取る */
export interface BoardFx {
  /** 駒を置く層。一時的な演出の要素もここに置く */
  readonly pieces: HTMLElement;
  /** 盤の枠（揺らす） */
  readonly frame: HTMLElement;
  /** 手前に表示する側（攻方） */
  readonly bottom: Color;
  /** 振り返り中か */
  readonly replay: boolean;
  cellRect(index: number): DOMRect;
  handPiece(color: Color, type: HandType): HTMLElement | null;
}

export interface StepOptions {
  /** 駒打ちの移動元（置き直す前の駒台の駒の位置） */
  dropFrom: DOMRect | undefined;
  /** 指す前の、指した側の持ち駒 */
  handBefore: Position['hands']['b'];
  /** 駒が盤に着地した瞬間（効果音を合わせる） */
  onLand(sound: LandSound): void;
}

/**
 * 着地の演出の強さ。
 * - light: 玉方の応手・振り返り。駒が潰れてマスが光るだけ
 * - normal: 自分の手。盤の揺れ・波紋・衝撃の輪・木くずまで
 * - strong: 自分の手で駒を取る・成る。輪と木くずを増やす
 * 攻方の手は必ず王手なので王手かどうかでは分けない。正誤が分かってしまうので、手の良し悪しでも分けない
 */
type ImpactLevel = 'light' | 'normal' | 'strong';

const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** 取った駒を駒台へ運ぶ時間 */
const FLIGHT_MS = 80;

/**
 * 1手のアニメーション（移動 → 着地 → 取った駒を駒台へ）。駒は置き直した後の盤にある前提。
 * 着地した瞬間に解決する（取った駒を駒台へ運ぶのは待たない）。途中で scope が cancel されたら、その時点で解決する。
 */
export async function playStep(scope: AnimationScope, fx: BoardFx, step: Step, opts: StepOptions): Promise<void> {
  const { move, captured } = step;
  const el = fx.pieces.querySelector<HTMLElement>(`.pc[data-index="${move.to}"]`);
  const fromRect = move.kind === 'move' ? fx.cellRect(move.from) : opts.dropFrom;
  if (!el || !fromRect) return;

  const moved = await moveFx(scope, fx, step, el, fromRect, opts.handBefore);
  if (!moved) return;
  landFx(scope, fx, step, el, opts.onLand);
  if (moved.victim) void carryToHand(scope, moved.victim, captured!, moved.handTarget);
}

// ---- 移動 ----

/**
 * 駒を持ち上げて素早く運び、最後に加速して盤に打ちつける（ペチン）。
 * 成る手は運んでいる途中で裏返し、成駒の面で着地する。取られる駒は、動かす駒の下に一旦残しておく。
 * 着地まで再生されたら、取られる駒と、それを運ぶ先の駒台の駒を返す。cancel されたら null
 */
async function moveFx(
  scope: AnimationScope,
  fx: BoardFx,
  step: Step,
  el: HTMLElement,
  fromRect: DOMRect,
  handBefore: Position['hands']['b'],
): Promise<{ victim: HTMLElement | null; handTarget: HTMLElement | null } | null> {
  const { move, mover, piece, captured } = step;
  const a = center(fromRect);
  const b = center(el.getBoundingClientRect());
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  // 減速しながら滑り込むと柔らかく見えるので、ほぼ一瞬で運び、勢いのまま止める
  const slideMs = Math.round(Math.min(60, 35 + Math.hypot(dx, dy) * 0.07));

  let victim: HTMLElement | null = null;
  let handTarget: HTMLElement | null = null;
  if (captured) {
    victim = scope.track(fragment(pieceHtml(captured, captured.color === fx.bottom, ` style="${el.getAttribute('style')}"`)));
    victim.classList.add('victim');
    fx.pieces.appendChild(victim);
    const type = (captured.type === 'K' ? null : captured.type) as HandType | null;
    handTarget = type ? fx.handPiece(mover, type) : null;
    // 駒台に新しく増える駒は、取った駒が届くまで見せない
    if (handTarget && type && handBefore[type] === 0) {
      void scope.animate(handTarget, [{ opacity: 0 }, { opacity: 0 }], { duration: slideMs + FLIGHT_MS });
    }
  }

  el.classList.add('moving');
  const promoting = move.kind === 'move' && move.promote;
  const [slid] = await Promise.all([
    scope.animate(
      el,
      [
        // 持ち上げて、減速せずに目的のマスまで運び…
        { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, easing: 'cubic-bezier(.2,.4,.6,1)' },
        { transform: 'translate(0, 0) scale(1.08)', offset: 0.85, easing: 'cubic-bezier(.6,0,1,.6)' },
        // …その場で盤に叩きつける
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: slideMs },
    ),
    promoting ? flipInFlight(scope, el, piece, slideMs) : Promise.resolve(true),
  ]);
  el.classList.remove('moving');
  if (!slid || !scope.active) return null;
  return { victim, handTarget };
}

/**
 * 運んでいる間に駒を裏返して成駒にする。奥行きを付けて縦軸で回し、
 * 真横を向いた瞬間に面を差し替える（駒の表と裏が入れ替わって見える）。
 */
async function flipInFlight(scope: AnimationScope, el: HTMLElement, plain: Piece, ms: number): Promise<boolean> {
  const face = el.querySelector<HTMLElement>('.pc-face')!;
  setFace(el, plain);
  // 運ぶ時間の中で裏返し終える（着地を待たせない）
  const half = Math.max(35, Math.round(ms * 0.42));
  const turned = await scope.animate(face, [{ transform: 'perspective(160px) rotateY(0deg)' }, { transform: 'perspective(160px) rotateY(90deg)' }], {
    duration: half,
    easing: 'ease-in',
  });
  setFace(el, { ...plain, promoted: true });
  if (!turned) return false;
  return scope.animate(face, [{ transform: 'perspective(160px) rotateY(-90deg)' }, { transform: 'perspective(160px) rotateY(0deg)' }], {
    duration: half,
    easing: 'ease-in',
  });
}

// ---- 着地 ----

/** 着地：盤に駒を打ちつけた手応え。振り返りで手順を送るときは控えめにする */
function landFx(scope: AnimationScope, fx: BoardFx, step: Step, el: HTMLElement, onLand: StepOptions['onLand']): void {
  const { move, mover, captured } = step;
  const replay = fx.replay;
  const own = mover === fx.bottom;
  const promote = move.kind === 'move' && move.promote;
  onLand({ own, capture: !!captured, promote, drop: move.kind === 'drop', replay });
  if (replay) softImpact(scope, fx, el);
  else impact(scope, fx, el, !own ? 'light' : captured || promote ? 'strong' : 'normal');
}

/**
 * 着地の瞬間（対局中）。駒を大きく押しつぶして弾み返らせ、盤ごと沈ませて揺らし、置いたマスから光の波紋を盤全体に広げ、
 * マスを白く光らせて衝撃の輪を2重に広げ、木くずを四方に飛ばす
 */
function impact(scope: AnimationScope, fx: BoardFx, el: HTMLElement, level: ImpactLevel): void {
  const light = level === 'light';
  void scope.animate(
    el.querySelector<HTMLElement>('.pc-face')!,
    light
      ? [{ transform: 'scale(1.1, 0.88)' }, { transform: 'scale(0.97, 1.03)', offset: 0.45 }, { transform: 'scale(1)' }]
      : [
          { transform: 'scale(1.22, 0.74)' },
          { transform: 'scale(0.92, 1.1)', offset: 0.35 },
          { transform: 'scale(1.04, 0.97)', offset: 0.7 },
          { transform: 'scale(1)' },
        ],
    { duration: light ? 110 : 140, easing: 'cubic-bezier(.2,.7,.3,1)' },
  );
  const style = el.getAttribute('style') ?? '';
  if (light) {
    const fx1 = scope.track(fragment(`<div class="impact-fx" style="${style}"><div class="impact-flash"></div></div>`));
    fx.pieces.insertBefore(fx1, el);
    void scope
      .animate(fx1.firstElementChild!, [{ opacity: 0.6 }, { opacity: 0 }], { duration: 150, easing: 'ease-out' })
      .then(() => fx1.remove());
    return;
  }
  const strong = level === 'strong';
  const side = Math.random() < 0.5 ? -1 : 1;
  void scope.animate(
    fx.frame,
    [
      { transform: 'translate(0, 0) scale(1)' },
      { transform: `translate(${side * 1.5}px, 4px) scale(0.985)`, offset: 0.15 },
      { transform: `translate(${-side * 1}px, -1.5px) scale(1.004)`, offset: 0.45 },
      { transform: `translate(${side * 0.5}px, 0.5px) scale(1)`, offset: 0.75 },
      { transform: 'translate(0, 0) scale(1)' },
    ],
    { duration: 220, easing: 'ease-out' },
  );

  // 光と輪は駒の下に、木くずは駒の上に描く。
  // 盤に入れてから再生する（盤の外で再生を始めると、開始を待つ間に詰みのヒットストップで pause → play されたとき、
  // Chrome では開始しないまま止まり、終わらないので取り除かれない）
  const under = scope.track(fragment(`<div class="impact-fx" style="${style}"><div class="impact-flash"></div></div>`));
  const over = scope.track(fragment(`<div class="impact-fx over" style="${style}"></div>`));
  fx.pieces.insertBefore(under, el);
  fx.pieces.appendChild(over);
  const flash = under.firstElementChild!;
  const anims: Promise<boolean>[] = [scope.animate(flash, [{ opacity: 0.85 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' })];
  const rings: [number, number][] = [
    [0, 1.9],
    [50, 2.5],
  ];
  if (strong) rings.push([100, 3.2]);
  for (const [delay, to] of rings) {
    const ring = document.createElement('div');
    ring.className = 'impact-ring';
    under.appendChild(ring);
    anims.push(
      scope.animate(
        ring,
        [
          { transform: 'scale(0.9)', opacity: 1, borderWidth: '3px' },
          { transform: `scale(${to})`, opacity: 0, borderWidth: '1px' },
        ],
        { duration: 320, delay, easing: 'cubic-bezier(.1,.8,.3,1)', fill: 'backwards' },
      ),
    );
  }
  const cell = el.getBoundingClientRect().width;
  const count = strong ? 16 : 10;
  for (let i = 0; i < count; i++) {
    const angle = ((i + Math.random() * 0.6) / count) * Math.PI * 2;
    const dist = cell * (0.75 + Math.random() * 0.5) * (strong ? 1.25 : 1);
    const size = 2 + Math.random() * 3;
    const chip = document.createElement('div');
    chip.className = 'impact-chip';
    chip.style.width = chip.style.height = `${size}px`;
    over.appendChild(chip);
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist * 1.09;
    anims.push(
      scope.animate(
        chip,
        [
          { transform: 'translate(-50%, -50%) translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(0.3)`, opacity: 0 },
        ],
        { duration: 260 + Math.random() * 120, easing: 'cubic-bezier(.1,.9,.3,1)' },
      ),
    );
  }

  ripple(scope, fx, el, '', 420);
  void Promise.all(anims).then(() => {
    under.remove();
    over.remove();
  });
}

/** 着地の瞬間（振り返り）。駒を一瞬押しつぶし、マスの枠を一瞬光らせるだけ */
function softImpact(scope: AnimationScope, fx: BoardFx, el: HTMLElement): void {
  void scope.animate(el.querySelector<HTMLElement>('.pc-face')!, [{ transform: 'scale(1.04, 0.93)' }, { transform: 'scale(1)' }], {
    duration: 50,
    easing: 'cubic-bezier(.2,0,.2,1)',
  });
  const ring = scope.track(fragment(`<div class="impact-fx" style="${el.getAttribute('style')}"><div class="impact-ring"></div></div>`));
  fx.pieces.insertBefore(ring, el);
  void scope
    .animate(
      ring.firstElementChild!,
      [
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(1.12)', opacity: 0 },
      ],
      { duration: 130, easing: 'cubic-bezier(.2,.8,.4,1)' },
    )
    .then(() => ring.remove());
}

/** 盤全体への波紋。駒のマスを中心に光の輪が盤の端まで広がって消える */
export function ripple(scope: AnimationScope, fx: BoardFx, el: HTMLElement, cls: string, ms: number): void {
  const board = fx.pieces.getBoundingClientRect();
  const c = center(el.getBoundingClientRect());
  const cx = c.x - board.left;
  const cy = c.y - board.top;
  const radius = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(board.width - cx, cy),
    Math.hypot(cx, board.height - cy),
    Math.hypot(board.width - cx, board.height - cy),
  );
  const wave = scope.track(
    fragment(
      `<div class="board-ripple ${cls}"><div style="left:${cx - radius}px;top:${cy - radius}px;width:${radius * 2}px;height:${radius * 2}px"></div></div>`,
    ),
  );
  fx.pieces.insertBefore(wave, fx.pieces.firstChild);
  void scope
    .animate(
      wave.firstElementChild!,
      [
        { transform: 'scale(0.08)', opacity: 0.9 },
        { transform: 'scale(1)', opacity: 0 },
      ],
      { duration: ms, easing: 'cubic-bezier(.2,.6,.4,1)' },
    )
    .then(() => wave.remove());
}

// ---- 駒台へ ----

/** 取った駒を、向きを変えながら駒台へ運ぶ */
async function carryToHand(scope: AnimationScope, victim: HTMLElement, captured: Piece, target: HTMLElement | null): Promise<void> {
  setFace(victim, { ...captured, promoted: false });
  victim.classList.add('flying');
  const from = center(victim.getBoundingClientRect());
  const to = target ? center(target.getBoundingClientRect()) : from;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const face = victim.querySelector<HTMLElement>('.pc-face')!;
  const [arrived] = await Promise.all([
    scope.animate(
      victim,
      [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(1.06)` },
        { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: target ? 1 : 0 },
      ],
      { duration: FLIGHT_MS, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' },
    ),
    scope.animate(face, [{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], { duration: FLIGHT_MS, easing: 'ease-in-out', fill: 'forwards' }),
  ]);
  victim.remove();
  if (arrived && target) void scope.animate(target, [{ transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 70, easing: 'linear' });
}
