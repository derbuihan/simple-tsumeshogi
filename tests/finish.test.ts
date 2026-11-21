import { describe, expect, it } from 'vitest';
import { finishOf } from '../src/game/finish';
import { parseSfen } from '../src/shogi/sfen';
import { squareIndex } from '../src/shogi/types';

// 指し手の合法性は見ないので、局面は判定に必要な駒だけを置く
describe('finishOf', () => {
  it('頭金：後手の玉の真正面（段が増える側）に金を打つ', () => {
    const f = finishOf(parseSfen('4k4/9/4P4/9/9/9/9/9/4K4 b G 1'), ['G*5b']);
    expect(f.headGold).toBe(true);
    expect(f.promote).toBe(false);
    expect(f.lastPiece).toEqual({ color: 'b', type: 'G', promoted: false });
  });

  it('頭金：先手の玉なら、段が減る側が真正面', () => {
    const f = finishOf(parseSfen('4k4/9/9/9/9/9/4p4/9/4K4 w g 1'), ['G*5h']);
    expect(f.headGold).toBe(true);
  });

  it('玉の横や斜めへの金、成金、玉の後ろへの金は頭金ではない', () => {
    expect(finishOf(parseSfen('4k4/9/9/9/9/9/9/9/4K4 b G 1'), ['G*4b']).headGold).toBe(false);
    expect(finishOf(parseSfen('9/4k4/9/9/9/9/9/9/4K4 b G 1'), ['G*5a']).headGold).toBe(false);
    expect(finishOf(parseSfen('4k4/9/4S4/9/9/9/9/9/4K4 b - 1'), ['5c5b+']).headGold).toBe(false);
  });

  it('成って詰み', () => {
    const f = finishOf(parseSfen('4k4/9/4S4/9/9/9/9/9/4K4 b - 1'), ['5c5b+']);
    expect(f.promote).toBe(true);
    expect(f.lastPiece).toEqual({ color: 'b', type: 'S', promoted: true });
  });

  it('捨て駒：玉方に取らせた攻方の駒を、取られた順に返す', () => {
    // 飛車を打って玉に取らせ、その後に頭金
    const f = finishOf(parseSfen('4k4/9/9/9/9/9/9/9/4K4 b RG 1'), ['R*5b', '5a5b', 'G*5c']);
    expect(f.sacrifices).toEqual(['R']);
    expect(f.headGold).toBe(true);
  });

  it('捨て駒：玉以外の駒が取っても数える。成駒は元の種類で返す', () => {
    const f = finishOf(parseSfen('3gk4/9/4+P4/9/9/9/9/9/4K4 b G 1'), ['5c5b', '6a5b', 'G*4b']);
    expect(f.sacrifices).toEqual(['P']);
  });

  it('合駒を取った：打った合駒も、動かした合駒も', () => {
    // 飛車の王手に歩を打って合駒し、それを取る
    const dropped = finishOf(parseSfen('4k4/9/9/9/9/9/9/9/K8 b RG2p 1'), ['R*5e', 'P*5c', '5e5c', '5a4a', 'G*4b']);
    expect(dropped.takenInterpositions).toEqual([squareIndex(5, 2)]);
    // 銀を動かして合駒し、それを取る
    const moved = finishOf(parseSfen('4k4/3s5/9/9/9/9/9/9/K8 b RG 1'), ['R*5e', '6b5c', '5e5c', '5a4a', 'G*4b']);
    expect(moved.takenInterpositions).toEqual([squareIndex(5, 2)]);
  });

  it('合駒を取らなかったときや、玉が逃げただけのときは数えない', () => {
    const f = finishOf(parseSfen('4k4/9/9/9/9/9/9/9/K8 b R2G2p 1'), ['R*5e', 'P*5c', 'G*4b', '5a6a', 'G*6b']);
    expect(f.takenInterpositions).toEqual([]);
    const fled = finishOf(parseSfen('4k4/9/9/9/9/9/9/9/K8 b RG 1'), ['R*5e', '5a4a', '5e4e']);
    expect(fled.takenInterpositions).toEqual([]);
    expect(fled.sacrifices).toEqual([]);
  });

  it('実際の問題（mate3/001/0：2d2h 3h4i B*3h）', () => {
    const f = finishOf(parseSfen('6g2/4p1s2/2+Ppgp1+L1/7+R1/PG6p/LpPP5/1G2P1S1P/1K3Sk2/1N2S4 b Brb3n2l7p 165'), ['2d2h', '3h4i', 'B*3h']);
    expect(f).toEqual({ promote: false, headGold: false, sacrifices: [], takenInterpositions: [], lastPiece: { color: 'b', type: 'B', promoted: false } });
  });
});
