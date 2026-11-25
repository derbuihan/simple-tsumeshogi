import { EngineClient } from './engine/EngineClient';
import { MateClient } from './engine/MateClient';
import { finishOf } from './game/finish';
import type { Problem } from './game/problem';
import { successFeats, type Feat } from './game/feats';
import { Session, type FailureReason } from './game/session';
import { problemStatus, type Outcome } from './history/record';
import type { HistoryStore } from './history/store';
import { loadIndex, loadProblem, PROBLEM_LENGTHS } from './problems/loader';
import { selectProblem } from './problems/selector';
import { clearUpcoming, fitsLengths, readUpcoming, saveUpcoming, type Upcoming } from './problems/upcoming';
import { loadCursor, ORDER_LABELS, saveCursor, saveSettings, type QuestionOrder, type Settings } from './settings';
import { applyMove, applyMoves, mustPromote, parseUsiMove, usiSquare } from './shogi/move';
import { canPromoteType, inPromotionZone, pieceChar } from './shogi/notation';
import { parseSfen } from './shogi/sfen';
import type { Color, HandType, Position } from './shogi/types';
import { BoardView, type Selection } from './ui/boardView';
import { streakAfterSuccess } from './ui/ghost/rules';
import { Sound } from './ui/sound';

/** 挑戦の結果 */
type Result =
  /** feats: 結果のカードで伝える達成 */
  | { kind: 'success'; moves: number; feats: Feat[] }
  /** missedAt: 詰みを逃した攻方の手（1始まり） */
  | { kind: 'failure'; reason: FailureReason | 'giveup'; missedAt?: number };

/** 結果が出た後の振り返り。盤の左右をタップして手順を1手ずつ戻る・進む */
interface Review {
  line: 'model' | 'mine';
  step: number;
}

/** 画面の状態。盤は常に同じ場所に表示し、下のパネルだけを切り替える */
type Phase =
  | { kind: 'loading'; message: string }
  | { kind: 'playing'; thinking: boolean; notice?: string }
  /** dialog: 結果のカード（pending: 盤の最後の手を見せてから出す / open / closed: 閉じて振り返り中） */
  | { kind: 'result'; result: Result; review: Review; dialog: 'pending' | 'open' | 'closed' }
  | { kind: 'error'; message: string };

const FAILURE_TEXT: Record<FailureReason | 'giveup', string> = {
  'no-mate': '詰みを逃しました',
  'no-checks': '王手がかけられなくなりました',
  repetition: '連続王手の千日手（反則）です',
  'defender-win': '玉方の勝ちになりました',
  giveup: 'ギブアップ',
};

/** 不正解のとき、結果のカードを出すまでの時間（最後の局面を見せてから出す）。正解のときは詰みの演出が終わってから出す */
const FAILURE_DIALOG_DELAY_MS = 300;
/** 不正解のとき、玉方が最後に応じた手を見せてから、不正解の表示（しょんぼり・結果）に移るまでの間 */
const FAILURE_AFTER_REPLY_MS = 600;
/** カードが出てすぐのタップ（盤を連打していた指）で、外側タップとして閉じないようにする */
const DIALOG_TAP_GUARD_MS = 300;

/** 起動時に履歴の同期を待つ上限。次の問題はこれを待ってから選ぶ（最初の問題は待たない） */
const SYNC_WAIT_MS = 3000;

/** 玉方の応手を見せるまでの最小待ち時間（攻方の手のアニメーションが終わるのを待つ） */
const MIN_REPLY_DELAY_MS = 320;

const STATUS_LABEL = { untried: '初挑戦', unsolved: '未正解', solved: '正解済み' } as const;
const SYNC_LABEL = { synced: '履歴は同期済み', pending: '履歴を同期中', offline: '履歴はこの端末に保存中（未同期）' } as const;

