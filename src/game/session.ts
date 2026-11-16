import type { EngineLike } from '../engine/types';
import { isMatedScore, type Score } from '../engine/usi';
import { applyMove } from '../shogi/move';
import { parseSfen, positionKey } from '../shogi/sfen';
import type { Position } from '../shogi/types';
import type { Problem } from './problem';

/**
 * 玉方の探索時間（攻方が指した後の、問題の残り手数ごと）。これ以内に詰みが見つからなければ詰みを逃したとみなす。
 * 詰みがあればエンジンはたいてい見つけた時点で返すが、無ければ時間いっぱい考える。
 * その差で正誤が分からないよう、画面側は応手を見せるまでの時間をこの値にそろえる。
 */
export function defenderMovetimeMs(remainingPlies: number): number {
  // 計測（PC の Node、mini）: 詰みが見つかるまでの最大は残り4手まで約5ms、6手で約50ms、8手で約400ms、10手で約2秒。
  // スマホは数倍遅いので、その分を見込む。時間内に見落としても、たいてい猶予に入り次の手で取り消される
  if (remainingPlies <= 4) return 300;
  if (remainingPlies <= 6) return 500;
  if (remainingPlies <= 8) return 1000;
  return 1500;
}

/** 詰みを逃した後に続けさせる最大の手数（攻方の手） */
export const MAX_GRACE = 2;

/** 攻方の優勢（玉方から見た評価値の符号を反転したもの）がこれ未満なら、明らかに逃したとしてすぐ不正解にする */
const CLEAR_MISS_CP = 300;

/**
 * 詰みを逃した直後に、あと何手続けさせるか（0〜MAX_GRACE）。
 * 攻方がまだ大きく優勢（＝惜しい逃し方）なほど長く続けさせ、どこで間違えたかを分かりにくくする。
 * @param score 攻方の手の後の玉方の探索結果（玉方から見た値）
 * @param random 0以上1未満の乱数
 */
export function graceMoves(score: Score | null, random: number): number {
  if (score?.kind !== 'cp') return 0;
  const advantage = -score.value;
  if (advantage < CLEAR_MISS_CP) return 0;
  const weights = advantage < 1000 ? [0.6, 0.3, 0.1] : advantage < 2000 ? [0.3, 0.4, 0.3] : [0.1, 0.3, 0.6];
  let acc = 0;
  for (let n = 0; n < weights.length; n++) {
    acc += weights[n];
    if (random < acc) return Math.min(n, MAX_GRACE);
  }
  return MAX_GRACE;
}

export type FailureReason =
  /** 玉方の探索で詰みが見つからない（通常評価値・時間切れ） */
  | 'no-mate'
  /** 攻方に王手が無い */
  | 'no-checks'
  /** 連続王手の千日手（攻方の反則） */
  | 'repetition'
  /** 玉方が入玉宣言勝ちなど、詰み以外で終局 */
  | 'defender-win';

export type SessionState =
  | { kind: 'attacker-turn'; checks: string[] }
  | { kind: 'thinking' }
  | { kind: 'success'; moves: number }
  /** missedAt: 詰みを逃した攻方の手（1始まりの手数）。詰みを逃したのでなければ undefined */
  | { kind: 'failure'; reason: FailureReason; missedAt?: number };

export interface SessionOptions {
  /** 残り手数ごとの玉方の探索時間 */
  movetimeMs?: (remainingPlies: number) => number;
  /** 0以上1未満の乱数（テスト用に差し替える） */
  random?: () => number;
}

/**
 * 1回の挑戦（問題の初期局面から詰む・詰みを逃すまで）。
 *
 * 判定ルール:
 *   - 攻方は王手しか指せない（checks の中から選ぶ）
 *   - 攻方の手の後、玉方に合法手が無ければ成功（遠回りでも成功）
 *   - 玉方の探索が「詰まされる」(score mate -N) なら最善手で応じて続行
 *   - 通常評価値・時間切れなら詰みを逃した。ただしすぐには不正解にせず、評価値に応じて
 *     0〜2手は玉方が最善手で応じて続ける（猶予）。猶予を使い切ったら不正解
 *   - 猶予中に本当に詰ませれば成功。猶予中に再び詰みが見つかれば（探索の見落としだった）猶予を取り消して続行
 *   - 同一局面が4回現れたら連続王手の千日手として不正解
 */
