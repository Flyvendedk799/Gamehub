'use client';

/**
 * Game Jam entry — start a room or join one with a code.
 *
 * Mobile-first, because that's where a party actually is: two enormous targets,
 * one thumb-reachable field, nothing above the fold that isn't the decision.
 * Joining deliberately does NOT require an account — a guest types a code and a
 * name and they're in. Only hosting asks you to sign in, because the host's
 * account owns the game the room builds.
 */

import { BrandMark } from '@/components/Logo';
import { isAuthenticated } from '@/lib/auth';
import {
  type JamRoomSummary,
  createJam,
  describeJamError,
  getRememberedJamName,
  listMyJams,
  rememberJamName,
  saveJamSeat,
} from '@/lib/jam';
import {
  JAM_DEFAULT_ROUNDS,
  JAM_MAX_NAME_LEN,
  JAM_MAX_PLAYERS,
  JAM_MAX_ROUNDS,
  JAM_MIN_PLAYERS,
  JAM_MIN_ROUNDS,
  normalizeJamCode,
} from '@playforge/shared/game-jam';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Mode = 'pick' | 'host' | 'join';

export default function JamLandingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('pick');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [rounds, setRounds] = useState(JAM_DEFAULT_ROUNDS);
  const [engine, setEngine] = useState<'phaser' | 'three'>('phaser');
  const [timed, setTimed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authed, setAuthed] = useState(false);
  const [recent, setRecent] = useState<JamRoomSummary[] | null>(null);

  useEffect(() => {
    setName(getRememberedJamName());
    const ok = isAuthenticated();
    setAuthed(ok);
    if (!ok) return;
    let cancelled = false;
    void listMyJams()
      .then(({ jams }) => {
        if (!cancelled) setRecent(jams.filter((j) => j.phase !== 'ended').slice(0, 3));
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleHost(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    if (!isAuthenticated()) {
      router.push('/auth/register?next=/jam');
      return;
    }
    setBusy(true);
    setError('');
    try {
      rememberJamName(trimmed);
      const { state, seat } = await createJam({
        name: trimmed,
        rounds,
        engine,
        answerSeconds: timed ? 60 : 0,
      });
      saveJamSeat(state.code, seat);
      router.push(`/jam/${state.code}`);
    } catch (err) {
      setError(describeJamError(err));
      setBusy(false);
    }
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = normalizeJamCode(code);
    if (clean.length < 4 || busy) return;
    // The room page owns the join form — it already handles the "I have a code
    // but no seat yet" state, so a shared link and this button land identically.
    if (name.trim()) rememberJamName(name.trim());
    router.push(`/jam/${clean}`);
  }

  return (
    <main className="min-h-dvh bg-ground">
      <div className="mx-auto w-full max-w-[560px] px-5 pb-24 pt-10 sm:pt-16">
        {/* Header */}
        <div className="mb-9 flex items-center gap-3">
          <BrandMark size={26} />
          <span className="type-label text-ink-4">Game Jam</span>
        </div>

        <h1 className="type-display text-[40px] leading-[0.95] text-ink sm:text-6xl">
          Make a game
          <br />
          <span className="text-signal">with your friends</span>
        </h1>
        <p className="mt-5 max-w-[42ch] text-[15px] leading-relaxed text-ink-3">
          Everyone grabs their phone. You each answer the same {rounds} questions with whatever idea
          comes out. At the end it all gets built into one game you play together on one screen.
        </p>

        {error && (
          <div className="mt-6 flex items-start gap-2 border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
            <span className="mt-0.5 flex-shrink-0">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* ── Pick a lane ─────────────────────────────────────────────────── */}
        {mode === 'pick' && (
          <div className="mt-10 flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setMode('join')}
              className="tap-target group flex items-center justify-between border border-hairline bg-surface px-5 py-6 text-left transition-colors hover:border-signal"
            >
              <span>
                <span className="block text-xl font-bold text-ink">Join a jam</span>
                <span className="mt-1 block text-[13px] text-ink-3">
                  Someone read you a 4-letter code. No account needed.
                </span>
              </span>
              <span className="ml-4 font-mono text-lg text-ink-4 transition-colors group-hover:text-signal">
                →
              </span>
            </button>

            <button
              type="button"
              onClick={() => setMode('host')}
              className="tap-target group flex items-center justify-between border border-hairline bg-surface px-5 py-6 text-left transition-colors hover:border-signal"
            >
              <span>
                <span className="block text-xl font-bold text-ink">Start a jam</span>
                <span className="mt-1 block text-[13px] text-ink-3">
                  You get a code to share. {JAM_MIN_PLAYERS}–{JAM_MAX_PLAYERS} players.
                </span>
              </span>
              <span className="ml-4 font-mono text-lg text-ink-4 transition-colors group-hover:text-signal">
                →
              </span>
            </button>
          </div>
        )}

        {/* ── Join ────────────────────────────────────────────────────────── */}
        {mode === 'join' && (
          <form onSubmit={handleJoin} className="mt-10">
            <label htmlFor="jam-code" className="type-label-xs block text-ink-4">
              Room code
            </label>
            <input
              id="jam-code"
              value={code}
              onChange={(e) => setCode(normalizeJamCode(e.target.value))}
              placeholder="ACDE"
              // biome-ignore lint/a11y/noAutofocus: single-purpose screen — the user tapped through specifically to type into this one field, so on a phone the keyboard must already be up.
              autoFocus
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              maxLength={4}
              className="mt-2 w-full border border-hairline bg-surface px-5 py-6 text-center font-mono text-[44px] font-bold uppercase tracking-[.3em] text-ink placeholder-ink-4/40 outline-none transition-colors focus:border-signal"
            />
            <button
              type="submit"
              disabled={code.length < 4}
              className="tap-target mt-4 w-full bg-signal px-6 py-4 text-base font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              Join the jam
            </button>
            <BackButton onClick={() => setMode('pick')} />
          </form>
        )}

        {/* ── Host ────────────────────────────────────────────────────────── */}
        {mode === 'host' && (
          <form onSubmit={handleHost} className="mt-10">
            <label htmlFor="jam-name" className="type-label-xs block text-ink-4">
              Your name in the room
            </label>
            <input
              id="jam-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Maya"
              // biome-ignore lint/a11y/noAutofocus: single-purpose screen — the user tapped through specifically to type into this one field, so on a phone the keyboard must already be up.
              autoFocus
              maxLength={JAM_MAX_NAME_LEN}
              className="mt-2 w-full border border-hairline bg-surface px-4 py-4 text-lg text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal"
            />

            <fieldset className="mt-7">
              <legend className="type-label-xs text-ink-4">Questions</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {[JAM_MIN_ROUNDS, 6, 8, JAM_MAX_ROUNDS].map((n) => (
                  <Chip key={n} active={rounds === n} onClick={() => setRounds(n)}>
                    {n}
                  </Chip>
                ))}
              </div>
            </fieldset>

            <fieldset className="mt-6">
              <legend className="type-label-xs text-ink-4">Engine</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                <Chip active={engine === 'phaser'} onClick={() => setEngine('phaser')}>
                  2D
                </Chip>
                <Chip active={engine === 'three'} onClick={() => setEngine('three')}>
                  3D
                </Chip>
              </div>
            </fieldset>

            <fieldset className="mt-6">
              <legend className="type-label-xs text-ink-4">Round timer</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                <Chip active={timed} onClick={() => setTimed(true)}>
                  60 seconds
                </Chip>
                <Chip active={!timed} onClick={() => setTimed(false)}>
                  No rush
                </Chip>
              </div>
            </fieldset>

            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="tap-target mt-8 w-full bg-signal px-6 py-4 text-base font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Opening the room…' : authed ? 'Get a room code' : 'Sign in and open a room'}
            </button>
            <BackButton onClick={() => setMode('pick')} />
          </form>
        )}

        {/* Rooms this host already has open */}
        {mode === 'pick' && recent !== null && recent.length > 0 && (
          <section className="mt-12">
            <div className="type-label-xs mb-3 text-ink-4">Your open rooms</div>
            <div className="flex flex-col gap-px border border-hairline bg-hairline">
              {recent.map((jam) => (
                <Link
                  key={jam.id}
                  href={`/jam/${jam.code}`}
                  className="flex items-center justify-between bg-ground px-4 py-3.5 transition-colors hover:bg-surface"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink-2">
                      {jam.title ?? 'Untitled jam'}
                    </span>
                    <span className="type-label-xs mt-1 block text-ink-4">
                      {jam.playerCount} player{jam.playerCount === 1 ? '' : 's'} · {jam.phase}
                    </span>
                  </span>
                  <span className="ml-4 font-mono text-lg font-bold tracking-[.2em] text-signal">
                    {jam.code}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* How it works */}
        {mode === 'pick' && (
          <section className="mt-14 border-t border-hairline pt-8">
            <div className="type-label-xs mb-4 text-ink-4">How it goes</div>
            <ol className="flex flex-col gap-4">
              {[
                ['Everyone joins', 'One person starts a room and reads out the code.'],
                ['Answer the questions', 'Same question, everyone at once, on their own phone.'],
                ['Hype the good ones', 'Answers flip face-up. Tap the ones you love.'],
                ['Play it together', 'It all compiles into one game for the whole room.'],
              ].map(([title, body], i) => (
                <li key={title} className="flex gap-4">
                  <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center border border-edge font-mono text-[11px] text-signal">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-ink">{title}</span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-3">
                      {body}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`tap-target border px-5 py-2.5 font-mono text-[13px] transition-colors ${
        active
          ? 'border-signal bg-raised text-signal'
          : 'border-hairline text-ink-4 hover:text-ink-3'
      }`}
    >
      {children}
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tap-target mt-3 w-full py-3 text-center font-mono text-[11px] tracking-[.14em] text-ink-4 transition-colors hover:text-ink-3"
    >
      ← BACK
    </button>
  );
}
