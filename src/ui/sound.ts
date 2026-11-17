/**
 * 効果音。音源ファイルは使わず、Web Audio で駒音を合成する。
 *
 * 駒音は「カチッ」という高い打撃音（帯域を絞ったノイズ）と、盤が受け止める「トン」という低い胴鳴り（減衰する正弦波）の2層。
 * 手の種類で重さを変える（取る手は低く重く、成る手は高い響きを重ねる、玉方の手は軽く小さく）。
 */

/** 着地の音の種類 */
export interface LandSound {
  /** 自分（攻方）の手か */
  own: boolean;
  capture: boolean;
  promote: boolean;
  drop: boolean;
  /** 振り返りで手順を送るとき（小さく鳴らす） */
  replay: boolean;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  constructor(public enabled: boolean) {
    // ブラウザは操作の中でしか音を鳴らし始められないので、最初のタップで準備する
    const unlock = () => {
      if (!this.enabled) return;
      this.context()?.resume().catch(() => undefined);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    const len = Math.round(this.ctx.sampleRate * 0.12);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  private ready(): AudioContext | null {
    if (!this.enabled) return null;
    const ctx = this.context();
    return ctx && ctx.state === 'running' ? ctx : null;
  }

  /** 駒が盤に着地した音 */
  land(s: LandSound): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const gain = s.replay ? 0.35 : s.own ? 1 : 0.55;
    // 打撃音：駒の角が盤に当たる高い音
    this.click(t, s.own ? 2600 : 2200, s.capture ? 0.05 : 0.035, 0.55 * gain);
    // 胴鳴り：取る手は低く長く
    this.thump(t, s.capture ? 120 : s.drop ? 190 : 165, s.capture ? 0.14 : 0.08, (s.capture ? 0.9 : 0.6) * gain);
    if (s.capture && !s.replay) this.click(t + 0.018, 1500, 0.04, 0.25 * gain);
    // 成る手：澄んだ響きを少し重ねる
    if (s.promote) this.tone(t + 0.01, 1320, 0.22, 0.12 * gain);
  }

  /** 詰み。重く打ち、2〜3音の澄んだ響きで締める（rare のときは1音足す） */
  mate(rare: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.thump(t, 85, 0.35, 1);
    this.click(t, 1800, 0.06, 0.5);
    const notes = rare ? [784, 1175, 1568] : [784, 1175];
    notes.forEach((f, i) => this.tone(t + 0.09 + i * 0.09, f, rare ? 1.1 : 0.8, 0.13));
  }

  private click(t: number, freq: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(band).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + dur + 0.01);
  }

  private thump(t: number, freq: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.02);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  private tone(t: number, freq: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}
