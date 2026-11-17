import { parseUsiMove } from '../shogi/move';
import { pieceChar, pieceName } from '../shogi/notation';
import { positionKey } from '../shogi/sfen';
import { HAND_TYPES, opposite, type Color, type HandType, type Piece, type Position } from '../shogi/types';
import type { LandSound } from './sound';
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
  private readonly frame: HTMLElement;
  private readonly pieces: HTMLElement;
  private model: BoardViewModel | null = null;
  /** 今置いている駒の局面と向き（同じなら駒を置き直さない） */
  private key = '';
  /** 駒を置き直すたびに増やす。古いアニメーションの続きを止めるのに使う */
  private generation = 0;
  /** 今のアニメーションの駒が着地したら解決する */
  private landing: Promise<void> = Promise.resolve();

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
      if (step) {
        let landed!: () => void;
        this.landing = new Promise((r) => (landed = r));
        void this.animate(step, dropFrom, handBefore!, landed).finally(landed);
      } else {
        this.landing = Promise.resolve();
      }
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
  private async animate(step: Step, dropFrom: DOMRect | undefined, handBefore: Position['hands']['b'], landed: () => void): Promise<void> {
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
    // 減速しながら滑り込むと柔らかく見えるので、ほぼ一瞬で運び、勢いのまま止める
    const slideMs = Math.round(Math.min(60, 35 + Math.hypot(dx, dy) * 0.07));
    const flightMs = 80;

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
            // 持ち上げて、減速せずに目的のマスまで運び…
            { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, easing: 'cubic-bezier(.2,.4,.6,1)' },
            { transform: 'translate(0, 0) scale(1.08)', offset: 0.85, easing: 'cubic-bezier(.6,0,1,.6)' },
            // …その場で盤に叩きつける
            { transform: 'translate(0, 0) scale(1)' },
          ],
          { duration: slideMs },
        ),
      ),
      flip,
    ]);
    el.classList.remove('moving');
    if (gen !== this.generation) return;

    // 着手：盤に駒を打ちつけた手応え。振り返りで手順を送るときは控えめにする
    const replay = this.model!.replay;
    const own = mover === this.model!.bottom;
    this.handlers.onLand({ own, capture: !!captured, promote: !!promoting, drop: move.kind === 'drop', replay });
    if (replay) this.softImpact(el);
    else this.impact(el, !own ? 'light' : captured || promoting ? 'strong' : 'normal');
    landed();

    if (victim) await this.carryToHand(victim, captured!, handTarget, flightMs);
  }

  /**
   * 着地の瞬間（対局中）。駒を大きく押しつぶして弾み返らせ、盤ごと沈ませて揺らし、置いたマスから光の波紋を盤全体に広げ、
   * マスを白く光らせて衝撃の輪を2重に広げ、木くずを四方に飛ばす
   */
  private impact(el: HTMLElement, level: ImpactLevel): void {
    const light = level === 'light';
    el.querySelector<HTMLElement>('.pc-face')!.animate(
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
      const fx = fragment(`<div class="impact-fx" style="${style}"><div class="impact-flash"></div></div>`);
      this.pieces.insertBefore(fx, el);
      void settle((fx.firstElementChild as HTMLElement).animate([{ opacity: 0.6 }, { opacity: 0 }], { duration: 150, easing: 'ease-out' })).then(() =>
        fx.remove(),
      );
      return;
    }
    const strong = level === 'strong';
    const side = Math.random() < 0.5 ? -1 : 1;
    this.frame.animate(
      [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: `translate(${side * 1.5}px, 4px) scale(0.985)`, offset: 0.15 },
        { transform: `translate(${-side * 1}px, -1.5px) scale(1.004)`, offset: 0.45 },
        { transform: `translate(${side * 0.5}px, 0.5px) scale(1)`, offset: 0.75 },
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: 220, easing: 'ease-out' },
    );

    // 光と輪は駒の下に、木くずは駒の上に描く
    const under = fragment(`<div class="impact-fx" style="${style}"><div class="impact-flash"></div></div>`);
    const over = fragment(`<div class="impact-fx over" style="${style}"></div>`);
    const flash = under.firstElementChild as HTMLElement;
    const anims: Animation[] = [flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' })];
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
        ring.animate(
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
        chip.animate(
          [
            { transform: 'translate(-50%, -50%) translate(0, 0) scale(1)', opacity: 1 },
            { transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(0.3)`, opacity: 0 },
          ],
          { duration: 260 + Math.random() * 120, easing: 'cubic-bezier(.1,.9,.3,1)' },
        ),
      );
    }

    this.ripple(el, '', 420);
    this.pieces.insertBefore(under, el);
    this.pieces.appendChild(over);
    void Promise.all(anims.map(settle)).then(() => {
      under.remove();
      over.remove();
    });
  }

  /** 盤全体への波紋。駒のマスを中心に光の輪が盤の端まで広がって消える */
  private ripple(el: HTMLElement, cls: string, ms: number): void {
    const board = this.pieces.getBoundingClientRect();
    const c = center(el.getBoundingClientRect());
    const cx = c.x - board.left;
    const cy = c.y - board.top;
    const radius = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(board.width - cx, cy),
      Math.hypot(cx, board.height - cy),
      Math.hypot(board.width - cx, board.height - cy),
    );
    const ripple = fragment(
      `<div class="board-ripple ${cls}"><div style="left:${cx - radius}px;top:${cy - radius}px;width:${radius * 2}px;height:${radius * 2}px"></div></div>`,
    );
    this.pieces.insertBefore(ripple, this.pieces.firstChild);
    void settle(
      (ripple.firstElementChild as HTMLElement).animate(
        [
          { transform: 'scale(0.08)', opacity: 0.9 },
          { transform: 'scale(1)', opacity: 0 },
        ],
        { duration: ms, easing: 'cubic-bezier(.2,.6,.4,1)' },
      ),
    ).then(() => ripple.remove());
  }

  /**
   * 詰み。最後の手の着地で一瞬止め（ヒットストップ）、玉を沈ませて玉のマスを赤く灯し、
   * 玉から波紋を広げてから「詰」の印を押す。onHit は玉が沈む瞬間（音を合わせる）。
   * rare（珍しい達成）のときは印と波紋を金色にする。カードを出してよくなったら解決する。
   */
  async mate(rare: boolean, onHit: () => void): Promise<void> {
    await this.landing;
    const gen = this.generation;
    const model = this.model;
    if (!model) return;
    const kingIndex = model.position.board.findIndex((p) => p?.type === 'K' && p.color !== model.bottom);
    const king = this.pieces.querySelector<HTMLElement>(`.pc[data-index="${kingIndex}"]`);
    if (reducedMotion() || !king) {
      onHit();
      return;
    }
    // ヒットストップ：着地の演出を潰れた瞬間で止める
    const running = this.el.getAnimations({ subtree: true });
    for (const a of running) a.pause();
    await wait(110);
    for (const a of running) if (a.playState === 'paused') a.play();
    if (gen !== this.generation) return;

    onHit();
    king.querySelector<HTMLElement>('.pc-face')!.animate(
      [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: 'translate(-2px, 1px) scale(0.95)', offset: 0.12 },
        { transform: 'translate(2px, 2px) scale(0.93)', offset: 0.26 },
        { transform: 'translate(-1.5px, 2px) scale(0.93)', offset: 0.4 },
        { transform: 'translate(1px, 2px) scale(0.94)', offset: 0.55 },
        { transform: 'translate(0, 2px) scale(0.94)' },
      ],
      { duration: 380, easing: 'ease-out', fill: 'forwards' },
    );
    const glow = fragment(`<div class="impact-fx" style="${king.getAttribute('style')}"><div class="mate-glow"></div><div class="impact-ring mate-ring"></div></div>`);
    this.pieces.insertBefore(glow, king);
    const [g, ring] = [...glow.children] as HTMLElement[];
    g.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0.7 }], { duration: 500, easing: 'ease-out', fill: 'forwards' });
    ring.animate(
      [
        { transform: 'scale(0.9)', opacity: 1 },
        { transform: 'scale(3)', opacity: 0 },
      ],
      { duration: 480, easing: 'cubic-bezier(.1,.8,.3,1)' },
    );
    this.ripple(king, rare ? 'mate rare' : 'mate', 620);

    await wait(220);
    if (gen !== this.generation) return;
    const stamp = fragment(`<div class="mate-stamp${rare ? ' rare' : ''}" aria-hidden="true"><span>詰</span></div>`);
    this.pieces.appendChild(stamp);
    void settle(
      stamp.animate(
        [
          { transform: 'translate(-50%, -50%) rotate(-12deg) scale(2.4)', opacity: 0 },
          { transform: 'translate(-50%, -50%) rotate(-8deg) scale(0.94)', opacity: 1, offset: 0.12 },
          { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 1, offset: 0.2 },
          { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 1, offset: 0.7 },
          { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 0 },
        ],
        { duration: 1600, easing: 'cubic-bezier(.3,.7,.3,1)' },
      ),
    ).then(() => stamp.remove());
    // 印が押されてから少し見せる
    await wait(330);
  }

  /** 着地の瞬間（振り返り）。駒を一瞬押しつぶし、マスの枠を一瞬光らせるだけ */
  private softImpact(el: HTMLElement): void {
    el.querySelector<HTMLElement>('.pc-face')!.animate([{ transform: 'scale(1.04, 0.93)' }, { transform: 'scale(1)' }], {
      duration: 50,
      easing: 'cubic-bezier(.2,0,.2,1)',
    });
    const fx = fragment(`<div class="impact-fx" style="${el.getAttribute('style')}"><div class="impact-ring"></div></div>`);
    this.pieces.insertBefore(fx, el);
    void settle(
      (fx.firstElementChild as HTMLElement).animate(
        [
          { transform: 'scale(1)', opacity: 1 },
          { transform: 'scale(1.12)', opacity: 0 },
        ],
        { duration: 130, easing: 'cubic-bezier(.2,.8,.4,1)' },
      ),
    ).then(() => fx.remove());
  }

  /**
   * 運んでいる間に駒を裏返して成駒にする。奥行きを付けて縦軸で回し、
   * 真横を向いた瞬間に面を差し替える（駒の表と裏が入れ替わって見える）。
   */
  private async flipInFlight(el: HTMLElement, plain: Piece, ms: number): Promise<void> {
    const face = el.querySelector<HTMLElement>('.pc-face')!;
    setFace(el, plain);
    // 運ぶ時間の中で裏返し終える（着地を待たせない）
    const half = Math.max(35, Math.round(ms * 0.42));
    await settle(
      face.animate([{ transform: 'perspective(160px) rotateY(0deg)' }, { transform: 'perspective(160px) rotateY(90deg)' }], {
        duration: half,
        easing: 'ease-in',
      }),
    );
    setFace(el, { ...plain, promoted: true });
    await settle(
      face.animate([{ transform: 'perspective(160px) rotateY(-90deg)' }, { transform: 'perspective(160px) rotateY(0deg)' }], {
        duration: half,
        easing: 'ease-in',
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
            { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(1.06)` },
            { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: target ? 1 : 0 },
          ],
          { duration: ms, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' },
        ),
      ),
      settle(face.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' })),
    ]);
    victim.remove();
    target?.animate([{ transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 70, easing: 'linear' });
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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
