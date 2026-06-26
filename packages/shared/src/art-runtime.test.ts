import { describe, expect, it } from 'vitest';
import {
  ART_KINDS,
  ART_RUNTIME_MARKER,
  ART_RUNTIME_SNIPPET,
  ART_SYNONYMS,
  artLibSource,
  resolveArtKind,
} from './art-runtime';

describe('ART_RUNTIME_SNIPPET (serve-time injection)', () => {
  it('is a marker-tagged <script> wrapping the art IIFE', () => {
    expect(ART_RUNTIME_SNIPPET).toContain(`data-pf="${ART_RUNTIME_MARKER}"`);
    expect(ART_RUNTIME_SNIPPET.startsWith('<script')).toBe(true);
    expect(ART_RUNTIME_SNIPPET.trimEnd().endsWith('</script>')).toBe(true);
    expect(ART_RUNTIME_SNIPPET).toContain('window.__game.art');
    // The wrapped source is exactly artLibSource() (single source of truth).
    expect(ART_RUNTIME_SNIPPET).toContain(artLibSource());
  });
});

// ── Mock 2D context that records every method call by name and stores props ───
interface MockCtx {
  _calls: string[];
  [k: string]: unknown;
}
function mockCtx(): MockCtx {
  const calls: string[] = [];
  const target: MockCtx = { _calls: calls };
  return new Proxy(target, {
    get(t, p: string) {
      if (p in t) return (t as Record<string, unknown>)[p];
      return (..._args: unknown[]) => {
        calls.push(p);
      };
    },
    set(t, p: string, v) {
      (t as Record<string, unknown>)[p] = v;
      return true;
    },
  }) as MockCtx;
}

interface ArtApi {
  draw(
    ctx: unknown,
    kind: string,
    x: number,
    y: number,
    size: number,
    opts?: unknown,
  ): string | null;
  sprite(kind: string, size: number, opts?: unknown): { width: number; height: number } | null;
  has(name: string): boolean;
  list(): string[];
  resolve(name: string): string | null;
}

/** Evaluate the emitted IIFE in a fresh fake window so we exercise the REAL
 *  in-iframe code path (not a TS re-implementation). */
function loadArt(): { art: ArtApi; win: { __game?: { art?: ArtApi } } } {
  const win: { __game?: { art?: ArtApi } } = {};
  const fakeDocument = {
    createElement: () => ({ width: 0, height: 0, getContext: () => mockCtx() }),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window',
    'document',
    'console',
    `${artLibSource()}\nreturn window.__game.art;`,
  );
  const art = fn(win, fakeDocument, console) as ArtApi;
  return { art, win };
}

describe('resolveArtKind (pure TS source of truth)', () => {
  it('maps direct kinds, synonyms, plurals, case-insensitively', () => {
    expect(resolveArtKind('fish')).toBe('fish');
    expect(resolveArtKind('  FISH  ')).toBe('fish');
    expect(resolveArtKind('salmon')).toBe('fish'); // synonym
    expect(resolveArtKind('Spaceship')).toBe('rocket');
    expect(resolveArtKind('monster')).toBe('slime');
    expect(resolveArtKind('coins')).toBe('coin'); // plural strip
    expect(resolveArtKind('hearts')).toBe('heart');
  });

  it('returns null for unknown nouns and empty input', () => {
    expect(resolveArtKind('wizard')).toBeNull();
    expect(resolveArtKind('')).toBeNull();
    expect(resolveArtKind(null)).toBeNull();
    expect(resolveArtKind(undefined)).toBeNull();
  });
});

describe('ART_SYNONYMS integrity', () => {
  it('every synonym resolves to a real canonical kind', () => {
    const kinds = new Set<string>(ART_KINDS);
    for (const [word, target] of Object.entries(ART_SYNONYMS)) {
      expect(kinds.has(target), `synonym '${word}' → '${target}' must be a canonical kind`).toBe(
        true,
      );
    }
  });
});

describe('artLibSource() emitted IIFE', () => {
  it('is syntactically valid JS and installs window.__game.art', () => {
    const { art, win } = loadArt();
    expect(typeof art.draw).toBe('function');
    expect(typeof art.sprite).toBe('function');
    expect(win.__game?.art).toBe(art);
  });

  it('list() stays in lockstep with ART_KINDS (no drawer drift)', () => {
    const { art } = loadArt();
    expect(art.list().sort()).toEqual([...ART_KINDS].sort());
  });

  it('has()/resolve() agree with the TS resolver', () => {
    const { art } = loadArt();
    expect(art.has('fish')).toBe(true);
    expect(art.has('salmon')).toBe(true); // synonym
    expect(art.has('wizard')).toBe(false);
    expect(art.resolve('spaceship')).toBe('rocket');
    expect(art.resolve('wizard')).toBeNull();
  });

  it('every canonical kind actually paints (fill/stroke/text) without throwing', () => {
    const { art } = loadArt();
    for (const kind of ART_KINDS) {
      const ctx = mockCtx();
      const resolved = art.draw(ctx, kind, 100, 100, 64);
      expect(resolved, `${kind} should resolve to itself`).toBe(kind);
      const painted = ctx._calls.some((c) => c === 'fill' || c === 'stroke' || c === 'fillText');
      expect(painted, `${kind} drew nothing`).toBe(true);
    }
  });

  it('an unknown noun draws a labelled crest, not a bare shape', () => {
    const { art } = loadArt();
    const ctx = mockCtx();
    const resolved = art.draw(ctx, 'wizard', 50, 50, 48);
    expect(resolved).toBeNull(); // no built-in silhouette
    expect(ctx._calls).toContain('fillText'); // the crest writes a label
  });

  it('draw() never throws even when a ctx method blows up', () => {
    const { art } = loadArt();
    const angry = {
      save() {},
      restore() {},
      translate() {},
      beginPath() {
        throw new Error('boom');
      },
    };
    expect(() => art.draw(angry, 'fish', 0, 0, 32)).not.toThrow();
  });

  it('sprite() bakes a silhouette to an offscreen canvas of the requested size', () => {
    const { art } = loadArt();
    const cv = art.sprite('coin', 48);
    expect(cv).not.toBeNull();
    expect(cv?.width).toBe(48);
    expect(cv?.height).toBe(48);
  });

  it('is idempotent — a second install does not clobber the first', () => {
    const win: { __game?: { art?: ArtApi } } = {};
    const fakeDocument = {
      createElement: () => ({ width: 0, height: 0, getContext: () => mockCtx() }),
    };
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'document', 'console', artLibSource());
    run(win, fakeDocument, console);
    const first = win.__game?.art;
    run(win, fakeDocument, console);
    expect(win.__game?.art).toBe(first); // guarded by `if (window.__game.art) return`
  });
});