export class App {
  private engine: EngineClient | null = null;
  /** 詰み専用エンジン（正誤の判定）。読み込めなければ null のまま、mini だけで判定する */
  private mateSolver: MateClient | null = null;
  /** エンジン2つの読み込み。起動してすぐ裏で始め、1手目を指すまでは待たない。失敗したら次の挑戦で読み込み直す */
  private engines: Promise<[EngineClient, MateClient | null]> | null = null;
  /** エンジンの準備が済む前に指した1手目。準備が済んだら王手か確かめてから指す */
  private queued: { move: string; at: number } | null = null;
  /** 挑戦を始めるたびに増やす（古い挑戦の準備の続きを捨てるため） */
  private attemptSeq = 0;
  /** 次に出す問題（裏で選んで取得する） */
  private upcoming: Promise<Upcoming | null> | null = null;
  /** 次の問題を選び直すたびに増やす（古い取得の結果を保存しないため） */
  private upcomingGen = 0;
  /** 起動時の履歴の同期 */
  private synced: Promise<unknown> = Promise.resolve();
  private problem: Problem | null = null;
  private session: Session | null = null;
  /** 最後に終わった挑戦の手順（解答再生の「自分の手順」） */
  private lastAttempt: string[] = [];
  /** この問題で解答を見たか（以後のクリアは「解答閲覧後のクリア」として記録する） */
  private viewedAnswer = false;
  /** 出題時点での履歴上の状態 */
  /** 出題方法についてのお知らせ（希望の順序で選べなかったときなど） */
  private problemNotice: string | undefined;
  private settingsOpen = false;
  private phase: Phase = { kind: 'loading', message: '問題を読み込み中…' };
  private selection: Selection = null;
  private pendingPromotion: { promote: string; plain: string } | null = null;
  private confirmGiveup = false;
  /** 結果を出すたびに増やす（古い結果のカードを出さないため） */
  private resultSeq = 0;
  private dialogOpenedAt = 0;
  /** 今出しているダイアログの HTML（同じなら置き直さず、出てくるアニメーションを繰り返さない） */
  private overlayHtml = '';
  /** 今出しているダイアログ（aria-label）。開いた・閉じたの判定に使う */
  private dialogLabel: string | null = null;
  /** ダイアログを閉じたらフォーカスを戻す要素 */
  private focusReturn: HTMLElement | null = null;
  /** 連チャン（盤の裏の幽霊が育つ）。アプリを開いている間だけ数え、保存しない */
  private streak = 0;
  /** この起動中に自力で解いた問題（再挑戦で同じ問題を解いても、連チャンは伸ばさない） */
  private readonly solvedThisSession = new Set<string>();

