import type { Color } from '../shogi/types';

/** 1問。id は "mate5/004/237"（手数/巻/行） */
export interface Problem {
  id: string;
  /** 収録手数（最短手数として扱う） */
  length: number;
  sfen: string;
  /** 収録されている詰み手順（最短解の一例） */
  solution: string[];
  /** 攻方（= 初期局面の手番） */
  attacker: Color;
}

/** 問題データの1行 "<SFEN> moves <m1> <m2> ..." を解析する */
export function parseProblemLine(id: string, line: string): Problem {
  const [sfen, movesStr] = line.trim().split(' moves ');
  if (!sfen || !movesStr) throw new Error(`invalid problem line: ${line}`);
  const solution = movesStr.trim().split(/\s+/);
  const turn = sfen.trim().split(/\s+/)[1];
  if (turn !== 'b' && turn !== 'w') throw new Error(`invalid problem sfen: ${sfen}`);
  return { id, length: solution.length, sfen: sfen.trim(), solution, attacker: turn };
}
