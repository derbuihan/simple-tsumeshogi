import { EngineClient, type EvalVariant } from './engine/EngineClient';
import type { Problem } from './game/problem';
import { Session, type FailureReason } from './game/session';
import { randomProblem } from './problems/loader';
import { applyMoves, parseUsiMove } from './shogi/move';
import { moveToJapanese, pieceChar } from './shogi/notation';
import { parseSfen } from './shogi/sfen';
import type { Color, HandType, Position } from './shogi/types';
import { BoardView, type Selection } from './ui/boardView';

/** 画面の状態。盤は常に同じ場所に表示し、下のパネルだけを切り替える */
type Phase =
  | { kind: 'loading'; message: string }
  | { kind: 'playing'; thinking: boolean; notice?: string }
  | { kind: 'success'; moves: number }
  | { kind: 'failure'; reason: FailureReason | 'giveup' }
  | { kind: 'answer'; line: 'model' | 'mine'; step: number; back: ResultPhase }
  | { kind: 'error'; message: string };
type ResultPhase = Extract<Phase, { kind: 'success' | 'failure' }>;

const FAILURE_TEXT: Record<FailureReason | 'giveup', string> = {
  'no-mate': '詰みを逃しました',
  'no-checks': '王手がかけられなくなりました',
  repetition: '連続王手の千日手（反則）です',
  'defender-win': '玉方の勝ちになりました',
  giveup: 'ギブアップ',
};

/** 玉方の応手を見せるための最小待ち時間 */
const MIN_REPLY_DELAY_MS = 350;

interface AppOptions {
  lengths: number[];
  showLength: boolean;
  variant: EvalVariant;
}

export class App {
  private engine: EngineClient | null = null;
  private problem: Problem | null = null;
  private session: Session | null = null;
  /** 最後に終わった挑戦の手順（解答再生の「自分の手順」） */
  private lastAttempt: string[] = [];
  /** この問題で解答を見たか（Phase 3 で履歴に記録する） */
  private viewedAnswer = false;
  private phase: Phase = { kind: 'loading', message: '準備中…' };
  private selection: Selection = null;
  private pendingPromotion: { promote: string; plain: string } | null = null;
  private confirmGiveup = false;

