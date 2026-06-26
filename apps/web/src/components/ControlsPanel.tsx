'use client';

import type { ControlsManifest } from '@/lib/iframe-bridge';
import {
  autoMapGamepad,
  hasGamepadBindings,
  mergeGamepadBindings,
  padLabel,
} from '@playforge/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

/** Friendly label for a bound input — a KeyboardEvent.code ('ArrowUp' → '↑',
 *  'KeyW' → 'W'), a mouse button ('Mouse0' → 'Left Click'), or a controller
 *  code ('Pad0' → 'A', 'PadLLeft' → 'L-Stick ←'). */
export function keyLabel(code: string): string {
  const pad = padLabel(code);
  if (pad) return pad;
  if (code.startsWith('Mouse')) {
    const m: Record<string, string> = {
      Mouse0: 'Left Click',
      Mouse1: 'Middle Click',
      Mouse2: 'Right Click',
    };
    return m[code] ?? `Mouse ${code.slice(5)}`;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    Escape: 'Esc',
  };
  return map[code] ?? code;
}

type Bindings = Record<string, string[]>;

function bindingsFromManifest(manifest: ControlsManifest): Bindings {
  const b: Bindings = {};
  for (const a of manifest.actions) b[a.id] = [...a.keys];
  return b;
}

function loadSaved(storageKey: string): Bindings | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Bindings) : null;
  } catch {
    return null;
  }
}

