'use client';

import { getToken } from '@/lib/auth';
import { useCloudSaveRelay } from '@/lib/cloud-save-relay';
import {
  type ControlsManifest,
  PREVIEW_IFRAME_ORIGIN,
  TWEAKS_UPDATE_MESSAGE_TYPE,
  parseControlsManifestMessage,
  parseGamepadStatusMessage,
  parseInboundBridgeMessage,
  parseRuntimeAliveMessage,
  parseRuntimeErrorMessage,
  sendControlsRebind,
  sendControlsRequest,
} from '@/lib/iframe-bridge';
import type { SseEvent } from '@/lib/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BuildStatus } from './BuildStatus';
import { ControlsPanel } from './ControlsPanel';
import { FilesPanel } from './FilesPanel';

type TweakKind = 'color' | 'number' | 'boolean';

interface TweakEntry {
  kind: TweakKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface TweakSchema {
  [key: string]: TweakEntry;
}

interface PreviewPaneProps {
  previewUrl: string | null;
  isBuilding: boolean;
  hasError: boolean;
  errorMessage?: string;
  /** Tweak schema for the current snapshot — drives the live-tweak panel. */
  tweakSchema?: TweakSchema | null;
  /** Project id — fallback storage key for saved key bindings (WS-A Controls). */
  projectId?: string;
  /** Legacy rescue: fire one scoped generation to wire the controls layer into a
   *  game that didn't declare it. Surfaced in the Controls tab's empty state. */
  onMapControls?: () => void;
  /** Fired after a manual file save in the Files tab so the parent can repoint
   *  the live preview at the project's just-edited HEAD and refresh versions. */
  onFileSaved?: () => void;
  /** Fired when the user clicks "Fix it" on a live crash/freeze the running game
   *  reported — the parent kicks off a repair run with the error as context.
   *  Undefined hides the button (e.g. while a run is already streaming). */
  onFixRuntimeIssue?: (errorText: string) => void;
  /** Live SSE events for the running build — drives the in-preview build status
   *  (current step, elapsed timer, phase tracker) while the game generates. */
  events?: SseEvent[];
}

export function PreviewPane({
  previewUrl,
  isBuilding,
  hasError,
  errorMessage,
  tweakSchema,
  projectId,
  onMapControls,
  onFileSaved,
  onFixRuntimeIssue,
  events = [],
}: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showTweaks, setShowTweaks] = useState(false);
  const [tweakValues, setTweakValues] = useState<Record<string, string | number | boolean>>({});
  const [view, setView] = useState<'preview' | 'controls' | 'files'>('preview');
  const [controlsManifest, setControlsManifest] = useState<ControlsManifest | null>(null);
  // Whether a controller is connected to the running game (the gamepad bridge
  // posts this once controller support is mapped) — drives the panel's badge.
  const [gamepadConnected, setGamepadConnected] = useState(false);
  // Live crash/freeze the running game reported (runtime beacon). Drives the
  // "your game crashed — Fix it" banner. `dismissed` hides it until the next
  // reload without re-querying.
  const [runtimeIssue, setRuntimeIssue] = useState<{
    kind: 'crash' | 'freeze';
    message: string;
  } | null>(null);
  const [issueDismissed, setIssueDismissed] = useState(false);
  // Freeze detection state (refs — they must not trigger re-renders): whether the
  // game has ever animated, and how many consecutive heartbeats reported a dead
  // render loop (rAF flatlined while the thread is still beating).
  const animatedRef = useRef(false);
  const staleBeatsRef = useRef(0);
  // Tracks unsaved edits in the Files tab so switching tabs can't silently
  // discard them (the FilesPanel bubbles this up via onDirtyChange).
  const [filesDirty, setFilesDirty] = useState(false);
  // Manual preview reload. Bumping this re-keys the iframe src so the game
  // restarts on demand (e.g. to test new key bindings, or just re-run it).
  const [reloadNonce, setReloadNonce] = useState(0);
  // True when a change was made that a reload would surface (e.g. controls were
  // rebound) — drives a "refresh to see your changes" cue on the reload button.
  const [previewStale, setPreviewStale] = useState(false);

  const reloadPreview = useCallback(() => {
    setReloadNonce((n) => n + 1);
    setPreviewStale(false);
  }, []);

  // Cross-device cloud-save relay: bridge the in-iframe save shim to the
  // session-authed API. In the builder the user is always logged in, so the
  // relay is always enabled (it stays inert until a projectId is present).
  useCloudSaveRelay(iframeRef, projectId, true);

