/**
 * 解答履歴。ブラウザ（src/history/store.ts）と Worker（worker/index.ts）で共有する。
 * 依存の無い純粋な TypeScript に保つこと。
 */

/** 1回の挑戦の結果 */
export type Outcome =
  /** 自力で最短手数で詰ませた */
  | 'shortest'
  /** 自力で詰ませた（最短より長い） */
  | 'clear'
  /** 解答を見た後に詰ませた */
  | 'clear-after-viewing'
  /** 詰みを逃した */
  | 'fail'
  /** 解けずに解答を見た */
  | 'giveup';

export interface HistoryEvent {
  /** 重複適用を防ぐための一意な ID */
  id: string;
  problemId: string;
  outcome: Outcome;
  /** 詰ませた手数（クリア時のみ） */
  moves?: number;
  /** epoch ms */
  at: number;
}

export interface ProblemRecord {
  /** 挑戦回数（ギブアップを含む） */
  attempts: number;
  /** 自力クリア回数（最短を含む） */
  clears: number;
  /** 自力で最短手数クリアした回数 */
  shortest: number;
  /** 解答閲覧後のクリア回数 */
  clearsAfterViewing: number;
  fails: number;
  giveups: number;
  /** 最短の詰み手数（クリアした中で） */
  bestMoves?: number;
  firstClearAt?: number;
  lastAt: number;
  lastOutcome: Outcome;
}

export type Records = Record<string, ProblemRecord>;

const isClear = (o: Outcome) => o === 'shortest' || o === 'clear' || o === 'clear-after-viewing';

/** イベントを1件適用する（records を直接更新する） */
export function applyEvent(records: Records, ev: HistoryEvent): void {
  const r: ProblemRecord = records[ev.problemId] ?? {
    attempts: 0,
    clears: 0,
    shortest: 0,
    clearsAfterViewing: 0,
    fails: 0,
    giveups: 0,
    lastAt: 0,
    lastOutcome: ev.outcome,
  };
  r.attempts++;
  switch (ev.outcome) {
    case 'shortest':
      r.shortest++;
      r.clears++;
      break;
    case 'clear':
      r.clears++;
      break;
    case 'clear-after-viewing':
      r.clearsAfterViewing++;
      break;
    case 'fail':
      r.fails++;
      break;
    case 'giveup':
      r.giveups++;
      break;
  }
  if (isClear(ev.outcome)) {
    if (ev.moves !== undefined && (r.bestMoves === undefined || ev.moves < r.bestMoves)) r.bestMoves = ev.moves;
    r.firstClearAt ??= ev.at;
  }
  if (ev.at >= r.lastAt) {
    r.lastAt = ev.at;
    r.lastOutcome = ev.outcome;
  }
  records[ev.problemId] = r;
}

export type ProblemStatus = 'untried' | 'unsolved' | 'solved';

/**
 * - untried: 履歴なし（解答を見ただけでも挑戦済み扱い）
 * - unsolved: 挑戦したが自力で解けていない（誤答優先の対象）
 * - solved: 自力で解いたことがある（後で間違えても記録は消えない）
 */
export function problemStatus(r: ProblemRecord | undefined): ProblemStatus {
  if (!r) return 'untried';
  return r.clears > 0 ? 'solved' : 'unsolved';
}

/** KV に保存する形 */
export interface StoredHistory {
  version: 1;
  records: Records;
  /** 直近に適用したイベント ID（再送による二重適用を防ぐ） */
  recentEventIds: string[];
}

export const RECENT_EVENT_LIMIT = 1000;

export const emptyHistory = (): StoredHistory => ({ version: 1, records: {}, recentEventIds: [] });

/** 未適用のイベントだけを適用する。適用した件数を返す */
export function applyEvents(h: StoredHistory, events: readonly HistoryEvent[]): number {
  const seen = new Set(h.recentEventIds);
  let n = 0;
  for (const ev of events) {
    if (!isValidEvent(ev) || seen.has(ev.id)) continue;
    applyEvent(h.records, ev);
    seen.add(ev.id);
    h.recentEventIds.push(ev.id);
    n++;
  }
  if (h.recentEventIds.length > RECENT_EVENT_LIMIT) h.recentEventIds.splice(0, h.recentEventIds.length - RECENT_EVENT_LIMIT);
  return n;
}

const OUTCOMES = new Set<Outcome>(['shortest', 'clear', 'clear-after-viewing', 'fail', 'giveup']);

export function isValidEvent(ev: unknown): ev is HistoryEvent {
  if (!ev || typeof ev !== 'object') return false;
  const e = ev as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 64 &&
    typeof e.problemId === 'string' &&
    /^mate\d+\/\d{3}\/\d+$/.test(e.problemId) &&
    OUTCOMES.has(e.outcome as Outcome) &&
    typeof e.at === 'number' &&
    (e.moves === undefined || (typeof e.moves === 'number' && e.moves > 0))
  );
}
