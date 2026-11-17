import { positionCommand, type EnginePosition, type MateSolverLike, type MateVerdict } from './types';
import { UsiEngine } from './UsiEngine';

/** "checkmate 7g7f ..." の最初の手（詰み手順）。nomate / timeout / none などは手ではない */
const MOVE = /^([1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

/** checkmate 行の判定 */
export function parseCheckmate(line: string): MateVerdict {
  const first = line.split(/\s+/)[1] ?? '';
  if (first === 'nomate') return 'nomate';
  return MOVE.test(first) ? 'mate' : 'unknown';
}

/**
 * やねうら王の詰将棋エンジン版（df-pn）。攻方の手番の局面が王手の連続で詰むかを判定する。
 * ⚠ 玉方の手番の局面を渡すと、調べずに nomate を返す。
 * 計測（docs/engine-tuning.md）: 正しい手の判定は PC で最大100ms 未満。手数の上限なしでは、
 * 間違った王手の約2割がメモリ不足（none）で結論が出ない。
 */
export class MateClient extends UsiEngine implements MateSolverLike {
  static async create(): Promise<MateClient> {
    UsiEngine.assertIsolated();
    const client = new MateClient();
    // 既定は Threads 4・USI_Hash 1024 なので必ず設定し直す。DepthLimit 0 は手数の上限なし（遠回りの詰みも詰み）
    await client.boot('YaneuraOuMate', 'yaneuraou.mate.js', [
      ['Threads', '1'],
      ['USI_Hash', '64'],
      ['DepthLimit', '0'],
      ['PvInterval', '0'],
    ]);
    return client;
  }

  solve(pos: EnginePosition, timeoutMs: number): Promise<MateVerdict> {
    return this.exec(async () => {
      this.send(positionCommand(pos));
      let verdict: MateVerdict = 'unknown';
      await this.sendAndWait(`go mate ${Math.max(1, Math.round(timeoutMs))}`, (line) => {
        if (!line.startsWith('checkmate')) return false;
        verdict = parseCheckmate(line);
        return true;
      });
      return verdict;
    });
  }
}
