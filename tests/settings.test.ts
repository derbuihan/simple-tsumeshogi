import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/settings';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
const saved = (v: unknown) => store.set('tsume.settings.v1', JSON.stringify(v));

describe('設定の読み込み', () => {
  beforeEach(() => store.clear());

  it('はじめは幽霊を出す', () => {
    expect(loadSettings().ghost).toBe(true);
    expect(DEFAULT_SETTINGS.ghost).toBe(true);
  });

  it('幽霊の設定が無い（入れる前に保存した）ときは出す', () => {
    saved({ lengths: [3], order: 'random', showLength: true, variant: 'micro', sound: false });
    expect(loadSettings()).toMatchObject({ lengths: [3], sound: false, ghost: true });
  });

  it('出さない設定を読み、壊れた値なら出す', () => {
    saved({ ghost: false });
    expect(loadSettings().ghost).toBe(false);
    saved({ ghost: 'no' });
    expect(loadSettings().ghost).toBe(true);
  });
});
