import { describe, expect, it } from 'vitest';
import { parseSfen, positionKey } from '../src/shogi/sfen';
import { applyMove, applyMoves, parseUsiMove } from '../src/shogi/move';
import { moveToJapanese } from '../src/shogi/notation';
import { squareIndex } from '../src/shogi/types';

const START = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
// mate3/000.txt の1問目（後手が攻方）
const P1 = 'ln1gkg1nl/6+P2/2sppps1p/2p3p2/p8/P1P1P3P/2NP1PP2/3s1KSR1/L1+b2G1NL w R2Pbgp 42';

describe('parseSfen', () => {
  it('平手', () => {
    const pos = parseSfen(START);
    expect(pos.turn).toBe('b');
    expect(pos.board[squareIndex(5, 8)]).toEqual({ color: 'b', type: 'K', promoted: false }); // 5九玉
    expect(pos.board[squareIndex(8, 1)]).toEqual({ color: 'w', type: 'R', promoted: false }); // 8二飛
    expect(pos.board[squareIndex(2, 7)]).toEqual({ color: 'b', type: 'R', promoted: false }); // 2八飛
  });

  it('成駒と持ち駒', () => {
    const pos = parseSfen(P1);
    expect(pos.turn).toBe('w');
    expect(pos.board[squareIndex(3, 1)]).toEqual({ color: 'b', type: 'P', promoted: true }); // 3二と
    expect(pos.board[squareIndex(7, 8)]).toEqual({ color: 'w', type: 'B', promoted: true }); // 7九馬
    expect(pos.hands.b).toMatchObject({ R: 1, P: 2, B: 0 });
    expect(pos.hands.w).toMatchObject({ B: 1, G: 1, P: 1 });
  });

  it('positionKey は手数を除いた SFEN と一致する', () => {
    expect(positionKey(parseSfen(START))).toBe('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -');
    expect(positionKey(parseSfen(P1))).toBe(P1.replace(/ \d+$/, ''));
  });
});

describe('applyMove', () => {
  it('移動・取り・成り・打つ', () => {
    let pos = parseSfen(START);
    pos = applyMoves(pos, ['7g7f', '3c3d', '8h2b+']);
    expect(pos.board[squareIndex(2, 1)]).toEqual({ color: 'b', type: 'B', promoted: true });
    expect(pos.hands.b.B).toBe(1); // 角を取った
    expect(pos.turn).toBe('w');
    pos = applyMoves(pos, ['3a2b', 'B*5e']);
    expect(pos.hands.w.B).toBe(1); // 馬を取ると角として持ち駒に
    expect(pos.hands.b.B).toBe(0);
    expect(pos.board[squareIndex(5, 4)]).toEqual({ color: 'b', type: 'B', promoted: false });
  });

  it('不正な手は例外', () => {
    expect(() => applyMove(parseSfen(START), '5e5d')).toThrow();
    expect(() => applyMove(parseSfen(START), 'B*5e')).toThrow();
  });

  it('parseUsiMove', () => {
    expect(parseUsiMove('B*5g')).toEqual({ kind: 'drop', type: 'B', to: squareIndex(5, 6) });
    expect(parseUsiMove('6h5g+')).toEqual({ kind: 'move', from: squareIndex(6, 7), to: squareIndex(5, 6), promote: true });
  });
});

describe('moveToJapanese', () => {
  it('打・同・成・不成', () => {
    const pos = parseSfen(P1);
    expect(moveToJapanese(pos, 'B*5g')).toBe('△５七角打');
    expect(moveToJapanese(pos, '6h5g+')).toBe('△５七銀成');
    expect(moveToJapanese(pos, '6h5g')).toBe('△５七銀不成');
    const after = applyMove(pos, 'B*5g');
    expect(moveToJapanese(after, '4h5h', squareIndex(5, 6))).toBe('▲５八玉');
    expect(moveToJapanese(parseSfen(START), '7g7f')).toBe('▲７六歩');
    const p2 = applyMoves(parseSfen(START), ['7g7f', '3c3d']);
    expect(moveToJapanese(p2, '8h2b+')).toBe('▲２二角成');
    const p3 = applyMove(p2, '8h2b+');
    expect(moveToJapanese(p3, '3a2b', squareIndex(2, 1))).toBe('△同　銀');
  });
});
