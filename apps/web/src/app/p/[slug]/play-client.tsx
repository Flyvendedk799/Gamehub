'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import {
  addComment,
  getComments,
  getLeaderboard,
  remixGame,
  reportGame,
  setRating,
  submitScore,
  toggleLike,
} from '@/lib/api';
import type { HubComment, LeaderboardEntry } from '@/lib/api';
import { isLoggedIn } from '@/lib/auth';
import { useCloudSaveRelay } from '@/lib/cloud-save-relay';
import { API_BASE } from '@/lib/config';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const BASE = API_BASE;

/**
 * postMessage `type` the in-iframe `window.__game.reportScore(n)` shim posts to
 * us (Phase 3.8). Mirrored from `@playforge/runtime` (SCORE_MESSAGE_TYPE) — the
 * web app deliberately doesn't depend on the runtime package, so the literal is
 * kept in lockstep here, like the tweak-bridge type in iframe-bridge.ts.
 */
const SCORE_MESSAGE_TYPE = 'playforge:score';

/** Type guard for an inbound score frame on the window message listener. */
function isScoreFrame(data: unknown): data is { type: string; score: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === SCORE_MESSAGE_TYPE &&
    typeof (data as { score?: unknown }).score === 'number' &&
    Number.isFinite((data as { score: number }).score)
  );
}

interface Props {
  slug: string;
  initialTitle?: string;
  /** #3.6 — how many times this game has been remixed. */
  remixCount?: number;
  /** #3.6 — slug this game was remixed FROM, for attribution. Null if original. */
  parentSlug?: string | null;
  /** Project this published game belongs to — scopes the cloud-save relay. */
  projectId?: string;
}

