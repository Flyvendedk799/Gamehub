'use client';

import { ChatPanel } from '@/components/ChatPanel';
import { BrandMark, Wordmark } from '@/components/Logo';
import { PreviewPane, type TweakSchema } from '@/components/PreviewPane';
import { SocialOutroModal } from '@/components/SocialOutroModal';
import {
  type SnapshotEntry,
  describeApiError,
  generateGame,
  getActiveRun,
  getChatHistory,
  getProject,
  getSnapshots,
  getSocialOutro,
  publishProject,
  revertToSnapshot,
  streamRun,
} from '@/lib/api';
import { hydrateHistoryEvents, lastPreviewUrlFromHistory } from '@/lib/chat-hydration';
import { API_BASE } from '@/lib/config';
import { TRANSPORT_LOST_MESSAGE } from '@/lib/event-normalize';
import type { Project, RunCompleteEvent, RunErrorEvent, SseEvent } from '@/lib/types';
import { useCollab } from '@/lib/use-collab';
import { usePresence } from '@/lib/use-presence';
import type { SocialOutroSummary } from '@playforge/shared/social-outro';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = API_BASE;

export default function BuilderPage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const projectId = typeof params['id'] === 'string' ? params['id'] : '';
  const initialRunId = searchParams.get('runId') ?? null;

  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(initialRunId);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [showTimeline, setShowTimeline] = useState(false);
  const [isReverting, setIsReverting] = useState<string | null>(null);
  const [currentTweakSchema, setCurrentTweakSchema] = useState<TweakSchema | null>(null);

  // ─── Social outro (Share card) ─────────────────────────────────────────────
  const [showSocialOutro, setShowSocialOutro] = useState(false);
  const [socialOutro, setSocialOutro] = useState<SocialOutroSummary | null>(null);
  const [isLoadingSocialOutro, setIsLoadingSocialOutro] = useState(false);
  const [socialOutroError, setSocialOutroError] = useState<string | null>(null);

  const loadSocialOutro = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingSocialOutro(true);
    setSocialOutroError(null);
    try {
      setSocialOutro(await getSocialOutro(projectId));
    } catch (err) {
      setSocialOutroError(describeApiError(err));
    } finally {
      setIsLoadingSocialOutro(false);
    }
  }, [projectId]);

  function openSocialOutro() {
    setShowSocialOutro(true);
    void loadSocialOutro();
  }

  // CRDT collab — syncs a shared Y.Doc across all browser tabs on this project
  const { peerCount, connected: collabConnected } = useCollab(projectId || null);

  // Presence — tracks viewer count and handles live preview push from other collaborators
  const { viewerCount } = usePresence(projectId || null, {
    onPreviewUpdated: (url) => {
      if (!isStreaming) {
        const full = url.startsWith('http') ? url : `${BASE}${url}`;
        setPreviewUrl(full);
      }
    },
  });

  const refreshSnapshots = useCallback(() => {
    if (!projectId) return;
    void getSnapshots(projectId)
      .then(({ snapshots: s }) => {
        setSnapshots(s);
        const latest = s[0];
        if (latest?.tweakSchema && Object.keys(latest.tweakSchema).length > 0) {
          setCurrentTweakSchema(latest.tweakSchema as TweakSchema);
        }
      })
      .catch(() => {});
  }, [projectId]);

  // Track active SSE controller so we can close it on unmount / new run
  const streamCtrlRef = useRef<{ close: () => void } | null>(null);

  // ─── Load project metadata + snapshots (independent of any run) ───────────
  useEffect(() => {
    if (!projectId) return;
    setLoadError(null);
    void getProject(projectId)
      .then(({ project }) => setProject(project))
      .catch((err) => setLoadError(describeApiError(err)));
    refreshSnapshots();
  }, [projectId, refreshSnapshots]);

  // ─── Start streaming when runId changes ───────────────────────────────────
  const startStream = useCallback(
    (runId: string) => {
      // Close any existing stream
      streamCtrlRef.current?.close();
      setIsStreaming(true);
      setReconnecting(false);
      setHasError(false);
      setErrorMessage(undefined);

      // Leave a `?runId=` breadcrumb so a page reload (common on mobile, where the
      // OS unloads backgrounded tabs) can re-attach to this run directly. We only
      // read searchParams on mount, so replaceState here causes no re-render.
      if (typeof window !== 'undefined') {
        const u = new URL(window.location.href);
        u.searchParams.set('runId', runId);
        window.history.replaceState(null, '', `${u.pathname}${u.search}`);
      }

      const ctrl = streamRun(
        runId,
        (event) => {
          // A frame arrived → the connection is healthy again.
          setReconnecting(false);
          setEvents((prev) => {
            // `assistant_text` is a FULL narration snapshot — completions models
            // emit one per token. Replace the in-progress snapshot instead of
            // appending so the event array stays bounded (and the prose block
            // just grows in place).
            const last = prev[prev.length - 1];
            if (event.type === 'assistant_text' && last?.type === 'assistant_text') {
              return [...prev.slice(0, -1), event];
            }
            return [...prev, event];
          });

          if (event.type === 'run_complete') {
            const completeEvent = event as RunCompleteEvent;
            // Build full preview URL from the path returned by the server
            const url = completeEvent.previewUrl.startsWith('http')
              ? completeEvent.previewUrl
              : `${BASE}${completeEvent.previewUrl}`;
            setPreviewUrl(url);
            setIsStreaming(false);
            streamCtrlRef.current?.close();
            refreshSnapshots();
          }

          if (event.type === 'run_error') {
            const errEvent = event as RunErrorEvent;
            setHasError(true);
            setErrorMessage(errEvent.error);
            setIsStreaming(false);
            streamCtrlRef.current?.close();
          }

          // Phase 2.5 — the backend pauses long runs at a safe boundary, emits a
          // single `run_paused` frame, then closes the stream. Stop streaming so
          // the ChatPanel's Resume button (re-fires generateGame; the server
          // auto-applies the stored continuation) takes over. Not an error.
          if (event.type === 'run_paused') {
            setIsStreaming(false);
            streamCtrlRef.current?.close();
          }

          // NOTE (#34): do NOT end the streaming UI on `agent_end`. Only the
          // terminal `run_complete` / `run_error` / `run_paused` events stop
          // streaming — the artifact may still be packaging after the agent
          // finishes its turns.
        },
        undefined,
        {
          // #10: surface transient disconnects as a "reconnecting" state; the
          // server bus replays history on reconnect so resume is clean.
          onReconnecting: () => setReconnecting(true),
          onGiveUp: () => {
            setReconnecting(false);
            setIsStreaming(false);
            setHasError(true);
            // 2.3: the transport-lost message must match TRANSPORT_LOST_MESSAGE so
            // shouldOfferFix() never shows a Fix button for a dropped socket.
            setErrorMessage(TRANSPORT_LOST_MESSAGE);
          },
        },
      );

      streamCtrlRef.current = ctrl;
    },
    [refreshSnapshots],
  );

  // Resolve which run we're streaming, hydrate chat history (deduped against the
  // SAME id), and attach the live stream. The dedup MUST use the streamed run id
  // or that run's terminal renders twice — once from the chat-derived hydration,
  // once from the SSE replay (which carries its own authoritative terminal) — and
  // a paused run would show a duplicate Resume card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; intentionally excludes initialRunId/projectId/startStream so it doesn't re-fire on re-render
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    // Prepend prior history ahead of the live feed; the streamed run's own
    // events arrive (and append) via the SSE stream, so they're deduped here.
    const hydrate = (streamRunId: string | null) => {
      void getChatHistory(projectId)
        .then(({ messages }) => {
          if (cancelled || messages.length === 0) return;
          setEvents((prev) => [...hydrateHistoryEvents(messages, streamRunId), ...prev]);
          const lastPreviewUrl = lastPreviewUrlFromHistory(messages);
          if (lastPreviewUrl) {
            setPreviewUrl(
              lastPreviewUrl.startsWith('http') ? lastPreviewUrl : `${BASE}${lastPreviewUrl}`,
            );
          }
        })
        .catch((err) => {
          if (!cancelled) setLoadError(describeApiError(err));
        });
    };

    if (initialRunId) {
      // URL carries the run id: stream immediately + hydrate in parallel (the id
      // is known, so the dedup is correct without waiting on a lookup).
      startStream(initialRunId);
      hydrate(initialRunId);
    } else {
      // No `?runId` (e.g. a mobile tab the OS reloaded to a clean URL): ask the
      // server for the project's live run, THEN hydrate (deduped against it) and
      // attach. Resolving first keeps the dedup id and the streamed id in sync.
      void getActiveRun(projectId)
        .then(({ run }) => {
          if (cancelled) return;
          const liveId =
            run && (run.status === 'running' || run.status === 'queued' || run.status === 'paused')
              ? run.id
              : null;
          if (liveId) {
            setCurrentRunId(liveId);
            startStream(liveId);
          }
          hydrate(liveId);
        })
        .catch(() => {
          if (!cancelled) hydrate(null);
        });
    }

    return () => {
      cancelled = true;
      streamCtrlRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Send a new prompt (iterate) ──────────────────────────────────────────
  async function handleSend(prompt: string) {
    if (!projectId || isStreaming) return;

    // Add a real user turn to the log (#34 — no more `> ` prefix hack).
    const userEvent: SseEvent = {
      type: 'user_message',
      runId: currentRunId ?? '',
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    setEvents((prev) => [...prev, userEvent]);

    await fireRun(prompt);
  }

  /** Start a generate run and stream it; surfaces failures as a run_error row. */
  async function fireRun(prompt: string) {
    if (!projectId) return;
    try {
      const { runId } = await generateGame(projectId, prompt);
      setCurrentRunId(runId);
      startStream(runId);
    } catch (err) {
      // #27: surface 402 (out of credits) / 429 (rate / concurrent limit) and
      // any other failure with a human message instead of a raw error string.
      const errEvent: SseEvent = {
        type: 'run_error',
        runId: currentRunId ?? '',
        error: describeApiError(err),
        timestamp: new Date().toISOString(),
      };
      setEvents((prev) => [...prev, errEvent]);
    }
  }

  // ─── Phase 2.3 — one-click "Fix this error" ───────────────────────────────
  // Starts a fresh run whose prompt embeds the prior error so the agent has the
  // failure in context. Only wired for genuine `run_error` rows — the transport
  // "Lost connection to the build stream" case never becomes a run_error event
  // (it sets the error banner via onGiveUp), so it never shows a Fix button.
  async function handleFixError(error: string) {
    if (!projectId || isStreaming) return;
    const fixPrompt = `The previous build failed with this error:\n\n${error}\n\nPlease diagnose and fix it, then continue building the game.`;
    const userEvent: SseEvent = {
      type: 'user_message',
      runId: currentRunId ?? '',
      content: 'Fix the build error',
      timestamp: new Date().toISOString(),
    };
    setEvents((prev) => [...prev, userEvent]);
    await fireRun(fixPrompt);
  }

  // ─── Phase 2.5 — Resume a paused long-run ─────────────────────────────────
  // Re-fires generateGame; the server's /generate route calls
  // getPausedContinuation(projectId) and auto-applies the stored continuation,
  // so any continue-style prompt resumes from the safe boundary.
  async function handleResume() {
    if (!projectId || isStreaming) return;
    await fireRun('Continue building from where you paused.');
  }

  async function handlePublish() {
    if (!projectId || isPublishing || !previewUrl) return;
    setIsPublishing(true);
    try {
      const { publishUrl: url } = await publishProject(projectId);
      const full = url.startsWith('http') ? url : `${BASE}${url}`;
      setPublishUrl(full);
    } catch (err) {
      setLoadError(`Publish failed — ${describeApiError(err)}`);
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleRevert(snapshotId: string) {
    if (!projectId || isReverting) return;
    setIsReverting(snapshotId);
    try {
      await revertToSnapshot(projectId, snapshotId);
      // After revert, reload the preview from the reverted snapshot
      setPreviewUrl(`${BASE}/v1/projects/${projectId}/preview/`);
      setShowTimeline(false);
    } catch (err) {
      setLoadError(`Restore failed — ${describeApiError(err)}`);
    } finally {
      setIsReverting(null);
    }
  }

  const isBuilding = isStreaming;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] bg-[#0a0a0a] overflow-hidden">
      {/* Top nav bar */}
      <header className="flex-shrink-0 h-12 border-b border-[#222222] bg-[#111111] flex items-center px-4 gap-3 z-10">
        <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
          <BrandMark size={24} />
          <Wordmark className="text-xs text-[#f4f4f5] hidden sm:block" />
        </Link>

        <div className="w-px h-5 bg-[#222222] flex-shrink-0" />

        <div className="flex-1 min-w-0">
          {project ? (
            <h1 className="text-sm font-medium text-[#f4f4f5] truncate">{project.name}</h1>
          ) : (
            <div className="h-3.5 w-40 bg-[#1a1a1a] rounded animate-pulse" />
          )}
        </div>

        <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
          {reconnecting ? (
            <output className="flex items-center gap-1.5 text-xs text-[#f59e0b] font-mono">
              <PulseRing color="#f59e0b" />
              <span className="hidden sm:inline">reconnecting</span>
            </output>
          ) : isBuilding ? (
            <output className="flex items-center gap-1.5 text-xs text-[#6366f1] font-mono">
              <PulseRing />
              <span className="hidden sm:inline">building</span>
            </output>
          ) : null}
          {previewUrl && (
            <>
              {/* Full screen — icon-only on small screens */}
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="
                  text-xs px-2 py-1.5 md:px-3 rounded-lg
                  bg-[#6366f1]/10 hover:bg-[#6366f1]/20
                  text-[#6366f1] border border-[#6366f1]/20
                  transition-colors font-medium
                "
                title="Full screen"
              >
                <span className="hidden md:inline">Full screen </span>↗
              </a>
              {/* Download — hidden on small screens */}
              <a
                href={`${BASE}/v1/projects/${projectId}/game.zip`}
                download
                className="
                  hidden md:inline-flex
                  text-xs px-3 py-1.5 rounded-lg
                  bg-[#1a1a1a] hover:bg-[#222222]
                  text-[#a1a1aa] border border-[#222222]
                  transition-colors font-medium
                "
              >
                Download ↓
              </a>
              {/* Share — opens the animated social-outro card */}
              <button
                type="button"
                onClick={openSocialOutro}
                disabled={isStreaming}
                className="
                  text-xs px-2 py-1.5 md:px-3 rounded-lg
                  bg-[#46e6f0]/10 hover:bg-[#46e6f0]/20
                  text-[#46e6f0] border border-[#46e6f0]/20
                  transition-colors font-medium
                  disabled:opacity-40 disabled:cursor-not-allowed
                "
                title="Create a shareable outro"
              >
                <span className="hidden md:inline">Share </span>↗
              </button>
              {publishUrl ? (
                <a
                  href={publishUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="
                    text-xs px-3 py-1.5 rounded-lg
                    bg-emerald-500/10 hover:bg-emerald-500/20
                    text-emerald-400 border border-emerald-500/20
                    transition-colors font-medium
                  "
                >
                  Published ↗
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void handlePublish();
                  }}
                  disabled={isPublishing || isStreaming}
                  className="
                    text-xs px-3 py-1.5 rounded-lg
                    bg-emerald-500/10 hover:bg-emerald-500/20
                    text-emerald-400 border border-emerald-500/20
                    transition-colors font-medium
                    disabled:opacity-40 disabled:cursor-not-allowed
                  "
                >
                  {isPublishing ? 'Publishing…' : 'Publish'}
                </button>
              )}
            </>
          )}
          {/* History — hidden on small screens */}
          {snapshots.length > 0 && (
            <button
              type="button"
              onClick={() => setShowTimeline((v) => !v)}
              className={`
                hidden md:inline-flex
                text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium
                ${
                  showTimeline
                    ? 'bg-[#6366f1]/20 text-[#6366f1] border-[#6366f1]/40'
                    : 'bg-[#1a1a1a] hover:bg-[#222222] text-[#a1a1aa] border-[#222222]'
                }
              `}
            >
              History ({snapshots.length})
            </button>
          )}
          {(viewerCount > 1 || (collabConnected && peerCount > 0)) && (
            <span
              className="flex items-center gap-1 text-xs text-emerald-400 font-medium"
              title="Live collaborators"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="hidden sm:inline">
                {Math.max(viewerCount - 1, peerCount)} with you
              </span>
            </span>
          )}
          {/* All projects link — hidden on small screens */}
          <Link
            href="/projects"
            className="hidden md:inline text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors"
          >
            All projects
          </Link>
        </div>
      </header>

      {/* Load-error banner (#27) — replaces the prior silent catch */}
      {loadError && (
        <div
          role="alert"
          className="flex-shrink-0 px-4 py-2 bg-[#ef4444]/10 border-b border-[#ef4444]/20 text-xs text-[#ef4444] flex items-center gap-2"
        >
          <span className="opacity-70">⚠</span>
          <span>{loadError}</span>
        </div>
      )}

      {/* Main split */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden relative">
        {/* Chat panel — full width on mobile (50vh), 35% sidebar on md+ */}
        <div className="h-[50vh] md:h-auto w-full md:w-[35%] md:min-w-[280px] md:max-w-[480px] md:flex-shrink-0 overflow-hidden">
          <ChatPanel
            events={events}
            onSend={(prompt) => {
              void handleSend(prompt);
            }}
            isStreaming={isStreaming}
            reconnecting={reconnecting}
            onFixError={(error) => {
              void handleFixError(error);
            }}
            onResume={() => {
              void handleResume();
            }}
          />
        </div>

        {/* Preview pane — full width on mobile (50vh), flex-1 on md+ */}
        <div className="h-[50vh] md:h-auto flex-1 overflow-hidden">
          <PreviewPane
            previewUrl={previewUrl}
            isBuilding={isBuilding}
            hasError={hasError}
            errorMessage={errorMessage}
            tweakSchema={currentTweakSchema}
            projectId={projectId}
            onFileSaved={() => {
              // A manual file edit created a new version — repoint the live
              // preview at the project's current HEAD and refresh the timeline.
              setPreviewUrl(`${BASE}/v1/projects/${projectId}/preview/?t=${Date.now()}`);
              refreshSnapshots();
            }}
            onMapControls={() => {
              // One scoped generation (one click = one run, no polling) that wires
              // the rebindable controls layer into a game that didn't declare it.
              void handleSend(
                'Make the controls rebindable: call window.__game.controls.define({ actions: [...] }) ' +
                  'declaring every keyboard action (id, label, keys), and read ALL input through ' +
                  'window.__game.controls.isDown(id) / .on(id, fn) instead of reading cursors/keydown directly — ' +
                  'so the Controls tab populates and players can remap keys live. Also fix any inverted or ' +
                  'wrong key mappings while you do this. Keep everything else the same.',
              );
            }}
          />
        </div>

        {/* Version timeline overlay */}
        {showTimeline && (
          <div className="absolute top-0 right-0 h-full w-full md:w-72 bg-[#111111] border-l border-[#222222] flex flex-col z-20">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#222222]">
              <span className="text-xs font-semibold text-[#f4f4f5]">Version history</span>
              <button
                type="button"
                onClick={() => setShowTimeline(false)}
                aria-label="Close version history"
                className="text-[#52525b] hover:text-[#a1a1aa] text-xs"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {snapshots.map((snap) => (
                <div
                  key={snap.id}
                  className="px-4 py-3 border-b border-[#1a1a1a] hover:bg-[#1a1a1a] group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span
                          className={`
                          text-[10px] px-1.5 py-0.5 rounded font-mono font-medium
                          ${snap.type === 'initial' ? 'bg-[#6366f1]/20 text-[#6366f1]' : 'bg-[#1a1a1a] text-[#52525b]'}
                        `}
                        >
                          v{snap.seq + 1}
                        </span>
                        {snap.engine && (
                          <span className="text-[10px] text-[#52525b] font-mono">
                            {snap.engine}
                          </span>
                        )}
                      </div>
                      {snap.prompt && (
                        <p className="text-xs text-[#a1a1aa] truncate leading-4">{snap.prompt}</p>
                      )}
                      <p className="text-[10px] text-[#3f3f46] mt-1">
                        {new Date(snap.createdAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void handleRevert(snap.id);
                      }}
                      disabled={isReverting !== null || isStreaming}
                      className="
                        text-[10px] px-2 py-1 rounded
                        bg-[#6366f1]/10 hover:bg-[#6366f1]/20
                        text-[#6366f1] border border-[#6366f1]/20
                        transition-colors font-medium flex-shrink-0
                        opacity-0 group-hover:opacity-100
                        disabled:opacity-30 disabled:cursor-not-allowed
                      "
                    >
                      {isReverting === snap.id ? '…' : 'Restore'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <SocialOutroModal
        open={showSocialOutro}
        summary={socialOutro}
        loading={isLoadingSocialOutro}
        error={socialOutroError}
        onClose={() => setShowSocialOutro(false)}
        onReload={() => {
          void loadSocialOutro();
        }}
      />
    </div>
  );
}

function PulseRing({ color = '#6366f1' }: { color?: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex rounded-full h-1.5 w-1.5"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