  private readonly board: BoardView;
  private readonly header: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly overlay: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: AppOptions,
  ) {
    this.root.innerHTML = `
      <header class="app-header">
        <h1 class="title">実戦詰将棋</h1>
        <div class="problem-info" aria-live="polite"></div>
      </header>
      <main class="app-main"></main>
      <section class="panel" aria-live="polite"></section>
      <div class="overlay" hidden></div>`;
    this.header = this.root.querySelector('.problem-info')!;
    this.panel = this.root.querySelector('.panel')!;
    this.overlay = this.root.querySelector('.overlay')!;
    this.board = new BoardView({
      onSquare: (i) => this.onSquare(i),
      onHand: (c, t) => this.onHand(c, t),
    });
    this.root.querySelector('.app-main')!.appendChild(this.board.el);
    this.panel.addEventListener('click', (e) => this.onAction(e));
    this.overlay.addEventListener('click', (e) => this.onAction(e));
  }

  async start(): Promise<void> {
    this.render();
    const enginePromise = EngineClient.create(this.options.variant);
    try {
      await this.loadProblem();
      this.phase = { kind: 'loading', message: '将棋エンジンを読み込み中…' };
      this.render();
      this.engine = await enginePromise;
      await this.beginAttempt();
    } catch (e) {
      this.fail(e);
    }
  }

  // ---- 進行 ----

  private async loadProblem(): Promise<void> {
    this.problem = await randomProblem(this.options.lengths);
    this.viewedAnswer = false;
    this.lastAttempt = [];
    this.session = null;
  }

  /** 問題の初期局面から挑戦を始める */
  private async beginAttempt(): Promise<void> {
    if (!this.problem || !this.engine) return;
    this.selection = null;
    this.session = new Session(this.problem, this.engine);
    this.phase = { kind: 'playing', thinking: true };
    this.render();
    const state = await this.session.start();
    this.afterState(state);
  }

  private async nextProblem(): Promise<void> {
    this.phase = { kind: 'loading', message: '問題を読み込み中…' };
    this.render();
    try {
      await this.loadProblem();
      await this.beginAttempt();
    } catch (e) {
      this.fail(e);
    }
  }

  private async play(move: string): Promise<void> {
    const session = this.session;
    if (!session || this.phase.kind !== 'playing') return;
    this.selection = null;
    this.phase = { kind: 'playing', thinking: true };
    const started = performance.now();
    // playAttacker は最初の await より前に攻方の手を局面に反映するので、すぐ描画できる
    const statePromise = session.playAttacker(move);
    this.render();
    try {
      const state = await statePromise;
      const wait = MIN_REPLY_DELAY_MS - (performance.now() - started);
      if (wait > 0 && state.kind === 'attacker-turn') await new Promise((r) => setTimeout(r, wait));
      this.afterState(state);
    } catch (e) {
      this.fail(e);
    }
  }

  private afterState(state: Session['state']): void {
    const session = this.session!;
    switch (state.kind) {
      case 'attacker-turn':
        this.phase = { kind: 'playing', thinking: false };
        break;
      case 'success':
        this.lastAttempt = session.moves.slice();
        this.phase = { kind: 'success', moves: state.moves };
        break;
      case 'failure':
        this.lastAttempt = session.moves.slice();
        this.phase = { kind: 'failure', reason: state.reason };
        break;
      case 'thinking':
        break;
    }
    this.render();
  }

  private fail(e: unknown): void {
    console.error(e);
    this.phase = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    this.render();
  }

  // ---- 入力 ----

  private get checks(): string[] {
    const st = this.session?.state;
    return this.phase.kind === 'playing' && !this.phase.thinking && st?.kind === 'attacker-turn' ? st.checks : [];
  }

  private targetsFor(sel: Selection): Set<number> {
    const targets = new Set<number>();
    if (!sel) return targets;
    for (const m of this.checks) {
      const mv = parseUsiMove(m);
      if (sel.kind === 'board' && mv.kind === 'move' && mv.from === sel.index) targets.add(mv.to);
      if (sel.kind === 'hand' && mv.kind === 'drop' && mv.type === sel.type) targets.add(mv.to);
    }
    return targets;
  }

  private onSquare(index: number): void {
    if (!this.session || this.checks.length === 0) return;
    const pos = this.session.position;
    const piece = pos.board[index];
    const attacker = this.session.problem.attacker;

    if (this.selection && this.targetsFor(this.selection).has(index)) {
      const candidates = this.checks.filter((m) => {
        const mv = parseUsiMove(m);
        if (mv.to !== index) return false;
        if (this.selection!.kind === 'board') return mv.kind === 'move' && mv.from === this.selection!.index;
        return mv.kind === 'drop' && mv.type === this.selection!.type;
      });
      const promote = candidates.find((m) => m.endsWith('+'));
      const plain = candidates.find((m) => !m.endsWith('+'));
      if (promote && plain) {
        this.pendingPromotion = { promote, plain };
        this.render();
      } else {
        void this.play((promote ?? plain)!);
      }
      return;
    }

    if (piece && piece.color === attacker) {
      const same = this.selection?.kind === 'board' && this.selection.index === index;
      this.selection = same ? null : { kind: 'board', index };
      this.setNotice(!same && this.targetsFor(this.selection).size === 0 ? 'その駒では王手できません' : undefined);
    } else {
      this.selection = null;
      this.setNotice(undefined);
    }
    this.render();
  }

  private onHand(color: Color, type: HandType): void {
    if (!this.session || color !== this.session.problem.attacker || this.checks.length === 0) return;
    const same = this.selection?.kind === 'hand' && this.selection.type === type;
    this.selection = same ? null : { kind: 'hand', type };
    this.setNotice(!same && this.targetsFor(this.selection).size === 0 ? 'その駒を打っても王手になりません' : undefined);
    this.render();
  }

  private setNotice(notice: string | undefined): void {
    if (this.phase.kind === 'playing') this.phase = { ...this.phase, notice };
  }

  private onAction(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action!;
    const phase = this.phase;
    switch (action) {
      case 'next':
        void this.nextProblem();
        return;
      case 'retry':
        void this.beginAttempt();
        return;
      case 'giveup':
        this.confirmGiveup = true;
        break;
      case 'giveup-cancel':
        this.confirmGiveup = false;
        break;
      case 'giveup-ok':
        this.confirmGiveup = false;
        if (this.session) this.lastAttempt = this.session.moves.slice();
        this.viewedAnswer = true;
        this.phase = { kind: 'answer', line: 'model', step: 0, back: { kind: 'failure', reason: 'giveup' } };
        break;
      case 'answer':
        if (phase.kind === 'success' || phase.kind === 'failure') {
          this.viewedAnswer = true;
          this.phase = { kind: 'answer', line: 'model', step: 0, back: phase };
        }
        break;
      case 'answer-close':
        if (phase.kind === 'answer') this.phase = phase.back;
        break;
      case 'line-model':
      case 'line-mine':
        if (phase.kind === 'answer') this.phase = { ...phase, line: action === 'line-model' ? 'model' : 'mine', step: 0 };
        break;
      case 'step-prev':
      case 'step-next':
      case 'step-first':
      case 'step-last':
      case 'step-to':
        if (phase.kind === 'answer') {
          const max = this.answerLine(phase.line).length;
          const step =
            action === 'step-prev' ? phase.step - 1
            : action === 'step-next' ? phase.step + 1
            : action === 'step-first' ? 0
            : action === 'step-last' ? max
            : Number(btn.dataset.step);
          this.phase = { ...phase, step: Math.max(0, Math.min(max, step)) };
        }
        break;
      case 'promote-yes':
      case 'promote-no':
        if (this.pendingPromotion) {
          const move = action === 'promote-yes' ? this.pendingPromotion.promote : this.pendingPromotion.plain;
          this.pendingPromotion = null;
          void this.play(move);
          return;
        }
        break;
      case 'promote-cancel':
        this.pendingPromotion = null;
        break;
    }
    this.render();
  }

  private answerLine(line: 'model' | 'mine'): string[] {
    return line === 'model' ? (this.problem?.solution ?? []) : this.lastAttempt;
  }

  // ---- 描画 ----

  private render(): void {
    this.renderHeader();
    this.renderBoard();
    this.renderPanel();
    this.renderOverlay();
  }

  private renderHeader(): void {
    const p = this.problem;
    if (!p) {
      this.header.textContent = '';
      return;
    }
    const [, vol, line] = p.id.split('/');
    const revealed = this.options.showLength || !['loading', 'playing'].includes(this.phase.kind);
    const side = p.attacker === 'b' ? '先手' : '後手';
    this.header.innerHTML = `<span class="pid">問題 ${vol}-${line}</span>
      <span class="badge">${revealed ? `${p.length}手詰` : '？手詰'}</span>
      <span class="side">攻方：${side}</span>`;
  }

  private renderBoard(): void {
    const p = this.problem;
    if (!p) return;
    let position: Position;
    let lastTo: number | null = null;
    const phase = this.phase;
    if (phase.kind === 'answer') {
      const line = this.answerLine(phase.line);
      position = applyMoves(parseSfen(p.sfen), line.slice(0, phase.step));
      if (phase.step > 0) lastTo = parseUsiMove(line[phase.step - 1]).to;
    } else if (this.session) {
      position = this.session.position;
      const moves = this.session.moves;
      if (moves.length) lastTo = parseUsiMove(moves[moves.length - 1]).to;
    } else {
      position = parseSfen(p.sfen);
    }
    const interactive = this.checks.length > 0 && !this.pendingPromotion && !this.confirmGiveup;
    this.board.render({
      position,
      bottom: p.attacker,
      selection: this.selection,
      targets: this.targetsFor(this.selection),
      lastTo,
      interactive,
    });
  }

  private renderPanel(): void {
    const phase = this.phase;
    const p = this.problem;
    const btn = (action: string, label: string, cls = 'secondary', disabled = false) =>
      `<button type="button" class="btn ${cls}" data-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
    let html = '';
    switch (phase.kind) {
      case 'loading':
        html = `<p class="status"><span class="spinner"></span>${phase.message}</p>`;
        break;
      case 'error':
        html = `<p class="status error">エラー：${escapeHtml(phase.message)}</p>
          <div class="actions">${btn('next', '次の問題', 'primary')}</div>`;
        break;
      case 'playing': {
        const moved = (this.session?.moves.length ?? 0) > 0;
        const status = phase.thinking
          ? '<span class="spinner"></span>玉方が考えています…'
          : `あなたの手番です。王手をかけてください${this.options.showLength && p ? `（${p.length}手詰）` : ''}`;
        html = `<p class="status">${status}</p>
          <p class="notice">${phase.notice ?? ''}</p>
          <div class="actions">
            ${btn('retry', 'やり直す', 'secondary', phase.thinking || !moved)}
            ${btn('giveup', '解答を見る', 'ghost', phase.thinking)}
          </div>`;
        break;
      }
      case 'success': {
        const shortest = p ? phase.moves <= p.length : true;
        const after = this.viewedAnswer ? '<span class="tag">解答閲覧後</span>' : '';
        html = `<p class="result success">✓ ${phase.moves}手で詰ませました！${after}</p>
          <p class="sub">${shortest ? '最短手数での正解です。' : `この問題は最短${p?.length}手で詰みます。`}</p>
          <div class="actions">${btn('next', '次の問題 →', 'primary')}</div>
          <div class="actions">
            ${btn('answer', shortest ? '解答を見る' : `${p?.length}手の解答を見る`)}
            ${btn('retry', 'もう一度')}
          </div>`;
        break;
      }
      case 'failure': {
        const played = this.lastAttempt.length;
        html = `<p class="result failure">✗ ${FAILURE_TEXT[phase.reason]}</p>
          <p class="sub">最短${p?.length}手で詰みます。${played ? `あなたは${played}手指しました。` : ''}もう一度挑戦できます。</p>
          <div class="actions">${btn('retry', '再挑戦', 'primary')}</div>
          <div class="actions">${btn('answer', '解答を見る')}${btn('next', '次の問題')}</div>`;
        break;
      }
      case 'answer': {
        const line = this.answerLine(phase.line);
        const label = phase.line === 'model' ? `最短${p?.length}手の解答例` : 'あなたの手順';
        const start = p ? parseSfen(p.sfen) : null;
        const items = start
          ? line
              .map((m, i) => {
                const before = applyMoves(start, line.slice(0, i));
                const prevTo = i > 0 ? parseUsiMove(line[i - 1]).to : undefined;
                const cur = i + 1 === phase.step ? ' current' : '';
                return `<button type="button" class="move${cur}" data-action="step-to" data-step="${i + 1}">${i + 1}. ${moveToJapanese(before, m, prevTo)}</button>`;
              })
              .join('')
          : '';
        html = `<div class="answer-head">
            <strong>${label}</strong><span class="step">${phase.step}/${line.length}手</span>
          </div>
          <div class="segmented" role="tablist">
            <button type="button" role="tab" class="${phase.line === 'model' ? 'on' : ''}" data-action="line-model">最短解</button>
            <button type="button" role="tab" class="${phase.line === 'mine' ? 'on' : ''}" data-action="line-mine"${this.lastAttempt.length ? '' : ' disabled'}>自分の手順</button>
          </div>
          <div class="moves">${items}</div>
          <div class="actions stepper">
            ${btn('step-first', '⏮', 'secondary', phase.step === 0)}
            ${btn('step-prev', '◀ 前の手', 'secondary', phase.step === 0)}
            ${btn('step-next', '次の手 ▶', 'secondary', phase.step === line.length)}
            ${btn('step-last', '⏭', 'secondary', phase.step === line.length)}
          </div>
          <div class="actions">${btn('answer-close', '解答再生を閉じる', 'primary')}</div>`;
        break;
      }
    }
    this.panel.innerHTML = html;
    this.panel.dataset.phase = phase.kind;
  }

  private renderOverlay(): void {
    if (this.pendingPromotion && this.session) {
      const mv = parseUsiMove(this.pendingPromotion.plain);
      const piece = mv.kind === 'move' ? this.session.position.board[mv.from] : null;
      const plainChar = piece ? pieceChar(piece) : '';
      const promChar = piece ? pieceChar({ ...piece, promoted: true }) : '';
      this.overlay.innerHTML = `<div class="dialog" role="dialog" aria-label="成りますか">
          <p>成りますか？</p>
          <div class="promote-choices">
            <button type="button" class="btn primary big" data-action="promote-yes"><span class="pc">${promChar}</span>成る</button>
            <button type="button" class="btn secondary big" data-action="promote-no"><span class="pc">${plainChar}</span>成らない</button>
          </div>
          <button type="button" class="btn ghost" data-action="promote-cancel">キャンセル</button>
        </div>`;
      this.overlay.hidden = false;
    } else if (this.confirmGiveup) {
      this.overlay.innerHTML = `<div class="dialog" role="dialog" aria-label="解答を表示しますか">
          <p><strong>解答を表示しますか？</strong></p>
          <p class="sub">この挑戦はギブアップとして記録されます。</p>
          <div class="actions">
            <button type="button" class="btn secondary" data-action="giveup-cancel">キャンセル</button>
            <button type="button" class="btn primary" data-action="giveup-ok">解答を見る</button>
          </div>
        </div>`;
      this.overlay.hidden = false;
    } else {
      this.overlay.hidden = true;
      this.overlay.innerHTML = '';
    }
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
