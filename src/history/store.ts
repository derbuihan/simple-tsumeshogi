import { applyEvents, emptyHistory, type HistoryEvent, type Outcome, type Records, type StoredHistory } from './record';

const CACHE_KEY = 'tsume.history.v1';
const ID_KEY = 'tsume.historyId';
const API = `${import.meta.env.BASE_URL}api/history`;

export type SyncState = 'synced' | 'pending' | 'offline';

interface Cache {
  history: StoredHistory;
  /** サーバーにまだ届いていないイベント */
  pending: HistoryEvent[];
}

/**
 * この端末の履歴 ID（推測できないランダムな UUID）。サーバーの保存キーになる。
 * localStorage を消すと別の履歴になる。localStorage が使えないときはページを開いている間だけ有効。
 */
let memoryId: string | null = null;
function historyId(): string {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) localStorage.setItem(ID_KEY, (id = crypto.randomUUID()));
    return id;
  } catch {
    return (memoryId ??= crypto.randomUUID());
  }
}

/**
 * 解答履歴。localStorage にキャッシュし、Cloudflare KV（/api/history）と同期する。
 * 記録は問題の挑戦が終わるたびに1件のイベントとして追記し、届かなければ次回まとめて再送する。
 */
export class HistoryStore {
  private cache: Cache;
  private flushing: Promise<void> | null = null;
  syncState: SyncState = 'pending';
  onChange: (() => void) | null = null;

  constructor() {
    this.cache = HistoryStore.read();
  }

  get records(): Records {
    return this.cache.history.records;
  }

  /** 起動時: 未送信分を送ってからサーバーの最新を取得する */
  async sync(): Promise<void> {
    await this.flush();
    if (this.cache.pending.length) return;
    try {
      const res = await fetch(API, { headers: { accept: 'application/json', 'x-history-id': historyId() } });
      if (!res.ok) throw new Error(String(res.status));
      const { records } = (await res.json()) as { records: Records };
      this.cache.history.records = records;
      this.setState('synced');
      this.save();
    } catch {
      this.setState('offline');
    }
  }

  /** 挑戦の結果を記録する */
  record(problemId: string, outcome: Outcome, moves?: number): void {
    const ev: HistoryEvent = { id: crypto.randomUUID(), problemId, outcome, moves, at: Date.now() };
    applyEvents(this.cache.history, [ev]);
    this.cache.pending.push(ev);
    this.save();
    this.onChange?.();
    void this.flush();
  }

  private flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    while (this.cache.pending.length) {
      const batch = this.cache.pending.slice(0, 500);
      try {
        const res = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-history-id': historyId() },
          body: JSON.stringify({ events: batch }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const { records } = (await res.json()) as { records: Records };
        const sent = new Set(batch.map((e) => e.id));
        this.cache.pending = this.cache.pending.filter((e) => !sent.has(e.id));
        // サーバーの結果に、送信中に増えた未送信分を重ねる
        const h: StoredHistory = { ...emptyHistory(), records };
        applyEvents(h, this.cache.pending);
        this.cache.history.records = h.records;
        this.save();
      } catch {
        this.setState('offline');
        return;
      }
    }
    this.setState('synced');
  }

  private setState(s: SyncState): void {
    if (this.syncState === s) return;
    this.syncState = s;
    this.onChange?.();
  }

  private save(): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this.cache));
    } catch {
      /* 容量超過などは無視（サーバー側に残る） */
    }
  }

  private static read(): Cache {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Cache | null;
      if (c?.history?.version === 1 && Array.isArray(c.pending)) return c;
    } catch {
      /* 壊れていたら初期化 */
    }
    return { history: emptyHistory(), pending: [] };
  }
}
