import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyablePlayUrl,
  formatPromptLoops,
  formatRuntime,
  formatTokenCount,
  publicShareUrl,
  safeFileSlug,
} from '../social-outro';

describe('formatRuntime', () => {
  it('formats zero as 0:00', () => {
    expect(formatRuntime(0)).toBe('0:00');
  });

  it('formats 137000ms as 2:17', () => {
    expect(formatRuntime(137000)).toBe('2:17');
  });

  it('zero-pads the seconds', () => {
    expect(formatRuntime(65000)).toBe('1:05');
    expect(formatRuntime(9000)).toBe('0:09');
  });

  it('floors sub-second remainders', () => {
    expect(formatRuntime(59999)).toBe('0:59');
    expect(formatRuntime(60999)).toBe('1:00');
  });

  it('clamps negatives to 0:00', () => {
    expect(formatRuntime(-5000)).toBe('0:00');
  });

  it('handles long runs over 10 minutes', () => {
    expect(formatRuntime(637000)).toBe('10:37');
  });
});

describe('formatTokenCount', () => {
  it('shows raw counts under 1000', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('rounds to whole K at >= 1000', () => {
    expect(formatTokenCount(1000)).toBe('1K');
    expect(formatTokenCount(428000)).toBe('428K');
    expect(formatTokenCount(1499)).toBe('1K');
    expect(formatTokenCount(1500)).toBe('2K');
  });

  it('uses one decimal M at >= 1e6, dropping a trailing .0', () => {
    expect(formatTokenCount(1250000)).toBe('1.3M');
    expect(formatTokenCount(1000000)).toBe('1M');
    expect(formatTokenCount(2000000)).toBe('2M');
    expect(formatTokenCount(9990000)).toBe('10M');
  });

  it('clamps negatives to 0', () => {
    expect(formatTokenCount(-100)).toBe('0');
  });
});

describe('formatPromptLoops', () => {
  it('uses the singular for exactly one', () => {
    expect(formatPromptLoops(1)).toBe('1 prompt');
  });

  it('uses the plural for other counts', () => {
    expect(formatPromptLoops(0)).toBe('0 prompts');
    expect(formatPromptLoops(3)).toBe('3 prompts');
  });

  it('rounds and clamps', () => {
    expect(formatPromptLoops(2.6)).toBe('3 prompts');
    expect(formatPromptLoops(-2)).toBe('0 prompts');
  });
});

describe('publicShareUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for null/blank so the card omits the chip', () => {
    expect(publicShareUrl(null)).toBeNull();
    expect(publicShareUrl('')).toBeNull();
    expect(publicShareUrl('   ')).toBeNull();
  });

  it('strips the protocol from an absolute url', () => {
    expect(publicShareUrl('https://playerzero.gg/p/neon-drift-arena')).toBe(
      'playerzero.gg/p/neon-drift-arena',
    );
    expect(publicShareUrl('http://example.com/x')).toBe('example.com/x');
  });

  it('drops a trailing slash on an absolute url', () => {
    expect(publicShareUrl('https://playerzero.gg/')).toBe('playerzero.gg');
  });

  it('prefixes a path with the browser host when available', () => {
    vi.stubGlobal('window', { location: { host: 'playerzero.gg' } });
    expect(publicShareUrl('/v1/play/neon-drift-arena')).toBe(
      'playerzero.gg/v1/play/neon-drift-arena',
    );
  });

  it('normalizes a relative path to a leading slash', () => {
    vi.stubGlobal('window', { location: { host: 'playerzero.gg' } });
    expect(publicShareUrl('v1/play/x')).toBe('playerzero.gg/v1/play/x');
  });

  it('returns just the path when there is no browser host', () => {
    // No window stub → server context.
    expect(publicShareUrl('/v1/play/neon-drift-arena')).toBe('/v1/play/neon-drift-arena');
  });
});

describe('copyablePlayUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for null/blank', () => {
    expect(copyablePlayUrl(null)).toBeNull();
    expect(copyablePlayUrl('  ')).toBeNull();
  });

  it('passes an absolute url through unchanged', () => {
    expect(copyablePlayUrl('https://playerzero.gg/p/x')).toBe('https://playerzero.gg/p/x');
  });

  it('prefixes a path with the browser origin when available', () => {
    vi.stubGlobal('window', { location: { origin: 'https://playerzero.gg' } });
    expect(copyablePlayUrl('/v1/play/x')).toBe('https://playerzero.gg/v1/play/x');
  });

  it('returns the path when there is no browser origin', () => {
    expect(copyablePlayUrl('/v1/play/x')).toBe('/v1/play/x');
  });
});

describe('safeFileSlug', () => {
  it('lowercases and replaces non-alnum with dashes', () => {
    expect(safeFileSlug('Neon Drift Arena')).toBe('neon-drift-arena');
    expect(safeFileSlug('Hello, World!')).toBe('hello-world');
  });

  it('collapses runs and trims edge dashes', () => {
    expect(safeFileSlug('  --Hello___World--  ')).toBe('hello-world');
  });

  it('caps the length at 40 chars without a trailing dash', () => {
    const long = 'a'.repeat(50);
    expect(safeFileSlug(long)).toBe('a'.repeat(40));
    // A space landing exactly at the 40-char boundary leaves no trailing dash.
    const boundary = `${'a'.repeat(39)} bcd`;
    expect(safeFileSlug(boundary)).toBe('a'.repeat(39));
  });

  it('falls back to "game" when nothing usable remains', () => {
    expect(safeFileSlug('')).toBe('game');
    expect(safeFileSlug('!!!')).toBe('game');
    expect(safeFileSlug('   ')).toBe('game');
  });
});
