import { describe, expect, it } from 'vitest';
import type { EngineLike, EnginePosition } from '../src/engine/types';
import { parseInfo, type ThinkResult } from '../src/engine/usi';
import { parseProblemLine } from '../src/game/problem';
import { Session } from '../src/game/session';

// mate3/000.txt の1問目（後手が攻方、解: B*5g 4h5h 7i6i）
const LINE =
  'ln1gkg1nl/6+P2/2sppps1p/2p3p2/p8/P1P1P3P/2NP1PP2/3s1KSR1/L1+b2G1NL w R2Pbgp 42 moves B*5g 4h5h 7i6i';

type Node = { checks?: string[]; legal?: string[]; think?: ThinkResult };

/** 指し手列ごとに応答を決めたモックエンジン */
function mockEngine(tree: Record<string, Node>): EngineLike {
  const at = (pos: EnginePosition) => {
    const node = tree[pos.moves.join(' ')];
    if (!node) throw new Error(`unexpected position: [${pos.moves.join(' ')}]`);
    return node;
  };
  return {
    checks: async (pos) => at(pos).checks ?? [],
    legalMoves: async (pos) => at(pos).legal ?? [],
    think: async (pos) => at(pos).think!,
  };
}

const mated = (n: number, bestmove: string): ThinkResult => ({
  bestmove,
  score: { kind: 'mate', value: -n, sign: '-' },
  pv: [bestmove],
});

describe('parseProblemLine', () => {
  it('SFEN・手順・攻方', () => {
    const p = parseProblemLine('mate3/000/0', LINE);
    expect(p.length).toBe(3);
    expect(p.solution).toEqual(['B*5g', '4h5h', '7i6i']);
    expect(p.attacker).toBe('w');
  });
});

describe('Session', () => {
  const problem = parseProblemLine('mate3/000/0', LINE);

  it('収録解どおりで成功', async () => {
    const engine = mockEngine({
      '': { checks: ['B*5g', '6h5g+'] },
      'B*5g': { legal: ['4h5h'], think: mated(2, '4h5h') },
      'B*5g 4h5h': { checks: ['7i6i', '5g4h+'] },
      'B*5g 4h5h 7i6i': { legal: [] },
    });
    const s = new Session(problem, engine);
    expect(await s.start()).toEqual({ kind: 'attacker-turn', checks: ['B*5g', '6h5g+'] });
    const replies: string[] = [];
    expect((await s.playAttacker('B*5g', (m) => replies.push(m))).kind).toBe('attacker-turn');
    expect(replies).toEqual(['4h5h']);
    expect(await s.playAttacker('7i6i')).toEqual({ kind: 'success', moves: 3 });
    expect(s.moves).toEqual(['B*5g', '4h5h', '7i6i']);
  });

  it('遠回りでも詰めば成功（3手詰を5手で）', async () => {
    const engine = mockEngine({
      '': { checks: ['B*5g', '6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h3g'], think: mated(4, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
      '6h5g+ 4h5g B*6f': { legal: ['5g4h'], think: mated(2, '5g4h') },
      '6h5g+ 4h5g B*6f 5g4h': { checks: ['6f8h'] },
      '6h5g+ 4h5g B*6f 5g4h 6f8h': { legal: [] },
    });
    const s = new Session(problem, engine);
    await s.start();
    await s.playAttacker('6h5g+');
    await s.playAttacker('B*6f');
    expect(await s.playAttacker('6f8h')).toEqual({ kind: 'success', moves: 5 });
  });

  it('詰みが見つからなければ不正解（局面は残す）', async () => {
    const engine = mockEngine({
      '': { checks: ['B*5g', '6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: { bestmove: '4h5g', score: { kind: 'cp', value: -1200 }, pv: [] } },
    });
    const s = new Session(problem, engine);
    await s.start();
    expect(await s.playAttacker('6h5g+')).toEqual({ kind: 'failure', reason: 'no-mate' });
    expect(s.moves).toEqual(['6h5g+']);
  });

  it('探索結果が無い（時間切れ相当）も不正解', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: { bestmove: '4h5g', score: null, pv: [] } },
    });
    const s = new Session(problem, engine);
    await s.start();
    expect((await s.playAttacker('6h5g+')).kind).toBe('failure');
  });

  it('王手が無くなったら不正解', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: mated(2, '4h5g') },
      '6h5g+ 4h5g': { checks: [] },
    });
    const s = new Session(problem, engine);
    await s.start();
    expect(await s.playAttacker('6h5g+')).toEqual({ kind: 'failure', reason: 'no-checks' });
  });

  it('王手以外は指せない', async () => {
    const s = new Session(problem, mockEngine({ '': { checks: ['B*5g'] } }));
    await s.start();
    await expect(s.playAttacker('9f9e')).rejects.toThrow();
  });

  it('連続王手の千日手（同一局面4回）は不正解', async () => {
    // 角の王手 → 玉が逃げる → 角を戻して王手 → 玉が戻る … を繰り返す想定のモック
    const tree: Record<string, Node> = {};
    const seq: string[] = [];
    // 局面を同じにするため、実際の盤面上で往復できる手を使う: 1手目だけ打ち、以後は 5g4f / 5h4h / 4f5g / 4h5h
    const moves = ['B*5g', '4h5h', '5g4f', '5h4h', '4f5g', '4h5h', '5g4f', '5h4h', '4f5g', '4h5h', '5g4f', '5h4h', '4f5g', '4h5h'];
    for (let i = 0; i < moves.length; i += 2) {
      tree[seq.join(' ')] = { checks: [moves[i]] };
      seq.push(moves[i]);
      tree[seq.join(' ')] = { legal: [moves[i + 1]], think: mated(9, moves[i + 1]) };
      seq.push(moves[i + 1]);
    }
    tree[seq.join(' ')] = { checks: ['5g4f'] };
    const s = new Session(problem, mockEngine(tree));
    let st = await s.start();
    let n = 0;
    while (st.kind === 'attacker-turn' && n++ < 20) st = await s.playAttacker(st.checks[0]);
    expect(st).toEqual({ kind: 'failure', reason: 'repetition' });
  });
});

describe('parseInfo', () => {
  it('score mate / cp / pv', () => {
    expect(parseInfo('info depth 15 seldepth 4 score mate -3 nodes 10 pv 4h5h 7i6i')).toEqual({
      score: { kind: 'mate', value: -3, sign: '-' },
      pv: ['4h5h', '7i6i'],
    });
    expect(parseInfo('info depth 3 score cp 120 upperbound pv 7g7f')?.score).toEqual({ kind: 'cp', value: 120 });
    expect(parseInfo('info string loading')).toBeNull();
    expect(parseInfo('info depth 1 score mate -0')?.score).toMatchObject({ kind: 'mate', sign: '-' });
  });
});
