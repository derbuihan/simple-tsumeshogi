import { describe, expect, it } from 'vitest';
import { parseCheckmate } from '../src/engine/MateClient';
import type { EngineLike, EnginePosition, MateSolverLike, MateVerdict } from '../src/engine/types';
import { parseInfo, type ThinkResult } from '../src/engine/usi';
import { parseProblemLine } from '../src/game/problem';
import { graceMoves, Session } from '../src/game/session';

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

/** 攻方の手番の局面（指し手列）ごとに判定を決めた詰み専用エンジンのモック。調べた局面を solved に残す */
function mockSolver(verdicts: Record<string, MateVerdict>): MateSolverLike & { solved: string[] } {
  const solved: string[] = [];
  return {
    solved,
    solve: async (pos) => {
      const key = pos.moves.join(' ');
      const v = verdicts[key];
      if (!v) throw new Error(`unexpected mate query: [${key}]`);
      solved.push(key);
      return v;
    },
  };
}

const cp = (value: number, bestmove: string): ThinkResult => ({ bestmove, score: { kind: 'cp', value }, pv: [] });

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
    // 乱数 0 → 猶予なしで、すぐ不正解
    const s = new Session(problem, engine, { random: () => 0 });
    await s.start();
    expect(await s.playAttacker('6h5g+')).toEqual({ kind: 'failure', reason: 'no-mate', missedAt: 1 });
    expect(s.moves).toEqual(['6h5g+']);
  });

  const cp = (value: number, bestmove: string): ThinkResult => ({ bestmove, score: { kind: 'cp', value }, pv: [bestmove] });

  it('惜しい逃し方なら猶予の手数だけ続けてから不正解（逃した手を覚えている）', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h3g'], think: cp(-2500, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
      '6h5g+ 4h5g B*6f': { legal: ['5g4h'], think: cp(-2400, '5g4h') },
      '6h5g+ 4h5g B*6f 5g4h': { checks: ['6f8h'] },
      '6h5g+ 4h5g B*6f 5g4h 6f8h': { legal: ['4h3h'], think: cp(-2300, '4h3h') },
    });
    // 乱数 0.99 → 最大の猶予（2手）
    const s = new Session(problem, engine, { random: () => 0.99 });
    await s.start();
    expect((await s.playAttacker('6h5g+')).kind).toBe('attacker-turn');
    expect((await s.playAttacker('B*6f')).kind).toBe('attacker-turn');
    expect(await s.playAttacker('6f8h')).toEqual({ kind: 'failure', reason: 'no-mate', missedAt: 1 });
    expect(s.moves).toEqual(['6h5g+', '4h5g', 'B*6f', '5g4h', '6f8h']);
  });

  it('猶予中に評価値が崩れたら猶予を残していても不正解', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: cp(-2500, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
      '6h5g+ 4h5g B*6f': { legal: ['5g4h'], think: cp(800, '5g4h') },
    });
    const s = new Session(problem, engine, { random: () => 0.99 });
    await s.start();
    await s.playAttacker('6h5g+');
    expect(await s.playAttacker('B*6f')).toEqual({ kind: 'failure', reason: 'no-mate', missedAt: 1 });
  });

  it('猶予中に本当に詰ませれば成功', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: cp(-2500, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
      '6h5g+ 4h5g B*6f': { legal: [] },
    });
    const s = new Session(problem, engine, { random: () => 0.5 });
    await s.start();
    await s.playAttacker('6h5g+');
    expect(await s.playAttacker('B*6f')).toEqual({ kind: 'success', moves: 3 });
  });

  it('猶予中に詰みが見つかれば（探索の見落とし）猶予を取り消して続行', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: cp(-2500, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
      '6h5g+ 4h5g B*6f': { legal: ['5g4h'], think: mated(2, '5g4h') },
      '6h5g+ 4h5g B*6f 5g4h': { checks: ['6f8h'] },
      '6h5g+ 4h5g B*6f 5g4h 6f8h': { legal: [] },
    });
    // 猶予1手。見落としでなければ2手目で不正解になるところ
    const s = new Session(problem, engine, { random: () => 0.3 });
    await s.start();
    await s.playAttacker('6h5g+');
    expect((await s.playAttacker('B*6f')).kind).toBe('attacker-turn');
    expect(await s.playAttacker('6f8h')).toEqual({ kind: 'success', moves: 5 });
  });

  it('猶予中に王手が無くなったら、理由は「詰みを逃した」', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g'], think: cp(-2500, '4h5g') },
      '6h5g+ 4h5g': { checks: [] },
    });
    const s = new Session(problem, engine, { random: () => 0.99 });
    await s.start();
    expect(await s.playAttacker('6h5g+')).toEqual({ kind: 'failure', reason: 'no-mate', missedAt: 1 });
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