export default function PlayClient({
  slug,
  initialTitle,
  remixCount = 0,
  parentSlug = null,
  projectId,
}: Props) {
  const router = useRouter();
  const gameUrl = `${BASE}/v1/play/${slug}`;

  // ─── Like state ───────────────────────────────────────────────────────────
  const [liked, setLiked] = useState(false);
  const [liking, setLiking] = useState(false);

  async function handleLike() {
    if (liking) return;
    setLiking(true);
    try {
      const { liked: newLiked } = await toggleLike(slug);
      setLiked(newLiked);
    } catch {
      // swallow
    } finally {
      setLiking(false);
    }
  }

  // ─── Rating state ─────────────────────────────────────────────────────────
  const [hoveredStar, setHoveredStar] = useState(0);
  const [selectedStar, setSelectedStar] = useState(0);
  const [ratingAvg, setRatingAvg] = useState(0);
  const [ratingCount, setRatingCount] = useState(0);
  const [rating, setRatingState] = useState(false);

  async function handleRate(stars: number) {
    if (rating) return;
    setSelectedStar(stars);
    setRatingState(true);
    try {
      const result = await setRating(slug, stars);
      setRatingAvg(result.ratingAvg);
      setRatingCount(result.ratingCount);
    } catch {
      // swallow
    } finally {
      setRatingState(false);
    }
  }

  // ─── Remix ────────────────────────────────────────────────────────────────
  const [remixing, setRemixing] = useState(false);

  async function handleRemix() {
    if (remixing) return;
    setRemixing(true);
    try {
      const { projectId } = await remixGame(slug);
      router.push(`/projects/${projectId}`);
    } catch {
      setRemixing(false);
    }
  }

  // ─── Report ───────────────────────────────────────────────────────────────
  const [reported, setReported] = useState(false);

  async function handleReport() {
    if (reported) return;
    try {
      await reportGame(slug);
      setReported(true);
    } catch {
      // swallow
    }
  }

  // ─── Comments ─────────────────────────────────────────────────────────────
  const [comments, setComments] = useState<HubComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentBody, setCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!slug) return;
    void getComments(slug)
      .then(({ comments: c }) => setComments(c))
      .catch(() => {})
      .finally(() => setCommentsLoading(false));
  }, [slug]);

  // ─── Leaderboard (Phase 3.8) ────────────────────────────────────────────────
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  // Ref to the game iframe so the score listener can verify a message actually
  // came from THIS frame's window, not an arbitrary script/embed. (CSP H2)
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Cross-device cloud-save relay (logged-in players only). `getToken` reads
  // localStorage, which is empty during SSR, so resolve the logged-in flag on
  // mount to avoid a hydration mismatch — the relay only needs to enable after
  // the client has hydrated anyway.
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => {
    setLoggedIn(isLoggedIn());
  }, []);
  useCloudSaveRelay(iframeRef, projectId, loggedIn);

  async function refreshLeaderboard() {
    try {
      const { entries } = await getLeaderboard(slug);
      setLeaderboard(entries);
    } catch {
      // swallow — leaderboard is best-effort
    }
  }

  // Initial load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per slug — intentionally excludes refreshLeaderboard to avoid refetch loops
  useEffect(() => {
    if (!slug) return;
    void refreshLeaderboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Listen for the game's `window.__game.reportScore(n)` frames, submit them,
  // then refresh the board. Best-effort: a 429 (rate-cap) is swallowed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind the listener only per slug — intentionally excludes refreshLeaderboard to avoid re-subscribing on every render
  useEffect(() => {
    if (!slug) return;
    function onMessage(e: MessageEvent) {
      // Only trust score frames from THIS game's iframe window. The iframe is a
      // sandboxed, opaque origin (no allow-same-origin), so an origin string
      // check is unreliable — gate on the source window identity instead. This
      // stops any other script/embed on the page from spoofing a leaderboard
      // submission as the signed-in user. (CSP H2)
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      if (!isScoreFrame(e.data)) return;
      const score = Math.trunc(e.data.score);
      if (score < 0) return;
      void submitScore(slug, score)
        .then(() => refreshLeaderboard())
        .catch(() => {});
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    const body = commentBody.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    try {
      const newComment = await addComment(slug, body);
      setComments((prev) => [...prev, newComment]);
      setCommentBody('');
    } catch {
      // swallow
    } finally {
      setSubmitting(false);
    }
  }

  const displayStar = hoveredStar > 0 ? hoveredStar : selectedStar;

  return (
    <div className="flex flex-col min-h-dvh bg-void">
      {/* Top bar */}
      <header className="safe-top z-10 flex h-14 flex-shrink-0 items-center gap-4 border-b border-hairline bg-chrome px-4">
        <Link href="/" className="group flex flex-shrink-0 items-center gap-2">
          <BrandMark size={24} />
          <Wordmark className="hidden text-xs text-ink sm:block" />
        </Link>

        <div className="h-5 w-px flex-shrink-0 bg-hairline" />

        <div className="min-w-0 flex-1">
          <span className="truncate text-[15px] font-bold tracking-[-.01em] text-ink">
            {initialTitle ?? slug}
          </span>
        </div>

        <div className="flex flex-shrink-0 items-center gap-3">
          <a
            href={gameUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2.5 py-2.5 text-sm font-semibold text-signal transition-colors hover:text-signal-bright"
          >
            Full screen ↗
          </a>
          <Link
            href="/"
            className="bg-signal px-4 py-2.5 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright"
          >
            Make your own
          </Link>
        </div>
      </header>

      {/* Game iframe */}
      <div className="w-full h-[60dvh] relative">
        <iframe
          ref={iframeRef}
          src={gameUrl}
          title={`Play ${initialTitle ?? slug}`}
          className="w-full h-full border-0 absolute inset-0"
          // No allow-same-origin: the public play iframe must run at an opaque
          // origin so a hostile game can't read another game's localStorage/
          // cookies on the shared games origin (until per-game subdomains land).
          // The score bridge uses postMessage-to-parent, which works without it. (CSP C2)
          sandbox="allow-scripts allow-pointer-lock allow-downloads"
          allow="autoplay; fullscreen"
        />
      </div>

      {/* Remix lineage (#3.6) — remix count + "remixed from" attribution. */}
      {(remixCount > 0 || parentSlug) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline bg-chrome px-4 py-2 font-mono text-[11px] tracking-[.06em]">
          {parentSlug && (
            <span className="inline-flex items-center gap-1.5 text-ink-3">
              <ForkIcon />
              REMIXED FROM{' '}
              <Link
                href={`/p/${parentSlug}`}
                className="text-signal transition-colors hover:text-signal-bright"
              >
                {parentSlug}
              </Link>
            </span>
          )}
          {remixCount > 0 && parentSlug && <span className="text-ink-4">·</span>}
          {remixCount > 0 && (
            <span className="text-ink-4">
              REMIXED {remixCount.toLocaleString()} {remixCount === 1 ? 'TIME' : 'TIMES'}
            </span>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-4 border-t border-hairline bg-ground px-4 py-3">
        {/* Like button */}
        <button
          type="button"
          onClick={() => {
            void handleLike();
          }}
          disabled={liking}
          className={`flex items-center gap-1.5 border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
            liked
              ? 'border-fail text-fail'
              : 'border-hairline text-ink-4 hover:border-edge hover:text-ink'
          }`}
        >
          <HeartIcon filled={liked} />
          {liked ? 'Liked' : 'Like'}
        </button>

        {/* Star rating */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => {
                  void handleRate(star);
                }}
                onMouseEnter={() => setHoveredStar(star)}
                onMouseLeave={() => setHoveredStar(0)}
                disabled={rating}
                className="px-2 py-2 text-lg leading-none transition-colors disabled:opacity-50"
                style={{ color: star <= displayStar ? '#ffb04d' : '#35393c' }}
                aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
              >
                ★
              </button>
            ))}
          </div>
          {ratingCount > 0 && (
            <span className="font-mono text-xs text-ink-4">
              {ratingAvg.toFixed(2)} ({ratingCount})
            </span>
          )}
        </div>

        <div className="flex-1" />

        {/* Remix */}
        <button
          type="button"
          onClick={() => {
            void handleRemix();
          }}
          disabled={remixing}
          className="border border-signal px-4 py-2.5 text-sm font-semibold text-signal transition-colors hover:bg-raised disabled:opacity-50"
        >
          {remixing ? 'Remixing…' : '↻ Remix it'}
        </button>

        {/* Report */}
        <button
          type="button"
          onClick={() => {
            void handleReport();
          }}
          disabled={reported}
          className="border border-hairline px-4 py-2.5 text-sm text-ink-4 transition-colors hover:border-edge hover:text-ink-3 disabled:opacity-50"
        >
          {reported ? 'Reported' : 'Report'}
        </button>
      </div>

      {/* Leaderboard (#3.8) — top-10 scores reported by the game. */}
      {leaderboard.length > 0 && (
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
          <h2 className="type-label mb-4 flex items-center gap-2 text-ink">
            <TrophyIcon />
            Leaderboard
          </h2>
          <div className="overflow-hidden border border-hairline bg-surface">
            {leaderboard.map((entry, i) => (
              <div
                key={`${entry.userId ?? 'anon'}-${entry.createdAt}-${i}`}
                className="flex items-center gap-3 border-b border-hairline px-4 py-2.5 last:border-b-0"
              >
                <span
                  className={`w-6 font-mono text-xs tabular-nums ${
                    i === 0 ? 'text-live' : i < 3 ? 'text-ink-2' : 'text-ink-4'
                  }`}
                >
                  {i + 1}
                </span>
                {entry.handle ? (
                  <Link
                    href={`/u/${entry.handle}`}
                    className="truncate text-sm font-medium text-ink-3 transition-colors hover:text-signal"
                  >
                    @{entry.handle}
                  </Link>
                ) : (
                  <span className="truncate text-sm italic text-ink-4">anonymous</span>
                )}
                <span className="flex-1" />
                <span className="font-mono text-sm font-semibold tabular-nums text-ink">
                  {entry.score.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Comments section */}
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <h2 className="type-label mb-6 text-ink">Comments</h2>

        {/* Add comment */}
        <form
          onSubmit={(e) => {
            void handleAddComment(e);
          }}
          className="mb-8"
        >
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Leave a comment…"
            rows={3}
            disabled={submitting}
            className="w-full resize-none border border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal disabled:opacity-50"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={submitting || !commentBody.trim()}
              className="bg-signal px-4 py-2 text-xs font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>

        {/* Comment list */}
        {commentsLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse border border-hairline bg-surface p-4">
                <div className="mb-2 h-3 w-1/4 bg-raised" />
                <div className="h-3 w-3/4 bg-raised" />
              </div>
            ))}
          </div>
        )}

        {!commentsLoading && comments.length === 0 && (
          <p className="py-8 text-center text-sm text-ink-4">No comments yet. Yours goes first.</p>
        )}

        {!commentsLoading && comments.length > 0 && (
          <div className="space-y-3">
            {comments.map((comment) => (
              <CommentCard key={comment.id} comment={comment} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({ comment }: { comment: HubComment }) {
  const date = new Date(comment.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="border border-hairline bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        {comment.authorHandle ? (
          // Author-resolved (#3.9): link the @handle to the creator profile.
          <Link
            href={`/u/${comment.authorHandle}`}
            className="text-xs font-medium text-ink-3 transition-colors hover:text-signal"
          >
            {comment.authorDisplayName ?? `@${comment.authorHandle}`}
          </Link>
        ) : (
          <span className="font-mono text-xs text-ink-4">{comment.userId.slice(0, 8)}</span>
        )}
        <span className="font-mono text-[10px] tracking-[.06em] text-ink-4">{date}</span>
      </div>
      <p className="text-sm leading-relaxed text-ink-3">{comment.body}</p>
    </div>
  );
}

function TrophyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#ffb04d"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="9" r="3" />
      <path d="M18 12a6 6 0 0 1-6 6H6" />
      <path d="M6 9v6" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
