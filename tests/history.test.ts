import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applyEvents,
  emptyHistory,
  isValidEvent,
  problemStatus,
  type HistoryEvent,
  type Records,
} from '../src/history/record';
import type { ProblemIndex } from '../src/problems/loader';
import { selectProblem } from '../src/problems/selector';

let n = 0;
const ev = (problemId: string, outcome: HistoryEvent['outcome'], moves?: number): HistoryEvent => ({
  id: `e${++n}`,
  problemId,
  outcome,
  moves,
  at: 1000 + n,
});

describe('履歴レコード', () => {
  it('結果の種類を区別して数える', () => {
    const r: Records = {};
    applyEvent(r, ev('mate3/000/1', 'fail'));
    expect(problemStatus(r['mate3/000/1'])).toBe('unsolved');
    applyEvent(r, ev('mate3/000/1', 'giveup'));
    applyEvent(r, ev('mate3/000/1', 'clear-after-viewing', 3));
    // 解答閲覧後のクリアは自力クリアではない
    expect(problemStatus(r['mate3/000/1'])).toBe('unsolved');
    applyEvent(r, ev('mate3/000/1', 'clear', 5));
    applyEvent(r, ev('mate3/000/1', 'shortest', 3));
    applyEvent(r, ev('mate3/000/1', 'fail'));
    expect(r['mate3/000/1']).toMatchObject({
      attempts: 6,
      clears: 2,
      shortest: 1,
      clearsAfterViewing: 1,
      fails: 2,
      giveups: 1,
      bestMoves: 3,
      lastOutcome: 'fail',
    });
    // 正解後に間違えても正解済みのまま
    expect(problemStatus(r['mate3/000/1'])).toBe('solved');
    expect(problemStatus(undefined)).toBe('untried');
  });

  it('同じイベントは二重に適用しない', () => {
    const h = emptyHistory();
    const e = ev('mate5/001/2', 'shortest', 5);
    expect(applyEvents(h, [e])).toBe(1);
    expect(applyEvents(h, [e, ev('mate5/001/2', 'fail')])).toBe(1);
    expect(h.records['mate5/001/2'].attempts).toBe(2);
  });

  it('不正なイベントは捨てる', () => {
    expect(isValidEvent(ev('mate3/000/1', 'fail'))).toBe(true);
    expect(isValidEvent({ ...ev('mate3/000/1', 'fail'), problemId: '../x' })).toBe(false);
    expect(isValidEvent({ ...ev('mate3/000/1', 'fail'), outcome: 'win' })).toBe(false);
    expect(isValidEvent(null)).toBe(false);
  });
});

describe('selectProblem', () => {
  const index: ProblemIndex = {
    mate3: { moves: 3, volumes: [2, 2] },
    mate5: { moves: 5, volumes: [3] },
  };
  const cursor = { next: {}, lengthIndex: 0 };
  const seq = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length];
  };

  it('未挑戦優先: 履歴にある問題を避ける', () => {
    const records: Records = {};
    for (const id of ['mate3/000/0', 'mate3/000/1', 'mate3/001/0']) applyEvent(records, ev(id, 'fail'));
    for (let i = 0; i < 20; i++) {
      const r = selectProblem({ index, lengths: [3], order: 'untried', records, cursor });
      expect(r.id).toBe('mate3/001/1');
      expect(r.fallback).toBeUndefined();
    }
  });

  it('未挑戦が無ければ挑戦済みから出し、その旨を返す', () => {
    const records: Records = {};
    for (const id of ['mate3/000/0', 'mate3/000/1', 'mate3/001/0', 'mate3/001/1']) applyEvent(records, ev(id, 'fail'));
    const r = selectProblem({ index, lengths: [3], order: 'untried', records, cursor });
    expect(r.id).toMatch(/^mate3\//);
    expect(r.fallback).toBeDefined();
  });

  it('誤答優先・復習は履歴から手数で絞って選ぶ', () => {
    const records: Records = {};
    applyEvent(records, ev('mate3/000/0', 'fail'));
    applyEvent(records, ev('mate5/000/1', 'fail'));
    applyEvent(records, ev('mate3/001/1', 'shortest', 3));
    expect(selectProblem({ index, lengths: [3], order: 'unsolved', records, cursor }).id).toBe('mate3/000/0');
    expect(selectProblem({ index, lengths: [3, 5], order: 'solved', records, cursor }).id).toBe('mate3/001/1');
    // 直前の問題は除外 → 候補が無いので未挑戦にフォールバック
    const r = selectProblem({ index, lengths: [3], order: 'unsolved', records, cursor, excludeId: 'mate3/000/0' });
    expect(r.fallback).toBeDefined();
  });

  it('番号順: 手数を交互に、巻をまたいで進む', () => {
    let c = cursor;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = selectProblem({ index, lengths: [3, 5], order: 'sequential', records: {}, cursor: c });
      ids.push(r.id);
      c = r.cursor;
    }
    expect(ids).toEqual([
      'mate3/000/0', 'mate5/000/0',
      'mate3/000/1', 'mate5/000/1',
      'mate3/001/0', 'mate5/000/2',
      'mate3/001/1', 'mate5/000/0',
    ]);
  });

  it('ランダム: 今の巻の中から選ぶ', () => {
    const r = selectProblem({ index, lengths: [5], order: 'random', records: {}, cursor, random: seq(0, 0.5) });
    expect(r.id).toMatch(/^mate5\/000\//);
    expect(r.cursor.current).toEqual({ mate5: 0 });
  });

  it('今の巻は挑戦済みが半分になるまで使い続け、半分に達したら未着手の巻へ移る', () => {
    const big: ProblemIndex = { mate3: { moves: 3, volumes: [1000, 1000, 1000] } };
    const records: Records = {};
    for (let i = 0; i < 499; i++) applyEvent(records, ev(`mate3/001/${i}`, 'fail'));
    applyEvent(records, ev('mate3/000/0', 'fail'));
    const c = { next: {}, lengthIndex: 0, current: { mate3: 1 } };
    for (let k = 0; k < 20; k++) {
      const r = selectProblem({ index: big, lengths: [3], order: 'untried', records, cursor: c });
      expect(r.id).toMatch(/^mate3\/001\//);
      expect(records[r.id]).toBeUndefined();
    }
    applyEvent(records, ev('mate3/001/499', 'fail'));
    const r = selectProblem({ index: big, lengths: [3], order: 'untried', records, cursor: c });
    // 001 は半分挑戦済み、000 は1問挑戦済み → 未着手の 002 へ
    expect(r.id).toMatch(/^mate3\/002\//);
    expect(r.cursor.current).toEqual({ mate3: 2 });
  });
});
