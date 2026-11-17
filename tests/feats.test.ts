import { describe, expect, it } from 'vitest';
import { successFeats, type FeatInput } from '../src/game/feats';
import type { ProblemRecord, Records } from '../src/history/record';

const rec = (r: Partial<ProblemRecord>): ProblemRecord => ({
  attempts: 1,
  clears: 0,
  shortest: 0,
  clearsAfterViewing: 0,
  fails: 0,
  giveups: 0,
  lastAt: 0,
  lastOutcome: 'fail',
  ...r,
});

/** mate{length}/000/{i} を solved 問だけ正解済みにした履歴 */
const solvedRecords = (length: number, solved: number): Records =>
  Object.fromEntries(Array.from({ length: solved }, (_, i) => [`mate${length}/000/${i}`, rec({ clears: 1 })]));

const input = (over: Partial<FeatInput>): FeatInput => ({
  problemId: 'mate7/000/0',
  length: 7,
  moves: 7,
  viewedAnswer: false,
  before: undefined,
  records: solvedRecords(7, 3),
  ...over,
});

const labels = (i: FeatInput) => successFeats(i).map((f) => `${f.label}${f.rare ? '*' : ''}`);

describe('successFeats', () => {
  it('初めての問題を最短で解くと「初見で最短」と、手数ごとの正解数を出す', () => {
    expect(labels(input({}))).toEqual(['初見で最短', '7手詰 3問目']);
    expect(labels(input({ moves: 9 }))).toEqual(['初見で正解', '7手詰 3問目']);
  });

  it('9手詰以上の初見で最短は珍しい達成', () => {
    expect(labels(input({ problemId: 'mate9/000/0', length: 9, moves: 9, records: solvedRecords(9, 2) }))).toEqual(['初見で最短*', '9手詰 2問目']);
  });

  it('前に解けなかった問題を自力で解くと「リベンジ成功」', () => {
    expect(labels(input({ before: rec({ fails: 2 }) }))).toEqual(['リベンジ成功', '7手詰 3問目']);
  });

  it('解いたことのある問題は、手数を縮めたときだけ「自己ベスト更新」を出し、正解数は数えない', () => {
    expect(labels(input({ before: rec({ clears: 1, bestMoves: 9 }) }))).toEqual(['自己ベスト更新（9→7手）']);
    expect(labels(input({ before: rec({ clears: 1, bestMoves: 7 }) }))).toEqual([]);
  });

  it('手数ごとの正解数は、はじめての1問と節目を特別に扱う（他の手数は数えない）', () => {
    expect(labels(input({ records: { ...solvedRecords(7, 1), ...solvedRecords(5, 30) } }))).toEqual(['初見で最短', 'はじめての7手詰']);
    expect(labels(input({ records: solvedRecords(7, 10) }))).toEqual(['初見で最短', '7手詰 10問達成*']);
    expect(labels(input({ records: solvedRecords(7, 300) }))).toEqual(['初見で最短', '7手詰 300問達成*']);
  });

  it('解答を見た後のクリアには何も出さない', () => {
    expect(successFeats(input({ viewedAnswer: true }))).toEqual([]);
  });
});
