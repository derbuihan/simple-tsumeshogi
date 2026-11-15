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
  /** 進めたカーソル（保存する） */
  cursor: Cursor;
  /** 希望の順序で選べず別の方法で選んだときの説明 */
  fallback?: string;
}

const TRIES = 64;
/** 今の巻で挑戦済みがこの割合に達したら次の巻へ移る（約1000問のうち500問） */
const VOLUME_SWITCH_RATIO = 0.5;

/**
 * 出題する問題 ID を選ぶ。約500万問を読み込まずに、手数・巻・行番号から ID を作って履歴と照合する。
 *
 * 「未挑戦優先」「完全ランダム」は、手数ごとに「今の巻」（約1000問・1ファイル）から出題し、
 * その巻の挑戦済みが半分に達したら、まだ手を付けていない巻へ移る。
 * 取得済みのファイルから出題が続くので、通信は巻を移るときだけになる。
 */
export function selectProblem(input: SelectInput): SelectResult {
  const { index, order, records, excludeId } = input;
  let cursor = input.cursor;
  const rand = input.random ?? Math.random;
  const lengths = input.lengths.filter((n) => index[`mate${n}`]);
  if (lengths.length === 0) throw new Error('出題できる手数がありません');

  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const randInt = (n: number) => Math.floor(rand() * n);

  /** 巻ごとの挑戦済み問題数（履歴の ID から数える） */
  const triedIn = (length: number, volume: number): number => {
    const prefix = problemId(length, volume, 0).replace(/0$/, '');
    let n = 0;
    for (const id in records) if (id.startsWith(prefix)) n++;
    return n;
  };
  const isFull = (length: number, volume: number) =>
    triedIn(length, volume) >= index[`mate${length}`].volumes[volume] * VOLUME_SWITCH_RATIO;

  /** 手数 length の「今の巻」。半分挑戦済みなら、手を付けていない巻（無ければ挑戦の少ない巻）へ移る */
  const currentVolume = (length: number): number => {
    const key = `mate${length}`;
    const vols = index[key].volumes;
    const cur = cursor.current?.[key];
    if (cur !== undefined && cur < vols.length && !isFull(length, cur)) return cur;
    let best = randInt(vols.length);
    let bestTried = triedIn(length, best);
    for (let i = 0; i < TRIES && bestTried > 0; i++) {
      const v = randInt(vols.length);
      const t = triedIn(length, v);
      if (t < bestTried) [best, bestTried] = [v, t];
    }
    cursor = { ...cursor, current: { ...cursor.current, [key]: best } };
    return best;
  };

  /** 今の巻からランダムに1問（untriedOnly なら未挑戦のみ） */
  const fromCurrentVolume = (untriedOnly: boolean): string | null => {
    const length = pick(lengths);
    const volume = currentVolume(length);
    const count = index[`mate${length}`].volumes[volume];
    const start = randInt(count);
    for (let i = 0; i < count; i++) {
      const id = problemId(length, volume, (start + i) % count);
      if (id === excludeId) continue;
      if (!untriedOnly || !records[id]) return id;
    }
    return null;
  };
  const randomAnywhere = () => {
    const length = pick(lengths);
    const vols = index[`mate${length}`].volumes;
    const volume = randInt(vols.length);
    return problemId(length, volume, randInt(vols[volume]));
  };
  const untried = (): string | null => fromCurrentVolume(true);

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
      return id ? { id, cursor } : { id: randomAnywhere(), cursor, fallback: '未挑戦の問題が見つからなかったので、挑戦済みの問題から出題しています' };
    }
    case 'unsolved': {
      const id = fromHistory('unsolved');
      if (id) return { id, cursor };
      return { id: untried() ?? randomAnywhere(), cursor, fallback: '間違えた問題が無いので、未挑戦の問題を出題しています' };
    }
    case 'solved': {
      const id = fromHistory('solved');
      if (id) return { id, cursor };
      return { id: untried() ?? randomAnywhere(), cursor, fallback: '正解済みの問題が無いので、未挑戦の問題を出題しています' };
    }
    case 'random':
      return { id: fromCurrentVolume(false) ?? randomAnywhere(), cursor };
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
        cursor: { ...cursor, next: { ...cursor.next, [`mate${length}`]: nextLine }, lengthIndex: (cursor.lengthIndex + 1) % lengths.length },
      };
    }
  }
}
