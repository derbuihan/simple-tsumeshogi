import type { Finish } from '../../game/finish';
import type { Color, Position } from '../../shogi/types';
import { AnimationScope } from '../effects/animationScope';
import type { LandSound } from '../sound';
import './ghost.css';
import {
  eatsFor,
  extraSoulsFor,
  HUES,
  kingSoulOf,
  MAX_STREAK,
  PLAIN_LOOK,
  pickDir,
  sizeFor,
  soulLookOf,
  spotNear,
  STAND_SIZE,
  type Cells,
  type Dir,
  type Eat,
  type SoulLook,
  type Spot,
  type Square,
} from './rules';

/**
 * 盤の裏の幽霊。盤（.board）の中の、木目とマスの上・駒の下の層に住む（駒台にもはみ出せる）。
 *
 * - 連チャン 0 のときは攻方の駒台の上に座っている。詰ませると玉から魂が抜け、幽霊が食べる
 *   （駒台からは食べに行く）。もぐもぐする瞬間に大きくなり、それから喜ぶ。以後は盤の裏に住みつく
 * - 盤の裏では玉方の玉のそばに隠れ、玉が動けば追いかける。照明も玉を中心に灯し、連チャンで熱くなる（10連で虹）
 * - 着地のたびに、手の種類（指す・取る・成る・打つ・応手）でリアクションする。手の良し悪しでは変えない
 * - 結果が出た後にしばらく触らないと眠る（考えている間は眠らない）
 *
 * 決まりごと（大きさ・色・食べ方・隠れ場所）は rules.ts。演出の考え方は docs/ghost.md。
 */

/** 盤の情報。BoardView が渡す */
export interface GhostHost {
  /** .board（幽霊の層を置く） */
  readonly board: HTMLElement;
  /** 幽霊の層をこの前に差し込む（駒の層） */
  readonly pieces: HTMLElement;
  /** 攻方の駒台（連チャン 0 の居場所） */
  readonly stand: HTMLElement;
  /** 玉方の駒台（捨て駒の魂が戻ってくる所） */
  readonly enemyStand: HTMLElement;
}

/** 詰ませたときに渡すもの */
export interface GhostMate {
  /** 解く前と後の連チャン（同じなら育たない） */
  before: number;
  after: number;
  finish: Finish;
  /** 手数 */
  length: number;
}

type Reaction = 'lick' | 'surprised' | 'sparkle' | 'peek' | 'nervous' | 'sad';
const FACES = ['idle', 'surprised', 'sparkle', 'peek', 'nervous', 'joy', 'sad', 'eat', 'munch', 'lick', 'sleep'] as const;
type Face = (typeof FACES)[number];
const faceSrc = (f: Face) => `/ghost/${f === 'idle' ? 'ghost-idle' : `face-${f}`}.webp`;
const soulSrc = (look: SoulLook) => `/ghost/${look.base === 'gold' ? 'soul-gold' : 'soul'}.webp`;

