'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { GameCard } from '@/components/GameCard';
import type { GameCardData } from '@/components/GameCard';
import { getCreatorGames } from '@/lib/api';
import type { CreatorGame } from '@/lib/api';

/** Map a creator's published game onto the shared gallery-card shape (#3.1). */
function toCardData(game: CreatorGame): GameCardData {
  return {
    seedId: game.id,
    slug: game.publishSlug,
    title: game.title,
    thumbnailUrl: game.thumbnailUrl,
    genre: game.genre,
    // PublishedGame doesn't carry play count; the card shows "Published".
  };
}

export default function CreatorProfilePage() {
  const params = useParams<{ handle: string }>();
  const handle = params?.handle ?? '';

  const [games, setGames] = useState<CreatorGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    getCreatorGames(handle, { limit: 50 })
      .then(({ games: g }) => setGames(g))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      })
      .finally(() => setLoading(false));
  }, [handle]);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Nav */}
      <header className="border-b border-[#222222] bg-[#111111]">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-7 h-7 rounded-lg bg-[#6366f1] flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <polygon points="2,1 12,7 2,13" fill="white" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-[#f4f4f5] group-hover:text-[#6366f1] transition-colors">
                Playforge
              </span>
            </Link>

            <div className="w-px h-5 bg-[#222222]" />

            <nav className="flex items-center gap-3">
              <Link
                href="/hub"
                className="text-xs text-[#71717a] hover:text-[#f4f4f5] transition-colors"
              >
                Hub
              </Link>
              <Link
                href="/projects"
                className="text-xs text-[#71717a] hover:text-[#f4f4f5] transition-colors"
              >
                Projects
              </Link>
            </nav>
          </div>

          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium"
          >
            Make a game
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Loading skeleton */}
        {loading && (
          <div className="animate-pulse">
            <div className="h-8 bg-[#111111] rounded w-48 mb-2" />
            <div className="h-4 bg-[#111111] rounded w-24 mb-10" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="bg-[#111111] border border-[#222222] rounded-xl overflow-hidden"
                >
                  <div className="aspect-video w-full bg-[#1a1a1a]" />
                  <div className="p-4">
                    <div className="h-4 bg-[#1a1a1a] rounded w-3/4 mb-3" />
                    <div className="h-3 bg-[#1a1a1a] rounded w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Profile loaded */}
        {!loading && !error && (
          <>
            {/* Hero */}
            <div className="mb-10">
              <h1 className="text-3xl font-bold text-[#f4f4f5] tracking-tight">@{handle}</h1>
              <p className="text-sm text-[#52525b] mt-1">
                {games.length} published {games.length === 1 ? 'game' : 'games'}
              </p>
            </div>

            {/* Thumbnail gallery (#3.1) */}
            {games.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 border border-dashed border-[#222222] rounded-2xl text-center">
                <div className="w-12 h-12 rounded-xl bg-[#111111] border border-[#222222] flex items-center justify-center mb-4">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <polygon points="4,2.5 16,10 4,17.5" fill="#3f3f46" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[#71717a]">No public games yet</p>
                <p className="text-xs text-[#52525b] mt-1">Check back later!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {games.map((game) => (
                  <GameCard key={game.id} game={toCardData(game)} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