export class Session {
  readonly moves: string[] = [];
  position: Position;
  state: SessionState = { kind: 'thinking' };
  private readonly seen = new Map<string, number>();
  private readonly movetimeMs: (remainingPlies: number) => number;
  private readonly random: () => number;
  /** 詰みを逃した手（1始まり）。逃していなければ null */
  private missedAt: number | null = null;
  /** 詰みを逃した後に、あと何手続けさせるか */
  private graceLeft = 0;

  constructor(
    readonly problem: Problem,
    private readonly engine: EngineLike,
    options: SessionOptions = {},
  ) {
    this.movetimeMs = options.movetimeMs ?? defenderMovetimeMs;
    this.random = options.random ?? Math.random;
    this.position = parseSfen(problem.sfen);
    this.remember();
  }

  get enginePosition() {
    return { sfen: this.problem.sfen, moves: this.moves.slice() };
  }

  /** 次の攻方の手に対して玉方が考える時間。手数だけで決まるので、正誤によらない */
  get nextMovetimeMs(): number {
    return this.movetimeMs(this.problem.length - this.moves.length - 1);
  }

  /** 初期局面の王手を取得して攻方の手番にする */
  async start(): Promise<SessionState> {
    return this.toAttackerTurn();
  }

  /**
   * 攻方の手を指す。玉方の応手まで進めて新しい状態を返す。
   * @param onDefenderMove 玉方が指した直後に呼ばれる（盤面更新用）
   */
  async playAttacker(move: string, onDefenderMove?: (move: string) => void): Promise<SessionState> {
    if (this.state.kind !== 'attacker-turn') throw new Error(`not attacker turn: ${this.state.kind}`);
    if (!this.state.checks.includes(move)) throw new Error(`not a checking move: ${move}`);
    const movetime = this.nextMovetimeMs;
    this.state = { kind: 'thinking' };
    this.push(move);

    if (this.isRepetition()) return this.fail('repetition');

    const legal = await this.engine.legalMoves(this.enginePosition);
    if (legal.length === 0) return (this.state = { kind: 'success', moves: this.moves.length });

    const result = await this.engine.think(this.enginePosition, movetime);
    if (isMatedScore(result.score)) {
      // 猶予中に詰みが見つかったなら、前の判定は探索の見落としだった
      this.missedAt = null;
      this.graceLeft = 0;
    } else if (this.missedAt === null) {
      this.missedAt = this.moves.length;
      this.graceLeft = graceMoves(result.score, this.random());
      if (this.graceLeft === 0) return this.fail('no-mate');
    } else {
      this.graceLeft--;
      const clearMiss = result.score?.kind !== 'cp' || -result.score.value < CLEAR_MISS_CP;
      if (this.graceLeft <= 0 || clearMiss) return this.fail('no-mate');
    }

    let reply = result.bestmove;
    if (reply === 'win') return this.fail('defender-win');
    // 詰みを読んでいても resign を返すことがある（ResignValue 等）。その場合は合法手から1つ選ぶ。
    if (!legal.includes(reply)) reply = legal[0];
    this.push(reply);
    onDefenderMove?.(reply);

    if (this.isRepetition()) return this.fail('repetition');
    return this.toAttackerTurn();
  }

  private async toAttackerTurn(): Promise<SessionState> {
    const checks = await this.engine.checks(this.enginePosition);
    if (checks.length === 0) return this.fail('no-checks');
    return (this.state = { kind: 'attacker-turn', checks });
  }

  /** 不正解にする。詰みを逃した後なら、理由は「詰みを逃した」にする（本当の原因はそこなので） */
  private fail(reason: FailureReason): SessionState {
    if (this.missedAt !== null) return (this.state = { kind: 'failure', reason: 'no-mate', missedAt: this.missedAt });
    return (this.state = { kind: 'failure', reason });
  }

  private push(move: string): void {
    this.moves.push(move);
    this.position = applyMove(this.position, move);
    this.remember();
  }

  private remember(): void {
    const key = positionKey(this.position);
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
  }

  private isRepetition(): boolean {
    return (this.seen.get(positionKey(this.position)) ?? 0) >= 4;
  }
}
