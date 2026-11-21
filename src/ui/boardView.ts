import { parseUsiMove } from '../shogi/move';
import { pieceName } from '../shogi/notation';
import { positionKey } from '../shogi/sfen';
import { HAND_TYPES, opposite, type Color, type HandType, type Position } from '../shogi/types';
import { AnimationScope } from './effects/animationScope';
import { playMate } from './effects/mateEffects';
import { playStep, type BoardFx } from './effects/pieceEffects';
import { GhostView } from './ghost/ghostView';
import { pieceHtml } from './pieceDom';
import type { LandSound } from './sound';
import { detectStep } from './step';

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
  /** 駒が盤に着地した瞬間（効果音を合わせる） */
  onLand(sound: LandSound): void;
}

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
  private readonly frame: HTMLElement;
  private readonly pieces: HTMLElement;
  private model: BoardViewModel | null = null;
  /** 今置いている駒の局面と向き（同じなら駒を置き直さない） */
  private key = '';
  /** 今の局面の演出。駒を置き直すたびに cancel して作り直す（古い局面の演出の続きを止める） */
  private scope = new AnimationScope();
  /** 今の局面に至った手の駒が着地したら解決する */
  private landed: Promise<void> = Promise.resolve();
  /** 演出に渡す盤の情報 */
  private readonly fx: BoardFx;
  /** 盤の裏の幽霊（連チャン・詰み・逃げられた・眠るは App から呼ぶ） */
  readonly ghost: GhostView;

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
    this.frame = this.el.querySelector('.board-frame')!;
    this.pieces = this.el.querySelector('.pieces')!;
    const view = this;
    this.fx = {
      pieces: this.pieces,
      frame: this.frame,
      get bottom() {
        return view.model!.bottom;
      },
      get replay() {
        return view.model!.replay;
      },
      cellRect: (index) => this.cell(index).getBoundingClientRect(),
      handPiece: (color, type) => this.handPiece(color, type),
    };

    for (let d = 0; d < 81; d++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.display = String(d);
      this.grid.insertBefore(cell, this.pieces);
    }
    // マスは .board の子の並び順で探すので、幽霊の層はマスを作った後に入れる
    this.ghost = new GhostView({ board: this.grid, pieces: this.pieces, stand: this.bottomHand, enemyStand: this.topHand });
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
      this.scope.cancel();
      this.scope = new AnimationScope();
      // 1手進んだか（幽霊は動きを減らす設定でも玉を追うので、演出の有無とは別に求める）
      const stepped = prev && prev.bottom === model.bottom ? detectStep(prev.position, model.position, model.lastMove) : null;
      const step = reducedMotion() ? null : stepped;
      // 駒打ちの移動元は、置き直す前の駒台の駒の位置
      const dropFrom = step?.move.kind === 'drop' ? this.handPiece(step.mover, step.move.type)?.getBoundingClientRect() : undefined;
      const handBefore = step ? prev!.position.hands[step.mover] : null;
      this.renderPieces(model.position, model.bottom);
      this.renderHand(this.bottomHand, model.position, model.bottom, '攻方', true);
      this.renderHand(this.topHand, model.position, opposite(model.bottom), '玉方', false);
      this.ghost.update(model.position, model.bottom, !!stepped, model.replay);
      const onLand = (s: LandSound) => {
        this.handlers.onLand(s);
        this.ghost.land(s);
      };
      this.landed = step ? playStep(this.scope, this.fx, step, { dropFrom, handBefore: handBefore!, onLand }).catch(console.error) : Promise.resolve();
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

  // ---- 演出（中身は effects/ にある） ----

  /**
   * 詰みの演出（effects/mateEffects.ts）。最後の手の着地を待ってから始める。
   * カードを出してよくなったら解決する。途中で局面が変わったら、その時点で解決する
   */
  async mate(rare: boolean, onHit: () => void): Promise<void> {
    const scope = this.scope;
    await this.landed;
    const model = this.model;
    if (!scope.active || !model) return;
    const kingIndex = model.position.board.findIndex((p) => p?.type === 'K' && p.color !== model.bottom);
    const king = this.pieces.querySelector<HTMLElement>(`.pc[data-index="${kingIndex}"]`);
    if (reducedMotion() || !king) {
      onHit();
      return;
    }
    await playMate(scope, this.fx, king, rare, onHit);
  }
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
