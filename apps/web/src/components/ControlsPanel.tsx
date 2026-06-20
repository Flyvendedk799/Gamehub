'use client';

import type { ControlsManifest } from '@/lib/iframe-bridge';
import { useCallback, useEffect, useMemo, useState } from 'react';

/** Friendly label for a KeyboardEvent.code (e.g. 'ArrowUp' → '↑', 'KeyW' → 'W'). */
export function keyLabel(code: string): string {
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
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage may be unavailable (private mode) — binds still apply live */
      }
    },
    [onApply, storageKey],
  );

  // While capturing, the next keydown binds that key to the action.
  useEffect(() => {
    if (capturing === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === 'Escape') {
        setCapturing(null);
        return;
      }
      const current = bindings[capturing] ?? [];
      if (!current.includes(e.code)) commit({ ...bindings, [capturing]: [...current, e.code] });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, bindings, commit]);

  const removeKey = (id: string, code: string) => {
    commit({ ...bindings, [id]: (bindings[id] ?? []).filter((k) => k !== code) });
  };
  const reset = () => commit({ ...defaults });

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
            className="rounded-lg bg-[#6366f1] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4f46e5]"
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
          className="text-[11px] text-[#818cf8] hover:text-[#a5b4fc] transition-colors"
        >
          Reset to defaults
        </button>
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
              <button
                type="button"
                onClick={() => setCapturing(action.id)}
                className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-[#6366f1]/30 text-[#818cf8] hover:bg-[#6366f1]/10 transition-colors"
              >
                {capturing === action.id ? 'Press a key…' : '+ Add key'}
              </button>
            </div>
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
                      className="text-[#52525b] hover:text-[#ef4444] transition-colors"
                      aria-label={`Remove ${keyLabel(code)} from ${action.label}`}
                    >
                      ✕
                    </button>
                  </span>
                ))
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
