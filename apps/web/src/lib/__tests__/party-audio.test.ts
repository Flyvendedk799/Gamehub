import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partyAudio } from '../party/PartyAudioBank';

describe('PartyAudioBank', () => {
  let createdOscillators: Array<{
    type: string;
    frequency: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }> = [];

  let createdGains: Array<{
    gain: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
  }> = [];

  class MockAudioContext {
    state = 'running';
    currentTime = 10;
    sampleRate = 44100;
    destination = {};

    async resume() {}

    createGain() {
      const gain = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      createdGains.push(gain);
      return gain;
    }

    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
      };
      createdOscillators.push(osc);
      return osc;
    }

    createBiquadFilter() {
      return {
        type: 'lowpass',
        frequency: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        Q: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
    }

    createBuffer(channels: number, length: number) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate: 44100,
        getChannelData: () => new Float32Array(length),
      };
    }

    createBufferSource() {
      return {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
  }

  beforeEach(() => {
    createdOscillators = [];
    createdGains = [];

    // Reset singleton audio context and timers
    const internalBank = partyAudio as unknown as {
      ctx: unknown;
      masterGain: unknown;
      lastSoundTime: number;
    };
    internalBank.ctx = null;
    internalBank.masterGain = null;
    internalBank.lastSoundTime = 0;

    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('window', {
      AudioContext: MockAudioContext,
    });
    partyAudio.setMuted(false);
    partyAudio.setVolume(0.8);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('controls volume and clamps to [0, 1]', () => {
    partyAudio.setVolume(0.5);
    expect(partyAudio.getVolume()).toBe(0.5);

    partyAudio.setVolume(1.5);
    expect(partyAudio.getVolume()).toBe(1.0);

    partyAudio.setVolume(-0.2);
    expect(partyAudio.getVolume()).toBe(0.0);
  });

  it('controls mute toggle', () => {
    partyAudio.setMuted(true);
    expect(partyAudio.getMuted()).toBe(true);

    // Muted sound playback returns false
    const played = partyAudio.playSoundBite('airhorn', true);
    expect(played).toBe(false);

    partyAudio.setMuted(false);
    expect(partyAudio.getMuted()).toBe(false);
  });

  it('enforces 4000ms soundbite cooldown', () => {
    const playedFirst = partyAudio.playSoundBite('airhorn', false);
    expect(playedFirst).toBe(true);

    // Immediate next soundbite without ignoreCooldown should fail
    expect(partyAudio.canPlaySoundBite()).toBe(false);
    expect(partyAudio.getCooldownRemainingMs()).toBeGreaterThan(0);
    const playedSecond = partyAudio.playSoundBite('bruh', false);
    expect(playedSecond).toBe(false);

    // With ignoreCooldown = true, it should succeed
    const playedForced = partyAudio.playSoundBite('bruh', true);
    expect(playedForced).toBe(true);
  });

  it('synthesizes all 6 soundbite types without errors', () => {
    const sounds: Array<'airhorn' | 'sad_trombone' | 'cheer' | 'drumroll' | 'fanfare' | 'bruh'> = [
      'airhorn',
      'sad_trombone',
      'cheer',
      'drumroll',
      'fanfare',
      'bruh',
    ];

    for (const id of sounds) {
      const res = partyAudio.playSoundBite(id, true);
      expect(res).toBe(true);
    }
  });

  it('plays UI sounds cleanly', () => {
    expect(() => {
      partyAudio.playUiClick();
      partyAudio.playPop();
      partyAudio.playCountdownBeep(false);
      partyAudio.playCountdownBeep(true);
      partyAudio.playVetoSound();
    }).not.toThrow();

    expect(createdOscillators.length).toBeGreaterThan(0);
  });
});
