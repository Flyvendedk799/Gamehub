import { describe, expect, it } from 'vitest';
import { buildHubFeedQuery } from '../api';

/** Parse the built query string back into a map for order-independent asserts. */
function parse(qs: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(qs).entries());
}

describe('buildHubFeedQuery (#3.3/#3.4)', () => {
  it('returns an empty string with no options', () => {
    expect(buildHubFeedQuery()).toBe('');
    expect(buildHubFeedQuery({})).toBe('');
  });

  it('sets sort for each tab', () => {
    expect(parse(buildHubFeedQuery({ sort: 'recent' }))).toEqual({ sort: 'recent' });
    expect(parse(buildHubFeedQuery({ sort: 'popular' }))).toEqual({ sort: 'popular' });
    expect(parse(buildHubFeedQuery({ sort: 'trending' }))).toEqual({ sort: 'trending' });
  });

  it('treats empty/whitespace genre and tag as "no filter"', () => {
    expect(buildHubFeedQuery({ genre: '' })).toBe('');
    expect(buildHubFeedQuery({ genre: '   ' })).toBe('');
    expect(buildHubFeedQuery({ tag: '' })).toBe('');
    expect(buildHubFeedQuery({ tag: '  ' })).toBe('');
  });

  it('composes sort + genre + tag + paging', () => {
    const parsed = parse(
      buildHubFeedQuery({
        sort: 'trending',
        genre: 'platformer',
        tag: 'retro',
        limit: 24,
        offset: 12,
      }),
    );
    expect(parsed).toEqual({
      sort: 'trending',
      genre: 'platformer',
      tag: 'retro',
      limit: '24',
      offset: '12',
    });
  });

  it('trims surrounding whitespace from genre and tag', () => {
    const parsed = parse(buildHubFeedQuery({ genre: '  rpg ', tag: ' neon ' }));
    expect(parsed).toEqual({ genre: 'rpg', tag: 'neon' });
  });

  it('serializes offset 0 (a meaningful value), not just truthy ones', () => {
    expect(parse(buildHubFeedQuery({ offset: 0 }))).toEqual({ offset: '0' });
    expect(parse(buildHubFeedQuery({ limit: 0 }))).toEqual({ limit: '0' });
  });
});
