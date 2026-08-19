'use client';

/**
 * The jam room. One screen, five faces, driven entirely by `state.phase`:
 *
 *   join      — you have the code but no seat yet
 *   lobby     — the code, big; the roster filling up; the host's start button
 *   prompt    — ONE question, one input, a countdown, and who's already in
 *   reveal    — every answer face-up, tappable to hype
 *   building  — the room watches the build together
 *   ready     — the play link, for everyone
 *
 * Everything is sized for a phone held in one hand: a single decision per
 * screen, controls in the bottom third, nothing that needs a second thumb.
 * Desktop gets the same layout centered — a jam is a phone experience that
 * happens to also work on a laptop, not the other way round.
 */

import JamPlayerDots from '@/components/JamPlayerDots';
import JamRevealCard from '@/components/JamRevealCard';
import { publishProject } from '@/lib/api';
import {
  JamError,
  type JamSeat,
  buildJam,
  clearJamSeat,
  describeJamError,
  endJam,
  getJamSeat,
  getRememberedJamName,
  jamInviteUrl,
  joinJam,
  leaveJam,
  nextJamRound,
  publishJam,
  rememberJamName,
  revealJamRound,
  saveJamSeat,
  startJam,
  submitJamAnswer,
  voteJamAnswer,
} from '@/lib/jam';
import { useJamCountdown, useJamRoom } from '@/lib/use-jam-room';
import {
  JAM_MAX_ANSWER_LEN,
  JAM_MAX_NAME_LEN,
  JAM_MIN_PLAYERS,
  type JamState,
  jamColorForSeat,
  jamPromptById,
  normalizeJamCode,
} from '@playforge/shared/game-jam';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Hex for a palette id, so a player's color is identical everywhere. */
function colorHex(colorId: string): string {
  for (let seat = 0; seat < 8; seat++) {
    const entry = jamColorForSeat(seat);
    if (entry.id === colorId) return entry.hex;
  }
  return jamColorForSeat(0).hex;
}

