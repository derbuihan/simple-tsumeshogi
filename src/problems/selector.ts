import { problemStatus, type Records } from '../history/record';
import type { Cursor, QuestionOrder } from '../settings';
import { problemId, type ProblemIndex } from './loader';

export interface SelectInput {
  index: ProblemIndex;
  lengths: readonly number[];
  order: QuestionOrder;
  records: Records;
  cursor: Cursor;
  /** 直前の問題（連続で同じ問題を出さない） */
  excludeId?: string;
  random?: () => number;
}

export interface SelectResult {
  id: string;
  /** 番号順出題で進めたカーソル（保存する） */
  cursor: Cursor;
  /** 希望の順序で選べず別の方法で選んだときの説明 */
  fallback?: string;
}

const UNTRIED_TRIES = 64;

/**
 * 出題する問題 ID を選ぶ。約500万問を読み込まずに、手数・巻・行番号から ID を作って履歴と照合する。
 */
export function selectProblem(input: SelectInput): SelectResult {
  const { index, order, records, cursor, excludeId } = input;
  const rand = input.random ?? Math.random;
  const lengths = input.lengths.filter((n) => index[`mate${n}`]);
  if (lengths.length === 0) throw new Error('出題できる手数がありません');

  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const randomId = () => {
    const length = pick(lengths);
    const vols = index[`mate${length}`].volumes;
    const volume = Math.floor(rand() * vols.length);
    return problemId(length, volume, Math.floor(rand() * vols[volume]));
  };
  const untried = (): string | null => {
    for (let i = 0; i < UNTRIED_TRIES; i++) {
      const id = randomId();
      if (!records[id] && id !== excludeId) return id;
    }
    return null;
  };
  const fromHistory = (want: 'unsolved' | 'solved'): string | null => {
    const prefixes = lengths.map((n) => `mate${n}/`);
    const ids = Object.keys(records).filter(
      (id) => id !== excludeId && prefixes.some((p) => id.startsWith(p)) && problemStatus(records[id]) === want,
    );
    return ids.length ? pick(ids) : null;
  };

  switch (order) {
    case 'untried': {
      const id = untried();
      return id ? { id, cursor } : { id: randomId(), cursor, fallback: '未挑戦の問題が見つからなかったので、挑戦済みの問題から出題しています' };
    }
    case 'unsolved': {
      const id = fromHistory('unsolved');
      if (id) return { id, cursor };
      return { id: untried() ?? randomId(), cursor, fallback: '間違えた問題が無いので、未挑戦の問題を出題しています' };
    }
    case 'solved': {
      const id = fromHistory('solved');
      if (id) return { id, cursor };
      return { id: untried() ?? randomId(), cursor, fallback: '正解済みの問題が無いので、未挑戦の問題を出題しています' };
    }
    case 'random': {
      let id = randomId();
      if (id === excludeId) id = randomId();
      return { id, cursor };
    }
    case 'sequential': {
      const length = lengths[cursor.lengthIndex % lengths.length];
      const vols = index[`mate${length}`].volumes;
      let { volume, line } = cursor.next[`mate${length}`] ?? { volume: 0, line: 0 };
      if (volume >= vols.length) volume = 0;
      if (line >= vols[volume]) [volume, line] = [(volume + 1) % vols.length, 0];
      const id = problemId(length, volume, line);
      const nextLine = line + 1 >= vols[volume] ? { volume: (volume + 1) % vols.length, line: 0 } : { volume, line: line + 1 };
      return {
        id,
        cursor: { next: { ...cursor.next, [`mate${length}`]: nextLine }, lengthIndex: (cursor.lengthIndex + 1) % lengths.length },
      };
    }
  }
}
