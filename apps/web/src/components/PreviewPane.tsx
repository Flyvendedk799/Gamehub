'use client';

import { getToken } from '@/lib/auth';
import {
  type ControlsManifest,
  PREVIEW_IFRAME_ORIGIN,
  TWEAKS_UPDATE_MESSAGE_TYPE,
  parseControlsManifestMessage,
  parseInboundBridgeMessage,
  sendControlsRebind,
  sendControlsRequest,
} from '@/lib/iframe-bridge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ControlsPanel } from './ControlsPanel';

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
}

export function PreviewPane({
  previewUrl,
  isBuilding,
  hasError,
  errorMessage,
  tweakSchema,
  projectId,
  onMapControls,
}: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showTweaks, setShowTweaks] = useState(false);
  const [tweakValues, setTweakValues] = useState<Record<string, string | number | boolean>>({});
  const [view, setView] = useState<'preview' | 'controls'>('preview');
  const [controlsManifest, setControlsManifest] = useState<ControlsManifest | null>(null);

  // Reset tweak values + controls when URL changes (new game loaded)
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewUrl is the intended trigger — reset tweak state whenever a new game URL loads
  useEffect(() => {
    setTweakValues({});
    setShowTweaks(false);
    setControlsManifest(null);
    setView('preview');
  }, [previewUrl]);

  // The owner-gated preview route accepts the session token via ?token= because
  // an iframe/EventSource cannot set Authorization headers (#30). Same-origin
  // play URLs (/v1/play/...) are public and must NOT carry a token.
  const iframeSrc = useMemo(() => {
    if (!previewUrl) return null;
    if (!previewUrl.includes('/preview')) return previewUrl;
    const token = getToken();
    if (!token) return previewUrl;
    try {
      const u = new URL(previewUrl);
      u.searchParams.set('token', token);
      return u.toString();
    } catch {
      return previewUrl;
    }
  }, [previewUrl]);

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
      const msg = parseInboundBridgeMessage(event);
      if (!msg) return; // untrusted origin or malformed shape → ignore
      // Reserved for future bridge ack handling.
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Push rebound keys to the running game.
  const applyControls = useCallback((bindings: Record<string, string[]>) => {
    sendControlsRebind(iframeRef.current, bindings);
  }, []);

  // Pull the manifest when the Controls tab opens (covers a game that declared
  // its controls before this pane attached its message listener).
  useEffect(() => {
    if (view === 'controls') sendControlsRequest(iframeRef.current);
  }, [view]);

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
    <div className="relative flex flex-col h-full bg-[#0a0a0a]">
      {/* Toolbar */}
      <div className="flex-shrink-0 px-4 py-2 border-b border-[#222222] bg-[#111111] flex items-center gap-3">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#ef4444]/60" />
          <div className="w-3 h-3 rounded-full bg-[#f59e0b]/60" />
          <div className="w-3 h-3 rounded-full bg-[#22c55e]/60" />
        </div>
        {previewUrl && (
          <span className="flex-1 text-center text-xs font-mono text-[#52525b] truncate">
            preview · {previewUrl.split('/').pop() ?? 'index.html'}
          </span>
        )}
        {!previewUrl && (
          <span className="flex-1 text-center text-xs font-mono text-[#3f3f46]">no preview</span>
        )}
        <div className="flex items-center gap-2">
          {previewUrl && (
            <div className="flex rounded-md border border-[#222222] overflow-hidden text-[10px] font-mono">
              <button
                type="button"
                onClick={() => setView('preview')}
                aria-pressed={view === 'preview'}
                className={`px-2.5 py-1 transition-colors ${
                  view === 'preview'
                    ? 'bg-[#6366f1]/20 text-[#818cf8]'
                    : 'bg-[#1a1a1a] text-[#52525b] hover:text-[#a1a1aa]'
                }`}
              >
                preview
              </button>
              <button
                type="button"
                onClick={() => setView('controls')}
                aria-pressed={view === 'controls'}
                className={`px-2.5 py-1 border-l border-[#222222] transition-colors ${
                  view === 'controls'
                    ? 'bg-[#6366f1]/20 text-[#818cf8]'
                    : 'bg-[#1a1a1a] text-[#52525b] hover:text-[#a1a1aa]'
                }`}
              >
                controls
              </button>
            </div>
          )}
          {hasTweaks && previewUrl && view === 'preview' && (
            <button
              type="button"
              onClick={() => setShowTweaks((v) => !v)}
              aria-pressed={showTweaks}
              aria-label="Toggle live tweaks panel"
              className={`
                text-[10px] px-2 py-1 rounded border transition-colors font-mono
                ${
                  showTweaks
                    ? 'bg-[#6366f1]/20 text-[#6366f1] border-[#6366f1]/40'
                    : 'bg-[#1a1a1a] text-[#52525b] border-[#222222] hover:text-[#a1a1aa]'
                }
              `}
            >
              ⚙ tweaks
            </button>
          )}
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-[#6366f1] hover:text-[#818cf8] transition-colors font-mono"
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

          {/* Controls tab — overlays the (still-running) game so rebinds apply live */}
          {view === 'controls' && previewUrl && !hasError && (
            <div className="absolute inset-0 z-10 bg-[#0a0a0a]">
              <ControlsPanel
                manifest={controlsManifest}
                onApply={applyControls}
                // Key per-RUN (previewUrl carries the runId) so a fresh generation
                // reverts stale manual binds to the new game's declared defaults.
                storageKey={`pf:controls:${previewUrl ?? projectId}`}
                {...(onMapControls ? { onMapWithAI: onMapControls } : {})}
              />
            </div>
          )}

          {/* Building placeholder */}
          {!previewUrl && !hasError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
              {isBuilding ? (
                <>
                  <BuildingAnimation />
                  <div className="text-center">
                    <p className="text-[#f4f4f5] text-sm font-medium">Building your game…</p>
                    <p className="mt-1 text-[#52525b] text-xs">This usually takes 15–60 seconds</p>
                  </div>
                </>
              ) : (
                <>
                  <IdleGraphic />
                  <div className="text-center">
                    <p className="text-[#3f3f46] text-sm">Preview will appear here</p>
                    <p className="mt-1 text-[#2a2a2a] text-xs">Start a build to see your game</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Error state */}
          {hasError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8">
              <div className="w-12 h-12 rounded-full bg-[#ef4444]/10 border border-[#ef4444]/20 flex items-center justify-center">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M10 6v4M10 14h.01M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                    stroke="#ef4444"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-[#ef4444] text-sm font-medium">Build failed</p>
                {errorMessage && (
                  <p className="mt-2 text-[#a1a1aa] text-xs font-mono max-w-sm break-all">
                    {errorMessage}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Tweak panel — slides in from the right of the preview */}
        {showTweaks && hasTweaks && (
          <div className="w-56 flex-shrink-0 bg-[#0f0f0f] border-l border-[#222222] overflow-y-auto flex flex-col">
            <div className="px-3 py-2 border-b border-[#1a1a1a] flex items-center justify-between">
              <span className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider">
                Live tweaks
              </span>
              <button
                type="button"
                onClick={() => setShowTweaks(false)}
                aria-label="Close live tweaks panel"
                className="text-[#3f3f46] hover:text-[#52525b] text-xs"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 px-3 py-3 flex flex-col gap-4">
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
    const colorVal = typeof value === 'string' ? value : '#6366f1';
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] text-[#52525b] capitalize">{label}</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={colorVal}
            onChange={(e) => onChange(e.target.value)}
            className="w-8 h-6 rounded cursor-pointer border border-[#222222] bg-transparent"
          />
          <span className="text-[10px] font-mono text-[#3f3f46]">{colorVal}</span>
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
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[#52525b] capitalize">{label}</span>
          <span className="text-[10px] font-mono text-[#3f3f46]">
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
          className="w-full accent-[#6366f1]"
        />
      </div>
    );
  }

  if (entry.kind === 'boolean') {
    const boolVal = typeof value === 'boolean' ? value : false;
    const switchId = `tweak-${tweakKey}`;
    return (
      <div className="flex items-center justify-between">
        <span id={switchId} className="text-[10px] text-[#52525b] capitalize">
          {label}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={boolVal}
          aria-labelledby={switchId}
          aria-label={`Toggle ${label}`}
          onClick={() => onChange(!boolVal)}
          className={`
            w-8 h-4 rounded-full transition-colors relative flex-shrink-0
            ${boolVal ? 'bg-[#6366f1]' : 'bg-[#222222]'}
          `}
        >
          <span
            className={`
            absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform
            ${boolVal ? 'translate-x-4' : 'translate-x-0.5'}
          `}
          />
        </button>
      </div>
    );
  }

  return null;
}

// ─── Animations ───────────────────────────────────────────────────────────────

function BuildingAnimation() {
  return (
    <div className="relative w-16 h-16">
      {/* Outer ring */}
      <svg
        className="absolute inset-0 animate-spin"
        style={{ animationDuration: '3s' }}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle
          cx="32"
          cy="32"
          r="28"
          stroke="#6366f1"
          strokeWidth="2"
          strokeDasharray="44 132"
          strokeLinecap="round"
        />
      </svg>
      {/* Inner icon */}
      <div className="absolute inset-0 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <polygon points="4,3 20,12 4,21" fill="#6366f1" className="opacity-80" />
        </svg>
      </div>
    </div>
  );
}

function IdleGraphic() {
  return (
    <div className="w-16 h-16 rounded-2xl border border-[#1a1a1a] bg-[#111111] flex items-center justify-center">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <polygon points="5,3 23,14 5,25" fill="#2a2a2a" />
      </svg>
    </div>
  );
}