export default function JamRoomPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = normalizeJamCode(
    typeof params?.code === 'string' ? params.code : (params?.code?.[0] ?? ''),
  );

  // The whole seat (id + token), not just the token: `seat.playerId` is what
  // decides which panel renders, so it must be true the instant a join returns
  // rather than after the next room snapshot arrives.
  const [seat, setSeat] = useState<JamSeat | null>(null);
  const [seatReady, setSeatReady] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  // Read the stored seat once on mount — a refresh mid-jam must not eject you.
  useEffect(() => {
    if (!code) return;
    setSeat(getJamSeat(code));
    setSeatReady(true);
  }, [code]);

  const seatToken = seat?.token ?? null;
  const { state, live, error, toasts, refresh } = useJamRoom(
    seatReady && code ? code : null,
    seatToken,
  );

  /** Forget this device's seat and fall back to the join form. */
  const dropSeat = useCallback(() => {
    clearJamSeat(code);
    setSeat(null);
  }, [code]);

  // The roster row for this seat. Briefly null right after joining (the last
  // snapshot predates the join) and while a player is mid-reconnect — which is
  // exactly why it must NOT decide whether we're seated. `seat` decides that.
  const me = useMemo(
    () => state?.players.find((p) => p.id === seat?.playerId) ?? null,
    [state, seat],
  );
  const isHost = seat !== null && state !== null && seat.playerId === state.hostPlayerId;

  /**
   * Run a room action, surfacing any failure as one sentence.
   *
   * A seat the server no longer recognizes is the one failure worth recovering
   * from rather than reporting: the room ended, or this seat left from another
   * tab. We only trust the server's explicit `jam_seat_invalid` for that —
   * inferring it from a roster that merely hasn't caught up yet would eject a
   * player the moment they joined.
   */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setActionError('');
      try {
        await fn();
        refresh();
      } catch (err) {
        if (err instanceof JamError && err.code === 'jam_seat_invalid') {
          dropSeat();
        }
        setActionError(describeJamError(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh, dropSeat],
  );

  function handleJoined(token: string, playerId: string) {
    const fresh: JamSeat = { playerId, token };
    saveJamSeat(code, fresh);
    setSeat(fresh);
    refresh();
  }

  if (!code) {
    return (
      <Shell>
        <Centered>That link is missing a room code.</Centered>
      </Shell>
    );
  }

  if (!seatReady || (!state && !error)) {
    return (
      <Shell>
        <Centered>
          <span className="animate-pulse font-mono text-sm tracking-[.2em] text-ink-4">
            FINDING ROOM {code}…
          </span>
        </Centered>
      </Shell>
    );
  }

  if (!state) {
    return (
      <Shell>
        <Centered>
          <p className="text-ink-2">We couldn&apos;t find room {code}.</p>
          <Link
            href="/jam"
            className="mt-6 inline-block bg-signal px-6 py-3 text-sm font-bold text-chrome"
          >
            Back to Game Jam
          </Link>
        </Centered>
      </Shell>
    );
  }

  const notSeated = seat === null;

  return (
    <Shell>
      <RoomHeader state={state} live={live} me={seat?.playerId ?? null} />
      <Toasts toasts={toasts} />

      <div className="mx-auto w-full max-w-[560px] flex-1 px-5 pb-10">
        {actionError && (
          <div className="mb-5 flex items-start gap-2 border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
            <span className="mt-0.5 flex-shrink-0">⚠</span>
            <span>{actionError}</span>
          </div>
        )}

        {notSeated ? (
          <JoinPanel code={code} state={state} onJoined={handleJoined} />
        ) : state.phase === 'lobby' ? (
          <LobbyPanel
            code={code}
            state={state}
            isHost={isHost}
            busy={busy}
            onStart={() => act(() => startJam(code, seatToken as string))}
          />
        ) : state.phase === 'prompt' ? (
          <PromptPanel
            state={state}
            me={seat.playerId}
            isHost={isHost}
            busy={busy}
            onSubmit={(text) => act(() => submitJamAnswer(code, seatToken as string, text))}
            onReveal={() => act(() => revealJamRound(code, seatToken as string))}
          />
        ) : state.phase === 'reveal' ? (
          <RevealPanel
            state={state}
            me={seat.playerId}
            isHost={isHost}
            busy={busy}
            onVote={(answerId) => act(() => voteJamAnswer(code, seatToken as string, answerId))}
            onNext={() => act(() => nextJamRound(code, seatToken as string))}
            onBuild={() => act(() => buildJam(code, seatToken as string))}
          />
        ) : state.phase === 'building' ? (
          <BuildingPanel state={state} toasts={toasts} isHost={isHost} />
        ) : (
          <ReadyPanel
            state={state}
            isHost={isHost}
            busy={busy}
            onPublish={() =>
              act(async () => {
                // Publishing is outward-facing, so it stays the owner's explicit
                // action through the normal publish route; the jam then reads the
                // slug back from the server rather than being handed one.
                if (state.projectId) await publishProject(state.projectId);
                await publishJam(code, seatToken as string);
              })
            }
          />
        )}

        {!notSeated && (
          <div className="mt-12 flex items-center justify-between border-t border-hairline pt-5">
            <button
              type="button"
              onClick={() =>
                act(async () => {
                  await leaveJam(code, seatToken as string);
                  dropSeat();
                  router.push('/jam');
                })
              }
              className="tap-target font-mono text-[11px] tracking-[.14em] text-ink-4 transition-colors hover:text-fail"
            >
              LEAVE ROOM
            </button>
            {isHost && state.phase !== 'ended' && (
              <button
                type="button"
                onClick={() =>
                  act(async () => {
                    await endJam(code, seatToken as string);
                    dropSeat();
                    router.push('/jam');
                  })
                }
                className="tap-target font-mono text-[11px] tracking-[.14em] text-ink-4 transition-colors hover:text-fail"
              >
                CLOSE JAM
              </button>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-dvh flex-col bg-ground">{children}</main>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      {children}
    </div>
  );
}

function RoomHeader({
  state,
  live,
  me,
}: {
  state: JamState;
  live: boolean;
  me: string | null;
}) {
  const roundLabel =
    state.phase === 'prompt' || state.phase === 'reveal'
      ? `${state.round + 1} / ${state.roundPromptIds.length}`
      : null;

  return (
    <header className="safe-top sticky top-0 z-30 border-b border-hairline bg-chrome/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[560px] items-center gap-3 px-5 py-3">
        <Link
          href="/jam"
          className="font-mono text-lg font-bold tracking-[.24em] text-signal"
          title="Room code"
        >
          {state.code}
        </Link>
        <span
          className={`h-1.5 w-1.5 flex-none rounded-full ${live ? 'bg-pass' : 'bg-live'}`}
          title={live ? 'Live' : 'Reconnecting'}
        />
        <div className="min-w-0 flex-1">
          {state.title && (
            <span className="block truncate text-[13px] font-semibold text-ink">{state.title}</span>
          )}
        </div>
        {roundLabel && <span className="type-label-xs flex-none text-ink-4">{roundLabel}</span>}
        <JamPlayerDots players={state.players} me={me} />
      </div>
    </header>
  );
}

function Toasts({ toasts }: { toasts: Array<{ id: number; message: string }> }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-1.5 px-5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="max-w-full truncate border border-hairline bg-raised px-4 py-2 font-mono text-[11px] tracking-[.1em] text-ink-2 shadow-lg"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ── join ─────────────────────────────────────────────────────────────────────

function JoinPanel({
  code,
  state,
  onJoined,
}: {
  code: string;
  state: JamState;
  onJoined: (token: string, playerId: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setName(getRememberedJamName()), []);

  const closed = state.phase === 'building' || state.phase === 'ready' || state.phase === 'ended';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      rememberJamName(trimmed);
      const { seat } = await joinJam(code, trimmed);
      onJoined(seat.token, seat.playerId);
    } catch (err) {
      setError(describeJamError(err));
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <div className="pt-14 text-center">
        <p className="text-lg text-ink-2">This jam has already moved on to building.</p>
        {state.playSlug && (
          <Link
            href={`/p/${state.playSlug}`}
            className="tap-target mt-7 inline-block w-full bg-signal px-6 py-4 text-base font-bold text-chrome"
          >
            Play what they made
          </Link>
        )}
        <Link
          href="/jam"
          className="tap-target mt-3 inline-block w-full border border-edge px-6 py-4 text-base font-semibold text-ink"
        >
          Start your own jam
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="pt-10">
      <div className="type-label-xs text-ink-4">Joining room</div>
      <div className="mt-1 font-mono text-[52px] font-bold leading-none tracking-[.2em] text-signal">
        {code}
      </div>
      <p className="mt-4 text-[15px] text-ink-3">
        {state.players.length} {state.players.length === 1 ? 'person is' : 'people are'} already in.
      </p>

      <label htmlFor="join-name" className="type-label-xs mt-9 block text-ink-4">
        What should we call you?
      </label>
      <input
        id="join-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Maya"
        // biome-ignore lint/a11y/noAutofocus: a jam round is a timed single-input screen; the keyboard must be up the instant the question appears or the player burns seconds of a 60-second round hunting for the box.
        autoFocus
        maxLength={JAM_MAX_NAME_LEN}
        className="mt-2 w-full border border-hairline bg-surface px-4 py-4 text-lg text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal"
      />
      {error && <p className="mt-3 text-sm text-fail">{error}</p>}
      <button
        type="submit"
        disabled={!name.trim() || busy}
        className="tap-target mt-5 w-full bg-signal px-6 py-4 text-base font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Joining…' : "I'm in"}
      </button>
    </form>
  );
}

// ── lobby ────────────────────────────────────────────────────────────────────

function LobbyPanel({
  code,
  state,
  isHost,
  busy,
  onStart,
}: {
  code: string;
  state: JamState;
  isHost: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const enough = state.players.length >= JAM_MIN_PLAYERS;

  async function share() {
    const url = jamInviteUrl(code);
    const shareData = { title: 'Join my Game Jam', text: `Room code ${code}`, url };
    // The native sheet is the whole point on a phone — it puts the code into
    // whatever group chat the party is already using. Clipboard is the desktop
    // fallback, and the code stays visible in huge type either way.
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the user dismissed the sheet, or the clipboard is blocked */
    }
  }

  return (
    <div className="pt-8">
      <div className="type-label-xs text-center text-ink-4">Read this out</div>
      <div className="mt-2 text-center font-mono text-[64px] font-bold leading-none tracking-[.18em] text-signal sm:text-[80px]">
        {code}
      </div>

      <button
        type="button"
        onClick={share}
        className="tap-target mt-6 w-full border border-edge px-6 py-3.5 text-sm font-semibold text-ink transition-colors hover:border-signal hover:text-signal"
      >
        {copied ? 'Link copied' : 'Share the link'}
      </button>

      <div className="type-label-xs mt-10 text-ink-4">In the room · {state.players.length}</div>
      <ul className="mt-3 flex flex-col gap-px border border-hairline bg-hairline">
        {state.players.map((p, i) => (
          <li key={p.id} className="flex items-center gap-3 bg-ground px-4 py-3.5">
            <span
              className="h-3 w-3 flex-none"
              style={{ backgroundColor: colorHex(p.color) }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{p.name}</span>
            {p.isHost && <span className="type-label-xs flex-none text-ink-4">HOST</span>}
            <span className="type-label-xs flex-none text-ink-4">P{i + 1}</span>
          </li>
        ))}
        {state.players.length < JAM_MIN_PLAYERS && (
          <li className="flex items-center gap-3 bg-ground px-4 py-3.5">
            <span
              className="h-3 w-3 flex-none border border-dashed border-edge"
              aria-hidden="true"
            />
            <span className="text-[15px] text-ink-4">Waiting for one more…</span>
          </li>
        )}
      </ul>

      <p className="mt-8 text-center text-[13px] leading-relaxed text-ink-3">
        {state.roundPromptIds.length} questions ·{' '}
        {state.config.answerSeconds > 0 ? `${state.config.answerSeconds}s each` : 'no timer'} ·{' '}
        {state.config.engine === 'three' ? '3D' : '2D'}
      </p>

      {isHost ? (
        <button
          type="button"
          onClick={onStart}
          disabled={!enough || busy}
          className="tap-target mt-6 w-full bg-signal px-6 py-4 text-base font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {enough ? 'Start the jam' : `Need ${JAM_MIN_PLAYERS - state.players.length} more player`}
        </button>
      ) : (
        <p className="mt-6 text-center font-mono text-[11px] tracking-[.14em] text-ink-4">
          WAITING FOR THE HOST TO START
        </p>
      )}
    </div>
  );
}

// ── prompt ───────────────────────────────────────────────────────────────────

function PromptPanel({
  state,
  me,
  isHost,
  busy,
  onSubmit,
  onReveal,
}: {
  state: JamState;
  me: string;
  isHost: boolean;
  busy: boolean;
  onSubmit: (text: string) => void;
  onReveal: () => void;
}) {
  const promptId = state.roundPromptIds[state.round] ?? '';
  const card = jamPromptById(promptId);
  const remaining = useJamCountdown(state.deadlineAt);
  const mine = state.answers.find((a) => a.round === state.round && a.playerId === me);
  const [text, setText] = useState('');
  const lastRound = useRef(state.round);

  // A new card must start blank — carrying the previous round's text over would
  // silently submit the wrong idea for anyone who taps fast.
  useEffect(() => {
    if (lastRound.current !== state.round) {
      lastRound.current = state.round;
      setText('');
    }
  }, [state.round]);

  const answered = state.answeredPlayerIds.length;
  const total = state.players.length;
  const iAnswered = mine !== undefined;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed);
    setText('');
  }

  return (
    <div className="pt-8">
      {remaining !== null && (
        <div className="mb-7">
          <div className="flex items-baseline justify-between">
            <span className="type-label-xs text-ink-4">Time</span>
            <span
              className={`font-mono text-2xl font-bold tabular-nums ${
                remaining <= 10 ? 'text-fail' : 'text-ink'
              }`}
            >
              {remaining}s
            </span>
          </div>
          <div className="mt-2 h-0.5 w-full bg-hairline">
            <div
              className={`h-full transition-[width] duration-300 ease-linear ${
                remaining <= 10 ? 'bg-fail' : 'bg-signal'
              }`}
              style={{
                width: `${Math.max(
                  0,
                  Math.min(100, (remaining / Math.max(1, state.config.answerSeconds)) * 100),
                )}%`,
              }}
            />
          </div>
        </div>
      )}

      <h2 className="type-display text-[32px] leading-[1.05] text-ink sm:text-[40px]">
        {card?.question ?? 'Throw in an idea'}
      </h2>
      {card?.hint && <p className="mt-3 text-[15px] text-ink-3">{card.hint}</p>}

      {iAnswered ? (
        <div className="mt-8">
          <div className="border border-signal/40 bg-signal/5 px-4 py-4">
            <div className="type-label-xs text-signal">Locked in</div>
            <p className="mt-2 text-lg leading-snug text-ink">{mine?.text}</p>
          </div>
          <p className="mt-4 text-center text-[13px] text-ink-3">
            Waiting on {Math.max(0, total - answered)} more…
          </p>
          <ChangeAnswer
            onChange={(next) => onSubmit(next)}
            busy={busy}
            current={mine?.text ?? ''}
          />
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, JAM_MAX_ANSWER_LEN))}
            placeholder={card?.placeholder ?? 'something weird'}
            rows={3}
            // biome-ignore lint/a11y/noAutofocus: a jam round is a timed single-input screen; the keyboard must be up the instant the question appears or the player burns seconds of a 60-second round hunting for the box.
            autoFocus
            className="w-full resize-none border border-hairline bg-surface px-4 py-4 text-lg leading-snug text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal"
          />
          <div className="mt-1.5 flex justify-end">
            <span className="font-mono text-[11px] text-ink-4">
              {text.length}/{JAM_MAX_ANSWER_LEN}
            </span>
          </div>
          <button
            type="submit"
            disabled={!text.trim() || busy}
            className="tap-target mt-3 w-full bg-signal px-6 py-4 text-base font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            Lock it in
          </button>
        </form>
      )}

      <div className="mt-10">
        <div className="flex items-center justify-between">
          <span className="type-label-xs text-ink-4">Locked in</span>
          <span className="font-mono text-[13px] text-ink-3">
            {answered} / {total}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {state.players.map((p) => {
            const isIn = state.answeredPlayerIds.includes(p.id);
            return (
              <span
                key={p.id}
                className={`border px-3 py-1.5 text-[13px] transition-colors ${
                  isIn ? 'border-transparent text-chrome' : 'border-hairline text-ink-4'
                }`}
                style={isIn ? { backgroundColor: colorHex(p.color) } : undefined}
              >
                {p.name}
              </span>
            );
          })}
        </div>
      </div>

      {isHost && (
        <button
          type="button"
          onClick={onReveal}
          disabled={busy}
          className="tap-target mt-8 w-full border border-edge px-6 py-3.5 text-sm font-semibold text-ink-3 transition-colors hover:border-signal hover:text-signal disabled:opacity-40"
        >
          Skip the wait — show what&apos;s in
        </button>
      )}
    </div>
  );
}

/** Small "actually, change it" affordance for a player who already submitted. */
function ChangeAnswer({
  current,
  busy,
  onChange,
}: {
  current: string;
  busy: boolean;
  onChange: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current);

  useEffect(() => setText(current), [current]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="tap-target mt-3 w-full py-3 text-center font-mono text-[11px] tracking-[.14em] text-ink-4 transition-colors hover:text-signal"
      >
        CHANGE MY ANSWER
      </button>
    );
  }

  return (
    <div className="mt-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, JAM_MAX_ANSWER_LEN))}
        rows={3}
        // biome-ignore lint/a11y/noAutofocus: a jam round is a timed single-input screen; the keyboard must be up the instant the question appears or the player burns seconds of a 60-second round hunting for the box.
        autoFocus
        className="w-full resize-none border border-hairline bg-surface px-4 py-4 text-lg leading-snug text-ink outline-none focus:border-signal"
      />
      <button
        type="button"
        disabled={!text.trim() || busy}
        onClick={() => {
          onChange(text.trim());
          setEditing(false);
        }}
        className="tap-target mt-3 w-full bg-signal px-6 py-3.5 text-sm font-bold text-chrome disabled:opacity-40"
      >
        Save it
      </button>
    </div>
  );
}