export function ControlsPanel({
  manifest,
  onApply,
  storageKey,
  onMapWithAI,
  onUserRebind,
  gamepadConnected = false,
}: {
  manifest: ControlsManifest | null;
  /** Push the full binding set to the running game. */
  onApply: (bindings: Bindings) => void;
  /** localStorage key (per RUN — see PreviewPane) for persisting custom binds.
   *  Keyed per-run so a fresh generation reverts stale manual overrides to the
   *  game's newly-declared defaults. */
  storageKey: string;
  /** Legacy rescue: fire ONE scoped generation that wires the rebindable
   *  controls layer into a game that didn't declare it. One click = one run; no
   *  polling. Undefined hides the button. */
  onMapWithAI?: () => void;
  /** Fired on a USER-initiated bind change (not the initial seed) so the host can
   *  cue a preview reload. */
  onUserRebind?: () => void;
  /** True when the running game reports a connected controller (gamepad bridge). */
  gamepadConnected?: boolean;
}) {
  const defaults = useMemo(() => (manifest ? bindingsFromManifest(manifest) : {}), [manifest]);
  const [bindings, setBindings] = useState<Bindings>({});
  const [capturing, setCapturing] = useState<string | null>(null); // actionId awaiting a key

  // Seed from saved binds (falling back to the game's declared defaults) and push
  // them to the running game so the user's keys are live immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the manifest changes
  useEffect(() => {
    if (!manifest) return;
    const saved = loadSaved(storageKey);
    const seeded: Bindings = {};
    for (const a of manifest.actions) seeded[a.id] = saved?.[a.id] ?? [...a.keys];
    setBindings(seeded);
    onApply(seeded);
  }, [manifest, storageKey]);

  const commit = useCallback(
    (next: Bindings) => {
      setBindings(next);
      onApply(next);
      onUserRebind?.();
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage may be unavailable (private mode) — binds still apply live */
      }
    },
    [onApply, storageKey, onUserRebind],
  );

  // While capturing, the next keydown OR mouse button binds to the action.
  useEffect(() => {
    if (capturing === null) return;
    const bind = (code: string) => {
      const current = bindings[capturing] ?? [];
      if (!current.includes(code)) commit({ ...bindings, [capturing]: [...current, code] });
      setCapturing(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === 'Escape') {
        setCapturing(null);
        return;
      }
      bind(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      e.preventDefault();
      bind(`Mouse${e.button}`);
    };
    // Suppress the context menu while capturing so a right-click binds cleanly;
    // the mousedown above is what actually records the button.
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('mousedown', onMouse, { capture: true });
    window.addEventListener('contextmenu', onCtx, { capture: true });

    // Also capture a CONTROLLER button/stick while binding, so pad binds are
    // rebindable like keys. Poll the gamepad; the first newly-pressed button (or
    // a stick pushed past the deadzone) binds. The first frame only records the
    // resting state so an already-held button doesn't bind instantly.
    let raf = 0;
    let prev: boolean[] = [];
    let first = true;
    const pollPad = () => {
      const pads = navigator.getGamepads?.();
      const gp = pads ? Array.from(pads).find((p) => p?.connected) : null;
      if (gp) {
        const pressed = gp.buttons.map((b) => b.pressed || b.value > 0.5);
        if (!first) {
          for (let i = 0; i < pressed.length; i++) {
            if (pressed[i] && !prev[i]) {
              bind(`Pad${i}`);
              return;
            }
          }
          const ax = gp.axes[0] ?? 0;
          const ay = gp.axes[1] ?? 0;
          if (ax < -0.5) return bind('PadLLeft');
          if (ax > 0.5) return bind('PadLRight');
          if (ay < -0.5) return bind('PadLUp');
          if (ay > 0.5) return bind('PadLDown');
        }
        prev = pressed;
        first = false;
      }
      raf = requestAnimationFrame(pollPad);
    };
    raf = requestAnimationFrame(pollPad);

    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('mousedown', onMouse, { capture: true });
      window.removeEventListener('contextmenu', onCtx, { capture: true });
      cancelAnimationFrame(raf);
    };
  }, [capturing, bindings, commit]);

  const removeKey = (id: string, code: string) => {
    commit({ ...bindings, [id]: (bindings[id] ?? []).filter((k) => k !== code) });
  };
  const reset = () => commit({ ...defaults });

  // Controller support: auto-map the current controls onto a standard gamepad
  // (the SAME heuristic the add_controller_support agent tool uses) and merge the
  // pad codes into the live bindings. The gamepad bridge in the running game then
  // translates controller input into the keys these actions already read.
  const controllerMapped = useMemo(() => hasGamepadBindings(bindings), [bindings]);
  const addControllerSupport = useCallback(() => {
    if (!manifest) return;
    commit(mergeGamepadBindings(bindings, autoMapGamepad(manifest.actions)));
  }, [manifest, bindings, commit]);

  if (!manifest) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-[#71717a] max-w-xs leading-relaxed">
          This game reads input directly, so its keys aren't mappable yet. Map them once and you can
          rebind live from here — no AI needed after that.
        </p>
        {onMapWithAI && (
          <button
            type="button"
            onClick={onMapWithAI}
            className="rounded-lg bg-[#6366f1] px-4 py-2.5 md:py-2 text-sm font-medium text-white transition-colors hover:bg-[#4f46e5]"
          >
            Map controls with AI
          </button>
        )}
        <p className="text-[11px] text-[#52525b] max-w-xs leading-relaxed">
          Runs once to wire a rebindable controls layer (and fix any inverted keys). New games map
          their controls automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono uppercase tracking-widest text-[#52525b]">Controls</h3>
        <button
          type="button"
          onClick={reset}
          className="px-3 py-2 text-xs text-[#818cf8] hover:text-[#a5b4fc] transition-colors"
        >
          Reset to defaults
        </button>
      </div>

      {/* Controller support — one click auto-maps the current controls onto a
          standard gamepad; afterwards each action shows its pad button as a chip. */}
      <div className="mb-3 rounded-xl border border-[#222222] bg-[#0f0f0f] px-3.5 py-3">
        {controllerMapped ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm">🎮</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#f4f4f5]">
                  {gamepadConnected ? 'Controller connected' : 'Controller mapped'}
                </p>
                <p className="text-[11px] text-[#71717a] leading-relaxed">
                  {gamepadConnected
                    ? 'Your controller is driving the game.'
                    : 'Connect a controller and press a button to start.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={addControllerSupport}
              className="flex-shrink-0 text-[11px] px-3 py-1.5 rounded-lg border border-[#27272a] text-[#a1a1aa] hover:text-[#d4d4d8] hover:border-[#3f3f46] transition-colors"
            >
              Re-map
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm">🎮</span>
              <p className="text-xs text-[#a1a1aa] leading-relaxed">
                Add controller support — auto-maps these controls onto a gamepad.
              </p>
            </div>
            <button
              type="button"
              onClick={addControllerSupport}
              className="flex-shrink-0 rounded-lg bg-[#6366f1] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#4f46e5]"
            >
              Add controller support
            </button>
          </div>
        )}
      </div>

      <ul className="space-y-2">
        {manifest.actions.map((action) => (
          <li
            key={action.id}
            className="rounded-xl border border-[#222222] bg-[#0f0f0f] px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#f4f4f5]">{action.label}</p>
                {action.description && (
                  <p className="mt-0.5 text-xs text-[#71717a] leading-relaxed">
                    {action.description}
                  </p>
                )}
              </div>
              {action.pointer ? (
                <span className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-[#18181b] border border-[#27272a] text-[#a1a1aa] capitalize">
                  Mouse · {action.pointer}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setCapturing(action.id)}
                  className="flex-shrink-0 text-xs px-3 py-2 md:text-[11px] md:py-1 rounded-lg border border-[#6366f1]/30 text-[#818cf8] hover:bg-[#6366f1]/10 transition-colors"
                >
                  {capturing === action.id ? 'Press a key, click, or button…' : '+ Add bind'}
                </button>
              )}
            </div>
            {action.pointer ? (
              <p className="mt-2 text-[11px] text-[#52525b] italic">
                Move the mouse to {action.pointer} — drag, or click to capture the pointer.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(bindings[action.id] ?? []).length === 0 ? (
                  <span className="text-[11px] text-[#52525b] italic">unbound</span>
                ) : (
                  (bindings[action.id] ?? []).map((code) => (
                    <span
                      key={code}
                      className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded-md bg-[#18181b] border border-[#27272a] text-[#d4d4d8]"
                    >
                      {keyLabel(code)}
                      <button
                        type="button"
                        onClick={() => removeKey(action.id, code)}
                        className="tap-target inline-flex items-center justify-center md:min-h-0 md:min-w-0 text-[#52525b] hover:text-[#ef4444] transition-colors"
                        aria-label={`Remove ${keyLabel(code)} from ${action.label}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
