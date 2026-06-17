'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getHubFeed, searchHub } from '@/lib/api';
import type { HubGame } from '@/lib/api';

type SortOption = 'recent' | 'popular';

export default function HubPage() {
  const [games, setGames] = useState<HubGame[]>([]);
  const [sort, setSort] = useState<SortOption>('recent');
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
      void getHubFeed({ sort, limit: 20 })
        .then(({ games: g }) => setGames(g))
        .catch(() => setGames([]))
        .finally(() => setLoading(false));
      return;
    }
    let cancelled = false;
    void searchHub(q, { limit: 20 })
      .then(({ results }) => { if (!cancelled) setGames(results); })
      .catch(() => { if (!cancelled) setGames([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sort, debouncedQuery]);

  return (
    <div className="flex flex-col min-h-screen bg-[#0a0a0a]">
      {/* Top nav bar */}
      <header className="flex-shrink-0 h-12 border-b border-[#222222] bg-[#111111] flex items-center px-4 gap-4 z-10">
        <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
          <div className="w-6 h-6 rounded-md bg-[#6366f1] flex items-center justify-center">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <polygon points="2,1 9,5.5 2,10" fill="white" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-[#f4f4f5] hidden sm:block group-hover:text-[#6366f1] transition-colors">
            Playforge
          </span>
        </Link>

        <div className="w-px h-5 bg-[#222222] flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-[#f4f4f5]">Hub</span>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium"
          >
            Make a game
          </Link>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-8 max-w-7xl mx-auto w-full">
        {/* Page heading + sort controls */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-[#f4f4f5]">Community Hub</h1>
            <p className="text-sm text-[#52525b] mt-0.5">Discover games built with Playforge</p>
          </div>

          <div className="flex items-center gap-1 bg-[#111111] border border-[#222222] rounded-lg p-0.5">
            <span className="text-xs text-[#52525b] px-2">Sort:</span>
            <button
              onClick={() => setSort('recent')}
              disabled={isSearching}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium disabled:opacity-40 ${
                sort === 'recent'
                  ? 'bg-[#6366f1] text-white'
                  : 'text-[#71717a] hover:text-[#f4f4f5]'
              }`}
            >
              Recent
            </button>
            <button
              onClick={() => setSort('popular')}
              disabled={isSearching}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium disabled:opacity-40 ${
                sort === 'popular'
                  ? 'bg-[#6366f1] text-white'
                  : 'text-[#71717a] hover:text-[#f4f4f5]'
              }`}
            >
              Popular
            </button>
          </div>
        </div>

        {/* Search box (#26) */}
        <div className="mb-8 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#52525b] pointer-events-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            className="w-full bg-[#111111] border border-[#222222] rounded-lg pl-9 pr-9 py-2.5 text-sm text-[#f4f4f5] placeholder-[#52525b] outline-none focus:border-[#6366f1] transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#52525b] hover:text-[#a1a1aa] text-sm"
            >
              ✕
            </button>
          )}
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="bg-[#111111] border border-[#222222] rounded-xl p-4 animate-pulse"
              >
                <div className="h-4 bg-[#1a1a1a] rounded w-3/4 mb-3" />
                <div className="h-3 bg-[#1a1a1a] rounded w-1/2" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && games.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#111111] border border-[#222222] flex items-center justify-center mb-4">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <polygon points="4,2.5 16,10 4,17.5" fill="#3f3f46" />
              </svg>
            </div>
            {isSearching ? (
              <>
                <p className="text-sm font-medium text-[#71717a]">No games match “{debouncedQuery.trim()}”</p>
                <p className="text-xs text-[#52525b] mt-1">Try a different search.</p>
                <button
                  onClick={() => setQuery('')}
                  className="mt-6 text-xs px-4 py-2 rounded-lg bg-[#1a1a1a] hover:bg-[#222222] text-[#a1a1aa] border border-[#222222] font-medium transition-colors"
                >
                  Clear search
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-[#71717a]">No games published yet</p>
                <p className="text-xs text-[#52525b] mt-1">Be the first!</p>
                <Link
                  href="/"
                  className="mt-6 text-xs px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white font-medium transition-colors"
                >
                  Build a game
                </Link>
              </>
            )}
          </div>
        )}

        {/* Game grid */}
        {!loading && games.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {games.map((game) => (
              <GameCard key={game.id} game={game} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function GameCard({ game }: { game: HubGame }) {
  const rating = game.ratingAvg.toFixed(2);
  const publishedDate = new Date(game.publishedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Link
      href={`/p/${game.publishSlug}`}
      className="bg-[#111111] border border-[#222222] rounded-xl p-4 hover:border-[#333333] cursor-pointer transition-colors block"
    >
      {/* Title */}
      <h2 className="text-sm font-semibold text-[#f4f4f5] truncate mb-2">{game.title}</h2>

      {/* Meta row */}
      <p className="text-xs text-[#52525b]">
        {game.playCount.toLocaleString()} {game.playCount === 1 ? 'play' : 'plays'}
        {game.ratingCount > 0 && (
          <>
            {' '}
            &middot; {'★'} {rating} ({game.ratingCount})
          </>
        )}
      </p>

      {/* Footer: published date + Play link */}
      <div className="flex items-center justify-between mt-4">
        <span className="text-xs text-[#3f3f46]">{publishedDate}</span>
        <span className="text-xs px-2.5 py-1 rounded-md bg-[#6366f1]/10 text-[#6366f1] border border-[#6366f1]/20 font-medium">
          Play
        </span>
      </div>
    </Link>
  );
}
