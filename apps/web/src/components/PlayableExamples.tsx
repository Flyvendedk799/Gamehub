'use client';

import { type HubGame, getHubFeed } from '@/lib/api';
import { useEffect, useState } from 'react';
import { GameCard } from './GameCard';

/** Show real published games; never pass invented examples off as generated results. */
export function PlayableExamples() {
  const [games, setGames] = useState<HubGame[]>([]);
  useEffect(() => {
    let cancelled = false;
    void getHubFeed({ sort: 'popular', limit: 12 })
      .then(({ games: feed }) => {
        if (cancelled) return;
        const selected: HubGame[] = [];
        const genres = new Set<string>();
        for (const game of feed) {
          if (game.status !== 'live' || !game.thumbnailUrl || genres.has(game.genre ?? ''))
            continue;
          selected.push(game);
          genres.add(game.genre ?? '');
          if (selected.length === 3) break;
        }
        setGames(selected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (games.length === 0) return null;
  return (
    <section className="mt-12 w-full" aria-label="Play community games">
      <h2 className="type-title mb-2 text-2xl text-ink">Try a game first</h2>
      <p className="mb-5 text-sm text-ink-2">
        Play something the community made, then bring your own idea.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {games.map((game) => (
          <GameCard
            key={game.id}
            game={{
              seedId: game.id,
              slug: game.publishSlug,
              title: game.title,
              thumbnailUrl: game.thumbnailUrl,
              genre: game.genre,
            }}
          />
        ))}
      </div>
    </section>
  );
}
