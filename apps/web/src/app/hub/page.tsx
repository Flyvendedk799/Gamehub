'use client';

import { GameCard } from '@/components/GameCard';
import type { GameCardData } from '@/components/GameCard';
import { getHubFeed, searchHub } from '@/lib/api';
import type { HubGame, HubSort } from '@/lib/api';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const SORTS: ReadonlyArray<{ id: HubSort; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'popular', label: 'Popular' },
  { id: 'trending', label: 'Trending' },
];

/** Map a HubGame onto the shared gallery-card shape (#3.1). */
function toCardData(game: HubGame): GameCardData {
  return {
    seedId: game.id,
    slug: game.publishSlug,
    title: game.title,
    thumbnailUrl: game.thumbnailUrl,
    genre: game.genre,
    playCount: game.playCount,
    ratingAvg: game.ratingAvg,
    ratingCount: game.ratingCount,
    tags: game.tags,
  };
}

/**
 * Genre chips are derived from whatever genres the feed actually surfaces, so
 * the chip list never drifts from backend data. We track the widest set we've
 * seen this session so chips don't vanish when a narrower filter is applied.
 */
function mergeGenres(prev: string[], games: HubGame[]): string[] {
  const set = new Set(prev);
  for (const g of games) {
    if (g.genre && g.genre.trim().length > 0) set.add(g.genre);
  }
  return Array.from(set).sort();
}

