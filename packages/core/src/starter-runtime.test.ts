import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { STARTER_AUDIO, STARTER_LOOP, STARTER_RESIZE } from './starter-runtime';

function harness() {
  const window = Object.assign(new EventTarget(), { devicePixelRatio: 3 });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const callbacks = new Map<number, (t: number) => void>();
  let nextId = 0;
  const api = runInNewContext(`${STARTER_LOOP.replaceAll('export ', '')}\n({runLoop})`, {
    window,
    document,
    requestAnimationFrame: (fn: (t: number) => void) => {
      callbacks.set(++nextId, fn);
      return nextId;
    },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
  }) as {
    runLoop: (
      step: (dt: number, time: number, alpha: number) => void,
      options?: {
        fixedUpdate?: (dt: number) => void;
        fixedStep?: number;
        maxSubSteps?: number;
      },
    ) => { pause: () => void; resume: () => void; dispose: () => void };
  };
  return {
    ...api,
    window,
    document,
    callbacks,
    frame(t: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(t);
    },
  };
}

describe('seeded game loop', () => {
  it('starts at zero, clamps stalls and cannot accrue time while hidden', () => {
    const h = harness();
    const step = vi.fn();
    h.runLoop(step);
    h.frame(5000);
    h.frame(5016);
    h.frame(9000);
    expect(step.mock.calls.map((c) => c[0])).toEqual([0, 0.016, 0.05]);
    h.document.hidden = true;
    h.document.dispatchEvent(new Event('visibilitychange'));
    expect(h.callbacks.size).toBe(0);
    h.document.hidden = false;
    h.document.dispatchEvent(new Event('visibilitychange'));
    h.frame(60000);
    expect(step.mock.lastCall?.[0]).toBe(0);
    expect(step.mock.lastCall?.[1]).toBeCloseTo(66);
  });

  it('manual pause survives visibility changes, repeated resume and disposal', () => {
    const h = harness();
    const step = vi.fn();
    const loop = h.runLoop(step);
    loop.pause();
    h.document.dispatchEvent(new Event('visibilitychange'));
    expect(h.callbacks.size).toBe(0);
    loop.resume();
    loop.resume();
    expect(h.callbacks.size).toBe(1);
    loop.dispose();
    loop.dispose();
    loop.resume();
    h.document.dispatchEvent(new Event('visibilitychange'));
    expect(h.callbacks.size).toBe(0);
  });

  it('runs identical simulation steps at 30/60/120Hz and bounds catch-up', () => {
    for (const hz of [30, 60, 120]) {
      const h = harness();
      const simulate = vi.fn();
      h.runLoop(() => {}, { fixedUpdate: simulate });
      for (let i = 0; i <= hz; i++) h.frame((i * 1000) / hz);
      expect(simulate).toHaveBeenCalledTimes(60);
      expect(simulate.mock.calls.every((c) => c[0] === 1 / 60)).toBe(true);
    }
    const h = harness();
    const simulate = vi.fn();
    h.runLoop(() => {}, { fixedUpdate: simulate, fixedStep: 0.001, maxSubSteps: 3 });
    h.frame(0);
    h.frame(9000);
    expect(simulate).toHaveBeenCalledTimes(3);
  });

  it('disposes on page exit and can dispose inside the frame callback', () => {
    const h = harness();
    const loop = h.runLoop(() => loop.dispose());
    h.frame(0);
    expect(h.callbacks.size).toBe(0);
    h.runLoop(() => {});
    h.window.dispatchEvent(new Event('pagehide'));
    expect(h.callbacks.size).toBe(0);
  });
});

describe('container resize', () => {
  it('handles collapsed containers, limits DPR, avoids redundant resizes and cleans up', () => {
    let observed = () => {};
    const disconnect = vi.fn();
    const window = Object.assign(new EventTarget(), { devicePixelRatio: 3 });
    const { watchStageSize } = runInNewContext(
      `${STARTER_RESIZE.replaceAll('export ', '')}\n({watchStageSize})`,
      {
        window,
        ResizeObserver: class {
          constructor(callback: () => void) {
            observed = callback;
          }
          observe() {}
          disconnect = disconnect;
        },
      },
    ) as {
      watchStageSize: (
        canvas: { clientWidth: number; clientHeight: number },
        resize: (w: number, h: number, dpr: number) => void,
      ) => () => void;
    };
    const canvas = { clientWidth: 0, clientHeight: 0 };
    const resize = vi.fn();
    const dispose = watchStageSize(canvas, resize);
    expect(resize).toHaveBeenLastCalledWith(1, 1, 2);
    observed();
    expect(resize).toHaveBeenCalledTimes(1);
    canvas.clientWidth = 800;
    canvas.clientHeight = 450;
    observed();
    expect(resize).toHaveBeenLastCalledWith(800, 450, 2);
    dispose();
    observed();
    window.dispatchEvent(new Event('resize'));
    expect(resize).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('shared audio', () => {
  function audioHarness(available = true) {
    const voices: Array<{
      stop: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended?: () => void;
    }> = [];
    const close = vi.fn(async () => {});
    const createOscillator = vi.fn(() => {
      const voice = {
        frequency: { value: 0 },
        type: '',
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      voices.push(voice);
      return voice;
    });
    class AudioContext {
      state = 'suspended';
      currentTime = 1;
      destination = {};
      resume = vi.fn(async () => {
        throw new Error('autoplay denied');
      });
      close = close;
      createOscillator = createOscillator;
      createGain() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: {
            value: 0,
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
        };
      }
    }
    const window = Object.assign(new EventTarget(), available ? { AudioContext } : {});
    const api = runInNewContext(
      `${STARTER_AUDIO.replaceAll('export ', '')}\n({sfx, setMuted, disposeAudio})`,
      {
        window,
        document: { hidden: false },
      },
    ) as {
      sfx: (freq?: number, dur?: number, type?: string) => void;
      setMuted: (v: boolean) => void;
      disposeAudio: () => void;
    };
    return { ...api, voices, createOscillator, close, window };
  }
  it('tolerates missing audio and autoplay rejection without breaking gameplay', async () => {
    expect(() => audioHarness(false).sfx()).not.toThrow();
    const h = audioHarness();
    h.sfx(Number.NaN, -1, 'invalid');
    await Promise.resolve();
    expect(h.createOscillator).toHaveBeenCalledOnce();
  });
  it('caps simultaneous voices, releases ended voices, honors mute and closes on exit', () => {
    const h = audioHarness();
    for (let i = 0; i < 100; i++) h.sfx();
    expect(h.voices).toHaveLength(16);
    h.voices[0]?.onended?.();
    h.sfx();
    expect(h.voices).toHaveLength(17);
    h.setMuted(true);
    h.sfx();
    expect(h.voices).toHaveLength(17);
    h.window.dispatchEvent(new Event('pagehide'));
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.voices.every((v) => v.disconnect.mock.calls.length > 0)).toBe(true);
  });
});
