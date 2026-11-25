import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReviewHintSeen, saveReviewHintSeen } from '../src/ui/reviewHint';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

describe('振り返りのヒント', () => {
  beforeEach(() => store.clear());

  it('はじめは出す。手を送ったと保存したら、次からは出さない', () => {
    expect(loadReviewHintSeen()).toBe(false);
    saveReviewHintSeen();
    expect(loadReviewHintSeen()).toBe(true);
  });

  it('localStorage が使えなくても例外を投げず、ヒントを出す側に倒す', () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(loadReviewHintSeen()).toBe(false);
    expect(() => saveReviewHintSeen()).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