// ── reveal ───────────────────────────────────────────────────────────────────

function RevealPanel({
  state,
  me,
  isHost,
  busy,
  onVote,
  onNext,
  onBuild,
}: {
  state: JamState;
  me: string;
  isHost: boolean;
  busy: boolean;
  onVote: (answerId: string) => void;
  onNext: () => void;
  onBuild: () => void;
}) {
  const promptId = state.roundPromptIds[state.round] ?? '';
  const card = jamPromptById(promptId);
  const answers = state.answers.filter((a) => a.round === state.round);
  const isFinal = state.round >= state.roundPromptIds.length - 1;
  const byId = new Map(state.players.map((p) => [p.id, p]));

  return (
    <div className="pt-8">
      <div className="type-label-xs text-ink-4">Round {state.round + 1}</div>
      <h2 className="type-title mt-2 text-2xl leading-tight text-ink">
        {card?.question ?? 'The ideas'}
      </h2>
      <p className="mt-2 text-[13px] text-ink-3">Tap the ones you love. They lead the build.</p>

      <div className="mt-6 flex flex-col gap-2.5">
        {answers.length === 0 && (
          <p className="border border-hairline bg-surface px-4 py-6 text-center text-sm text-ink-4">
            Nobody got an answer in for this one. It happens.
          </p>
        )}
        {answers.map((answer) => {
          const author = byId.get(answer.playerId);
          return (
            <JamRevealCard
              key={answer.id}
              text={answer.text}
              votes={answer.votes}
              authorName={author?.name ?? 'Someone'}
              authorColor={colorHex(author?.color ?? 'cyan')}
              isMine={answer.playerId === me}
              disabled={busy}
              onVote={() => onVote(answer.id)}
            />
          );
        })}
      </div>

      {isHost ? (
        <button
          type="button"
          onClick={isFinal ? onBuild : onNext}
          disabled={busy}
          className="tap-target mt-9 w-full bg-signal px-6 py-4 text-base font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Working…' : isFinal ? 'Build our game' : 'Next question'}
        </button>
      ) : (
        <p className="mt-9 text-center font-mono text-[11px] tracking-[.14em] text-ink-4">
          {isFinal ? 'HOST IS ABOUT TO BUILD IT' : 'WAITING FOR THE NEXT QUESTION'}
        </p>
      )}
    </div>
  );
}

