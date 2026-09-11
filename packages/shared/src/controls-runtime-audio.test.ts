/**
 * The serve-time audio counter.
 *
 * Run 550cef11's game played WebAudio on every hit, but its agent-written
 * index.html never got the bootstrap's counter, so the browser-worker read
 * audioPlays = 0 and the done gate called the game MUTE.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_COUNTER_MARKER,
  AUDIO_COUNTER_SNIPPET,
  injectControlsRuntime,
} from './controls-runtime';

const PAGE =
  '<!doctype html><html><head><title>x</title></head><body><script type="module" src="src/main.js"></script></body></html>';

/** Run the snippet's script body against a fake window; return that window. */
function runSnippet(times: number) {
  class FakeAudioContext {
    resume() {
      return undefined;
    }
    createOscillator() {
      return { start() {} };
    }
  }
  const window = {
    __game: { debug: {} as { audioPlays?: number } },
    AudioContext: FakeAudioContext,
  };
  const body = AUDIO_COUNTER_SNIPPET.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  for (let i = 0; i < times; i += 1) runInNewContext(body, { window });
  return window;
}

describe('audio counter', () => {
  it('is injected before the game module, exactly once', () => {
    const out = injectControlsRuntime(PAGE);
    expect(out).toContain(AUDIO_COUNTER_MARKER);
    expect(out.indexOf(AUDIO_COUNTER_MARKER)).toBeLessThan(out.indexOf('src/main.js'));
    expect(injectControlsRuntime(out).split(AUDIO_COUNTER_MARKER).length - 1).toBe(1);
  });

  it('counts an oscillator start into window.__game.debug.audioPlays', () => {
    const window = runSnippet(1);
    const ctx = new window.AudioContext();
    ctx.createOscillator().start();
    ctx.createOscillator().start();
    expect(window.__game.debug.audioPlays).toBe(2);
  });

  it('does not double-count when installed twice (bootstrap + serve-time)', () => {
    const window = runSnippet(2);
    new window.AudioContext().createOscillator().start();
    expect(window.__game.debug.audioPlays).toBe(1);
  });
});
