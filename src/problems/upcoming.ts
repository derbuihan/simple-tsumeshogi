import { parseProblemLine, type Problem } from '../game/problem';
import { parseSfen } from '../shogi/sfen';

/**
 * 次に出す問題。起動したらこれをすぐ盤に出し、通信やエンジンの読み込みを待たない。
 * 問題を出すたびに次の問題を選んで取得し、ここに保存しておく。
 * 読めない・壊れている・設定の手数に合わないときは使わず、普通に取得する（無くても動く）。
 */
export interface Upcoming {
  problem: Problem;
  /** 希望の順序で選べなかったときのお知らせ（selectProblem の fallback） */
  notice?: string;
}

const KEY = 'tsume.upcoming.v1';

interface Stored {
  id: string;
  /** 問題データの1行（"<SFEN> moves <手順>"） */
  line: string;
  notice?: string;
}

const lengthOf = (id: string): number => Number(id.match(/^mate(\d+)\//)?.[1]);

export function readUpcoming(lengths: readonly number[]): Upcoming | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    if (!s || typeof s.id !== 'string' || typeof s.line !== 'string') return null;
    if (!lengths.includes(lengthOf(s.id))) return null;
    const problem = parseProblemLine(s.id, s.line);
    parseSfen(problem.sfen);
    return { problem, notice: typeof s.notice === 'string' ? s.notice : undefined };
  } catch {
    return null;
  }
}

export function saveUpcoming({ problem, notice }: Upcoming): void {
  const s: Stored = { id: problem.id, line: `${problem.sfen} moves ${problem.solution.join(' ')}`, notice };
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても次回は普通に取得する */
  }
}

export function clearUpcoming(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}

/** 保存した問題が今の設定の手数で出せるか */
export const fitsLengths = (u: Upcoming, lengths: readonly number[]): boolean => lengths.includes(lengthOf(u.problem.id));