export default function HubPage() {
  const [games, setGames] = useState<HubGame[]>([]);
  const [sort, setSort] = useState<HubSort>('recent');
  const [genre, setGenre] = useState<string>(''); // '' = All
  const [tag, setTag] = useState<string>(''); // '' = no tag filter
  const [knownGenres, setKnownGenres] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // #26 — debounced Hub search. Empty query falls back to the normal feed.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const isSearching = debouncedQuery.trim().length > 0;

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    const q = debouncedQuery.trim();
    setLoading(true);
    if (q.length === 0) {
      // Sort + genre + tag filters compose on the feed (#3.3/#3.4).
      void getHubFeed({ sort, genre, tag, limit: 24 })
        .then(({ games: g }) => {
          setGames(g);
          setKnownGenres((prev) => mergeGenres(prev, g));
        })
        .catch(() => setGames([]))
        .finally(() => setLoading(false));
      return;
    }
    // Search ignores sort/genre/tag (the search endpoint is its own ranking);
    // the controls are disabled while searching to keep the UX honest.
    let cancelled = false;
    void searchHub(q, { limit: 24 })
      .then(({ results }) => {
        if (!cancelled) {
          setGames(results);
          setKnownGenres((prev) => mergeGenres(prev, results));
        }
      })
      .catch(() => {
        if (!cancelled) setGames([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sort, genre, tag, debouncedQuery]);

  const filtersActive = !isSearching && (genre !== '' || tag !== '');
  const genreChips = useMemo(() => knownGenres, [knownGenres]);

  return (
    <div className="flex flex-col min-h-dvh bg-ground">
      {/* Main content */}
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-8 md:py-12 max-w-7xl mx-auto w-full">
        {/* Page heading + sort controls */}
        <div className="flex items-end justify-between mb-8 gap-4 flex-wrap border-b border-hairline pb-5">
          <div>
            <div className="type-label mb-3 text-ink-4">Community hub</div>
            <h1 className="type-display text-3xl text-ink sm:text-4xl">Play what people built</h1>
            <p className="mt-2.5 text-sm text-ink-3">
              Discover, play, rate, and remix games built with PlayerZero.
            </p>
          </div>

          {/* #3.3 — sort tabs */}
          <div className="flex items-center font-mono text-[11px] tracking-[.1em]">
            {SORTS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSort(s.id)}
                disabled={isSearching}
                className={`border px-3.5 py-2.5 uppercase transition-colors disabled:opacity-40 md:py-1.5 ${
                  i > 0 ? 'border-l-0' : ''
                } ${
                  sort === s.id
                    ? 'border-signal border-l bg-raised text-signal'
                    : 'border-hairline text-ink-4 hover:text-ink-2'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Search box (#26) */}
        <div className="mb-4 relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4 pointer-events-none">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games…"
            aria-label="Search games"
            className="w-full bg-surface border border-hairline pl-10 pr-9 py-3 text-sm text-ink placeholder-ink-4 outline-none focus:border-signal transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink text-sm tap-target inline-flex items-center justify-center md:min-h-0 md:min-w-0"
            >
              ✕
            </button>
          )}
        </div>

        {/* #3.4 — genre filter chips + active tag chip. Hidden while searching
            (search is its own ranking and ignores these filters). */}
        {!isSearching && (genreChips.length > 0 || tag !== '') && (
          <div className="mb-8 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setGenre('')}
              className={`font-mono text-sm md:text-[11px] tracking-[.1em] uppercase px-4 py-2.5 md:px-3 md:py-1.5 border transition-colors ${
                genre === ''
                  ? 'bg-signal text-chrome border-signal'
                  : 'text-ink-4 border-hairline hover:text-ink-2 hover:border-edge'
              }`}
            >
              All
            </button>
            {genreChips.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenre(genre === g ? '' : g)}
                className={`font-mono text-sm md:text-[11px] tracking-[.1em] uppercase px-4 py-2.5 md:px-3 md:py-1.5 border transition-colors ${
                  genre === g
                    ? 'bg-signal text-chrome border-signal'
                    : 'text-ink-4 border-hairline hover:text-ink-2 hover:border-edge'
                }`}
              >
                {g.replace(/_/g, ' ')}
              </button>
            ))}

            {/* Active tag filter (set by clicking a tag on a card) */}
            {tag !== '' && (
              <button
                type="button"
                onClick={() => setTag('')}
                className="font-mono text-sm md:text-[11px] tracking-[.1em] px-4 py-2.5 md:px-3 md:py-1.5 border border-signal text-signal inline-flex items-center gap-1.5"
                aria-label={`Remove tag filter ${tag}`}
              >
                #{tag}{' '}
                <span className="tap-target inline-flex items-center justify-center md:min-h-0 md:min-w-0">
                  ✕
                </span>
              </button>
            )}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list, never reordered
                key={i}
                className="bg-surface border border-hairline overflow-hidden animate-pulse"
              >
                <div className="aspect-video w-full bg-raised" />
                <div className="p-4">
                  <div className="h-4 bg-raised w-3/4 mb-3" />
                  <div className="h-3 bg-raised w-1/2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && games.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-5 flex h-12 w-12 items-center justify-center border-[1.5px] border-signal text-lg font-extrabold text-ink">
              0
            </div>
            {isSearching ? (
              <>
                <p className="text-sm font-semibold text-ink-2">
                  No games match “{debouncedQuery.trim()}”
                </p>
                <p className="text-xs text-ink-4 mt-1">Try a different search.</p>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-6 text-xs px-4 py-2 border border-edge text-ink font-semibold hover:border-signal hover:text-signal transition-colors"
                >
                  Clear search
                </button>
              </>
            ) : filtersActive ? (
              <>
                <p className="text-sm font-semibold text-ink-2">No games match this filter</p>
                <p className="text-xs text-ink-4 mt-1">
                  Try a different genre or clear the filter.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setGenre('');
                    setTag('');
                  }}
                  className="mt-6 text-xs px-4 py-2 border border-edge text-ink font-semibold hover:border-signal hover:text-signal transition-colors"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink-2">No games published yet</p>
                <p className="text-xs text-ink-4 mt-1">Yours goes first.</p>
                <Link
                  href="/"
                  className="mt-6 text-xs px-4 py-2 bg-signal text-chrome font-bold hover:bg-signal-bright transition-colors"
                >
                  Build a game
                </Link>
              </>
            )}
          </div>
        )}

        {/* Game gallery (#3.1) */}
        {!loading && games.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {games.map((game) => (
              <GameCard
                key={game.id}
                game={toCardData(game)}
                onTagClick={(t) => {
                  setTag(t);
                  setQuery('');
                }}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
