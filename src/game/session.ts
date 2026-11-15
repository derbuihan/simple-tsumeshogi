import type { EngineLike } from '../engine/types';
import { isMatedScore } from '../engine/usi';
import { applyMove } from '../shogi/move';
import { parseSfen, positionKey } from '../shogi/sfen';
import type { Position } from '../shogi/types';
import type { Problem } from './problem';

/** 玉方の探索時間。これ以内に詰みが見つからなければ不正解 */
export const DEFENDER_MOVETIME_MS = 3000;

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
  | { kind: 'failure'; reason: FailureReason };

/**
 * 1回の挑戦（問題の初期局面から詰む・詰みを逃すまで）。
 *
 * 判定ルール:
 *   - 攻方は王手しか指せない（checks の中から選ぶ）
 *   - 攻方の手の後、玉方に合法手が無ければ成功（遠回りでも成功）
 *   - 玉方の探索が「詰まされる」(score mate -N) なら最善手で応じて続行
 *   - 通常評価値・時間切れなら不正解（失敗局面はそのまま残す）
 *   - 同一局面が4回現れたら連続王手の千日手として不正解
 */
export class Session {
  readonly moves: string[] = [];
  position: Position;
  state: SessionState = { kind: 'thinking' };
  private readonly seen = new Map<string, number>();

  constructor(
    readonly problem: Problem,
    private readonly engine: EngineLike,
    private readonly movetimeMs = DEFENDER_MOVETIME_MS,
  ) {
    this.position = parseSfen(problem.sfen);
    this.remember();
  }

  get enginePosition() {
    return { sfen: this.problem.sfen, moves: this.moves.slice() };
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
    this.state = { kind: 'thinking' };
    this.push(move);

    if (this.isRepetition()) return (this.state = { kind: 'failure', reason: 'repetition' });

    const legal = await this.engine.legalMoves(this.enginePosition);
    if (legal.length === 0) return (this.state = { kind: 'success', moves: this.moves.length });

    const result = await this.engine.think(this.enginePosition, this.movetimeMs);
    if (!isMatedScore(result.score)) return (this.state = { kind: 'failure', reason: 'no-mate' });

    let reply = result.bestmove;
    if (reply === 'win') return (this.state = { kind: 'failure', reason: 'defender-win' });
    // 詰みを読んでいても resign を返すことがある（ResignValue 等）。その場合は合法手から1つ選ぶ。
    if (!legal.includes(reply)) reply = legal[0];
    this.push(reply);
    onDefenderMove?.(reply);

    if (this.isRepetition()) return (this.state = { kind: 'failure', reason: 'repetition' });
    return this.toAttackerTurn();
  }

  private async toAttackerTurn(): Promise<SessionState> {
    const checks = await this.engine.checks(this.enginePosition);
    if (checks.length === 0) return (this.state = { kind: 'failure', reason: 'no-checks' });
    return (this.state = { kind: 'attacker-turn', checks });
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
