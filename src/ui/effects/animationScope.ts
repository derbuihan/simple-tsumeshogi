/**
 * 1つの局面の演出が持つもの（Animation・待ち時間・演出用の一時的な DOM）をまとめて管理する。
 * 局面が変わったら cancel して捨て、新しい scope を作る。
 *
 * WAAPI を薄く包むだけで、補間やタイムラインは自作しない。
 * cancel されても Promise は reject せず false で解決するので、呼び出し側は `if (!(await ...)) return` で抜ける。
 */
export class AnimationScope {
  private readonly animations = new Set<Animation>();
  private readonly nodes = new Set<Element>();
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get active(): boolean {
    return !this.signal.aborted;
  }

  /** 再生して登録する。最後まで再生されたら true、cancel されたら（途中で中断されても）false */
  animate(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    const animation = el.animate(frames, options);
    this.animations.add(animation);
    return animation.finished.then(
      () => {
        this.animations.delete(animation);
        return this.active;
      },
      () => false,
    );
  }

  /** ms 待つ。cancel されたらすぐ false で解決する */
  wait(ms: number): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', done);
        resolve(true);
      }, ms);
      this.signal.addEventListener('abort', done, { once: true });
    });
  }

  /** 演出用の一時的な DOM を登録する。cancel したときに取り除く */
  track<T extends Element>(el: T): T {
    if (this.active) this.nodes.add(el);
    else el.remove();
    return el;
  }

  /** この scope の再生中のアニメーションだけを止める（ヒットストップ） */
  pause(): void {
    for (const a of this.animations) if (a.playState === 'running') a.pause();
  }

  /** pause で止めたアニメーションを再開する */
  resume(): void {
    for (const a of this.animations) if (a.playState === 'paused') a.play();
  }

  cancel(): void {
    if (!this.active) return;
    this.controller.abort();
    for (const a of this.animations) a.cancel();
    for (const el of this.nodes) el.remove();
    this.animations.clear();
    this.nodes.clear();
  }
}
