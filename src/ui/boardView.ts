import { parseUsiMove } from '../shogi/move';
import { pieceChar, pieceName } from '../shogi/notation';
import { positionKey } from '../shogi/sfen';
import { HAND_TYPES, opposite, type Color, type HandType, type Piece, type Position } from '../shogi/types';
import { detectStep, type Step } from './step';

export type Selection = { kind: 'board'; index: number } | { kind: 'hand'; type: HandType } | null;

export interface BoardViewModel {
  position: Position;
  /** 手前に表示する側（攻方） */
  bottom: Color;
  selection: Selection;
  /** 選択中の駒が王手で動けるマス */
  targets: ReadonlySet<number>;
  /** この局面に至った直前の指し手（USI）。1手進んだときはこの手をアニメーションで見せる */
  lastMove: string | null;
  /** 入力を受け付けるか */
  interactive: boolean;
  /** 振り返り中か（盤の左側のタップで戻る、右側で進む） */
  replay: boolean;
  /** 直前の手が詰みを逃した手か（振り返りで、そのマスを赤く示す） */
  missed: boolean;
}

export interface BoardViewHandlers {
  onSquare(index: number): void;
  onHand(color: Color, type: HandType): void;
  /** 振り返りで盤をタップした（-1: 左側＝戻る、+1: 右側＝進む） */
  onReplay(dir: -1 | 1): void;
}

/** 駒の要素。upright = 手前向き（攻方の駒・攻方の駒台） */
function pieceHtml(p: Piece, upright: boolean, attrs = ''): string {
  const cls = `pc t-${p.type}${p.promoted ? ' promoted' : ''}${upright ? '' : ' flip'}`;
  return `<div class="${cls}"${attrs}><div class="pc-face"><div class="pc-body"><span class="pc-char">${pieceChar(p)}</span></div></div></div>`;
}

const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const settle = (a: Animation) => a.finished.then(() => undefined, () => undefined);

/**
 * 盤と駒台の描画。盤の位置と大きさは状態によらず固定し、中身だけを描き替える。
 * 攻方が後手の問題では盤を180°回転させて、常に攻方を手前に表示する。
 *
 * 盤は2層。下の層（.cell）がタップと印（選択・移動先・直前の手）を受け持ち、
 * 上の層（.pieces）に駒を置く。局面が変わったときだけ駒を置き直し、
 * 直前の局面から1手進んだのであればその手をアニメーションで見せる。
 */
export class BoardView {
  readonly el: HTMLElement;
  private readonly topHand: HTMLElement;
  private readonly bottomHand: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly pieces: HTMLElement;
  private model: BoardViewModel | null = null;
  /** 今置いている駒の局面と向き（同じなら駒を置き直さない） */
  private key = '';
  /** 駒を置き直すたびに増やす。古いアニメーションの続きを止めるのに使う */
  private generation = 0;

