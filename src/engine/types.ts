import type { ThinkResult } from './usi';

/** 局面: 初期 SFEN とそこからの指し手 */
export interface EnginePosition {
  sfen: string;
  moves: readonly string[];
}

/** 判定ロジックが使うエンジン機能（テストではモックに差し替える） */
export interface EngineLike {
  /** 合法な王手をすべて返す */
  checks(pos: EnginePosition): Promise<string[]>;
  /** 合法手をすべて返す */
  legalMoves(pos: EnginePosition): Promise<string[]>;
  /** 通常探索して最善手と評価値を返す */
  think(pos: EnginePosition, movetimeMs: number): Promise<ThinkResult>;
}

export const positionCommand = (pos: EnginePosition): string =>
  `position sfen ${pos.sfen}${pos.moves.length ? ` moves ${pos.moves.join(' ')}` : ''}`;

/** 詰み専用エンジンの判定。unknown は時間切れ・メモリ不足などで結論が出なかったもの */
export type MateVerdict = 'mate' | 'nomate' | 'unknown';

/** 詰み専用エンジン（テストではモックに差し替える） */
export interface MateSolverLike {
  /** 攻方の手番の局面が、王手の連続で詰むか（手数の上限なし） */
  solve(pos: EnginePosition, timeoutMs: number): Promise<MateVerdict>;
}
