import type { SoundBiteId } from './party-types';

class PartyAudioBank {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private volume = 0.8;
  private isMuted = false;
  private lastSoundTime = 0;
  private readonly cooldownMs = 4000;

  private initContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {
        // user gesture required
      });
    }
    return this.ctx;
  }

  public setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx && !this.isMuted) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public canPlaySoundBite(): boolean {
    return Date.now() - this.lastSoundTime >= this.cooldownMs;
  }

  public getCooldownRemainingMs(): number {
    const elapsed = Date.now() - this.lastSoundTime;
    return Math.max(0, this.cooldownMs - elapsed);
  }

  public playSoundBite(id: SoundBiteId, ignoreCooldown = false): boolean {
    if (!ignoreCooldown && !this.canPlaySoundBite()) {
      return false;
    }
    const ctx = this.initContext();
    if (!ctx || !this.masterGain || this.isMuted) return false;

    this.lastSoundTime = Date.now();

    switch (id) {
      case 'airhorn':
        this.synthAirhorn(ctx, this.masterGain);
        break;
      case 'sad_trombone':
        this.synthSadTrombone(ctx, this.masterGain);
        break;
      case 'cheer':
        this.synthCheer(ctx, this.masterGain);
        break;
      case 'drumroll':
        this.synthDrumroll(ctx, this.masterGain);
        break;
      case 'fanfare':
        this.synthFanfare(ctx, this.masterGain);
        break;
      case 'bruh':
        this.synthBruh(ctx, this.masterGain);
        break;
    }
    return true;
  }

  // ── Synthesized Sound Effects ───────────────────────────────────────────

  private synthAirhorn(ctx: AudioContext, destination: GainNode): void {
    const now = ctx.currentTime;
    // 3 rhythmic blasts: beep beep beeeeeep
    const blasts = [
      { start: 0, dur: 0.15 },
      { start: 0.18, dur: 0.15 },
      { start: 0.36, dur: 0.45 },
    ];

    for (const b of blasts) {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';
      // Bb3 (~233Hz) + slight detune
      osc1.frequency.setValueAtTime(233, now + b.start);
      osc2.frequency.setValueAtTime(238, now + b.start);

      gain.gain.setValueAtTime(0.001, now + b.start);
      gain.gain.exponentialRampToValueAtTime(0.4, now + b.start + 0.02);
      gain.gain.setValueAtTime(0.4, now + b.start + b.dur - 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + b.start + b.dur);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(destination);

      osc1.start(now + b.start);
      osc2.start(now + b.start);
      osc1.stop(now + b.start + b.dur);
      osc2.stop(now + b.start + b.dur);
    }
  }

  private synthSadTrombone(ctx: AudioContext, destination: GainNode): void {
    const now = ctx.currentTime;
    // 4 descending notes: D4 (293.66), C#4 (277.18), C4 (261.63), B3 (246.94) sliding down
    const notes = [
      { freq: 293.66, start: 0, dur: 0.35 },
      { freq: 277.18, start: 0.4, dur: 0.35 },
      { freq: 261.63, start: 0.8, dur: 0.35 },
      { freq: 246.94, start: 1.2, dur: 0.8, slide: 200 },
    ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(n.freq, now + n.start);
      if (n.slide) {
        osc.frequency.linearRampToValueAtTime(n.slide, now + n.start + n.dur);
      }

      filter.type = 'bandpass';
      filter.Q.setValueAtTime(4, now + n.start);
      filter.frequency.setValueAtTime(400, now + n.start);
      filter.frequency.linearRampToValueAtTime(800, now + n.start + n.dur * 0.5);
      filter.frequency.linearRampToValueAtTime(300, now + n.start + n.dur);

      gain.gain.setValueAtTime(0.001, now + n.start);
      gain.gain.linearRampToValueAtTime(0.3, now + n.start + 0.05);
      gain.gain.setValueAtTime(0.3, now + n.start + n.dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(destination);

      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur);
    }
  }

  private synthCheer(ctx: AudioContext, destination: GainNode): void {
    const now = ctx.currentTime;
    const dur = 1.6;

    // Crowd noise via buffer
    const bufferSize = ctx.sampleRate * dur;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, now);
    filter.Q.setValueAtTime(2, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.3);
    gain.gain.setValueAtTime(0.3, now + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(destination);

    noise.start(now);
    noise.stop(now + dur);

    // Chime chords on top
    const chimes = [523.25, 659.25, 783.99, 1046.5];
    for (let idx = 0; idx < chimes.length; idx++) {
      const f = chimes[idx]!;
      const chimeOsc = ctx.createOscillator();
      const chimeGain = ctx.createGain();

      chimeOsc.type = 'sine';
      chimeOsc.frequency.setValueAtTime(f, now + 0.2 + idx * 0.08);

      chimeGain.gain.setValueAtTime(0.001, now + 0.2 + idx * 0.08);
      chimeGain.gain.linearRampToValueAtTime(0.1, now + 0.25 + idx * 0.08);
      chimeGain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

      chimeOsc.connect(chimeGain);
      chimeGain.connect(destination);

      chimeOsc.start(now + 0.2 + idx * 0.08);
      chimeOsc.stop(now + 1.2);
    }
  }

  private synthDrumroll(ctx: AudioContext, destination: GainNode): void {
    const now = ctx.currentTime;
    const rollDur = 1.4;

    const bufLen = ctx.sampleRate * rollDur;
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Amplitude modulation for roll taps
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(1000, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.linearRampToValueAtTime(0.3, now + rollDur - 0.1);
    gain.gain.linearRampToValueAtTime(0.001, now + rollDur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(destination);

    noise.start(now);
    noise.stop(now + rollDur);

    // Cymbal crash at end
    const crashDur = 0.8;
    const crashBufLen = ctx.sampleRate * crashDur;
    const crashBuf = ctx.createBuffer(1, crashBufLen, ctx.sampleRate);
    const crashData = crashBuf.getChannelData(0);
    for (let i = 0; i < crashBufLen; i++) {
      crashData[i] = Math.random() * 2 - 1;
    }
    const crashSrc = ctx.createBufferSource();
    crashSrc.buffer = crashBuf;
    const crashGain = ctx.createGain();
    crashGain.gain.setValueAtTime(0.4, now + rollDur);
    crashGain.gain.exponentialRampToValueAtTime(0.001, now + rollDur + crashDur);

    crashSrc.connect(crashGain);
    crashGain.connect(destination);

    crashSrc.start(now + rollDur);
    crashSrc.stop(now + rollDur + crashDur);
  }

  private synthFanfare(ctx: AudioContext, destination: GainNode): void {
    const now = ctx.currentTime;
    // C4, E4, G4, high C5 triumph
    const notes = [
      { freq: 261.63, start: 0, dur: 0.15 },
      { freq: 329.63, start: 0.16, dur: 0.15 },
      { freq: 392.0, start: 0.32, dur: 0.18 },
      { freq: 523.25, start: 0.52, dur: 0.7 },
    ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      gain.gain.setValueAtTime(0.001, now + n.start);
      gain.gain.linearRampToValueAtTime(0.35, now + n.start + 0.02);
      gain.gain.setValueAtTime(0.3, now + n.start + n.dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);

      osc.connect(gain);
      gain.connect(destination);

      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur);
    }
  }

  private synthBruh(ctx: AudioContext, destination: GainNode): void {
    const now = ctx.currentTime;
    const dur = 0.5;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(65, now + dur);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, now);
    filter.Q.setValueAtTime(6, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(destination);

    osc.start(now);
    osc.stop(now + dur);
  }

  // ── UI Sounds ──────────────────────────────────────────────────────────

  public playUiClick(): void {
    const ctx = this.initContext();
    if (!ctx || !this.masterGain || this.isMuted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.04);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.04);
  }

  public playPop(): void {
    const ctx = this.initContext();
    if (!ctx || !this.masterGain || this.isMuted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(950, now + 0.06);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.06);
  }

  public playCountdownBeep(isFinal = false): void {
    const ctx = this.initContext();
    if (!ctx || !this.masterGain || this.isMuted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(isFinal ? 880 : 440, now);

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (isFinal ? 0.35 : 0.12));

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + (isFinal ? 0.35 : 0.12));
  }

  public playVetoSound(): void {
    const ctx = this.initContext();
    if (!ctx || !this.masterGain || this.isMuted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.3);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.3);
  }
}

export const partyAudio = new PartyAudioBank();
