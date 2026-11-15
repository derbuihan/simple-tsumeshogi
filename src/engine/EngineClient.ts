import { positionCommand, type EngineLike, type EnginePosition } from './types';
import { parseBestmove, parseInfo, type Score, type ThinkResult } from './usi';

export type EvalVariant = 'mini' | 'micro';

/** Emscripten が生成したモジュール（wasm_pre.js が追加する API を含む） */
interface YaneuraOuModule {
  addMessageListener(listener: (line: string) => void): void;
  postMessage(command: string): void;
  terminate(): void;
  FS: { mkdir(path: string): void; writeFile(path: string, data: Uint8Array): void };
}
type YaneuraOuFactory = (opts: Record<string, unknown>) => Promise<YaneuraOuModule>;

declare global {
  interface Window {
    YaneuraOu?: YaneuraOuFactory;
  }
}

const BASE = `${import.meta.env.BASE_URL}engine/`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * ブラウザ内のやねうら王 WASM を USI で操作するクライアント。
 *
 * - コマンドは1つずつ直列に実行する（queue）。
 * - 探索中でなければ moves / checks の応答は直後の1行（合法手が無ければ空行）。
 * - ⚠ isready は局面を初期化するので、初期化時以外は送らない。
 */
export class EngineClient implements EngineLike {
  private module: YaneuraOuModule | null = null;
  private listener: ((line: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  static async create(variant: EvalVariant): Promise<EngineClient> {
    if (typeof SharedArrayBuffer === 'undefined' || !crossOriginIsolated) {
      throw new Error('SharedArrayBuffer が使えません（COOP/COEP ヘッダーが必要です）');
    }
    const client = new EngineClient();
    await client.init(variant);
    return client;
  }

  private async init(variant: EvalVariant): Promise<void> {
    const [, nn, progress, options] = await Promise.all([
      window.YaneuraOu ? Promise.resolve() : loadScript(`${BASE}yaneuraou.${variant}.js`),
      fetchBytes(`${BASE}eval/${variant}/nn.bin`),
      fetchBytes(`${BASE}eval/${variant}/progress.bin`),
      fetchBytes(`${BASE}eval/${variant}/eval_options.txt`),
    ]);
    const factory = window.YaneuraOu;
    if (!factory) throw new Error('YaneuraOu factory not found');
    const module = await factory({
      locateFile: (file: string) => `${BASE}${file}`,
      mainScriptUrlOrBlob: `${BASE}yaneuraou.${variant}.js`,
    });
    module.FS.mkdir('/eval');
    module.FS.writeFile('/eval/nn.bin', nn);
    module.FS.writeFile('/eval/progress.bin', progress);
    module.FS.writeFile('/eval/eval_options.txt', options);
    module.addMessageListener((line) => this.listener?.(line));
    this.module = module;

    await this.exec(async () => {
      await this.sendAndWait('usi', (l) => l === 'usiok');
      for (const [name, value] of [
        ['Threads', '1'],
        ['USI_Hash', '16'],
        ['EvalDir', '/eval'],
        ['NetworkDelay', '0'],
        ['NetworkDelay2', '0'],
        ['MinimumThinkingTime', '100'],
      ]) {
        this.send(`setoption name ${name} value ${value}`);
      }
      await this.sendAndWait('isready', (l) => l === 'readyok');
    });
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

  terminate(): void {
    this.module?.terminate();
    this.module = null;
  }

  // ---- 内部 ----

  /** 前のコマンドが終わってから実行する */
  private exec<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private send(cmd: string): void {
    if (!this.module) throw new Error('engine not initialized');
    if (import.meta.env.DEV && localStorage.getItem('usiDebug')) console.debug('>', cmd);
    this.module.postMessage(cmd);
  }

  /** cmd を送り、pred が true を返す行が来るまで待つ */
  private sendAndWait(cmd: string, pred: (line: string) => boolean, timeoutMs = 60000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listener = null;
        reject(new Error(`engine timeout: ${cmd}`));
      }, timeoutMs);
      this.listener = (line) => {
        if (import.meta.env.DEV && localStorage.getItem('usiDebug')) console.debug('<', line);
        if (pred(line)) {
          clearTimeout(timer);
          this.listener = null;
          resolve();
        }
      };
      this.send(cmd);
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