describe('graceMoves', () => {
  const cpScore = (value: number) => ({ kind: 'cp' as const, value });
  it('明らかに逃した（玉方が互角以上・玉方が詰ます・探索結果なし）なら猶予なし', () => {
    for (const r of [0, 0.5, 0.99]) {
      expect(graceMoves(cpScore(500), r)).toBe(0);
      expect(graceMoves(cpScore(-200), r)).toBe(0);
      expect(graceMoves({ kind: 'mate', value: 9, sign: '+' }, r)).toBe(0);
      expect(graceMoves(null, r)).toBe(0);
    }
  });
  it('攻方が優勢なほど長く、最大2手', () => {
    const mean = (v: number) => {
      let sum = 0;
      for (let i = 0; i < 100; i++) sum += graceMoves(cpScore(v), i / 100);
      return sum / 100;
    };
    expect(mean(-600)).toBeLessThan(mean(-1500));
    expect(mean(-1500)).toBeLessThan(mean(-3000));
    for (let i = 0; i < 100; i++) expect(graceMoves(cpScore(-30000), i / 100)).toBeLessThanOrEqual(2);
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

describe('Session（詰み専用エンジンで判定）', () => {
  const problem = parseProblemLine('mate3/000/0', LINE);

  it('mini が詰みを見落としても、すべての応手で詰めば続行（遠回りの詰みも詰み）', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h5h'], think: cp(-900, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
    });
    const solver = mockSolver({ '6h5g+ 4h5g': 'mate', '6h5g+ 4h5h': 'mate' });
    const s = new Session(problem, engine, { mateSolver: solver, random: () => 0 });
    await s.start();
    expect((await s.playAttacker('6h5g+')).kind).toBe('attacker-turn');
    expect(solver.solved).toEqual(['6h5g+ 4h5g', '6h5g+ 4h5h']);
  });

  it('mini が詰みと読んでも、詰まない応手があれば詰みを逃した', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h5h'], think: mated(9, '4h5g') },
    });
    const solver = mockSolver({ '6h5g+ 4h5g': 'mate', '6h5g+ 4h5h': 'nomate' });
    const s = new Session(problem, engine, { mateSolver: solver, random: () => 0.99 });
    await s.start();
    expect(await s.playAttacker('6h5g+')).toEqual({ kind: 'failure', reason: 'no-mate', missedAt: 1 });
  });

  it('猶予中は、mini の最善手が詰む応手なら、詰まない応手で応じる', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h5h'], think: cp(-2500, '4h5g') },
      '6h5g+ 4h5h': { checks: ['B*6f'] },
    });
    const solver = mockSolver({ '6h5g+ 4h5g': 'mate', '6h5g+ 4h5h': 'nomate' });
    const s = new Session(problem, engine, { mateSolver: solver, random: () => 0.99 });
    await s.start();
    const replies: string[] = [];
    expect((await s.playAttacker('6h5g+', (m) => replies.push(m))).kind).toBe('attacker-turn');
    expect(replies).toEqual(['4h5h']);
  });

  it('mini の最善手が詰まない応手なら、そのまま応じる', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h5h'], think: cp(-2500, '4h5h') },
      '6h5g+ 4h5h': { checks: ['B*6f'] },
    });
    const solver = mockSolver({ '6h5g+ 4h5g': 'nomate', '6h5g+ 4h5h': 'nomate' });
    const s = new Session(problem, engine, { mateSolver: solver, random: () => 0.99 });
    await s.start();
    const replies: string[] = [];
    await s.playAttacker('6h5g+', (m) => replies.push(m));
    expect(replies).toEqual(['4h5h']);
  });

  it('結論が出なければ mini の探索結果で決める', async () => {
    const tree = (think: ThinkResult) =>
      mockEngine({
        '': { checks: ['6h5g+'] },
        '6h5g+': { legal: ['4h5g', '4h5h'], think },
        '6h5g+ 4h5g': { checks: ['B*6f'] },
      });
    const solver = () => mockSolver({ '6h5g+ 4h5g': 'mate', '6h5g+ 4h5h': 'unknown' });
    const a = new Session(problem, tree(mated(4, '4h5g')), { mateSolver: solver(), random: () => 0 });
    await a.start();
    expect((await a.playAttacker('6h5g+')).kind).toBe('attacker-turn');
    const b = new Session(problem, tree(cp(-100, '4h5g')), { mateSolver: solver(), random: () => 0 });
    await b.start();
    expect(await b.playAttacker('6h5g+')).toEqual({ kind: 'failure', reason: 'no-mate', missedAt: 1 });
  });

  it('持ち時間を使い切ったら、残りの応手は調べず unknown', async () => {
    const engine = mockEngine({
      '': { checks: ['6h5g+'] },
      '6h5g+': { legal: ['4h5g', '4h5h'], think: mated(4, '4h5g') },
      '6h5g+ 4h5g': { checks: ['B*6f'] },
    });
    const slow: MateSolverLike & { solved: string[] } = {
      solved: [],
      async solve(pos, timeoutMs) {
        this.solved.push(pos.moves.join(' '));
        await new Promise((r) => setTimeout(r, timeoutMs + 5));
        return 'unknown';
      },
    };
    const s = new Session(problem, engine, { mateSolver: slow, movetimeMs: () => 20, random: () => 0 });
    await s.start();
    expect((await s.playAttacker('6h5g+')).kind).toBe('attacker-turn');
    expect(slow.solved).toEqual(['6h5g+ 4h5g']);
  });
});

describe('parseCheckmate', () => {
  it('詰み手順・不詰・結論なし', () => {
    expect(parseCheckmate('checkmate 7g7f 3c3d G*2b')).toBe('mate');
    expect(parseCheckmate('checkmate G*5b')).toBe('mate');
    expect(parseCheckmate('checkmate 2c2b+')).toBe('mate');
    expect(parseCheckmate('checkmate nomate')).toBe('nomate');
    expect(parseCheckmate('checkmate timeout')).toBe('unknown');
    expect(parseCheckmate('checkmate none')).toBe('unknown');
  });
});
