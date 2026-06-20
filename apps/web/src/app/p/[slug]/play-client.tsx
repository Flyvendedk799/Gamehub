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
}

export default function PlayClient({
  slug,
  initialTitle,
  remixCount = 0,
  parentSlug = null,
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
    <div className="flex flex-col min-h-screen bg-[#0a0a0a]">
      {/* Top bar */}
      <header className="flex-shrink-0 h-12 border-b border-[#222222] bg-[#111111] flex items-center px-4 gap-4 z-10">
        <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
          <BrandMark size={24} />
          <Wordmark className="text-xs font-semibold text-[#f4f4f5] hidden sm:block group-hover:text-[#6366f1] transition-colors" />
        </Link>

        <div className="w-px h-5 bg-[#222222] flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-[#a1a1aa] truncate">
            {initialTitle ?? slug}
          </span>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <a
            href={gameUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium"
          >
            Full screen ↗
          </a>
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#1a1a1a] hover:bg-[#222222] text-[#a1a1aa] border border-[#2a2a2a] transition-colors font-medium"
          >
            Make your own
          </Link>
        </div>
      </header>

      {/* Game iframe */}
      <div className="w-full h-[60vh] relative">
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
        <div className="border-t border-[#222222] bg-[#0d0d0d] px-4 py-2 flex items-center gap-3 flex-wrap text-xs">
          {parentSlug && (
            <span className="text-[#71717a] inline-flex items-center gap-1.5">
              <ForkIcon />
              Remixed from{' '}
              <Link
                href={`/p/${parentSlug}`}
                className="text-[#6366f1] hover:text-[#818cf8] font-medium transition-colors"
              >
                {parentSlug}
              </Link>
            </span>
          )}
          {remixCount > 0 && parentSlug && <span className="text-[#2a2a2a]">·</span>}
          {remixCount > 0 && (
            <span className="text-[#52525b]">
              Remixed {remixCount.toLocaleString()} {remixCount === 1 ? 'time' : 'times'}
            </span>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="border-t border-[#222222] bg-[#111111] px-4 py-3 flex items-center gap-4 flex-wrap">
        {/* Like button */}
        <button
          type="button"
          onClick={() => {
            void handleLike();
          }}
          disabled={liking}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium disabled:opacity-50 ${
            liked
              ? 'bg-rose-500/10 text-rose-400 border-rose-500/20 hover:bg-rose-500/20'
              : 'bg-[#1a1a1a] text-[#71717a] border-[#2a2a2a] hover:text-[#f4f4f5] hover:border-[#333333]'
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
                className="text-lg leading-none transition-colors disabled:opacity-50"
                style={{ color: star <= displayStar ? '#f59e0b' : '#3f3f46' }}
                aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
              >
                ★
              </button>
            ))}
          </div>
          {ratingCount > 0 && (
            <span className="text-xs text-[#52525b]">
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
          className="text-xs px-3 py-1.5 rounded-lg bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium disabled:opacity-50"
        >
          {remixing ? 'Remixing…' : 'Remix'}
        </button>

        {/* Report */}
        <button
          type="button"
          onClick={() => {
            void handleReport();
          }}
          disabled={reported}
          className="text-xs px-3 py-1.5 rounded-lg bg-[#1a1a1a] hover:bg-[#222222] text-[#52525b] hover:text-[#71717a] border border-[#2a2a2a] transition-colors font-medium disabled:opacity-50"
        >
          {reported ? 'Reported' : 'Report'}
        </button>
      </div>

      {/* Leaderboard (#3.8) — top-10 scores reported by the game. */}
      {leaderboard.length > 0 && (
        <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-3xl mx-auto w-full">
          <h2 className="text-sm font-semibold text-[#f4f4f5] mb-4 flex items-center gap-2">
            <TrophyIcon />
            Leaderboard
          </h2>
          <div className="bg-[#111111] border border-[#222222] rounded-xl overflow-hidden">
            {leaderboard.map((entry, i) => (
              <div
                key={`${entry.userId ?? 'anon'}-${entry.createdAt}-${i}`}
                className="flex items-center gap-3 px-4 py-2.5 border-b border-[#1a1a1a] last:border-b-0"
              >
                <span
                  className={`w-6 text-xs font-mono tabular-nums ${
                    i === 0 ? 'text-[#f59e0b]' : i < 3 ? 'text-[#a1a1aa]' : 'text-[#52525b]'
                  }`}
                >
                  {i + 1}
                </span>
                {entry.handle ? (
                  <Link
                    href={`/u/${entry.handle}`}
                    className="text-sm text-[#a1a1aa] hover:text-[#6366f1] transition-colors font-medium truncate"
                  >
                    @{entry.handle}
                  </Link>
                ) : (
                  <span className="text-sm text-[#52525b] italic truncate">anonymous</span>
                )}
                <span className="flex-1" />
                <span className="text-sm font-semibold text-[#f4f4f5] tabular-nums">
                  {entry.score.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Comments section */}
      <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-3xl mx-auto w-full">
        <h2 className="text-sm font-semibold text-[#f4f4f5] mb-6">Comments</h2>

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
            className="w-full bg-[#111111] border border-[#222222] rounded-xl px-4 py-3 text-sm text-[#f4f4f5] placeholder-[#52525b] outline-none focus:border-[#6366f1] transition-colors resize-none disabled:opacity-50"
          />
          <div className="flex justify-end mt-2">
            <button
              type="submit"
              disabled={submitting || !commentBody.trim()}
              className="text-xs px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>

        {/* Comment list */}
        {commentsLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="bg-[#111111] border border-[#222222] rounded-xl p-4 animate-pulse"
              >
                <div className="h-3 bg-[#1a1a1a] rounded w-1/4 mb-2" />
                <div className="h-3 bg-[#1a1a1a] rounded w-3/4" />
              </div>
            ))}
          </div>
        )}

        {!commentsLoading && comments.length === 0 && (
          <p className="text-sm text-[#52525b] text-center py-8">No comments yet. Be the first!</p>
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
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        {comment.authorHandle ? (
          // Author-resolved (#3.9): link the @handle to the creator profile.
          <Link
            href={`/u/${comment.authorHandle}`}
            className="text-xs text-[#71717a] hover:text-[#6366f1] transition-colors font-medium"
          >
            {comment.authorDisplayName ?? `@${comment.authorHandle}`}
          </Link>
        ) : (
          <span className="text-xs text-[#52525b] font-mono">{comment.userId.slice(0, 8)}</span>
        )}
        <span className="text-xs text-[#3f3f46]">{date}</span>
      </div>
      <p className="text-sm text-[#a1a1aa] leading-relaxed">{comment.body}</p>
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
      stroke="#f59e0b"
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