// ── building ─────────────────────────────────────────────────────────────────

function BuildingPanel({
  state,
  toasts,
  isHost,
}: {
  state: JamState;
  toasts: Array<{ id: number; message: string }>;
  isHost: boolean;
}) {
  const latest = toasts[toasts.length - 1]?.message ?? 'Warming up the engine…';
  return (
    <div className="pt-16 text-center">
      <div className="mx-auto mb-8 h-14 w-14 animate-spin border-2 border-hairline border-t-signal" />
      <h2 className="type-display text-[32px] leading-tight text-ink">
        Building
        <br />
        {state.title ?? 'your game'}
      </h2>
      <p className="mt-5 text-[15px] text-ink-3">
        Every idea in this room is going in. This takes a couple of minutes — stay on this screen
        and watch.
      </p>
      <p className="mt-8 truncate font-mono text-[11px] tracking-[.12em] text-signal">{latest}</p>

      {isHost && state.projectId && (
        <Link
          href={`/projects/${state.projectId}`}
          className="tap-target mt-10 inline-block w-full border border-edge px-6 py-3.5 text-sm font-semibold text-ink-3 transition-colors hover:border-signal hover:text-signal"
        >
          Watch the full build log
        </Link>
      )}
    </div>
  );
}

// ── ready ────────────────────────────────────────────────────────────────────