  // Guarded tab switch: confirm before leaving the Files tab with unsaved edits.
  const switchView = useCallback(
    (next: 'preview' | 'controls' | 'files') => {
      if (view === 'files' && next !== 'files' && filesDirty) {
        if (!window.confirm('Discard unsaved changes?')) return;
        setFilesDirty(false);
      }
      setView(next);
    },
    [view, filesDirty],
  );

  // Reset tweak values + controls when a NEW game loads. A manual file save (or a
  // revert) repoints previewUrl at the project's HEAD preview
  // (`/v1/projects/:id/preview/`) to refresh the iframe — that must NOT kick the
  // user out of the Files tab or wipe their controls. So only do the full reset
  // when the URL is NOT a project-preview URL: that covers null + a fresh build's
  // run preview (`/v1/runs/.../preview/`), the real "new game" cases.
  useEffect(() => {
    const isProjectPreview = Boolean(previewUrl) && previewUrl?.includes('/v1/projects/');
    if (isProjectPreview) return; // save/revert refresh of the same project — keep view + controls
    setTweakValues({});
    setShowTweaks(false);
    setControlsManifest(null);
    setView('preview');
    setPreviewStale(false);
  }, [previewUrl]);

  // The owner-gated preview route accepts the session token via ?token= because
  // an iframe/EventSource cannot set Authorization headers (#30). Same-origin
  // play URLs (/v1/play/...) are public and must NOT carry a token.
  const iframeSrc = useMemo(() => {
    if (!previewUrl) return null;
    try {
      const u = new URL(previewUrl);
      // Owner-gated preview routes accept the session token via ?token= (an
      // iframe can't set Authorization headers, #30). Public play URLs must not.
      if (previewUrl.includes('/preview')) {
        const token = getToken();
        if (token) u.searchParams.set('token', token);
      }
      // Manual reload: a changing query param re-fetches the iframe.
      if (reloadNonce > 0) u.searchParams.set('_r', String(reloadNonce));
      return u.toString();
    } catch {
      return previewUrl;
    }
  }, [previewUrl, reloadNonce]);

  // Validate inbound bridge messages: only trust the preview origin + a
  // well-formed `{ type }` payload (#20). We don't act on any message today
  // beyond ignoring untrusted ones, but this closes the "trust any inbound
  // origin" gap and gives a typed seam for future bridge acks.
  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      // WS-A — the game posts its control manifest on startup (and on request).
      const controls = parseControlsManifestMessage(event);
      if (controls) {
        setControlsManifest(controls);
        return;
      }
      const gamepad = parseGamepadStatusMessage(event);
      if (gamepad) {
        setGamepadConnected(gamepad.connected);
        return;
      }
      // Live CRASH — an uncaught error in the running game. The first one wins
      // (a crash usually repeats every frame); we surface it and offer a fix.
      const crash = parseRuntimeErrorMessage(event);
      if (crash) {
        setRuntimeIssue((cur) => cur ?? { kind: 'crash', message: crash.message });
        return;
      }
      // Heartbeat — detect a dead render loop (FREEZE). rAF flatlining for two
      // beats (~3s) after the game has animated, while the tab is visible (a
      // backgrounded tab throttles rAF to ~0 — not a real freeze), means the loop
      // stopped. A true thread hang can't be seen here (same-origin tab hangs too).
      const alive = parseRuntimeAliveMessage(event);
      if (alive) {
        if (alive.raf > 0) {
          animatedRef.current = true;
          staleBeatsRef.current = 0;
        } else if (animatedRef.current && typeof document !== 'undefined' && !document.hidden) {
          staleBeatsRef.current += 1;
          if (staleBeatsRef.current >= 2) {
            setRuntimeIssue(
              (cur) => cur ?? { kind: 'freeze', message: 'The game stopped responding.' },
            );
          }
        }
        return;
      }
      const msg = parseInboundBridgeMessage(event);
      if (!msg) return; // untrusted origin or malformed shape → ignore
      // Reserved for future bridge ack handling.
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Reset crash/freeze detection whenever the preview (re)loads or swaps games.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload nonce + url are the reset triggers
  useEffect(() => {
    setRuntimeIssue(null);
    setIssueDismissed(false);
    animatedRef.current = false;
    staleBeatsRef.current = 0;
  }, [previewUrl, reloadNonce]);

