import { describe, expect, it, vi } from 'vitest';
import { GAME_SESSION_RUNTIME } from './game-session-runtime';
import { PREMIUM_STARTER_FILES } from './premium-starters';

interface State {
  resources: number;
  placed: string[];
  roll: number;
}
interface Session {
  readonly state: Readonly<State>;
  readonly time: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  defineAction(
    name: string,
    reducer: (draft: State, payload: unknown, context: { random(): number }) => unknown,
  ): Session;
  dispatch(name: string, payload?: unknown): boolean;
  subscribe(listener: (state: Readonly<State>) => void): () => void;
  after(seconds: number, callback: (session: Session) => void): () => void;
  advance(dt: number): void;
  undo(): boolean;
  redo(): boolean;
  reset(): void;
  pause(): void;
  resume(): void;
  snapshot(): { schemaVersion: number; state: State; rng: number; time: number };
  restore(snapshot: unknown): void;
  dispose(): void;
}
const create = new Function(
  `${GAME_SESSION_RUNTIME.replaceAll('export ', '')}; return createGameSession;`,
)() as (
  state: State,
  options?: {
    seed?: number;
    version?: number;
    historyLimit?: number;
    validate?: (s: State) => boolean;
    onError?: (error: unknown) => void;
  },
) => Session;
function session(options?: Parameters<typeof create>[1]) {
  return create({ resources: 3, placed: [], roll: 0 }, options).defineAction(
    'place',
    (draft, payload, { random }) => {
      draft.roll = random();
      if (draft.resources < 1) return false;
      draft.resources--;
      draft.placed.push(String(payload));
    },
  );
}

describe('shared rules runtime', () => {
  it('ships the same tested implementation for Phaser, Three and legacy projects', () => {
    for (const engine of ['phaser', 'three', 'canvas2d'] as const)
      expect(PREMIUM_STARTER_FILES[engine]['src/runtime/session.js']).toContain(
        GAME_SESSION_RUNTIME,
      );
  });
  it('commits transactions, rejects invalid actions atomically and prevents external mutation', () => {
    const game = session();
    for (const name of ['mill', 'pond', 'house']) expect(game.dispatch('place', name)).toBe(true);
    const before = game.snapshot();
    expect(game.dispatch('place', 'tower')).toBe(false);
    expect(game.snapshot()).toEqual(before);
    expect(Object.isFrozen(game.state.placed)).toBe(true);
    expect(game.state.placed).toEqual(['mill', 'pond', 'house']);
  });
  it('rolls back failed validation and thrown rules including randomness', () => {
    const game = session({ validate: (s) => s.resources >= 0 });
    game.defineAction('bad', (draft, _payload, { random }) => {
      draft.roll = random();
      draft.resources = -1;
    });
    const before = game.snapshot();
    expect(() => game.dispatch('bad')).toThrow('validation');
    expect(game.snapshot()).toEqual(before);
    game.defineAction('throws', (draft, _payload, { random }) => {
      draft.roll = random();
      throw new Error('bad');
    });
    expect(() => game.dispatch('throws')).toThrow('bad');
    expect(game.snapshot()).toEqual(before);
  });
  it('provides deterministic undo/redo, branch replacement, and reset', () => {
    const game = session({ seed: 71 });
    game.dispatch('place', 'pond');
    const first = game.snapshot();
    expect(game.undo()).toBe(true);
    expect(game.state.placed).toEqual([]);
    expect(game.redo()).toBe(true);
    expect(game.snapshot()).toEqual(first);
    game.undo();
    game.dispatch('place', 'mill');
    expect(game.state.roll).toBe(first.state.roll);
    expect(game.canRedo).toBe(false);
    game.reset();
    game.dispatch('place', 'pond');
    expect(game.snapshot()).toEqual(first);
  });
  it('bounds history and supports disabling it for simulations', () => {
    const game = session({ historyLimit: 1 });
    game.dispatch('place', 'pond');
    game.dispatch('place', 'mill');
    expect(game.undo()).toBe(true);
    expect(game.undo()).toBe(false);
    const sim = session({ historyLimit: 0 });
    sim.dispatch('place', 'pond');
    expect(sim.canUndo).toBe(false);
  });
  it('pauses timers and input, cancels pending work on recovery, and orders callbacks by due time', () => {
    const game = session();
    const fired: string[] = [];
    game.after(2, () => fired.push('late'));
    game.after(1, () => fired.push('early'));
    game.pause();
    game.advance(10);
    expect(game.dispatch('place', 'pond')).toBe(false);
    expect(game.time).toBe(0);
    expect(fired).toEqual([]);
    game.resume();
    game.advance(2);
    expect(fired).toEqual(['early', 'late']);
    game.after(1, () => fired.push('stale'));
    game.reset();
    game.advance(5);
    expect(fired).toEqual(['early', 'late']);
  });
  it('does not recursively execute newly scheduled zero-delay timers', () => {
    const game = session();
    const callback = vi.fn();
    game.after(0, () => game.after(0, callback));
    game.advance(0);
    expect(callback).not.toHaveBeenCalled();
    game.advance(0);
    expect(callback).toHaveBeenCalledTimes(1);
    game.after(0, () => game.advance(1));
    expect(() => game.advance(0)).toThrow('recursively');
    expect(() => game.advance(0)).not.toThrow();
  });
  it('restores versioned snapshots without stale timers or mutable aliases', () => {
    const game = session({ version: 2 });
    game.dispatch('place', 'pond');
    const saved = game.snapshot();
    const callback = vi.fn();
    game.after(1, callback);
    game.dispatch('place', 'mill');
    game.restore(saved);
    saved.state.placed.push('external');
    expect(game.state.placed).toEqual(['pond']);
    game.advance(2);
    expect(callback).not.toHaveBeenCalled();
    expect(() => game.restore({ ...saved, schemaVersion: 1 })).toThrow('Incompatible');
    expect(game.state.placed).toEqual(['pond']);
  });
  it('isolates broken subscribers without partially rolling back committed state', () => {
    const onError = vi.fn(() => {
      throw new Error('observer error');
    });
    const game = session({ onError });
    const listener = vi.fn();
    game.subscribe(() => {
      game.reset();
    });
    game.subscribe(listener);
    expect(game.dispatch('place', 'pond')).toBe(true);
    expect(onError).toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
    expect(game.state.placed).toEqual(['pond']);
  });
  it('rejects asynchronous rules and engine objects, and disposes all future work', () => {
    const game = session();
    game.defineAction('async', async (draft) => {
      draft.resources--;
    });
    expect(() => game.dispatch('async')).toThrow('synchronous');
    expect(game.state.resources).toBe(3);
    game.defineAction('object', (draft) => {
      Object.assign(draft, { mesh: new Date() });
    });
    expect(() => game.dispatch('object')).toThrow('engine objects');
    game.dispose();
    expect(() => game.advance(1)).toThrow('disposed');
    expect(() => game.dispatch('place')).toThrow('disposed');
  });
});
