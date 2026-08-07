'use client';

import { GameCard } from '@/components/GameCard';
import type { GameCardData } from '@/components/GameCard';
import { followUser, getCreatorGames, getCreatorProfile, unfollowUser } from '@/lib/api';
import type { CreatorGame, CreatorProfile } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

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

  // Follow state (Phase 3.9). signedIn gates the Follow button.
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [following, setFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(isAuthenticated());
  }, []);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    // Games + profile (follow stats) load together; the profile is best-effort
    // so a failure there doesn't blank the gallery.
    Promise.all([
      getCreatorGames(handle, { limit: 50 }),
      getCreatorProfile(handle).catch(() => null),
    ])
      .then(([{ games: g }, p]) => {
        setGames(g);
        setProfile(p);
        if (p) {
          setFollowing(p.isFollowing);
          setFollowerCount(p.followerCount);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      })
      .finally(() => setLoading(false));
  }, [handle]);

  async function handleToggleFollow() {
    if (followBusy) return;
    setFollowBusy(true);
    try {
      const res = following ? await unfollowUser(handle) : await followUser(handle);
      setFollowing(res.following);
      setFollowerCount(res.followerCount);
    } catch {
      // swallow — keep prior state
    } finally {
      setFollowBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-ground">
      <main className="mx-auto max-w-5xl px-6 py-10 md:py-14">
        {/* Loading skeleton */}
        {loading && (
          <div className="animate-pulse">
            <div className="mb-2 h-8 w-48 bg-surface" />
            <div className="mb-10 h-4 w-24 bg-surface" />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list, never reordered
                  key={i}
                  className="overflow-hidden border border-hairline bg-surface"
                >
                  <div className="aspect-video w-full bg-raised" />
                  <div className="p-4">
                    <div className="mb-3 h-4 w-3/4 bg-raised" />
                    <div className="h-3 w-1/3 bg-raised" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
            {error}
          </div>
        )}

        {/* Profile loaded */}
        {!loading && !error && (
          <>
            {/* Hero */}
            <div className="mb-10 flex flex-col gap-6 border-b border-hairline pb-8 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
              <div className="flex items-start gap-4">
                {profile?.avatarUrl ? (
                  <img
                    src={profile.avatarUrl}
                    alt=""
                    className="h-14 w-14 border border-hairline object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center border border-edge bg-surface font-mono text-lg text-signal">
                    {(profile?.displayName ?? handle).slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div>
                  <h1 className="type-display text-3xl text-ink sm:text-4xl">
                    {profile?.displayName ?? `@${handle}`}
                  </h1>
                  <p className="mt-1.5 font-mono text-[11px] tracking-[.06em] text-ink-4">
                    @{handle}
                  </p>
                  {profile?.bio && (
                    <p className="mt-3 max-w-xl text-sm leading-6 text-ink-3">{profile.bio}</p>
                  )}
                </div>
              </div>
              <div>
                <p className="mt-1 font-mono text-[11px] tracking-[.08em] text-ink-4">
                  {games.length} PUBLISHED {games.length === 1 ? 'GAME' : 'GAMES'}
                  {profile && (
                    <>
                      {' · '}
                      {followerCount.toLocaleString()}{' '}
                      {followerCount === 1 ? 'FOLLOWER' : 'FOLLOWERS'}
                    </>
                  )}
                </p>
              </div>

              {/* Follow / Unfollow (#3.9) — auth-gated. */}
              {profile && signedIn && (
                <button
                  type="button"
                  onClick={() => {
                    void handleToggleFollow();
                  }}
                  disabled={followBusy}
                  className={`px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50 sm:py-2 sm:text-xs ${
                    following
                      ? 'border border-edge text-ink-3 hover:border-signal hover:text-signal'
                      : 'bg-signal font-bold text-chrome hover:bg-signal-bright'
                  }`}
                >
                  {following ? 'Following' : 'Follow'}
                </button>
              )}
            </div>

            {/* Thumbnail gallery (#3.1) */}
            {games.length === 0 ? (
              <div className="flex flex-col items-center justify-center border border-dashed border-hairline py-24 text-center">
                <div className="mb-5 flex h-12 w-12 items-center justify-center border-[1.5px] border-signal text-lg font-extrabold text-ink">
                  0
                </div>
                <p className="text-sm font-semibold text-ink-2">No public games yet</p>
                <p className="mt-1 text-xs text-ink-4">Check back soon.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
