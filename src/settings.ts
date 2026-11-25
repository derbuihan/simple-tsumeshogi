import type { EvalVariant } from './engine/EngineClient';

export type QuestionOrder = 'untried' | 'unsolved' | 'random' | 'solved';

export const ORDER_LABELS: Record<QuestionOrder, string> = {
  untried: '未挑戦の問題を優先',
  unsolved: '間違えた問題を優先',
  random: '完全ランダム',
  solved: '正解済みの問題を復習',
};

export interface Settings {
  lengths: number[];
  order: QuestionOrder;
  showLength: boolean;
  variant: EvalVariant;
  /** 駒音などの効果音 */
  sound: boolean;
  /** 盤の裏の幽霊を出す */
  ghost: boolean;
}

export const DEFAULT_SETTINGS: Settings = { lengths: [3, 5, 7], order: 'untried', showLength: false, variant: 'mini', sound: true, ghost: true };

/** 出題の現在位置 */
export interface Cursor {
  /** 未挑戦優先・ランダム: 手数ごとの「今の巻」 */
  current?: Record<string, number>;
}

const SETTINGS_KEY = 'tsume.settings.v1';
const CURSOR_KEY = 'tsume.cursor.v1';

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    if (!s) return { ...DEFAULT_SETTINGS };
    const lengths = Array.isArray(s.lengths) ? s.lengths.filter((n) => [3, 5, 7, 9, 11].includes(n)) : [];
    return {
      lengths: lengths.length ? lengths : DEFAULT_SETTINGS.lengths,
      order: s.order && s.order in ORDER_LABELS ? s.order : DEFAULT_SETTINGS.order,
      showLength: typeof s.showLength === 'boolean' ? s.showLength : DEFAULT_SETTINGS.showLength,
      variant: s.variant === 'micro' ? 'micro' : 'mini',
      sound: typeof s.sound === 'boolean' ? s.sound : DEFAULT_SETTINGS.sound,
      ghost: typeof s.ghost === 'boolean' ? s.ghost : DEFAULT_SETTINGS.ghost,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても（容量超過・プライベートモード）、この起動中は画面の設定のまま使える */
  }
}

export function loadCursor(): Cursor {
  try {
    const c = JSON.parse(localStorage.getItem(CURSOR_KEY) ?? 'null') as Cursor | null;
    if (c && typeof c === 'object') return { current: c.current };
  } catch {
    /* 壊れていたら初期化 */
  }
  return {};
}

export function saveCursor(c: Cursor): void {
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify(c));
  } catch {
    /* 保存できなくても出題は続けられる（次の起動で巻の位置が戻るだけ） */
  }
}