function ReadyPanel({
  state,
  isHost,
  busy,
  onPublish,
}: {
  state: JamState;
  isHost: boolean;
  busy: boolean;
  onPublish: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const playUrl = state.playSlug
    ? `${typeof window === 'undefined' ? '' : window.location.origin}/p/${state.playSlug}`
    : null;

  async function share() {
    if (!playUrl) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: state.title ?? 'Our game', url: playUrl });
        return;
      }
      await navigator.clipboard.writeText(playUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* dismissed or blocked */
    }
  }

  return (
    <div className="pt-14 text-center">
      <div className="type-label-xs text-pass">Built</div>
      <h2 className="type-display mt-3 text-[36px] leading-[1.05] text-ink sm:text-5xl">
        {state.title ?? 'Your game'}
      </h2>
      <p className="mt-5 text-[15px] leading-relaxed text-ink-3">
        {state.players.length} players, one screen. Gather round whichever device has the biggest
        screen and hit play.
      </p>

      {state.playSlug ? (
        <>
          <Link
            href={`/p/${state.playSlug}`}
            className="tap-target mt-9 inline-block w-full bg-signal px-6 py-5 text-lg font-bold text-chrome transition-colors hover:bg-signal-bright"
          >
            Play it now
          </Link>
          <button
            type="button"
            onClick={share}
            className="tap-target mt-3 w-full border border-edge px-6 py-3.5 text-sm font-semibold text-ink transition-colors hover:border-signal hover:text-signal"
          >
            {copied ? 'Link copied' : 'Send everyone the link'}
          </button>
        </>
      ) : isHost ? (
        <>
          <p className="mt-9 text-[13px] leading-relaxed text-ink-3">
            Publish it and everyone in the room — including the guests who never signed in — gets a
            link they can play.
          </p>
          <button
            type="button"
            onClick={onPublish}
            disabled={busy}
            className="tap-target mt-4 w-full bg-signal px-6 py-5 text-lg font-bold text-chrome transition-colors hover:bg-signal-bright disabled:opacity-40"
          >
            {busy ? 'Publishing…' : 'Publish for the room'}
          </button>
        </>
      ) : (
        <p className="mt-9 font-mono text-[11px] tracking-[.14em] text-ink-4">
          WAITING FOR THE HOST TO SHARE IT
        </p>
      )}

      {isHost && state.projectId && (
        <Link
          href={`/projects/${state.projectId}`}
          className="tap-target mt-3 inline-block w-full border border-edge px-6 py-3.5 text-sm font-semibold text-ink-3 transition-colors hover:border-signal hover:text-signal"
        >
          Open it in the builder
        </Link>
      )}
    </div>
  );
}
