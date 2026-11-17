import { positionCommand, type EngineLike, type EnginePosition } from './types';
import { ENGINE_BASE, fetchBytes, UsiEngine } from './UsiEngine';
import { parseBestmove, parseInfo, type Score, type ThinkResult } from './usi';

export type EvalVariant = 'mini' | 'micro';

/**
 * 通常探索のやねうら王（つようら王11mini/micro）。玉方の応手・評価値と、王手・合法手の列挙に使う。
 * 探索中でなければ moves / checks の応答は直後の1行（合法手が無ければ空行）。
 */
export class EngineClient extends UsiEngine implements EngineLike {
  static async create(variant: EvalVariant): Promise<EngineClient> {
    UsiEngine.assertIsolated();
    const client = new EngineClient();
    // 評価関数はエンジン本体の読み込みと並行して取得する
    const files = ['nn.bin', 'progress.bin', 'eval_options.txt'];
    const fetched = Promise.all(files.map((f) => fetchBytes(`${ENGINE_BASE}eval/${variant}/${f}`)));
    fetched.catch(() => undefined);
    await client.boot(
      'YaneuraOu',
      `yaneuraou.${variant}.js`,
      [
        ['Threads', '4'],
        ['USI_Hash', '16'],
        ['EvalDir', '/eval'],
        ['NetworkDelay', '0'],
        ['NetworkDelay2', '0'],
        ['MinimumThinkingTime', '100'],
      ],
      async (module) => {
        const data = await fetched;
        module.FS.mkdir('/eval');
        files.forEach((f, i) => module.FS.writeFile(`/eval/${f}`, data[i]));
      },
    );
    return client;
  }

  checks(pos: EnginePosition): Promise<string[]> {
    return this.exec(() => this.queryLine(pos, 'checks'));
  }

  legalMoves(pos: EnginePosition): Promise<string[]> {
    return this.exec(() => this.queryLine(pos, 'moves'));
  }

  think(pos: EnginePosition, movetimeMs: number): Promise<ThinkResult> {
    return this.exec(async () => {
      this.send(positionCommand(pos));
      let score: Score | null = null;
      let pv: string[] = [];
      let bestmove: string | null = null;
      await this.sendAndWait(`go movetime ${movetimeMs}`, (line) => {
        const info = parseInfo(line);
        if (info) {
          if (info.score) score = info.score;
          if (info.pv.length) pv = info.pv;
        }
        bestmove = parseBestmove(line);
        return bestmove !== null;
      });
      return { bestmove: bestmove!, score, pv };
    });
  }

  private async queryLine(pos: EnginePosition, cmd: 'checks' | 'moves'): Promise<string[]> {
    this.send(positionCommand(pos));
    let result: string[] = [];
    await this.sendAndWait(cmd, (line) => {
      result = line.trim().split(/\s+/).filter(Boolean);
      return true;
    });
    return result;
  }
}