  private readonly board: BoardView;
  private readonly sound: Sound;
  private readonly header: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly overlay: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private settings: Settings,
    private readonly history: HistoryStore,
  ) {
    this.root.innerHTML = `
      <header class="app-header">
        <div class="problem-info" aria-live="polite"></div>
        <span class="sync" role="status"></span>
        <button type="button" class="icon-btn" data-action="settings" aria-label="出題設定">⚙</button>
      </header>
      <main class="app-main"></main>
      <section class="panel" aria-live="polite"></section>
      <div class="overlay" hidden></div>`;
    this.header = this.root.querySelector('.problem-info')!;
    this.panel = this.root.querySelector('.panel')!;
    this.overlay = this.root.querySelector('.overlay')!;
    this.sound = new Sound(settings.sound);
    this.board = new BoardView({
      onSquare: (i) => this.onSquare(i),
      onHand: (c, t) => this.onHand(c, t),
      onReplay: (dir) => this.stepReview(dir),
      onLand: (s) => this.sound.land(s),
      ghostSounds: this.sound,
    });
    this.board.setGhost(settings.ghost);
    this.root.querySelector('.app-main')!.appendChild(this.board.el);
    // 詰みの演出中に盤をタップしたら、演出の終わりを待たずに結果のカードを出す
    this.board.el.addEventListener('pointerdown', () => {
      if (this.phase.kind === 'result' && this.phase.dialog === 'pending') this.openResultDialog(this.resultSeq);
    });
    this.panel.addEventListener('click', (e) => this.onAction(e));
    this.overlay.addEventListener('click', (e) => {
      // 結果のカードの外側をタップしたら閉じて振り返りにする
      if (e.target === this.overlay && this.phase.kind === 'result' && this.phase.dialog === 'open') {
        if (performance.now() - this.dialogOpenedAt < DIALOG_TAP_GUARD_MS) return;
        this.phase = { ...this.phase, dialog: 'closed' };
        this.render();
        return;
      }
      this.onAction(e);
    });
    this.root.querySelector('.app-header')!.addEventListener('click', (e) => this.onAction(e));
    this.history.onChange = () => this.renderHeader();
    // 盤に使える高さ＝画面の高さからヘッダーとパネルを除いた分。文字の大きさや画面の向きが変われば測り直す
    const header = this.root.querySelector<HTMLElement>('.app-header')!;
    const fitBoard = () => {
      const cs = getComputedStyle(this.root);
      const h =
        this.root.clientHeight -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom) -
        parseFloat(cs.rowGap) * 2 -
        header.offsetHeight -
        this.panel.offsetHeight;
      this.root.style.setProperty('--board-h', `${Math.max(0, h)}px`);
    };
    const observer = new ResizeObserver(fitBoard);
    for (const el of [this.root, header, this.panel]) observer.observe(el);
    // Escape で一番上のダイアログを閉じる。PC では左右キーでも振り返りを操作できる
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.closeTopDialog()) {
        e.preventDefault();
        return;
      }
      if (this.overlay.hidden === false) return;
      if (e.key === 'ArrowRight') this.stepReview(1);
      else if (e.key === 'ArrowLeft') this.stepReview(-1);
    });
  }

  /**
   * 起動する。前回保存した次の問題があれば、通信もエンジンも待たずにすぐ盤に出す。
   * 履歴の同期とエンジンの読み込みは裏で進める。返す Promise はエンジンの読み込みまで済んだら解決する
   */
  async start(): Promise<void> {
    this.synced = Promise.race([this.history.sync(), new Promise((r) => setTimeout(r, SYNC_WAIT_MS))]);
    const engines = this.loadEngines();
    const stored = readUpcoming(this.settings.lengths);
    if (stored) {
      this.show(stored);
    } else {
      this.render();
      try {
        // 履歴の同期は待たず、端末内の履歴で選ぶ
        this.show(await this.pickProblem());
      } catch (e) {
        this.fail(e);
        return;
      }
    }
    void this.beginAttempt();
    this.prefetchNext();
    await engines.catch(() => undefined);
  }

  // ---- 進行 ----

  private loadEngines(): Promise<[EngineClient, MateClient | null]> {
    if (!this.engines) {
      const mate = MateClient.create().catch((e) => {
        console.error('詰み専用エンジンを読み込めませんでした。mini だけで判定します', e);
        return null;
      });
      const p = Promise.all([EngineClient.create(this.settings.variant), mate]);
      this.engines = p;
      p.catch(() => {
        if (this.engines === p) this.engines = null;
      });
    }
    return this.engines;
  }

  /** 設定と履歴から問題を選んで取得する */
  private async pickProblem(): Promise<Upcoming> {
    const index = await loadIndex();
    const result = selectProblem({
      index,
      lengths: this.settings.lengths,
      order: this.settings.order,
      records: this.history.records,
      cursor: loadCursor(),
      excludeId: this.problem?.id,
    });
    saveCursor(result.cursor);
    return { problem: await loadProblem(result.id), notice: result.fallback };
  }

  /** 次に出す問題を裏で選んで取得し、次の起動のために保存しておく。失敗しても、出すときに取得し直す */
  private prefetchNext(): void {
    const gen = ++this.upcomingGen;
    this.upcoming = (async () => {
      await this.synced;
      const u = await this.pickProblem();
      if (gen === this.upcomingGen) saveUpcoming(u);
      return u;
    })().catch((e) => {
      console.warn('次の問題を取得できませんでした', e);
      return null;
    });
  }

  private show({ problem, notice }: Upcoming): void {
    this.problem = problem;
    this.problemNotice = notice;
    this.viewedAnswer = false;
    this.lastAttempt = [];
    this.session = null;
  }

  /**
   * 問題の初期局面から挑戦を始める。盤はすぐ操作できるようにし、エンジンの準備は裏で待つ。
   * 準備が済む前に指した1手目は、準備が済んでから王手か確かめて指す
   */
  private async beginAttempt(): Promise<void> {
    const problem = this.problem;
    if (!problem) return;
    const seq = ++this.attemptSeq;
    this.selection = null;
    this.queued = null;
    this.session = null;
    this.phase = { kind: 'playing', thinking: false };
    this.render();
    try {
      const [engine, mateSolver] = this.engine ? [this.engine, this.mateSolver] : await this.loadEngines();
      this.engine = engine;
      this.mateSolver = mateSolver;
      if (seq !== this.attemptSeq) return;
      const session = new Session(problem, engine, { mateSolver: mateSolver ?? undefined });
      const state = await session.start();
      if (seq !== this.attemptSeq) return;
      this.session = session;
      // 待っている間に指した1手目（TS は await をまたいでも上の null 代入のままと見なすので型を戻す）
      const queued = this.queued as App['queued'];
      this.queued = null;
      if (queued && state.kind === 'attacker-turn') {
        if (state.checks.includes(queued.move)) {
          void this.play(queued.move, queued.at);
        } else {
          this.phase = { kind: 'playing', thinking: false, notice: 'その手では王手になりません' };
          this.render();
        }
        return;
      }
      this.afterState(state);
    } catch (e) {
      if (seq === this.attemptSeq) this.fail(e);
    }
  }

  private async nextProblem(): Promise<void> {
    this.attemptSeq++;
    this.phase = { kind: 'loading', message: '問題を読み込み中…' };
    this.render();
    try {
      const pending = this.upcoming;
      this.upcoming = null;
      let next = pending ? await pending : null;
      if (!next || next.problem.id === this.problem?.id || !fitsLengths(next, this.settings.lengths)) next = await this.pickProblem();
      this.show(next);
      void this.beginAttempt();
      this.prefetchNext();
    } catch (e) {
      this.fail(e);
    }
  }

  /** 攻方の手を指す。エンジンの準備が済む前なら保留する */
  private submit(move: string): void {
    if (this.preparing) return this.queueFirst(move);
    // 準備中に選んだ手（成・不成の確認中に準備が済んだ）は、王手か確かめてから指す
    if (!this.checks.includes(move)) {
      this.setNotice('その手では王手になりません');
      this.render();
      return;
    }
    void this.play(move);
  }

  /** @param started 指した時刻（保留した1手目なら、保留した時刻。エンジンを待った時間も玉方の考慮時間に含める） */
  private async play(move: string, started = performance.now()): Promise<void> {
    const session = this.session;
    if (!session || this.phase.kind !== 'playing') return;
    this.selection = null;
    this.phase = { kind: 'playing', thinking: true };
    // 応手（または不正解）を見せるまでの時間を、玉方の探索時間にそろえる。
    // 詰みがあるとエンジンはすぐ返すので、そろえないと待ち時間で正誤が分かってしまう
    const delay = Math.max(MIN_REPLY_DELAY_MS, session.nextMovetimeMs);
    // playAttacker は最初の await より前に攻方の手を局面に反映するので、すぐ描画できる
    const statePromise = session.playAttacker(move);
    this.render();
    try {
      const state = await statePromise;
      const wait = delay - (performance.now() - started);
      if (wait > 0 && state.kind !== 'success') await new Promise((r) => setTimeout(r, wait));
      if (this.session !== session) return;
      // 不正解でも玉方は先に応じている。その手を盤に見せて、少し間を置いてから結果を出す
      if (state.kind === 'failure' && session.moves.length % 2 === 0) {
        this.render();
        await new Promise((r) => setTimeout(r, FAILURE_AFTER_REPLY_MS));
        if (this.session !== session) return;
      }
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
      case 'success': {
        this.lastAttempt = session.moves.slice();
        const { id, length } = session.problem;
        const before = this.history.records[id];
        const snapshot = before && { ...before };
        const outcome: Outcome = this.viewedAnswer ? 'clear-after-viewing' : state.moves <= length ? 'shortest' : 'clear';
        this.history.record(id, outcome, state.moves);
        const feats = successFeats({
          problemId: id,
          length,
          moves: state.moves,
          viewedAnswer: this.viewedAnswer,
          before: snapshot,
          records: this.history.records,
        });
        this.showResult({ kind: 'success', moves: state.moves, feats });
        break;
      }
      case 'failure':
        this.lastAttempt = session.moves.slice();
        this.showResult({ kind: 'failure', reason: state.reason, missedAt: state.missedAt });
        this.history.record(session.problem.id, 'fail');
        break;
      case 'thinking':
        break;
    }
    this.render();
  }

  /**
   * 結果を出す。盤は自分の手順の最後の局面のまま、正解なら詰みの演出（止め→玉が沈む→「詰」の印）を見せてから、
   * 不正解なら少し間を置いてから結果のカードを出す
   */
  private showResult(result: Result): void {
    const seq = ++this.resultSeq;
    this.phase = { kind: 'result', result, review: { line: 'mine', step: this.lastAttempt.length }, dialog: 'pending' };
    if (result.kind === 'success') {
      const rare = result.feats.some((f) => f.rare);
      const problem = this.problem!;
      const moves = this.lastAttempt;
      // 連チャン：自力で、この起動中に初めて解いた問題だけ数える
      const before = this.streak;
      this.streak = streakAfterSuccess(before, this.viewedAnswer, this.solvedThisSession.has(problem.id));
      if (!this.viewedAnswer) this.solvedThisSession.add(problem.id);
      const ghost = { before, after: this.streak, finish: finishOf(parseSfen(problem.sfen), moves), length: moves.length };
      // 玉が沈む瞬間に、玉から魂が抜けて幽霊が食べる。カードは詰みの演出の後に出し、食べる演出はその間も続く
      void this.board
        .mate(rare, () => {
          // 連チャンで響きが上がるのは、幽霊が育つのが見えているときだけ
          this.sound.mate(rare, this.board.ghost ? ghost.after : 0);
          this.board.ghost?.mate(ghost);
        })
        .then(() => this.openResultDialog(seq));
    } else {
      this.loseStreak();
      setTimeout(() => this.openResultDialog(seq), FAILURE_DIALOG_DELAY_MS);
    }
    this.board.ghost?.sleepLater();
  }

  /** 不正解・ギブアップ：連チャンが切れ、幽霊はしょんぼりして駒台へ帰る */
  private loseStreak(): void {
    this.streak = 0;
    // 幽霊の演出で魂が抜けていく音が鳴らないとき（出さない設定・連チャン0で駒台にいる・動きを減らす設定）は、
    // 代わりに短い下降音を鳴らす。不正解が音で伝わらないことがないようにする
    const ghostSounds = this.board.ghost?.fail() ?? false;
    if (!ghostSounds) this.sound.miss();
  }

  private openResultDialog(seq: number): void {
    const phase = this.phase;
    if (seq !== this.resultSeq || phase.kind !== 'result' || phase.dialog !== 'pending') return;
    this.phase = { ...phase, dialog: 'open' };
    this.dialogOpenedAt = performance.now();
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

  /** エンジンの準備中で、1手目をまだ指していない */
  private get preparing(): boolean {
    return this.phase.kind === 'playing' && !this.phase.thinking && !this.session && !this.queued && !!this.problem;
  }

  /** 準備中の1手目を保留する。盤には指した手を出し、玉方が考えている表示にする */
  private queueFirst(move: string): void {
    this.queued = { move, at: performance.now() };
    this.selection = null;
    this.phase = { kind: 'playing', thinking: true };
    this.render();
  }

  /**
   * エンジンの準備中の盤のタップ。王手かどうかはまだ分からないので、自分の駒を選んで
   * 自分の駒がないマスをタップしたら、その手を保留する（王手でなければ準備が済んでから戻す）
   */
  private onSquareEarly(index: number): void {
    const p = this.problem!;
    const pos = parseSfen(p.sfen);
    const piece = pos.board[index];
    const sel = this.selection;
    if (piece?.color === p.attacker) {
      const same = sel?.kind === 'board' && sel.index === index;
      this.selection = same ? null : { kind: 'board', index };
    } else if (sel?.kind === 'board') {
      const mover = pos.board[sel.index]!;
      const plain = `${usiSquare(sel.index)}${usiSquare(index)}`;
      if (canPromoteType(mover.type) && !mover.promoted && inPromotionZone(p.attacker, sel.index, index)) {
        if (mustPromote(mover.type, p.attacker, index)) return this.queueFirst(`${plain}+`);
        this.pendingPromotion = { promote: `${plain}+`, plain };
      } else {
        return this.queueFirst(plain);
      }
    } else if (sel?.kind === 'hand' && !piece) {
      return this.queueFirst(`${sel.type}*${usiSquare(index)}`);
    } else {
      this.selection = null;
    }
    this.setNotice(undefined);
    this.render();
  }

  private onSquare(index: number): void {
    if (this.preparing) return this.onSquareEarly(index);
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
        this.submit((promote ?? plain)!);
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
    if (this.preparing) {
      if (color !== this.problem!.attacker) return;
      const same = this.selection?.kind === 'hand' && this.selection.type === type;
      this.selection = same ? null : { kind: 'hand', type };
      this.setNotice(undefined);
      this.render();
      return;
    }
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
        // エンジンの準備中なら、準備の続きで挑戦を始めないようにする
        this.attemptSeq++;
        this.queued = null;
        this.lastAttempt = this.session?.moves.slice() ?? [];
        if (this.problem) this.history.record(this.problem.id, 'giveup');
        this.viewedAnswer = true;
        this.loseStreak();
        this.board.ghost?.sleepLater();
        // 自分で解答を見ると決めたので、結果のカードは出さずにすぐ解答の振り返りにする
        this.resultSeq++;
        this.phase = {
          kind: 'result',
          result: { kind: 'failure', reason: 'giveup' },
          review: { line: 'model', step: 0 },
          dialog: 'closed',
        };
        break;
      case 'line-model':
        if (phase.kind === 'result') {
          // 解答を見たので、この問題の以後のクリアは「解答閲覧後」として記録する
          this.viewedAnswer = true;
          this.phase = { ...phase, review: { line: 'model', step: 0 }, dialog: 'closed' };
        }
        break;
      case 'review':
        // 正解の振り返りは自分の手順を初手から見直す（結果のカードが出ている間は詰みの局面のまま）
        if (phase.kind === 'result') this.phase = { ...phase, review: { line: 'mine', step: this.mineStartStep(phase.result) }, dialog: 'closed' };
        break;
      case 'line-mine':
        if (phase.kind === 'result') this.phase = { ...phase, review: { line: 'mine', step: this.mineStartStep(phase.result) } };
        break;
      case 'promote-yes':
      case 'promote-no':
        if (this.pendingPromotion) {
          const move = action === 'promote-yes' ? this.pendingPromotion.promote : this.pendingPromotion.plain;
          this.pendingPromotion = null;
          this.submit(move);
          return;
        }
        break;
      case 'promote-cancel':
        this.pendingPromotion = null;
        break;
      case 'settings':
        this.settingsOpen = true;
        break;
      case 'settings-cancel':
        this.settingsOpen = false;
        break;
      case 'settings-save':
        this.saveSettingsForm();
        return;
    }
    this.render();
  }

  /** 出ているダイアログをキャンセルと同じ扱いで閉じる。閉じるものが無ければ false */
  private closeTopDialog(): boolean {
    const phase = this.phase;
    if (this.pendingPromotion) this.pendingPromotion = null;
    else if (this.confirmGiveup) this.confirmGiveup = false;
    else if (this.settingsOpen) this.settingsOpen = false;
    else if (phase.kind === 'result' && phase.dialog === 'open') this.phase = { ...phase, dialog: 'closed' };
    else return false;
    this.render();
    return true;
  }

  /** 振り返りで、詰みを逃した手を表示しているか */
  private isMissedStep(): boolean {
    const phase = this.phase;
    if (phase.kind !== 'result' || phase.result.kind !== 'failure') return false;
    return phase.review.line === 'mine' && phase.review.step === phase.result.missedAt;
  }

  /** 振り返りで1手戻る（-1）・進む（+1） */
  private stepReview(dir: -1 | 1): void {
    const phase = this.phase;
    if (phase.kind !== 'result' || phase.dialog !== 'closed') return;
    const max = this.answerLine(phase.review.line).length;
    const step = Math.max(0, Math.min(max, phase.review.step + dir));
    if (step === phase.review.step) return;
    this.phase = { ...phase, review: { ...phase.review, step } };
    this.render();
  }

  /** 振り返りで自分の手順を開いたときの手数。正解なら初手から、不正解なら最後の局面から */
  private mineStartStep(result: Result): number {
    return result.kind === 'success' ? 0 : this.lastAttempt.length;
  }

  private answerLine(line: 'model' | 'mine'): string[] {
    return line === 'model' ? (this.problem?.solution ?? []) : this.lastAttempt;
  }

  // ---- 描画 ----

  private render(): void {
    // パネルなどを描き直すと押したボタンが消えるので、描き直す前のフォーカスを覚えておく
    const focused = document.activeElement;
    this.renderHeader();
    this.renderBoard();
    this.renderPanel();
    this.renderOverlay(focused);
  }

  private renderHeader(): void {
    const p = this.problem;
    if (!p) {
      this.header.textContent = '';
      return;
    }
    const [, vol, line] = p.id.split('/');
    const revealed = this.settings.showLength || !['loading', 'playing'].includes(this.phase.kind);
    const side = p.attacker === 'b' ? '先手' : '後手';
    // 履歴から毎回求めるので、解いた直後や他の端末との同期の後にも印が変わる
    const tag = problemStatus(this.history.records[p.id]);
    this.header.innerHTML = `<span class="badge">${revealed ? `${p.length}手詰` : '？手詰'}</span>
      <span class="pid">問題 ${vol}-${line}</span>
      <span class="side">攻方 ${side}</span>
      <span class="tag status-${tag}">${STATUS_LABEL[tag]}</span>`;
    const sync = this.root.querySelector<HTMLElement>('.sync')!;
    sync.dataset.state = this.history.syncState;
    sync.title = SYNC_LABEL[this.history.syncState];
    sync.setAttribute('aria-label', SYNC_LABEL[this.history.syncState]);
  }

  private renderBoard(): void {
    const p = this.problem;
    if (!p) return;
    let position: Position;
    let lastMove: string | null = null;
    const phase = this.phase;
    if (phase.kind === 'result') {
      const { line: which, step } = phase.review;
      const line = this.answerLine(which);
      position = applyMoves(parseSfen(p.sfen), line.slice(0, step));
      if (step > 0) lastMove = line[step - 1];
    } else if (this.session) {
      position = this.session.position;
      lastMove = this.session.moves.at(-1) ?? null;
    } else {
      position = parseSfen(p.sfen);
      if (this.queued) {
        position = applyMove(position, this.queued.move);
        lastMove = this.queued.move;
      }
    }
    const interactive = (this.checks.length > 0 || this.preparing) && !this.pendingPromotion && !this.confirmGiveup && !this.settingsOpen;
    this.board.render({
      position,
      bottom: p.attacker,
      selection: this.selection,
      targets: this.targetsFor(this.selection),
      lastMove,
      interactive,
      replay: phase.kind === 'result' && phase.dialog === 'closed' && !this.settingsOpen,
      missed: this.isMissedStep(),
    });
  }

  /**
   * 下のパネル。高さは固定で、ボタンはどの状態でも一番下の同じ位置に置く
   * （左：やり直す・再挑戦、右：解答を見る・次の問題）。
   */
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
        // お知らせ（その駒では王手できない、など）があれば手番の案内の代わりに出す
        const notice = phase.notice ?? (moved ? undefined : this.problemNotice);
        const status = phase.thinking
          ? '<span class="spinner"></span>玉方が考えています…'
          : notice
            ? `<span class="notice">${escapeHtml(notice)}</span>`
            : `あなたの手番です。王手をかけてください${this.settings.showLength && p ? `（${p.length}手詰）` : ''}`;
        html = `<p class="status">${status}</p>
          <div class="actions">
            ${btn('retry', 'やり直す', 'secondary', phase.thinking || !moved)}
            ${btn('giveup', '解答を見る', 'secondary', phase.thinking)}
          </div>`;
        break;
      }
      case 'result': {
        const { result, review } = phase;
        const success = result.kind === 'success';
        const line = this.answerLine(review.line);
        const missed = this.isMissedStep();
        html = `<div class="review-bar">
            <span class="mark ${success ? 'success' : 'failure'}" aria-label="${success ? '正解' : '不正解'}">${success ? '✓' : '✗'}</span>
            <div class="segmented" role="tablist" aria-label="振り返る手順">
              <button type="button" role="tab" aria-selected="${review.line === 'mine'}" class="${review.line === 'mine' ? 'on' : ''}" data-action="line-mine"${this.lastAttempt.length ? '' : ' disabled'}>あなたの手順</button>
              <button type="button" role="tab" aria-selected="${review.line === 'model'}" class="${review.line === 'model' ? 'on' : ''}" data-action="line-model">解答（${p?.length}手）</button>
            </div>
            <span class="step${missed ? ' missed' : ''}"${missed ? ' title="この手で詰みを逃しました"' : ''}>${missed ? '▲' : ''}${review.step}/${line.length}手</span>
          </div>
          <div class="actions">
            ${btn('retry', '再挑戦', success ? 'secondary' : 'primary')}
            ${btn('next', '次の問題 →', success ? 'primary' : 'secondary')}
          </div>`;
        break;
      }
    }
    this.panel.innerHTML = html;
    this.panel.dataset.phase = phase.kind;
  }

  private renderOverlay(focused: Element | null): void {
    this.drawOverlay();
    this.syncDialogFocus(focused);
  }

  /**
   * ダイアログを開いたらダイアログへフォーカスを移し、すべて閉じたら開く前の場所へ戻す。
   * 開いたきっかけのボタンが描き直されて無くなっていたら、同じ data-action のボタンへ戻す
   */
  private syncDialogFocus(focused: Element | null): void {
    const dialog = this.overlay.hidden ? null : this.overlay.querySelector<HTMLElement>('[role="dialog"]');
    const label = dialog?.getAttribute('aria-label') ?? null;
    const changed = label !== this.dialogLabel;
    if (dialog && !this.dialogLabel) {
      this.focusReturn = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }
    this.dialogLabel = label;
    if (dialog) {
      // 開いた直後か、描き直しでフォーカスしていた要素が消えたとき
      if (changed || !this.overlay.contains(document.activeElement)) dialog.focus({ preventScroll: true });
      return;
    }
    const back = this.focusReturn;
    this.focusReturn = null;
    if (!changed || !back) return;
    const action = back.dataset.action;
    const target = back.isConnected ? back : action ? this.root.querySelector<HTMLElement>(`[data-action="${action}"]`) : null;
    target?.focus({ preventScroll: true });
  }

  private drawOverlay(): void {
    if (this.pendingPromotion && this.problem) {
      const mv = parseUsiMove(this.pendingPromotion.plain);
      const position = this.session?.position ?? parseSfen(this.problem.sfen);
      const piece = mv.kind === 'move' ? position.board[mv.from] : null;
      const plainChar = piece ? pieceChar(piece) : '';
      const promChar = piece ? pieceChar({ ...piece, promoted: true }) : '';
      this.overlay.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label="成りますか">
          <p>成りますか？</p>
          <div class="promote-choices">
            <button type="button" class="btn primary big" data-action="promote-yes"><span class="pc">${promChar}</span>成る</button>
            <button type="button" class="btn secondary big" data-action="promote-no"><span class="pc">${plainChar}</span>成らない</button>
          </div>
          <button type="button" class="btn ghost" data-action="promote-cancel">キャンセル</button>
        </div>`;
      this.overlay.hidden = false;
    } else if (this.confirmGiveup) {
      this.overlay.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label="解答を表示しますか">
          <p><strong>解答を表示しますか？</strong></p>
          <p class="sub">この挑戦はギブアップとして記録されます。</p>
          <div class="actions">
            <button type="button" class="btn secondary" data-action="giveup-cancel">キャンセル</button>
            <button type="button" class="btn primary" data-action="giveup-ok">解答を見る</button>
          </div>
        </div>`;
      this.overlay.hidden = false;
    } else if (this.settingsOpen) {
      this.overlay.innerHTML = this.settingsDialogHtml();
      this.overlay.hidden = false;
    } else if (this.phase.kind === 'result' && this.phase.dialog === 'open') {
      // 結果のカードは画面の下寄りに出し、背景は薄く暗くして盤の上側（玉の周り）が見えるようにする
      const html = this.resultDialogHtml(this.phase.result);
      if (html !== this.overlayHtml || this.overlay.hidden) this.overlay.innerHTML = html;
      this.overlayHtml = html;
      this.overlay.classList.add('sheet');
      this.overlay.hidden = false;
      return;
    } else {
      this.overlay.hidden = true;
      this.overlay.innerHTML = '';
    }
    this.overlayHtml = '';
    this.overlay.classList.remove('sheet');
  }

  /** 結果のカード。次にやること（正解なら次の問題、不正解なら再挑戦）を一番大きなボタンにする */
  private resultDialogHtml(result: Result): string {
    const p = this.problem;
    const btn = (action: string, label: string, cls: string) =>
      `<button type="button" class="btn ${cls}" data-action="${action}">${label}</button>`;
    if (result.kind === 'success') {
      const shortest = p ? result.moves <= p.length : true;
      const tag = this.viewedAnswer ? '解答閲覧後' : shortest ? '最短' : `最短は${p?.length}手`;
      const rare = result.feats.some((f) => f.rare);
      const feats = result.feats.map((f) => `<span class="feat-chip${f.rare ? ' feat-chip--rare' : ''}">${escapeHtml(f.label)}</span>`).join('');
      return `<div class="dialog result-card${rare ? ' rare' : ''}" role="dialog" aria-modal="true" tabindex="-1" aria-label="正解">
          <p class="result success">✓ ${result.moves}手で詰みました</p>
          <p><span class="tag success">${tag}</span></p>
          ${feats ? `<p class="feat-chips">${feats}</p>` : ''}
          ${btn('next', '次の問題 →', 'primary main')}
          <div class="actions">${btn('retry', '再挑戦', 'secondary')}${btn('review', '振り返る', 'secondary')}</div>
        </div>`;
    }
    const at = result.missedAt ? `<p><span class="tag failure">${result.missedAt}手目</span></p>` : '';
    return `<div class="dialog result-card" role="dialog" aria-modal="true" tabindex="-1" aria-label="不正解">
        <p class="result failure">✗ ${FAILURE_TEXT[result.reason]}</p>
        ${at}
        ${btn('retry', '再挑戦', 'primary main')}
        <div class="actions">${btn('next', '次の問題', 'secondary')}${btn('line-model', '解答を見る', 'secondary')}</div>
      </div>`;
  }

  private settingsDialogHtml(): string {
    const s = this.settings;
    const records = Object.values(this.history.records);
    const solved = records.filter((r) => r.clears > 0).length;
    const lengths = PROBLEM_LENGTHS.map(
      (n) => `<label class="chip"><input type="checkbox" name="length" value="${n}"${s.lengths.includes(n) ? ' checked' : ''}>${n}手詰</label>`,
    ).join('');
    const orders = (Object.keys(ORDER_LABELS) as QuestionOrder[])
      .map(
        (o) => `<label class="radio"><input type="radio" name="order" value="${o}"${s.order === o ? ' checked' : ''}>${ORDER_LABELS[o]}${o === 'untried' ? '（おすすめ）' : ''}</label>`,
      )
      .join('');
    return `<form class="dialog settings" role="dialog" aria-modal="true" tabindex="-1" aria-label="出題設定" onsubmit="return false">
        <h2>出題設定</h2>
        <fieldset><legend>出題する手数</legend><div class="chips">${lengths}</div></fieldset>
        <fieldset><legend>出題順序</legend>${orders}</fieldset>
        <label class="radio"><input type="checkbox" name="showLength"${s.showLength ? ' checked' : ''}>解答中に詰み手数を表示する</label>
        <label class="radio"><input type="checkbox" name="sound"${s.sound ? ' checked' : ''}>効果音を鳴らす</label>
        <label class="radio"><input type="checkbox" name="ghost"${s.ghost ? ' checked' : ''}>幽霊を出す</label>
        <fieldset><legend>評価関数</legend>
          <label class="radio"><input type="radio" name="variant" value="mini"${s.variant === 'mini' ? ' checked' : ''}>つようら王11mini（標準）</label>
          <label class="radio"><input type="radio" name="variant" value="micro"${s.variant === 'micro' ? ' checked' : ''}>つようら王11micro（軽量）</label>
        </fieldset>
        <p class="sub">挑戦済み ${records.length}問 ・ 自力で正解 ${solved}問</p>
        <p class="notice settings-error"></p>
        <div class="actions">
          <button type="button" class="btn secondary" data-action="settings-cancel">キャンセル</button>
          <button type="button" class="btn primary" data-action="settings-save">保存</button>
        </div>
      </form>`;
  }

  private saveSettingsForm(): void {
    const form = this.overlay.querySelector('form')!;
    const lengths = [...form.querySelectorAll<HTMLInputElement>('input[name="length"]:checked')].map((i) => Number(i.value));
    if (lengths.length === 0) {
      form.querySelector('.settings-error')!.textContent = '手数を1つ以上選んでください';
      return;
    }
    const next: Settings = {
      lengths,
      order: (form.querySelector<HTMLInputElement>('input[name="order"]:checked')?.value ?? 'untried') as QuestionOrder,
      showLength: form.querySelector<HTMLInputElement>('input[name="showLength"]')!.checked,
      variant: form.querySelector<HTMLInputElement>('input[name="variant"]:checked')?.value === 'micro' ? 'micro' : 'mini',
      sound: form.querySelector<HTMLInputElement>('input[name="sound"]')!.checked,
      ghost: form.querySelector<HTMLInputElement>('input[name="ghost"]')!.checked,
    };
    this.sound.enabled = next.sound;
    if (next.ghost !== this.settings.ghost) {
      // 出し直した幽霊は駒台から始めるので、連チャンも数え直す
      this.streak = 0;
      this.board.setGhost(next.ghost);
    }
    const variantChanged = next.variant !== this.settings.variant;
    const orderChanged = next.order !== this.settings.order || next.lengths.join() !== this.settings.lengths.join();
    this.settings = next;
    // 次の問題は前の設定で選んだものなので、選び直す
    if (orderChanged) {
      clearUpcoming();
      this.prefetchNext();
    }
    saveSettings(next);
    this.settingsOpen = false;
    // 評価関数の切り替えはエンジンを読み込み直す必要があるので再読み込みする
    if (variantChanged) {
      location.reload();
      return;
    }
    this.render();
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
