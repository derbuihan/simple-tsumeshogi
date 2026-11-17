import type { ProblemRecord, Records } from '../history/record';

/**
 * 正解したときに結果のカードで伝える達成。履歴から言える事実だけを出す（根拠のない褒め言葉は出さない）。
 * rare は珍しい達成で、詰みの演出とカードを少し豪華にする。
 */
export interface Feat {
  label: string;
  rare: boolean;
}

export interface FeatInput {
  problemId: string;
  /** 問題の詰み手数（最短） */
  length: number;
  /** 詰ませた手数 */
  moves: number;
  /** この問題で解答を見た後のクリアか */
  viewedAnswer: boolean;
  /** 今回の結果を記録する前の、この問題の記録 */
  before: ProblemRecord | undefined;
  /** 今回の結果を記録した後の全履歴 */
  records: Records;
}

/** 手数ごとの正解数の節目（10・50・100問、以後100問ごと） */
const isMilestone = (n: number) => n === 10 || n === 50 || (n >= 100 && n % 100 === 0);

export function successFeats({ problemId, length, moves, viewedAnswer, before, records }: FeatInput): Feat[] {
  if (viewedAnswer) return [];
  const feats: Feat[] = [];
  const shortest = moves <= length;
  if (!before) {
    feats.push(shortest ? { label: '初見で最短', rare: length >= 9 } : { label: '初見で正解', rare: false });
  } else if (before.clears === 0) {
    feats.push({ label: 'リベンジ成功', rare: false });
  } else if (before.bestMoves !== undefined && moves < before.bestMoves) {
    feats.push({ label: `自己ベスト更新（${before.bestMoves}→${moves}手）`, rare: false });
  }
  // 初めて自力で解いた問題だけ、手数ごとの正解数を数える
  if ((before?.clears ?? 0) === 0) {
    const prefix = `${problemId.split('/')[0]}/`;
    const solved = Object.entries(records).filter(([id, r]) => id.startsWith(prefix) && r.clears > 0).length;
    if (solved === 1) feats.push({ label: `はじめての${length}手詰`, rare: false });
    else if (isMilestone(solved)) feats.push({ label: `${length}手詰 ${solved}問達成`, rare: true });
    else feats.push({ label: `${length}手詰 ${solved}問目`, rare: false });
  }
  return feats;
}