  // Push rebound keys to the running game.
  const applyControls = useCallback((bindings: Record<string, string[]>) => {
    sendControlsRebind(iframeRef.current, bindings);
  }, []);

  // Pull the manifest when the Controls tab opens (covers a game that declared
  // its controls before this pane attached its message listener). Retry over a
  // few seconds and stop once a manifest arrives: a Three.js game can take a
  // moment to load its engine module + call controls.define, so a single request
  // on open often fires before the game has declared anything.
  useEffect(() => {
    if (view !== 'controls' || controlsManifest) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [0, 700, 1500, 3000, 5000]) {
      timers.push(
        setTimeout(() => {
          if (!cancelled) sendControlsRequest(iframeRef.current);
        }, delay),
      );
    }
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [view, controlsManifest]);

  // Give the game keyboard focus the moment it loads. An iframe only receives
  // keydown while it (not the host page) holds focus, so without this the
  // arrow/WASD keys go to the builder and the car/player never moves — the #1
  // "I can't control it" complaint, even though the game's input works. Skip if
  // the user is typing (e.g. mid-prompt in the chat) so we never steal focus
  // from an input. Clicking the game re-focuses it natively after that.
  const focusGame = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    const typing =
      active != null &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (!typing) iframeRef.current?.focus();
  }, []);

  const hasTweaks = tweakSchema && Object.keys(tweakSchema).length > 0;

  const sendTweaks = useCallback((values: Record<string, string | number | boolean>) => {
    // Explicit targetOrigin — never '*' (#20). The preview iframe is served by
    // the API origin, so that is the only origin we will postMessage to.
    iframeRef.current?.contentWindow?.postMessage(
      { type: TWEAKS_UPDATE_MESSAGE_TYPE, tokens: values },
      PREVIEW_IFRAME_ORIGIN,
    );
  }, []);

  function handleTweakChange(key: string, value: string | number | boolean) {
    const next = { ...tweakValues, [key]: value };
    setTweakValues(next);
    sendTweaks(next);
  }

  return (
    <div className="relative flex flex-col h-full bg-void">
      {/* Toolbar (board 1c: mono tab group + breadcrumb + tools on one hairline) */}
      <div className="flex-shrink-0 px-3.5 py-2 border-b border-hairline bg-ground flex items-center gap-3 font-mono text-[11px] tracking-[.1em]">
        {previewUrl && (
          <div className="flex">
            <button
              type="button"
              onClick={() => switchView('preview')}
              aria-pressed={view === 'preview'}
              className={`px-3 py-2.5 text-xs md:py-1.5 md:text-[11px] border transition-colors ${
                view === 'preview'
                  ? 'border-signal bg-raised text-signal'
                  : 'border-hairline text-ink-3 hover:text-ink'
              }`}
            >
              preview
            </button>
            <button
              type="button"
              onClick={() => switchView('controls')}
              aria-pressed={view === 'controls'}
              className={`px-3 py-2.5 text-xs md:py-1.5 md:text-[11px] border border-l-0 transition-colors ${
                view === 'controls'
                  ? 'border-signal border-l bg-raised text-signal'
                  : 'border-hairline text-ink-3 hover:text-ink'
              }`}
            >
              controls
            </button>
            <button
              type="button"
              onClick={() => switchView('files')}
              aria-pressed={view === 'files'}
              className={`px-3 py-2.5 text-xs md:py-1.5 md:text-[11px] border border-l-0 transition-colors ${
                view === 'files'
                  ? 'border-signal border-l bg-raised text-signal'
                  : 'border-hairline text-ink-3 hover:text-ink'
              }`}
            >
              files
            </button>
          </div>
        )}
        {previewUrl ? (
          <span className="hidden flex-1 truncate text-center text-ink-4 sm:block">
            preview · {previewUrl.split('/').pop() ?? 'index.html'}
          </span>
        ) : (
          <span className="flex-1 text-center text-ink-4">no preview</span>
        )}
        <div className="flex items-center gap-2">
          {hasTweaks && previewUrl && view === 'preview' && (
            <button
              type="button"
              onClick={() => setShowTweaks((v) => !v)}
              aria-pressed={showTweaks}
              aria-label="Toggle live tweaks panel"
              className={`border px-3 py-2.5 text-xs transition-colors md:px-2.5 md:py-1.5 md:text-[11px] ${
                showTweaks
                  ? 'border-signal text-signal'
                  : 'border-hairline text-ink-3 hover:text-ink'
              }`}
            >
              ⚙ tweaks
            </button>
          )}
          {previewUrl && (
            <button
              type="button"
              onClick={reloadPreview}
              aria-label="Reload preview"
              title={
                previewStale
                  ? 'Changes were made — reload to see them in the game'
                  : 'Reload the preview'
              }
              className={`relative border px-3 py-2.5 text-xs transition-colors md:px-2.5 md:py-1.5 md:text-[11px] ${
                previewStale
                  ? 'border-signal text-signal'
                  : 'border-hairline text-ink-3 hover:text-ink'
              }`}
            >
              ↻{previewStale ? ' refresh' : ''}
              {previewStale && (
                <span className="absolute -top-1 -right-1 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
                </span>
              )}
            </button>
          )}
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex px-3 py-2.5 text-xs text-signal transition-colors hover:text-signal-bright md:px-0 md:py-0 md:text-[11px]"
            >
              open ↗
            </a>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 relative overflow-hidden flex">
        {/* Preview iframe */}
        <div className="flex-1 relative overflow-hidden">
          {iframeSrc && !hasError && (
            // NOTE (#20): `allow-same-origin` is retained intentionally. The
            // preview is served from a DIFFERENT origin (the API) than this app,
            // so the iframe never shares the host's origin. Keeping
            // allow-same-origin gives the iframe its real API origin, which is
            // what lets the host postMessage with an EXPLICIT targetOrigin
            // (PREVIEW_IFRAME_ORIGIN) instead of '*'. Dropping it would force an
            // opaque origin and reintroduce a '*' broadcast for the tweak bridge.
            // Residual: a same-origin preview can script its own (API) origin —
            // mitigated server-side by the locked game CSP + owner-gated route.
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              title="Game preview"
              onLoad={focusGame}
              sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-downloads"
              className="absolute inset-0 w-full h-full border-0"
            />
          )}

          {/* Iteration build status — a slim banner over the still-running game so
              you keep playing the current version while the next one builds. */}
          {isBuilding && previewUrl && !hasError && view === 'preview' && (
            <BuildStatus events={events} isBuilding={isBuilding} compact />
          )}

          {/* Live crash/freeze banner — the running game's runtime beacon reported
              an uncaught error or a dead render loop. One click repairs it. */}
          {runtimeIssue && !issueDismissed && view === 'preview' && (
            <div className="absolute inset-x-0 bottom-0 z-20 border-t border-fail bg-[#16100f]/95 px-4 py-3 backdrop-blur">
              <div className="flex items-center justify-between gap-3.5">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-fail">
                    {runtimeIssue.kind === 'crash'
                      ? 'Your game hit an error while playing'
                      : 'Your game stopped responding'}
                  </p>
                  <p className="mt-1 line-clamp-2 break-words font-mono text-[11px] leading-relaxed text-ink-3">
                    {runtimeIssue.message}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {onFixRuntimeIssue && (
                    <button
                      type="button"
                      onClick={() => {
                        onFixRuntimeIssue(
                          runtimeIssue.kind === 'crash'
                            ? `The game crashes during play with this runtime error: "${runtimeIssue.message}". Find the root cause and fix it.`
                            : 'The game freezes / stops responding during play (its render loop dies). Find the root cause and fix it.',
                        );
                        setIssueDismissed(true);
                      }}
                      className="bg-fail px-4 py-2 text-[13px] font-bold text-[#16100f] transition-colors hover:opacity-90"
                    >
                      Fix it
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setIssueDismissed(true)}
                    aria-label="Dismiss"
                    className="border border-edge px-3 py-2 text-[13px] text-ink-3 transition-colors hover:text-ink"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Controls tab — overlays the (still-running) game so rebinds apply live */}
          {view === 'controls' && previewUrl && !hasError && (
            <div className="absolute inset-0 z-10 bg-void">
              <ControlsPanel
                manifest={controlsManifest}
                onApply={applyControls}
                // Key per-RUN (previewUrl carries the runId) so a fresh generation
                // reverts stale manual binds to the new game's declared defaults.
                storageKey={`pf:controls:${previewUrl ?? projectId}`}
                // A user rebind applies live, but cue a reload so they can restart
                // the game and test the new bindings from a clean state.
                onUserRebind={() => setPreviewStale(true)}
                gamepadConnected={gamepadConnected}
                {...(onMapControls ? { onMapWithAI: onMapControls } : {})}
              />
            </div>
          )}

          {/* Files tab — overlays the (still-running) game like Controls does */}
          {view === 'files' && previewUrl && !hasError && (
            <div className="absolute inset-0 z-10 bg-void">
              <FilesPanel
                projectId={projectId ?? ''}
                previewUrl={previewUrl}
                isBuilding={isBuilding}
                onDirtyChange={setFilesDirty}
                {...(onFileSaved ? { onFileSaved } : {})}
              />
            </div>
          )}

          {/* Building placeholder */}
          {!previewUrl && !hasError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
              {isBuilding ? (
                <BuildStatus events={events} isBuilding={isBuilding} />
              ) : (
                <>
                  <IdleGraphic />
                  <div className="text-center">
                    <p className="text-sm text-ink-3">Slot zero is empty</p>
                    <p className="mt-1 text-xs text-ink-4">Start a build to see your game here</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Error state */}
          {hasError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8">
              <div className="flex h-12 w-12 items-center justify-center border-[1.5px] border-fail font-mono text-lg text-fail">
                ✗
              </div>
              <div className="text-center">
                <p className="type-label text-fail">Build failed</p>
                {errorMessage && (
                  <p className="mt-2 max-w-sm break-all font-mono text-xs text-ink-3">
                    {errorMessage}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Tweak panel — slides in from the right of the preview */}
        {showTweaks && hasTweaks && (
          <div className="flex w-56 flex-shrink-0 flex-col overflow-y-auto border-l border-hairline bg-chrome">
            <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
              <span className="type-label-xs text-ink">Live tweaks</span>
              <button
                type="button"
                onClick={() => setShowTweaks(false)}
                aria-label="Close live tweaks panel"
                className="text-xs text-ink-4 hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-5 px-4 py-4">
              {Object.entries(tweakSchema).map(([key, entry]) => (
                <TweakControl
                  key={key}
                  tweakKey={key}
                  entry={entry}
                  value={tweakValues[key]}
                  onChange={(v) => handleTweakChange(key, v)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TweakControlProps {
  tweakKey: string;
  entry: TweakEntry;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}

function TweakControl({ tweakKey, entry, value, onChange }: TweakControlProps) {
  const label = tweakKey
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();

  if (entry.kind === 'color') {
    const colorVal = typeof value === 'string' ? value : '#46e6f0';
    return (
      <div className="flex flex-col gap-2">
        <span className="type-label-xs tracking-[.12em] text-ink-3">{label}</span>
        <div className="flex items-center gap-2.5">
          <input
            type="color"
            value={colorVal}
            onChange={(e) => onChange(e.target.value)}
            className="h-5 w-7 cursor-pointer border border-edge bg-transparent"
          />
          <span className="font-mono text-[11px] text-ink-4">{colorVal.toUpperCase()}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === 'number') {
    const numVal = typeof value === 'number' ? value : (entry.min ?? 0);
    const min = entry.min ?? 0;
    const max = entry.max ?? 100;
    const step = entry.step ?? 1;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="type-label-xs tracking-[.12em] text-ink-3">{label}</span>
          <span className="font-mono text-[11px] text-ink">
            {numVal}
            {entry.unit ?? ''}
          </span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={numVal}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-[#46e6f0]"
        />
      </div>
    );
  }

  if (entry.kind === 'boolean') {
    const boolVal = typeof value === 'boolean' ? value : false;
    const switchId = `tweak-${tweakKey}`;
    return (
      <div className="flex items-center justify-between">
        <span id={switchId} className="type-label-xs tracking-[.12em] text-ink-3">
          {label}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={boolVal}
          aria-labelledby={switchId}
          aria-label={`Toggle ${label}`}
          onClick={() => onChange(!boolVal)}
          className={`relative h-3.5 w-[30px] flex-shrink-0 transition-colors ${
            boolVal ? 'bg-signal' : 'bg-hairline'
          }`}
        >
          <span
            className={`absolute top-0.5 h-2.5 w-2.5 bg-chrome transition-transform ${
              boolVal ? 'translate-x-[17px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    );
  }

  return null;
}

// ─── Animations ───────────────────────────────────────────────────────────────

/** The empty slot: the Slot Zero mark itself (identity board, direction A). */
function IdleGraphic() {
  return (
    <div className="flex h-14 w-14 items-center justify-center border-[1.5px] border-signal text-[22px] font-extrabold text-ink">
      0
    </div>
  );
}
