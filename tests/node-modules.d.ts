// テストで使う Node 標準モジュールの最小の型（@types/node を入れずに済ませる）
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: never[]): unknown[];
      get(...params: never[]): unknown;
      run(...params: never[]): unknown;
    };
  }
}
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
