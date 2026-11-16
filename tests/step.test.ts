import { describe, expect, it } from 'vitest';
import { applyMove, applyMoves } from '../src/shogi/move';
import { parseSfen } from '../src/shogi/sfen';
import { squareIndex } from '../src/shogi/types';
import { detectStep } from '../src/ui/step';

const START = parseSfen('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1');

describe('detectStep', () => {
  it('1手進んだときは、その手と動かした駒を返す', () => {
    const next = applyMove(START, '7g7f');
    const step = detectStep(START, next, '7g7f');
    expect(step?.mover).toBe('b');
    expect(step?.piece).toEqual({ color: 'b', type: 'P', promoted: false });
    expect(step?.captured).toBeNull();
  });

  it('駒を取って成る手は、成る前の駒と取った駒を返す', () => {
    const before = applyMoves(START, ['7g7f', '3c3d']);
    const next = applyMove(before, '8h2b+');
    const step = detectStep(before, next, '8h2b+');
    expect(step?.piece).toEqual({ color: 'b', type: 'B', promoted: false });
    expect(step?.captured).toEqual({ color: 'w', type: 'B', promoted: false });
    expect(step?.move).toEqual({ kind: 'move', from: squareIndex(8, 7), to: squareIndex(2, 1), promote: true });
  });

  it('駒打ちは、打った駒を返す', () => {
    const before = applyMoves(START, ['7g7f', '3c3d', '8h2b+', '3a2b']);
    const next = applyMove(before, 'B*5e');
    expect(detectStep(before, next, 'B*5e')?.piece).toEqual({ color: 'b', type: 'B', promoted: false });
  });

  it('1手進んだのでなければ null（やり直し・巻き戻し・指し手なし）', () => {
    const one = applyMove(START, '7g7f');
    const two = applyMove(one, '3c3d');
    expect(detectStep(two, START, null)).toBeNull();
    expect(detectStep(two, one, '7g7f')).toBeNull();
    expect(detectStep(START, two, '3c3d')).toBeNull();
    expect(detectStep(one, one, '7g7f')).toBeNull();
  });
});
