import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Like, D1StatementLike } from '../src/history/api';

/** node:sqlite で D1 の代わりを作る（migrations/ の SQL をそのまま流す） */
export const memoryD1 = () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_history_events.sql', 'utf8'));
  const stmt = (sql: string, values: unknown[] = []): D1StatementLike => ({
    bind: (...v) => stmt(sql, v),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
    run: () => sqlite.prepare(sql).run(...(values as never[])),
  } as D1StatementLike & { run(): unknown });
  const db: D1Like = {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      sqlite.exec('BEGIN');
      try {
        for (const s of list) (s as unknown as { run(): unknown }).run();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return [];
    },
  };
  return { db, count: () => (sqlite.prepare('SELECT COUNT(*) AS n FROM history_events').get() as { n: number }).n };
};
