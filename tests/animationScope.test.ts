import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimationScope } from '../src/ui/effects/animationScope';

/** WAAPI の Animation の代わり。finish() で再生を終え、cancel() で finished を reject する */
class FakeAnimation {
  playState: AnimationPlayState = 'running';
  readonly finished: Promise<unknown>;
  private settle!: { resolve(): void; reject(e: unknown): void };
  constructor() {
    this.finished = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.finished.catch(() => undefined);
  }
  finish(): void {
    this.playState = 'finished';
    this.settle.resolve();
  }
  cancel = vi.fn(() => {
    this.playState = 'idle';
    this.settle.reject(new DOMException('cancelled', 'AbortError'));
  });
  pause = vi.fn(() => {
    this.playState = 'paused';
  });
  play = vi.fn(() => {
    this.playState = 'running';
  });
}

function fakeElement() {
  const animations: FakeAnimation[] = [];
  const el = {
    animations,
    animate: vi.fn(() => {
      const a = new FakeAnimation();
      animations.push(a);
      return a;
    }),
    remove: vi.fn(),
  };
  return el as typeof el & Element;
}

const frames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

describe('AnimationScope', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('最後まで再生したら true で解決する', async () => {
    const scope = new AnimationScope();
    const el = fakeElement();
    const done = scope.animate(el, frames, { duration: 100 });
    el.animations[0].finish();
    expect(await done).toBe(true);
  });

  it('cancel すると false で解決し、登録したアニメーションをすべて cancel する', async () => {
    const scope = new AnimationScope();
    const el = fakeElement();
    const a = scope.animate(el, frames, { duration: 100 });
    const b = scope.animate(el, frames, { duration: 100 });
    scope.cancel();
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(el.animations.every((x) => x.cancel.mock.calls.length === 1)).toBe(true);
    expect(scope.active).toBe(false);
    expect(scope.signal.aborted).toBe(true);
  });

  it('cancel の後の animate は再生せずに false を返す', async () => {
    const scope = new AnimationScope();
    scope.cancel();
    const el = fakeElement();
    expect(await scope.animate(el, frames, { duration: 100 })).toBe(false);
    expect(el.animate).not.toHaveBeenCalled();
  });

  it('wait は ms 後に true、途中で cancel したらすぐ false で解決する', async () => {
    const scope = new AnimationScope();
    const ok = scope.wait(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await ok).toBe(true);

    const cut = scope.wait(100);
    scope.cancel();
    expect(await cut).toBe(false);
    expect(await scope.wait(100)).toBe(false);
  });

  it('track した要素を cancel で取り除く。cancel は2回呼んでもよい', () => {
    const scope = new AnimationScope();
    const el = fakeElement();
    expect(scope.track(el)).toBe(el);
    scope.cancel();
    scope.cancel();
    expect(el.remove).toHaveBeenCalledTimes(1);
  });

  it('cancel の後に track した要素はすぐ取り除く', () => {
    const scope = new AnimationScope();
    scope.cancel();
    const el = fakeElement();
    scope.track(el);
    expect(el.remove).toHaveBeenCalledTimes(1);
  });

  it('pause / resume は再生中のアニメーションだけを止めて再開する', async () => {
    const scope = new AnimationScope();
    const el = fakeElement();
    const done = scope.animate(el, frames, { duration: 100 });
    void scope.animate(el, frames, { duration: 100 });
    el.animations[0].finish();
    await done;
    scope.pause();
    expect(el.animations[0].pause).not.toHaveBeenCalled();
    expect(el.animations[1].pause).toHaveBeenCalledTimes(1);
    scope.resume();
    expect(el.animations[1].play).toHaveBeenCalledTimes(1);
    expect(el.animations[1].playState).toBe('running');
  });

  it('別の scope のアニメーションは止めない', () => {
    const a = new AnimationScope();
    const b = new AnimationScope();
    const el = fakeElement();
    void a.animate(el, frames, { duration: 100 });
    void b.animate(el, frames, { duration: 100 });
    a.pause();
    a.cancel();
    expect(el.animations[1].pause).not.toHaveBeenCalled();
    expect(el.animations[1].cancel).not.toHaveBeenCalled();
  });
});
