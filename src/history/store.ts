import { applyEvents, emptyHistory, type HistoryEvent, type Outcome, type Records, type StoredHistory } from './record';

const CACHE_KEY = 'tsume.history.v2';
const ID_KEY = 'tsume.historyId';
const API = `${import.meta.env.BASE_URL}api/history`;
/** 1回に送るイベントの最大数（サーバーの上限と合わせる） */
const BATCH = 500;

export type SyncState = 'synced' | 'pending' | 'offline';

interface Cache {
  /** サーバーにあるイベントだけを集計したもの。cursor までを取り込んである */
  server: StoredHistory;
  /** サーバーから取り込み済みの最後の seq（次はこれより後だけを取る） */
  cursor: number;
  /** サーバーにまだ届いていないイベント */
  pending: HistoryEvent[];
}

interface SyncResponse {
  events: HistoryEvent[];
  next: number;
  more: boolean;
}

/**
 * この端末の履歴 ID（推測できないランダムな UUID）。サーバーの保存先を分ける。
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
 * 解答履歴。サーバー（/api/history、D1）には追記専用のイベントが入り、集計はここで行う。
 *   - 記録は問題の挑戦が終わるたびに1件のイベントとして追記し、届かなければ次回まとめて再送する
 *   - 同期は差分だけ（前回の続きの seq より後）。送信の応答にも差分が付いてくる
 *   - 画面に出す records は「サーバーのイベントの集計 + まだ届いていないイベント」
 */
export class HistoryStore {
  private cache: Cache;
  /** 画面に出す集計（server + pending） */
  private view: StoredHistory;
  private syncing: Promise<void> | null = null;
  syncState: SyncState = 'pending';
  onChange: (() => void) | null = null;

  constructor() {
    this.cache = HistoryStore.read();
    this.view = this.rebuild();
  }

  get records(): Records {
    return this.view.records;
  }

  /** 起動時: 未送信分を送り、サーバーの続きを取り込む */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null;
      // 同期の最後の確認と終了の間に記録されたイベントを取りこぼさない（失敗中は繰り返さない）
      if (this.cache.pending.length && this.syncState !== 'offline') void this.sync();
    });
    return this.syncing;
  }

  /** 挑戦の結果を記録する */
  record(problemId: string, outcome: Outcome, moves?: number): void {
    const ev: HistoryEvent = { id: crypto.randomUUID(), problemId, outcome, moves, at: Date.now() };
    applyEvents(this.view, [ev]);
    this.cache.pending.push(ev);
    this.save();
    this.setState('pending');
    this.onChange?.();
    void this.sync();
  }

  /** 送るものが無くなり、サーバーの続きも無くなるまで繰り返す */
  private async doSync(): Promise<void> {
    try {
      let more = true;
      while (this.cache.pending.length || more) {
        const batch = this.cache.pending.slice(0, BATCH);
        const res = batch.length
          ? await fetch(API, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-history-id': historyId() },
              body: JSON.stringify({ events: batch, since: this.cache.cursor }),
            })
          : await fetch(`${API}?since=${this.cache.cursor}`, {
              headers: { accept: 'application/json', 'x-history-id': historyId() },
            });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as SyncResponse;
        // 送ったイベントは、この応答の events にサーバー側の分として入って返ってくる
        applyEvents(this.cache.server, body.events);
        this.cache.cursor = body.next;
        const sent = new Set(batch.map((e) => e.id));
        this.cache.pending = this.cache.pending.filter((e) => !sent.has(e.id));
        more = body.more;
        this.view = this.rebuild();
        this.save();
      }
      this.setState('synced');
    } catch {
      this.setState('offline');
    }
    this.onChange?.();
  }

  private rebuild(): StoredHistory {
    const h: StoredHistory = structuredClone(this.cache.server);
    applyEvents(h, this.cache.pending);
    return h;
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
      if (c?.server?.version === 1 && typeof c.cursor === 'number' && Array.isArray(c.pending)) return c;
    } catch {
      /* 壊れていたら初期化 */
    }
    return { server: emptyHistory(), cursor: 0, pending: [] };
  }
}
