import { pieceChar, pieceName } from '../shogi/notation';
import { HAND_TYPES, opposite, type Color, type HandType, type Position } from '../shogi/types';

export type Selection = { kind: 'board'; index: number } | { kind: 'hand'; type: HandType } | null;

export interface BoardViewModel {
  position: Position;
  /** 手前に表示する側（攻方） */
  bottom: Color;
  selection: Selection;
  /** 選択中の駒が王手で動けるマス */
  targets: ReadonlySet<number>;
  /** 直前の指し手の移動先 */
  lastTo: number | null;
  /** 入力を受け付けるか */
  interactive: boolean;
}

export interface BoardViewHandlers {
  onSquare(index: number): void;
  onHand(color: Color, type: HandType): void;
}

const ZEN = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
const KAN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 盤と駒台の描画。盤の位置と大きさは状態によらず固定し、中身だけを描き替える。
 * 攻方が後手の問題では盤を180°回転させて、常に攻方を手前に表示する。
 */
export class BoardView {
  readonly el: HTMLElement;
  private readonly topHand: HTMLElement;
  private readonly bottomHand: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly fileLabels: HTMLElement;
  private readonly rankLabels: HTMLElement;
  private model: BoardViewModel | null = null;

  constructor(private readonly handlers: BoardViewHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'board-area';
    this.el.innerHTML = `
      <div class="hand hand-top" aria-label="玉方の持ち駒"></div>
      <div class="board-frame">
        <div class="file-labels" aria-hidden="true"></div>
        <div class="board-with-ranks">
          <div class="board" role="grid" aria-label="将棋盤"></div>
          <div class="rank-labels" aria-hidden="true"></div>
        </div>
      </div>
      <div class="hand hand-bottom" aria-label="攻方の持ち駒"></div>`;
    this.topHand = this.el.querySelector('.hand-top')!;
    this.bottomHand = this.el.querySelector('.hand-bottom')!;
    this.grid = this.el.querySelector('.board')!;
    this.fileLabels = this.el.querySelector('.file-labels')!;
    this.rankLabels = this.el.querySelector('.rank-labels')!;

    for (let d = 0; d < 81; d++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.display = String(d);
      this.grid.appendChild(cell);
    }
    this.grid.addEventListener('click', (e) => {
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

  /** 表示上の位置 → 局面の index */
  private toIndex(display: number): number {
    return this.flipped ? 80 - display : display;
  }

  render(model: BoardViewModel): void {
    this.model = model;
    const { position, bottom, selection, targets, lastTo, interactive } = model;
    this.el.classList.toggle('interactive', interactive);

    // 筋・段の目盛り（反転時は逆順）
    const files = this.flipped ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [9, 8, 7, 6, 5, 4, 3, 2, 1];
    const ranks = this.flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
    this.fileLabels.innerHTML = files.map((f) => `<span>${ZEN[f]}</span>`).join('');
    this.rankLabels.innerHTML = ranks.map((r) => `<span>${KAN[r]}</span>`).join('');

    const cells = this.grid.children;
    for (let d = 0; d < 81; d++) {
      const index = this.toIndex(d);
      const cell = cells[d] as HTMLElement;
      const piece = position.board[index];
      cell.textContent = piece ? pieceChar(piece) : '';
      cell.className = 'cell';
      if (piece) {
        cell.classList.add('piece', piece.color === bottom ? 'own' : 'opp');
        if (piece.promoted) cell.classList.add('promoted');
      }
      if (selection?.kind === 'board' && selection.index === index) cell.classList.add('selected');
      if (targets.has(index)) cell.classList.add('target');
      if (lastTo === index) cell.classList.add('last');
      cell.setAttribute('aria-label', piece ? `${pieceName(piece.type, piece.promoted)}` : '空き');
    }

    this.renderHand(this.bottomHand, position, bottom, selection, '攻方');
    this.renderHand(this.topHand, position, opposite(bottom), null, '玉方');
  }

  private renderHand(el: HTMLElement, pos: Position, color: Color, selection: Selection, label: string): void {
    const items = HAND_TYPES.filter((t) => pos.hands[color][t] > 0)
      .map((t) => {
        const n = pos.hands[color][t];
        const selected = selection?.kind === 'hand' && selection.type === t ? ' selected' : '';
        return `<button type="button" class="hand-piece${selected}" data-color="${color}" data-type="${t}" aria-label="${pieceName(t)}${n}枚">
            <span class="hand-char">${pieceName(t)}</span>${n > 1 ? `<span class="hand-count">${n}</span>` : ''}
          </button>`;
      })
      .join('');
    el.innerHTML = `<span class="hand-label">${label}${color === 'b' ? '☗' : '☖'}</span>${items || '<span class="hand-none">なし</span>'}`;
  }
}
