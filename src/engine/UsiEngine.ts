/** Emscripten が生成したモジュール（wasm_pre.js が追加する API を含む） */
export interface YaneuraOuModule {
  addMessageListener(listener: (line: string) => void): void;
  postMessage(command: string): void;
  terminate(): void;
  FS: { mkdir(path: string): void; writeFile(path: string, data: Uint8Array): void };
}
type YaneuraOuFactory = (opts: Record<string, unknown>) => Promise<YaneuraOuModule>;

/** ビルド時の EXPORT_NAME（engine/build.sh）。mini/micro と詰み専用エンジンで分けてある */
export type FactoryName = 'YaneuraOu' | 'YaneuraOuMate';

declare global {
  interface Window {
    YaneuraOu?: YaneuraOuFactory;
    YaneuraOuMate?: YaneuraOuFactory;
  }
}

export const ENGINE_BASE = `${import.meta.env.BASE_URL}engine/`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * ブラウザ内のやねうら王 WASM と USI でやり取りする土台。
 *
 * - コマンドは1つずつ直列に実行する（exec）。
 * - ⚠ isready は局面を初期化するので、初期化時以外は送らない。
 */
export class UsiEngine {
  private module: YaneuraOuModule | null = null;
  private listener: ((line: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  static assertIsolated(): void {
    if (typeof SharedArrayBuffer === 'undefined' || !crossOriginIsolated) {
      throw new Error('SharedArrayBuffer が使えません（COOP/COEP ヘッダーが必要です）');
    }
  }

  /** エンジンを読み込む。setup でファイルを置き、options を設定して isready まで済ませる */
  protected async boot(
    factoryName: FactoryName,
    script: string,
    options: [string, string][],
    setup?: (module: YaneuraOuModule) => void | Promise<void>,
  ): Promise<void> {
    if (!window[factoryName]) await loadScript(`${ENGINE_BASE}${script}`);
    const factory = window[factoryName];
    if (!factory) throw new Error(`${factoryName} factory not found`);
    const module = await factory({
      locateFile: (file: string) => `${ENGINE_BASE}${file}`,
      mainScriptUrlOrBlob: `${ENGINE_BASE}${script}`,
    });
    await setup?.(module);
    module.addMessageListener((line) => this.listener?.(line));
    this.module = module;

    await this.exec(async () => {
      await this.sendAndWait('usi', (l) => l === 'usiok');
      for (const [name, value] of options) this.send(`setoption name ${name} value ${value}`);
      await this.sendAndWait('isready', (l) => l === 'readyok');
    });
  }

  terminate(): void {
    this.module?.terminate();
    this.module = null;
  }

  /** 前のコマンドが終わってから実行する */
  protected exec<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  protected send(cmd: string): void {
    if (!this.module) throw new Error('engine not initialized');
    if (import.meta.env.DEV && localStorage.getItem('usiDebug')) console.debug('>', cmd);
    this.module.postMessage(cmd);
  }

  /** cmd を送り、pred が true を返す行が来るまで待つ */
  protected sendAndWait(cmd: string, pred: (line: string) => boolean, timeoutMs = 60000): Promise<void> {
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
}