/** 結果が出てから眠るまで */
const SLEEP_MS = 30_000;

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class GhostView {
  private readonly haunt: HTMLElement;
  private readonly over: HTMLElement;
  private readonly light: HTMLElement;
  private readonly spirit: HTMLElement;
  private readonly flip: HTMLElement;
  private readonly pose: HTMLElement;

  /** 見た目の上の連チャン（App が数えたものを、詰ませたとき・逃げられたときに受け取る） */
  private streak = 0;
  /** 詰ませて、まだ大きさに反映していない連チャン（食べる途中で次の問題へ進んでも取りこぼさない） */
  private pending: number | null = null;
  private where: 'stand' | 'board' = 'stand';
  private dir: Dir = { x: -1, y: 0 };
  /** 今の局面の、玉方の玉（表示上のマス）。なければ null */
  private king: Square | null = null;
  private kingIndex = -1;
  private flipped = false;
  /** 濃さ（.spirit-pose）。駒台の上ではほぼ不透明、盤の裏では .spirit の濃さと掛け合わせて薄く見せる */
  private rest = 0.95;
  private peak = 1;

  /** 幽霊の動き。新しい動きを始めるときは、今の見た目から続ける（打ち切って戻すと大きさが跳ぶ） */
  private scope = new AnimationScope();
  private faceTimer = 0;
  private sleepTimer = 0;
  private asleep = false;
  private zzz: HTMLElement | null = null;

  constructor(private readonly host: GhostHost) {
    this.haunt = document.createElement('div');
    this.haunt.className = 'haunt';
    this.haunt.setAttribute('aria-hidden', 'true');
    this.haunt.innerHTML = `
      <div class="haunt-light"></div>
      <div class="spirit"><div class="spirit-flip"><div class="spirit-float"><div class="spirit-pose" data-face="idle">
        ${FACES.map((f) => `<img class="face face-${f}" src="${faceSrc(f)}" alt="" decoding="async" ${f === 'idle' ? '' : 'loading="lazy"'} />`).join('')}
      </div></div></div></div>`;
    // マスは .board の子の並び順で探すので、マスの後ろ・駒の層の前に入れる
    host.board.insertBefore(this.haunt, host.pieces);
    this.over = document.createElement('div');
    this.over.className = 'haunt-over';
    this.over.setAttribute('aria-hidden', 'true');
    host.board.appendChild(this.over);
    this.light = this.haunt.querySelector('.haunt-light')!;
    this.spirit = this.haunt.querySelector('.spirit')!;
    this.flip = this.haunt.querySelector('.spirit-flip')!;
    this.pose = this.haunt.querySelector('.spirit-pose')!;
    this.pose.style.opacity = String(this.rest);
    // 居場所は px で持つので、盤の大きさが変わったら（画面の向き・文字の大きさ）置き直す
    new ResizeObserver(() => this.relayout()).observe(host.board);
    // 眠っている間にどこかに触れたら起きる。結果の画面で触るたびに、眠るまでを数え直す
    for (const ev of ['pointerdown', 'keydown'] as const) {
      window.addEventListener(ev, () => {
        if (this.asleep) this.wake();
        if (this.sleepTimer) this.sleepLater();
      });
    }
  }

  // ---- 盤から呼ぶ ----

  /**
   * 局面が変わった。stepped: 直前の局面から1手進んだ（そうでなければ別の問題・やり直し）。
   * 振り返り中は追いかけない（照明だけ玉に合わせない）
   */
  update(position: Position, bottom: Color, stepped: boolean, replay: boolean): void {
    if (replay) return;
    this.flipped = bottom === 'w';
    this.kingIndex = position.board.findIndex((p) => p?.type === 'K' && p.color !== bottom);
    const king = this.kingIndex < 0 ? null : this.display(this.kingIndex);
    const moved = !this.king || !king || king.x !== this.king.x || king.y !== this.king.y;
    this.king = king;
    if (!stepped) {
      // 次の問題・やり直し：育つ分を反映し、眠りを覚まして、新しい玉のそばへ移る（連チャンが切れていたら駒台へ）
      this.grow();
      this.stopSleep();
      if (this.streak === 0) this.where = 'stand';
      this.paintLight();
      this.density();
      if (this.where === 'stand' || !king) return this.settleOnStand();
      this.dir = pickDir(king, sizeFor(this.streak), this.cells());
      void this.travel(this.spotNow(), 1300);
      return;
    }
    if (this.where === 'board' && king && moved) {
      // 玉が逃げた：ふわっとついて行く
      this.paintLight();
      void this.travel(this.spotNow(), 700, false);
    }
  }

  /** 駒が着地した。攻方の手（王手）なら玉がびくっとし、幽霊は手の種類で反応する（ふつうの手は舌なめずり） */
  land(s: LandSound): void {
    if (s.replay || reducedMotion()) return;
    if (!s.own) return this.react('nervous');
    this.flinchKing();
    this.react(s.capture ? 'surprised' : s.promote ? 'sparkle' : s.drop ? 'peek' : 'lick');
  }

  /** 詰み（玉が沈む瞬間に呼ぶ）。玉から魂が抜け、幽霊が食べる */
  mate(m: GhostMate): void {
    this.pending = m.after > m.before ? m.after : null;
    if (reducedMotion()) {
      if (this.pending !== null && this.where === 'stand') this.moveToBoard();
      this.grow();
      return;
    }
    void this.mateShow(m);
  }

  /** 逃げられた（ギブアップも）：しょんぼりして駒台へ帰る */
  fail(): void {
    this.pending = null;
    if (this.where === 'stand' && this.streak === 0) {
      if (!reducedMotion()) this.react('sad');
      return;
    }
    this.streak = 0;
    if (reducedMotion()) {
      this.where = 'stand';
      this.paintLight();
      this.settleOnStand();
      return;
    }
    this.react('sad');
    window.setTimeout(() => {
      // しょんぼりした後に、まだ駒台へ帰っていなければ帰る（その間に次の問題へ進んでいたら update が帰している）
      if (this.where !== 'board' || this.streak !== 0) return;
      this.where = 'stand';
      this.paintLight();
      this.clip(false);
      void this.travel(this.standSpot(), 1100).then(() => this.density());
    }, 1400);
  }

  /** 結果が出た：しばらく触らなければ眠る */
  sleepLater(): void {
    window.clearTimeout(this.sleepTimer);
    this.sleepTimer = window.setTimeout(() => this.fallAsleep(), SLEEP_MS);
  }

  /** 考え始める：眠らせない（眠っていたら起こす） */
  stopSleep(): void {
    window.clearTimeout(this.sleepTimer);
    this.sleepTimer = 0;
    if (this.asleep) this.wake(false);
  }

  // ---- 座標 ----

  private display(index: number): Square {
    const d = this.flipped ? 80 - index : index;
    return { x: d % 9, y: Math.floor(d / 9) };
  }

  private cells(): Cells {
    const r = this.host.board.querySelector<HTMLElement>('.cell')!.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  /** .board の中の座標（駒や幽霊の層と同じ基準） */
  private local(r: DOMRect) {
    const b = this.host.board.getBoundingClientRect();
    return { left: r.left - b.left - this.host.board.clientLeft, top: r.top - b.top - this.host.board.clientTop, width: r.width, height: r.height };
  }

  private centerOf(r: DOMRect) {
    const l = this.local(r);
    return { x: l.left + l.width / 2, y: l.top + l.height / 2 };
  }

  private squareCenter(index: number) {
    const c = this.cells();
    const d = this.display(index);
    return { x: (d.x + 0.5) * c.w, y: (d.y + 0.5) * c.h };
  }

  // ---- 居場所・濃さ・照明 ----

  private standSpot(): Spot {
    const c = this.cells();
    const h = this.local(this.host.stand.getBoundingClientRect());
    const s = STAND_SIZE * c.w;
    return { left: h.left + h.width - s - c.w * 0.1, top: h.top + h.height - s - 2, size: s, faceRight: false };
  }

  /** 今の連チャンの大きさで、玉のそばの隠れ場所 */
  private spotNow(n = sizeFor(this.streak)): Spot {
    return spotNear(this.king ?? { x: 4, y: 4 }, n, this.dir, this.cells());
  }

  private place(sp: Spot, faceRight = sp.faceRight): void {
    Object.assign(this.spirit.style, { left: `${sp.left}px`, top: `${sp.top}px`, width: `${sp.size}px`, height: `${sp.size}px` });
    this.flip.classList.toggle('right', faceRight);
  }

  /** 盤の上にいる間は盤の形で切り抜く（駒台との行き来の間は切り抜かない） */
  private clip(on: boolean): void {
    this.haunt.classList.toggle('clip', on);
  }

  private density(): void {
    if (this.where === 'stand') {
      this.spirit.style.opacity = '1';
      this.rest = 0.95;
      this.peak = 1;
    } else {
      // 盤の裏：初めて住みついた問題だけ少し薄く、その後は駒が読める濃さ（約22%、反応の山で約43%）
      this.spirit.style.opacity = this.streak <= 1 ? '0.36' : '0.5';
      this.rest = 0.44;
      this.peak = 0.85;
    }
  }

  private relayout(): void {
    if (this.spirit.classList.contains('traveling') || this.spirit.classList.contains('growing')) return;
    if (this.where === 'stand') this.place(this.standSpot());
    else if (this.king) this.place(this.spotNow());
  }

  private settleOnStand(): void {
    this.clip(false);
    this.takeover();
    this.place(this.standSpot());
    this.pose.style.opacity = String(this.rest);
    this.setFace('idle');
  }

  private moveToBoard(): void {
    this.where = 'board';
    if (this.king) this.dir = pickDir(this.king, sizeFor(1), this.cells());
    this.clip(true);
  }

  private paintLight(): void {
    const st = this.streak;
    const light = this.light;
    light.classList.toggle('rainbow', st >= MAX_STREAK);
    const frame = this.host.board.closest<HTMLElement>('.board-area');
    if (st === 0 || !this.king) {
      light.style.opacity = '0';
      frame?.style.removeProperty('--frame-glow');
      return;
    }
    const kx = ((this.king.x + 0.5) * 100) / 9;
    const ky = ((this.king.y + 0.5) * 100) / 9;
    light.style.opacity = '1';
    light.style.setProperty('--kx', `${kx}%`);
    light.style.setProperty('--ky', `${ky}%`);
    if (st >= MAX_STREAK) {
      light.style.background = '';
      light.style.boxShadow = '';
      frame?.style.setProperty('--frame-glow', '0 0 18px rgba(255, 140, 220, .7), 0 0 4px 1px rgba(160, 230, 255, .9)');
      return;
    }
    const h = HUES[st];
    const a = 0.14 + st * 0.03;
    light.style.background = `radial-gradient(circle at ${kx}% ${ky}%, hsla(${h}, 95%, 72%, ${a + 0.12}) 0, hsla(${h}, 90%, 70%, ${a}) ${18 + st * 3}%, hsla(${h}, 90%, 70%, ${a * 0.25}) 75%)${
      st >= 9 ? `, repeating-conic-gradient(from 0deg at ${kx}% ${ky}%, hsla(${h}, 100%, 80%, .14) 0 7deg, transparent 7deg 21deg)` : ''
    }`;
    light.style.boxShadow = `inset 0 0 ${10 + st * 2.5}px hsla(${h}, 95%, 65%, ${0.25 + st * 0.05})`;
    frame?.style.setProperty('--frame-glow', `0 0 ${6 + st * 2}px hsla(${h}, 95%, 65%, ${0.35 + st * 0.05})`);
  }

  /** 食べた瞬間：連チャンを伸ばし、その場でぐっと大きくする */
  private grow(): void {
    if (this.pending === null) return;
    this.streak = this.pending;
    this.pending = null;
    if (this.where === 'stand') this.moveToBoard();
    this.paintLight();
    this.density();
    this.spirit.classList.add('growing');
    this.place(this.spotNow());
    window.setTimeout(() => this.spirit.classList.remove('growing'), 900);
  }

  // ---- 動き ----

  private setFace(f: Face): void {
    this.pose.dataset.face = f;
  }

  /** 今の動きを引き継ぐ。前の動きの途中の見た目を返す */
  private takeover() {
    const cs = getComputedStyle(this.pose);
    const from = { transform: cs.transform, opacity: Number(cs.opacity) };
    this.scope.cancel();
    this.scope = new AnimationScope();
    window.clearTimeout(this.faceTimer);
    return { s: this.scope, from };
  }

  private restFrame = () => ({ transform: 'none', opacity: this.rest });

  private poseTo(s: AnimationScope, frame: Keyframe, duration: number, easing = 'ease-out') {
    const cs = getComputedStyle(this.pose);
    return s.animate(this.pose, [{ transform: cs.transform, opacity: Number(cs.opacity), filter: cs.filter }, frame], { duration, easing, fill: 'forwards' });
  }

  /** 今いる所から、ふわふわ移動する。進む向きを向き、着いたら玉のほうを向く */
  private async travel(to: Spot, ms: number, peek = true): Promise<void> {
    if (reducedMotion()) {
      this.place(to);
      return;
    }
    const { s, from } = this.takeover();
    const now = this.local(this.spirit.getBoundingClientRect());
    this.spirit.style.setProperty('--travel', `${ms}ms`);
    this.spirit.classList.add('traveling');
    this.place(to, to.left > now.left);
    if (peek) this.setFace('peek');
    void s.animate(
      this.pose,
      [from, { transform: 'rotate(-5deg) translateY(-3%)', offset: 0.25 }, { transform: 'rotate(5deg)', offset: 0.5 }, { transform: 'rotate(-4deg) translateY(-3%)', offset: 0.75 }, this.restFrame()],
      { duration: ms, easing: 'ease-in-out' },
    );
    await s.wait(ms);
    this.spirit.classList.remove('traveling');
    if (!s.active) return;
    this.flip.classList.toggle('right', to.faceRight);
    await s.wait(300);
    if (s.active) this.setFace('idle');
  }

  /** 王手：玉の駒が小さく震えて縮こまる */
  private flinchKing(): void {
    this.host.pieces.querySelector<HTMLElement>(`.pc[data-index="${this.kingIndex}"] .pc-face`)?.animate(
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

  private react(kind: Reaction): void {
    const { s, from } = this.takeover();
    const back = (ms: number) => (this.faceTimer = window.setTimeout(() => this.setFace('idle'), ms));
    const play = (frames: Keyframe[], duration: number, easing = 'ease-out') => void s.animate(this.pose, [from, ...frames, this.restFrame()], { duration, easing });
    const P = this.peak;
    switch (kind) {
      case 'lick':
        this.setFace('lick');
        play([{ transform: 'scale(1.05, .95)', opacity: P * 0.8, offset: 0.2 }, { transform: 'scale(.99, 1.02) rotate(-2deg)', opacity: P * 0.75, offset: 0.55 }], 650);
        back(750);
        break;
      case 'surprised':
        this.setFace('surprised');
        play(
          [
            { transform: 'translateY(-6%) scale(1.07)', opacity: P, offset: 0.22 },
            { transform: 'translateY(-3%) scale(1.03)', opacity: P * 0.8, offset: 0.6 },
          ],
          800,
          'cubic-bezier(.2,.8,.3,1)',
        );
        back(850);
        break;
      case 'sparkle':
        this.setFace('sparkle');
        play(
          [
            { transform: 'rotate(-4deg) scale(1.04)', opacity: P, filter: 'brightness(1.5)', offset: 0.3 },
            { transform: 'rotate(0) scale(1.01)', opacity: P * 0.7, filter: 'brightness(1)', offset: 0.7 },
          ],
          950,
        );
        this.sparkles(s, this.pose.getBoundingClientRect(), 10, false);
        back(950);
        break;
      case 'peek': {
        // 打ったマスのほう（今は玉のほう）へ寄ってのぞき込む
        this.setFace('peek');
        const right = this.flip.classList.contains('right') ? -1 : 1;
        const vx = this.dir.x === 0 ? 0 : -this.dir.x * right * 0.5;
        const vy = -this.dir.y * 0.5;
        play(
          [
            { transform: `translate(${vx * 14}%, ${vy * 10}%) rotate(${vx * -6}deg)`, opacity: P * 0.9, offset: 0.35 },
            { transform: `translate(${vx * 12}%, ${vy * 8}%) rotate(${vx * -5}deg)`, opacity: P * 0.8, offset: 0.75 },
          ],
          1100,
          'ease-in-out',
        );
        back(1050);
        break;
      }
      case 'nervous':
        this.setFace('nervous');
        play(
          [
            { transform: 'translateX(-2.5%)', opacity: P * 0.7, offset: 0.15 },
            { transform: 'translateX(2.5%)', offset: 0.32 },
            { transform: 'translateX(-1.8%)', offset: 0.5 },
            { transform: 'translateX(1.2%)', offset: 0.68 },
          ],
          750,
          'ease-in-out',
        );
        back(800);
        break;
      case 'sad':
        this.setFace('sad');
        play(
          [
            { transform: 'translateY(4%) scale(.96)', opacity: this.rest * 0.45, offset: 0.25 },
            { transform: 'translateY(4%) scale(.96)', opacity: this.rest * 0.45, offset: 0.75 },
          ],
          2000,
          'ease-in-out',
        );
        back(1900);
        break;
    }
  }

  // ---- 眠る ----

  private fallAsleep(): void {
    this.sleepTimer = 0;
    if (reducedMotion()) return;
    const { s, from } = this.takeover();
    this.asleep = true;
    this.setFace('sleep');
    const breathIn = { transform: 'translateY(2%) scale(1.03, .97)', opacity: this.rest };
    void s.animate(this.pose, [from, breathIn], { duration: 900, easing: 'ease-in-out', fill: 'forwards' }).then((ok) => {
      if (ok) void s.animate(this.pose, [breathIn, { transform: 'translateY(1%) scale(.99, 1.02)', opacity: this.rest }], { duration: 1800, easing: 'ease-in-out', iterations: Infinity, direction: 'alternate' });
    });
    const r = this.local(this.spirit.getBoundingClientRect());
    this.zzz = s.track(document.createElement('div'));
    this.zzz.className = 'zzz';
    this.zzz.innerHTML = '<span>z</span><span>z</span><span>Z</span>';
    Object.assign(this.zzz.style, {
      left: `${r.left + r.width * (this.flip.classList.contains('right') ? 0.18 : 0.72)}px`,
      top: `${this.where === 'stand' ? r.top + r.height * 0.12 : Math.max(r.top + r.height * 0.22, 40)}px`,
    });
    this.haunt.appendChild(this.zzz);
  }

  private wake(surprised = true): void {
    this.asleep = false;
    this.zzz?.remove();
    this.zzz = null;
    if (surprised) this.react('surprised');
    else {
      this.takeover();
      this.setFace('idle');
    }
  }

  // ---- 詰み ----

  private makeSoul(s: AnimationScope, p: { x: number; y: number }, size: number, look: SoulLook | 'rainbow', extra = ''): HTMLElement {
    const el = s.track(document.createElement('div'));
    const rainbow = look === 'rainbow';
    el.className = `soul${rainbow ? ' rainbow' : look.base === 'gold' ? ' gold' : ''}${extra ? ` ${extra}` : ''}`;
    el.innerHTML = `<img src="${rainbow ? soulSrc(PLAIN_LOOK) : soulSrc(look)}" alt="" />`;
    if (!rainbow) el.style.setProperty('--tint', look.filter);
    Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${size}px`, height: `${size}px` });
    el.dataset.x = String(p.x);
    el.dataset.y = String(p.y);
    this.over.appendChild(el);
    return el;
  }

  private setLook(el: HTMLElement, look: SoulLook): void {
    el.classList.toggle('gold', look.base === 'gold');
    el.querySelector('img')!.src = soulSrc(look);
    el.style.setProperty('--tint', look.filter);
  }

  /** 魂を動かす。dataset.x/y に今いる所を持たせ、動かした後に更新する */
  private async soulTo(s: AnimationScope, el: HTMLElement, pts: { x: number; y: number; scale?: number; opacity?: number; offset?: number }[], o: KeyframeAnimationOptions): Promise<boolean> {
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
    const last = pts[pts.length - 1];
    el.dataset.x = String(last.x);
    el.dataset.y = String(last.y);
    return ok;
  }

  private here = (el: HTMLElement) => ({ x: parseFloat(el.dataset.x!), y: parseFloat(el.dataset.y!) });

  private mouth() {
    const r = this.local(this.pose.getBoundingClientRect());
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.56 };
  }

  private async swallow(s: AnimationScope, soul: HTMLElement, ms: number): Promise<void> {
    const m = this.mouth();
    await this.soulTo(s, soul, [this.here(soul), { x: m.x, y: m.y, scale: 0.25, opacity: 0.6 }], { duration: ms, easing: 'cubic-bezier(.6,0,.9,.6)' });
    soul.remove();
  }

  /** 成って詰み：魂がくるっと裏返って、成駒の色に変わる */
  private async flipSoul(s: AnimationScope, soul: HTMLElement, to: SoulLook): Promise<void> {
    const i = soul.querySelector('img')!;
    await s.animate(i, [{ transform: 'rotateY(0)' }, { transform: 'rotateY(90deg) scale(1.1)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    this.setLook(soul, to);
    this.sparkles(s, soul.getBoundingClientRect(), 6, to.base === 'gold');
    await s.animate(i, [{ transform: 'rotateY(-90deg) scale(1.1)' }, { transform: 'rotateY(0) scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.3,1.4)', fill: 'forwards' });
  }

  /** もぐもぐ：最初のひと噛みで連チャンが伸び、ぐっと大きくなる（魂を食べて育ったのが分かるように）。大きくなりきってから喜ぶ */
  private async munchAndGrow(s: AnimationScope, chews: number): Promise<void> {
    this.setFace('munch');
    for (let i = 0; i < chews && s.active; i++) {
      if (i === 0 && this.pending !== null) {
        this.grow();
        this.sparkles(s, this.pose.getBoundingClientRect(), 8, this.streak >= 9);
      }
      await this.poseTo(s, { transform: 'scale(1.08, .92)', opacity: 1 }, 120);
      await this.poseTo(s, { transform: 'scale(.97, 1.05)', opacity: 1 }, 150);
    }
    await s.wait(Math.max(0, 950 - chews * 270));
  }

  private async rejoice(s: AnimationScope, rainbow: boolean, feast: number): Promise<void> {
    this.setFace('joy');
    this.sparkles(s, this.pose.getBoundingClientRect(), 8 + this.streak * 2 + feast * 2, this.streak >= 9);
    if (rainbow) this.rainbowBurst(s);
    else if (this.streak >= 6 || feast >= 4) this.confetti(s, Math.max(0, this.streak - 5) * 8 + feast * 4, this.streak >= 9 ? 'gold' : 'cool');
    await this.poseTo(s, { transform: 'translateY(-6%) scale(1.05)', opacity: 1, filter: rainbow ? 'brightness(1.3) hue-rotate(180deg)' : 'brightness(1.25)' }, 280, 'cubic-bezier(.2,.8,.3,1.3)');
    await this.poseTo(s, { transform: 'none', opacity: 0.95, filter: rainbow ? 'brightness(1.1) hue-rotate(360deg)' : 'brightness(1)' }, 450, 'ease-in-out');
    await s.wait(450);
    await this.poseTo(s, { transform: 'none', opacity: this.rest, filter: 'none' }, 600, 'ease-in-out');
    if (s.active) this.setFace('idle');
  }

  private async mateShow(m: GhostMate): Promise<void> {
    const { s } = this.takeover();
    const kingEl = this.host.pieces.querySelector<HTMLElement>(`.pc[data-index="${this.kingIndex}"]`);
    if (!kingEl) return this.grow();
    const k = this.centerOf(kingEl.getBoundingClientRect());
    const c = this.cells();
    const st = m.before;
    const grows = this.pending !== null;
    const willRainbow = grows && m.after >= MAX_STREAK;
    // 駒台から食べに行くのは、育つとき（初めての正解）だけ。育たないときは、魂のほうが駒台まで飛んでくる
    const fromStand = this.where === 'stand';
    const eats = eatsFor(st);
    const kind: Eat = fromStand ? 'slurp' : eats[Math.floor(Math.random() * eats.length)];
    const look = kingSoulOf(m.finish);
    const start: SoulLook | 'rainbow' = willRainbow ? 'rainbow' : look.start;
    const big = m.length >= 7 ? 1.25 : 1;

    // 玉から魂が抜け出す
    const up = { x: k.x, y: k.y - c.h * 0.9 };
    const soul = this.makeSoul(s, k, c.w * (kind === 'feast' ? 1.3 : 1.8) * big, start, look.dango && !willRainbow ? 'dango' : '');
    const rise = this.soulTo(
      s,
      soul,
      [
        { x: k.x, y: k.y, scale: 0.2, opacity: 0 },
        { x: k.x + c.w * 0.1, y: k.y - c.h * 0.5, scale: 0.9, opacity: 1, offset: 0.6 },
        { x: up.x, y: up.y, scale: 1 },
      ],
      { duration: 520, easing: 'ease-out' },
    );
    const extras = this.spawnExtras(s, m, k, c, willRainbow, look.end);

    if (fromStand && grows) {
      // 初めて詰ませた：魂が抜け出すのと同時に、駒台から飛び立つ（結果のカードが駒台の上に出る前に、盤の上へ着く）
      this.where = 'board';
      if (this.king) this.dir = pickDir(this.king, STAND_SIZE * 1.4, c);
      const to = this.spotNow(STAND_SIZE * 1.4);
      this.setFace('eat');
      this.spirit.style.setProperty('--travel', '600ms');
      this.spirit.classList.add('traveling');
      this.place(to, to.left > this.local(this.spirit.getBoundingClientRect()).left);
      await Promise.all([rise, s.wait(600)]);
      this.spirit.classList.remove('traveling');
      if (!s.active) return;
      this.clip(true);
      this.density();
      this.flip.classList.toggle('right', to.faceRight);
    } else {
      await rise;
    }
    if (!s.active) return;

    if (look.flip && !willRainbow) await this.flipSoul(s, soul, look.end);
    if (look.dango && !willRainbow) {
      await s.animate(soul.querySelector('img')!, [{ transform: 'scale(1)' }, { transform: 'scale(1.25, .8)' }, { transform: 'scale(.9, 1.15)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
    }
    if (!s.active) return;

    await this.eat(s, kind, soul, k, up, c, willRainbow, look.end);
    if (!s.active) return;
    // ごちそうの残り（手数・捨て駒・合駒の魂）を、口を開けたまま順に吸い込む
    if (extras.length) {
      this.setFace('eat');
      for (const e of extras) {
        if (!s.active) return;
        await this.swallow(s, e, 200);
        void this.poseTo(s, { transform: 'scale(1.06, .94)', opacity: 1 }, 90);
        await s.wait(70);
      }
    }
    await this.munchAndGrow(s, Math.min(6, 3 + Math.floor(extras.length / 2)));
    if (s.active) await this.rejoice(s, willRainbow || (grows ? m.after : st) >= MAX_STREAK, extras.length);
  }

  /** 本命の魂のほかに出る魂：手数の分（玉から）、捨て駒（玉方の駒台から、その駒の色で）、合駒を取ったマス（おまけ） */
  private spawnExtras(s: AnimationScope, m: GhostMate, k: { x: number; y: number }, c: Cells, rainbow: boolean, end: SoulLook): HTMLElement[] {
    const extras: HTMLElement[] = [];
    const more = extraSoulsFor(m.length);
    for (let i = 0; i < more; i++) {
      const e = this.makeSoul(s, k, c.w * 1.05, rainbow ? 'rainbow' : end);
      const a = -Math.PI / 2 + (i - (more - 1) / 2) * 0.9;
      const to = { x: k.x + Math.cos(a) * c.w * 1.5, y: k.y + Math.sin(a) * c.h * 1.2 - c.h * 0.3 };
      void this.soulTo(s, e, [{ ...k, scale: 0.2, opacity: 0 }, { ...to, scale: 1 }], { duration: 480, delay: 120 + i * 110, easing: 'cubic-bezier(.2,.8,.3,1.3)' });
      extras.push(e);
    }
    const es = this.local(this.host.enemyStand.getBoundingClientRect());
    m.finish.sacrifices.forEach((t, i) => {
      const from = { x: es.left + es.width * (0.3 + 0.4 * Math.random()), y: es.top + es.height / 2 };
      const e = this.makeSoul(s, from, c.w * 0.95, soulLookOf(t), 'returned');
      const to = { x: k.x + (i - (m.finish.sacrifices.length - 1) / 2) * c.w * 0.9, y: Math.max(c.h * 0.5, k.y - c.h * 1.7) };
      void this.soulTo(s, e, [{ ...from, scale: 0.4, opacity: 0 }, { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - c.h * 0.3, scale: 0.8, offset: 0.5 }, { ...to, scale: 1 }], {
        duration: 700,
        delay: 200 + i * 150,
        easing: 'ease-in-out',
      });
      extras.push(e);
    });
    for (const sq of m.finish.takenInterpositions) {
      const p = this.squareCenter(sq);
      const e = this.makeSoul(s, p, c.w, PLAIN_LOOK, 'bonus');
      void this.soulTo(s, e, [{ ...p, scale: 0.2, opacity: 0 }, { x: p.x, y: p.y - c.h * 0.7, scale: 1.1, offset: 0.6 }, { x: p.x, y: p.y - c.h * 0.5, scale: 1 }], {
        duration: 520,
        delay: 80,
        easing: 'cubic-bezier(.2,.8,.3,1.3)',
      });
      extras.push(e);
    }
    return extras;
  }

  /** 本命の魂を食べる（食べ方は毎回ランダム） */
  private async eat(s: AnimationScope, kind: Eat, soul: HTMLElement, k: { x: number; y: number }, up: { x: number; y: number }, c: Cells, rainbow: boolean, end: SoulLook): Promise<void> {
    const mirror = () => (this.flip.classList.contains('right') ? -1 : 1);
    const P = this.peak;
    const W = c.w * 9;
    const H = c.h * 9;
    switch (kind) {
      case 'slurp':
        // 大きく口を開けて、ずずっと吸い込む
        this.setFace('eat');
        await this.poseTo(s, { transform: 'scale(1.05)', opacity: P }, 200);
        await this.swallow(s, soul, 400);
        return;
      case 'lunge': {
        // 魂めがけて、ぱくっと飛びつく
        this.setFace('eat');
        const m = this.mouth();
        const r = this.local(this.pose.getBoundingClientRect());
        const fx = ((up.x - m.x) / r.width) * 60 * mirror();
        const fy = ((up.y - m.y) / r.height) * 60;
        await this.poseTo(s, { transform: `translate(${-fx * 0.15}%, ${-fy * 0.15}%) scale(.95)`, opacity: P }, 160, 'ease-in');
        void this.poseTo(s, { transform: `translate(${fx}%, ${fy}%) scale(1.08)`, opacity: 1 }, 200, 'cubic-bezier(.3,1.4,.5,1)');
        await s.wait(120);
        await this.swallow(s, soul, 120);
        await this.poseTo(s, { transform: 'none', opacity: 1 }, 300);
        return;
      }
      case 'chase': {
        // 魂が逃げ回り、のぞき込みながら追いかけて、最後に吸い込む
        this.setFace('peek');
        for (let i = 0; i < 3 && s.active; i++) {
          const p = this.here(soul);
          const q = { x: Math.max(c.w * 0.5, Math.min(W - c.w * 0.5, k.x + (Math.random() - 0.5) * c.w * 3.2)), y: Math.max(c.h * 0.5, Math.min(H - c.h * 0.5, k.y - c.h * (0.6 + Math.random() * 1.4))) };
          const mid = { x: (p.x + q.x) / 2, y: Math.min(p.y, q.y) - c.h * 0.7 };
          const r = this.local(this.pose.getBoundingClientRect());
          const m = this.mouth();
          const lx = ((q.x - m.x) / r.width) * 25 * mirror();
          void this.poseTo(s, { transform: `translate(${lx}%, ${((q.y - m.y) / r.height) * 18}%) rotate(${-lx * 0.4}deg)`, opacity: P }, 300, 'ease-in-out');
          await this.soulTo(s, soul, [p, { ...mid, offset: 0.5 }, q], { duration: 300, easing: 'ease-in-out' });
          await s.wait(90);
        }
        this.setFace('eat');
        await this.swallow(s, soul, 260);
        await this.poseTo(s, { transform: 'none', opacity: 1 }, 250);
        return;
      }
      case 'catch': {
        // 魂がぽーんと跳ね上がり、両手を上げてキャッチする
        this.setFace('surprised');
        const p = this.here(soul);
        const top = { x: p.x, y: Math.max(c.h * 0.4, p.y - c.h * 2) };
        await this.soulTo(s, soul, [p, { ...top, scale: 1.1 }], { duration: 380, easing: 'cubic-bezier(.2,.8,.4,1)' });
        this.setFace('joy');
        void this.poseTo(s, { transform: 'translateY(-8%) scale(1.04)', opacity: 1 }, 380, 'ease-out');
        await s.wait(200);
        this.setFace('eat');
        const m = this.mouth();
        await this.soulTo(s, soul, [top, { x: m.x, y: m.y, scale: 0.3, opacity: 0.7 }], { duration: 360, easing: 'cubic-bezier(.5,0,1,.6)' });
        soul.remove();
        await this.poseTo(s, { transform: 'translateY(2%) scale(1.08, .92)', opacity: 1 }, 140);
        return;
      }
      case 'split': {
        // 魂が3つに分かれ、順番に吸い込む
        const p = this.here(soul);
        const pts = [-1, 0, 1].map((i) => ({ x: p.x + i * c.w * 1.1, y: p.y - (i === 0 ? c.h * 0.5 : 0) }));
        const kids = pts.map(() => this.makeSoul(s, p, c.w * 1.2, rainbow ? 'rainbow' : end));
        soul.remove();
        await Promise.all(kids.map((e, i) => this.soulTo(s, e, [{ ...p, scale: 0.6 }, pts[i]], { duration: 300, easing: 'cubic-bezier(.2,.8,.3,1.3)' })));
        this.setFace('eat');
        for (const e of kids) {
          if (!s.active) return;
          await this.swallow(s, e, 240);
          void this.poseTo(s, { transform: 'scale(1.07, .93)', opacity: 1 }, 100);
          await s.wait(110);
        }
        return;
      }
      case 'feast': {
        // 10連：たくさんの魂が玉からあふれ、幽霊の周りを回ってから、まとめて吸い込まれる
        soul.remove();
        const n = 8;
        const g = this.centerOf(this.pose.getBoundingClientRect());
        const R = Math.max(c.w * 1.6, this.pose.getBoundingClientRect().width * 0.45);
        const kids = Array.from({ length: n }, () => this.makeSoul(s, k, c.w * 1.1, rainbow ? 'rainbow' : end));
        this.setFace('surprised');
        await Promise.all(
          kids.map((e, i) => {
            const a0 = (i / n) * Math.PI * 2;
            const pts = Array.from({ length: 9 }, (_, j) => {
              const a = a0 + (j / 8) * Math.PI * 1.6;
              const rr = j === 0 ? 0 : R * (0.6 + 0.4 * Math.sin((j / 8) * Math.PI));
              return { x: (j === 0 ? k.x : g.x) + Math.cos(a) * rr, y: (j === 0 ? k.y : g.y) + Math.sin(a) * rr * 0.8, scale: j === 0 ? 0.3 : 1 };
            });
            return this.soulTo(s, e, pts, { duration: 1100, delay: i * 40, easing: 'ease-in-out' });
          }),
        );
        this.setFace('eat');
        await this.poseTo(s, { transform: 'scale(1.1)', opacity: 1, filter: 'brightness(1.3)' }, 200);
        await Promise.all(kids.map((e, i) => s.wait(i * 35).then(() => this.swallow(s, e, 260))));
        return;
      }
    }
  }

  // ---- きらめき・紙吹雪・虹 ----

  private sparkles(s: AnimationScope, rect: DOMRect, n: number, gold: boolean): void {
    const r = this.local(rect);
    for (let i = 0; i < n; i++) {
      const p = s.track(document.createElement('div'));
      p.className = `haunt-spark${gold ? ' gold' : ''}`;
      const a = Math.random() * Math.PI * 2;
      const d = 0.3 + Math.random() * 0.2;
      p.style.left = `${r.left + r.width * (0.5 + Math.cos(a) * d)}px`;
      p.style.top = `${r.top + r.height * (0.45 + Math.sin(a) * d)}px`;
      this.over.appendChild(p);
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

  private confetti(s: AnimationScope, n: number, palette: 'cool' | 'gold' | 'rainbow'): void {
    const colors = {
      cool: ['#9fe8d6', '#c9f5ff', '#d6a8ff', '#ffb3d9'],
      gold: ['#ffd75e', '#fff3c4', '#ffb347'],
      rainbow: ['#ff6b6b', '#ffb347', '#ffe66d', '#7ee081', '#5ec8ff', '#8b7bff', '#e07bff'],
    }[palette];
    const height = this.over.clientHeight;
    for (let i = 0; i < n; i++) {
      const p = s.track(document.createElement('div'));
      p.className = 'haunt-confetti';
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      this.over.appendChild(p);
      void s
        .animate(
          p,
          [
            { transform: 'translate(0, -20px) rotate(0)', opacity: 1 },
            { transform: `translate(${(Math.random() - 0.5) * 60}px, ${height * (0.7 + Math.random() * 0.3)}px) rotate(${360 + Math.random() * 540}deg)`, opacity: 0 },
          ],
          { duration: 1400 + Math.random() * 900, delay: Math.random() * 400, easing: 'cubic-bezier(.2,.5,.5,1)', fill: 'backwards' },
        )
        .then(() => p.remove());
    }
  }

  /** 10連：玉から虹の輪が盤いっぱいに広がり、虹の紙吹雪が降る */
  private rainbowBurst(s: AnimationScope): void {
    const k = this.squareCenter(this.kingIndex);
    const c = this.cells();
    for (let i = 0; i < 3; i++) {
      const ring = s.track(document.createElement('div'));
      ring.className = 'rainbow-ring';
      Object.assign(ring.style, { left: `${k.x}px`, top: `${k.y}px`, width: `${c.w * 9 * 2.4}px`, height: `${c.w * 9 * 2.4}px` });
      this.over.appendChild(ring);
      void s
        .animate(ring, [{ transform: 'translate(-50%,-50%) scale(.05) rotate(0)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1) rotate(120deg)', opacity: 0 }], {
          duration: 1300,
          delay: i * 220,
          easing: 'cubic-bezier(.2,.6,.4,1)',
          fill: 'backwards',
        })
        .then(() => ring.remove());
    }
    this.confetti(s, 70, 'rainbow');
    void s.animate(this.light, [{ filter: 'brightness(1.8) saturate(1.6)' }, { filter: 'none' }], { duration: 1600, easing: 'ease-out' });
  }
}
