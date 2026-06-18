import { describe, expect, it } from 'vitest';
import { API_BASE } from '../config';
import { placeholderGradient, resolveThumbnailUrl } from '../thumbnail';

describe('resolveThumbnailUrl (#3.1 fallback selection)', () => {
  it('returns null for missing/blank values so the caller renders a gradient', () => {
    expect(resolveThumbnailUrl(null)).toBeNull();
    expect(resolveThumbnailUrl(undefined)).toBeNull();
    expect(resolveThumbnailUrl('')).toBeNull();
    expect(resolveThumbnailUrl('   ')).toBeNull();
  });

  it('passes through absolute http/https/data URLs unchanged', () => {
    expect(resolveThumbnailUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(resolveThumbnailUrl('http://x/y.jpg')).toBe('http://x/y.jpg');
    expect(resolveThumbnailUrl('//cdn/x.png')).toBe('//cdn/x.png');
    expect(resolveThumbnailUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('prefixes a server-relative path with the API base', () => {
    expect(resolveThumbnailUrl('/v1/thumbs/abc.png')).toBe(`${API_BASE}/v1/thumbs/abc.png`);
  });
});

describe('placeholderGradient (#3.1 deterministic fallback)', () => {
  it('is deterministic for a given seed', () => {
    expect(placeholderGradient('game-123')).toBe(placeholderGradient('game-123'));
  });

  it('returns a CSS linear-gradient string', () => {
    expect(placeholderGradient('anything')).toMatch(
      /^linear-gradient\(135deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/,
    );
  });

  it('different seeds can land on different gradients', () => {
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const distinct = new Set(seeds.map((s) => placeholderGradient(s)));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
