import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHistory } from '../src/history/api';
import { HistoryStore } from '../src/history/store';
import { memoryD1 } from './d1';

// HistoryStore はブラウザ向けなので、localStorage・fetch を差し替えて動かす
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
});

let db = memoryD1();
let online = true;
let requests = 0;
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  requests++;
  if (!online) throw new TypeError('offline');
  return handleHistory(new Request(new URL(url, 'http://x'), init), db.db);
});

const settle = async (s: HistoryStore) => {
  await new Promise((r) => setTimeout(r, 20));
  await s.sync();
};

beforeEach(() => {
  storage.clear();
  db = memoryD1();
  online = true;
  requests = 0;
});

describe('HistoryStore', () => {
  it('記録するとすぐ画面用の集計に反映され、同期するとサーバーに届く', async () => {
    const s = new HistoryStore();
    s.record('mate3/000/1', 'shortest', 3);
    expect(s.records['mate3/000/1'].attempts).toBe(1);
    await settle(s);
    expect(s.syncState).toBe('synced');
    expect(db.count()).toBe(1);
    expect(s.records['mate3/000/1'].attempts).toBe(1); // 二重に数えない
  });

  it('別の端末は、同じ履歴 ID でサーバーの分を取り込める', async () => {
    const a = new HistoryStore();
    a.record('mate3/000/1', 'shortest', 3);
    a.record('mate3/000/2', 'fail');
    await settle(a);
    const id = storage.get('tsume.historyId')!;
    storage.clear();
    storage.set('tsume.historyId', id);
    const b = new HistoryStore();
    await b.sync();
    expect(Object.keys(b.records).sort()).toEqual(['mate3/000/1', 'mate3/000/2']);
    await b.sync();
    expect(b.records['mate3/000/1'].attempts).toBe(1);
  });

  it('オフラインの記録は残り、復帰したときにまとめて届く', async () => {
    const s = new HistoryStore();
    online = false;
    s.record('mate3/000/1', 'clear', 3);
    await settle(s);
    expect(s.syncState).toBe('offline');
    expect(s.records['mate3/000/1'].attempts).toBe(1);
    expect(db.count()).toBe(0);
    online = true;
    await s.sync();
    expect(s.syncState).toBe('synced');
    expect(db.count()).toBe(1);
    expect(s.records['mate3/000/1'].attempts).toBe(1);
  });

  it('再読み込みしても（キャッシュから）続きだけを取る', async () => {
    const a = new HistoryStore();
    a.record('mate3/000/1', 'shortest', 3);
    await settle(a);
    const b = new HistoryStore();
    expect(b.records['mate3/000/1'].attempts).toBe(1);
    requests = 0;
    await b.sync();
    expect(requests).toBe(1);
    expect(b.records['mate3/000/1'].attempts).toBe(1);
  });
});
