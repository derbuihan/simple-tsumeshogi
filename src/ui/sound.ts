/**
 * 効果音。音源ファイルは使わず、Web Audio で駒音を合成する。
 *
 * 駒音は「カチッ」という高い打撃音（帯域を絞ったノイズ）と、盤が受け止める「トン」という低い胴鳴り（減衰する正弦波）の2層。
 * 手の種類で重さを変える（取る手は低く重く、成る手は高い響きを重ねる、玉方の手は軽く小さく）。
 *
 * 盤の裏の幽霊の音（ぱくっ・もぐもぐ・魂が抜ける・ため息）も同じように合成する。詰みの響きは連チャンで音程が上がる。
 */

/** 全体の音量。音はすべてこの GainNode を通して出す（姉妹アプリと同じ作り）。今の音量のまま 1 にしている */
const MASTER_GAIN = 1;

/** 詰みの響きを上げる上限（半音）。8連で5度上になり、以後は変えない */
const MAX_LIFT = 7;

/**
 * 詰みの響きの音（Hz）。rare なら1音足す。streak（解いた後の連チャン、幽霊を出さないときは 0）が
 * 伸びるほど半音ずつ上がり、10連は虹に合わせてさらに1音足す
 */
export function mateNotes(rare: boolean, streak = 0): number[] {
  const notes = rare || streak >= 10 ? [784, 1175, 1568] : [784, 1175];
  if (streak >= 10) notes.push(1976);
  const lift = 2 ** (Math.max(0, Math.min(MAX_LIFT, streak - 1)) / 12);
  return notes.map((f) => Math.round(f * lift));
}

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
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  constructor(public enabled: boolean) {
    // ブラウザは操作の中でしか音を鳴らし始められないので、最初のタップで準備する。
    // 電話などで中断されても再開できるよう、リスナーは外さない
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
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(this.ctx.destination);
    // ため息（約0.8秒）にも使うので、少し長めのノイズを作っておく
    const len = Math.round(this.ctx.sampleRate * 1);
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

  /** 詰み。重く打ち、2〜4音の澄んだ響きで締める（rare のときは1音足す。連チャンで音程が上がる） */
  mate(rare: boolean, streak = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.thump(t, 85, 0.35, 1);
    this.click(t, 1800, 0.06, 0.5);
    const notes = mateNotes(rare, streak);
    const long = notes.length > 2;
    notes.forEach((f, i) => this.tone(t + 0.09 + i * 0.09, f, long ? 1.1 : 0.8, notes.length > 3 ? 0.11 : 0.13));
  }

  /**
   * 詰みを逃した・ギブアップした（幽霊を出さない設定のとき。出すときは幽霊のため息が鳴る）。
   * 低く短い2音の下降で、責めない柔らかい音（三角波）。simple-eigo / simple-whowhy の不正解の音と同じ。
   * 向こうは master が 0.5 なので、音量を半分にして同じ大きさで聞こえるようにする
   */
  miss(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(t, 330, 0.12, 0.14, 'triangle');
    this.tone(t + 0.1, 247, 0.18, 0.14, 'triangle');
  }

  // ---- 盤の裏の幽霊 ----

  /** ぱくっ：口に入れた音。音程の落ちる短いポップ。soft は続けて食べる小さな魂 */
  gulp(soft = false): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const vol = soft ? 0.22 : 0.45;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(soft ? 1100 : 900, t);
    osc.frequency.exponentialRampToValueAtTime(soft ? 300 : 200, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.1);
    this.click(t, 3200, 0.02, vol * 0.4);
  }

  /** もぐ：口を閉じたまま噛む、こもった低い音（毎回少しずつ変える） */
  munch(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 320 + Math.random() * 160;
    low.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(low).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.1);
    this.thump(t, 110 + Math.random() * 30, 0.07, 0.25);
  }

  /** 魂が抜けていく：ひゅうっと上る、細い音。i 番目／n 個で、抜けるほど低く小さくなる */
  release(i: number, n: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 1050 * 2 ** (-(n > 1 ? i / (n - 1) : 0));
    const vol = 0.09 * (1 - (n > 1 ? i / (n - 1) : 0) * 0.4);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 0.8, t);
    osc.frequency.exponentialRampToValueAtTime(f * 1.25, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.46);
  }

  /** はぁ：息が抜けていく音（帯域が下がっていくノイズ）に、下がる低い声を少し重ねる */
  sigh(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 0.8;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(1100, t);
    band.frequency.exponentialRampToValueAtTime(350, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(band).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.01);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(330, t + 0.05);
    osc.frequency.exponentialRampToValueAtTime(200, t + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.05);
    og.gain.exponentialRampToValueAtTime(0.05, t + 0.15);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(og).connect(this.master!);
    osc.start(t + 0.05);
    osc.stop(t + dur + 0.01);
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
    src.connect(band).connect(g).connect(this.master!);
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
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  private tone(t: number, freq: number, dur: number, vol: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}