  constructor(private readonly handlers: BoardViewHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'board-area';
    this.el.innerHTML = `
      <div class="hand hand-top" aria-label="玉方の持ち駒"></div>
      <div class="board-frame">
        <div class="board" role="grid" aria-label="将棋盤"><div class="pieces" aria-hidden="true"></div></div>
      </div>
      <div class="hand hand-bottom" aria-label="攻方の持ち駒"></div>`;
    this.topHand = this.el.querySelector('.hand-top')!;
    this.bottomHand = this.el.querySelector('.hand-bottom')!;
    this.grid = this.el.querySelector('.board')!;
    this.pieces = this.el.querySelector('.pieces')!;

    for (let d = 0; d < 81; d++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.display = String(d);
      this.grid.insertBefore(cell, this.pieces);
    }
    this.grid.addEventListener('click', (e) => {
      if (this.model?.replay) {
        // 盤を反転していても、画面上の左右で決める
        const r = this.grid.getBoundingClientRect();
        this.handlers.onReplay(e.clientX < r.left + r.width / 2 ? -1 : 1);
        return;
      }
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
      if (!cell || !this.model?.interactive) return;
      this.handlers.onSquare(this.toIndex(Number(cell.dataset.display)));
    });
    for (const hand of [this.topHand, this.bottomHand]) {
      hand.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.hand-piece');
        if (!btn || !this.model?.interactive) return;
        this.handlers.onHand(btn.dataset.color as Color, btn.dataset.type as HandType);
      });
    }
  }

  private get flipped(): boolean {
    return this.model?.bottom === 'w';
  }

  /** 表示上の位置 → 局面の index（反転は自分自身が逆変換） */
  private toIndex(display: number): number {
    return this.flipped ? 80 - display : display;
  }

  private cell(index: number): HTMLElement {
    return this.grid.children[this.toIndex(index)] as HTMLElement;
  }

  private handOf(color: Color): HTMLElement {
    return color === this.model!.bottom ? this.bottomHand : this.topHand;
  }

  private handPiece(color: Color, type: HandType): HTMLElement | null {
    return this.handOf(color).querySelector<HTMLElement>(`.hand-piece[data-type="${type}"]`);
  }

  render(model: BoardViewModel): void {
    const prev = this.model;
    this.model = model;
    const key = `${positionKey(model.position)} ${model.bottom}`;
    if (key !== this.key) {
      this.key = key;
      const step =
        prev && prev.bottom === model.bottom && !reducedMotion()
          ? detectStep(prev.position, model.position, model.lastMove)
          : null;
      // 駒打ちの移動元は、置き直す前の駒台の駒の位置
      const dropFrom = step?.move.kind === 'drop' ? this.handPiece(step.mover, step.move.type)?.getBoundingClientRect() : undefined;
      const handBefore = step ? prev!.position.hands[step.mover] : null;
      this.generation++;
      this.renderPieces(model.position, model.bottom);
      this.renderHand(this.bottomHand, model.position, model.bottom, '攻方', true);
      this.renderHand(this.topHand, model.position, opposite(model.bottom), '玉方', false);
      if (step) void this.animate(step, dropFrom, handBefore!);
    }
    this.renderMarks(model);
  }

  private renderPieces(position: Position, bottom: Color): void {
    let html = '';
    for (let index = 0; index < 81; index++) {
      const piece = position.board[index];
      const cell = this.cell(index);
      cell.setAttribute('aria-label', piece ? pieceName(piece.type, piece.promoted) : '空き');
      cell.dataset.piece = piece ? (piece.color === bottom ? 'own' : 'opp') : '';
      if (!piece) continue;
      const d = this.toIndex(index);
      html += pieceHtml(piece, piece.color === bottom, ` data-index="${index}" style="--x:${d % 9};--y:${Math.floor(d / 9)}"`);
    }
    this.pieces.innerHTML = html;
  }

  private renderHand(el: HTMLElement, pos: Position, color: Color, label: string, upright: boolean): void {
    const items = HAND_TYPES.filter((t) => pos.hands[color][t] > 0)
      .map((t) => {
        const n = pos.hands[color][t];
        return `<button type="button" class="hand-piece" data-color="${color}" data-type="${t}" aria-label="${pieceName(t)}${n}枚">
            ${pieceHtml({ color, type: t, promoted: false }, upright)}${n > 1 ? `<span class="hand-count">${n}</span>` : ''}
          </button>`;
      })
      .join('');
    el.innerHTML = `<span class="hand-label">${color === 'b' ? '☗' : '☖'}${label}</span>${items || '<span class="hand-none">持ち駒なし</span>'}`;
  }

  /** 選択・移動先・直前の手の印。駒は置き直さずに付け替えるだけ */
  private renderMarks(model: BoardViewModel): void {
    const { selection, targets, lastMove, interactive, replay, missed } = model;
    this.el.classList.toggle('interactive', interactive);
    this.el.classList.toggle('replay', replay);
    const lastTo = lastMove ? parseUsiMove(lastMove).to : -1;
    const selectedIndex = selection?.kind === 'board' ? selection.index : -1;
    for (let index = 0; index < 81; index++) {
      const cell = this.cell(index);
      cell.classList.toggle('last', index === lastTo && !missed);
      cell.classList.toggle('missed', index === lastTo && missed);
      cell.classList.toggle('selected', index === selectedIndex);
      cell.classList.toggle('target', targets.has(index));
    }
    for (const pc of this.pieces.querySelectorAll<HTMLElement>('.pc[data-index]')) {
      pc.classList.toggle('selected', Number(pc.dataset.index) === selectedIndex);
    }
    for (const btn of this.bottomHand.querySelectorAll<HTMLElement>('.hand-piece')) {
      btn.classList.toggle('selected', selection?.kind === 'hand' && selection.type === btn.dataset.type);
    }
  }

  // ---- アニメーション ----

  /**
   * 1手のアニメーション。駒を持ち上げて素早く運び、最後に加速して盤に打ちつける（ペチン）。
   * 成る手は運んでいる途中で裏返し、成駒の面で着地する。取った駒は指した側の駒台へ運ぶ。
   */
  private async animate(step: Step, dropFrom: DOMRect | undefined, handBefore: Position['hands']['b']): Promise<void> {
    const gen = this.generation;
    const { move, mover, piece, captured } = step;
    const el = this.pieces.querySelector<HTMLElement>(`.pc[data-index="${move.to}"]`);
    const fromRect = move.kind === 'move' ? this.cell(move.from).getBoundingClientRect() : dropFrom;
    if (!el || !fromRect) return;

    const toRect = el.getBoundingClientRect();
    const a = center(fromRect);
    const b = center(toRect);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const slideMs = Math.round(Math.min(170, 100 + Math.hypot(dx, dy) * 0.18));
    const flightMs = 170;

    // 取られる駒は、動かす駒の下に一旦残しておく
    let victim: HTMLElement | null = null;
    let handTarget: HTMLElement | null = null;
    if (captured) {
      victim = fragment(pieceHtml(captured, captured.color === this.model!.bottom, ` style="${el.getAttribute('style')}"`));
      victim.classList.add('victim');
      this.pieces.appendChild(victim);
      const type = (captured.type === 'K' ? null : captured.type) as HandType | null;
      handTarget = type ? this.handPiece(mover, type) : null;
      // 駒台に新しく増える駒は、取った駒が届くまで見せない
      if (handTarget && type && handBefore[type] === 0) {
        handTarget.animate([{ opacity: 0 }, { opacity: 0 }], { duration: slideMs + flightMs });
      }
    }

    el.classList.add('moving');
    const promoting = move.kind === 'move' && move.promote;
    const flip = promoting ? this.flipInFlight(el, piece, slideMs) : Promise.resolve();
    await Promise.all([
      settle(
        el.animate(
          [
            // 持ち上げた状態で素早く運び（減速しながら目的のマスの上へ）…
            { transform: `translate(${dx}px, ${dy}px) scale(1.14)`, easing: 'cubic-bezier(.2,.7,.4,1)' },
            { transform: 'translate(0, 0) scale(1.14)', offset: 0.72, easing: 'cubic-bezier(.6,0,1,1)' },
            // …最後は加速して盤に落とす
            { transform: 'translate(0, 0) scale(1)' },
          ],
          { duration: slideMs },
        ),
      ),
      flip,
    ]);
    el.classList.remove('moving');
    if (gen !== this.generation) return;

    // 着手：盤に駒を打ちつけた手応え
    this.impact(el);
    navigator.vibrate?.(15);

    if (victim) await this.carryToHand(victim, captured!, handTarget, flightMs);
  }

  /** 着地の瞬間。駒を一瞬つぶし、盤をわずかに沈ませ、波紋を出す */
  private impact(el: HTMLElement): void {
    el.querySelector<HTMLElement>('.pc-face')!.animate(
      [{ transform: 'scale(1.06, 0.9)' }, { transform: 'scale(0.98, 1.02)', offset: 0.55 }, { transform: 'scale(1)' }],
      { duration: 110, easing: 'ease-out' },
    );
    this.grid.animate([{ transform: 'translateY(1.5px)' }, { transform: 'translateY(0)' }], { duration: 90, easing: 'ease-out' });
    const ring = fragment(`<div class="impact" style="${el.getAttribute('style')}"></div>`);
    this.pieces.appendChild(ring);
    void settle(
      ring.animate(
        [
          { transform: 'scale(0.75)', opacity: 0.8 },
          { transform: 'scale(1.3)', opacity: 0 },
        ],
        { duration: 180, easing: 'cubic-bezier(.2,.8,.4,1)' },
      ),
    ).then(() => ring.remove());
  }

  /**
   * 運んでいる間に駒を裏返して成駒にする。奥行きを付けて縦軸で回し、
   * 真横を向いた瞬間に面を差し替える（駒の表と裏が入れ替わって見える）。
   */
  private async flipInFlight(el: HTMLElement, plain: Piece, ms: number): Promise<void> {
    const face = el.querySelector<HTMLElement>('.pc-face')!;
    setFace(el, plain);
    const half = Math.max(50, Math.round(ms * 0.36));
    await settle(
      face.animate([{ transform: 'perspective(160px) rotateY(0deg)' }, { transform: 'perspective(160px) rotateY(90deg)' }], {
        duration: half,
        delay: Math.max(0, ms * 0.12),
        easing: 'ease-in',
        fill: 'backwards',
      }),
    );
    setFace(el, { ...plain, promoted: true });
    await settle(
      face.animate([{ transform: 'perspective(160px) rotateY(-90deg)' }, { transform: 'perspective(160px) rotateY(0deg)' }], {
        duration: half,
        easing: 'ease-out',
      }),
    );
  }

  /** 取った駒を、向きを変えながら駒台へ運ぶ */
  private async carryToHand(victim: HTMLElement, captured: Piece, target: HTMLElement | null, ms: number): Promise<void> {
    setFace(victim, { ...captured, promoted: false });
    victim.classList.add('flying');
    const from = center(victim.getBoundingClientRect());
    const to = target ? center(target.getBoundingClientRect()) : from;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const face = victim.querySelector<HTMLElement>('.pc-face')!;
    await Promise.all([
      settle(
        victim.animate(
          [
            { transform: 'translate(0, 0) scale(1)' },
            { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(1.12)` },
            { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: target ? 1 : 0 },
          ],
          { duration: ms, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
        ),
      ),
      settle(face.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' })),
    ]);
    victim.remove();
    target?.animate([{ transform: 'scale(1.2)' }, { transform: 'scale(1)' }], { duration: 120, easing: 'ease-out' });
  }
}

function fragment(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
}

/** 駒の文字と成りの表示を差し替える */
function setFace(el: HTMLElement, p: Piece): void {
  el.querySelector('.pc-char')!.textContent = pieceChar(p);
  el.classList.toggle('promoted', p.promoted);
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
