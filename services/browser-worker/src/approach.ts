/**
 * The adaptive "close in on the opponent" playtest step.
 *
 * A canned playbook closes the gap by holding W. That is a guess about the camera: in a side-on
 * view W walks into the depth of the arena, left and right close the gap, and the same duel plays
 * fine but fails "opponent HP is lower after closing in and striking" (run 98e9cf12, which spent
 * two repair rounds on a game that was correct). The step cannot know the camera, but it can find
 * out by trying:
 *
 *   distance mode  the snapshot exposes both positions: hill-climb. Probe each movement key for a
 *                  few frames, keep the one that shrinks the distance, stop when none does.
 *   outcome mode   no opponent position (the usual case: real duels expose `playerPos` and
 *                  `opponentHp` only): search by result. Walk forward as the playbook always did,
 *                  hop each other direction, steer back to the start, then walk each direction
 *                  outward, striking along the way and stopping as soon as the watched field drops.
 *   none           nothing readable: hold the forward key, which is what the playbook did before.
 *
 * Everything page-facing is injected (`ApproachIo`), so the strategy is unit-tested without a
 * browser. The controls manifest and the snapshot both come from untrusted game code, so every
 * read here is total: nothing throws on a malformed value.
 */
import { resolveControlKey } from './control-intents.js';

export interface ApproachStep {
  kind: 'approach';
  /** Snapshot field (dotted path) that should DROP once a strike lands, e.g. `opponentHp`. */
  watch: string;
  /** Total frame budget for the whole search. */
  frames?: number;
}

/**
 * The server's browser job runs about 18 frames a second (software rendering) under a 45 s
 * ceiling, and a failing check is driven up to three times. The whole fighting plan is sized at
 * roughly 450 frames; the two walking steps this one replaces were 130 of them. So this step gets
 * about twice that, and no more.
 */
export const APPROACH_DEFAULT_FRAMES = 260;
export const APPROACH_MIN_FRAMES = 60;
export const APPROACH_MAX_FRAMES = 420;

/** Frames a movement key is held to learn what it does. Short, and opposite keys cancel out. */
const PROBE_FRAMES = 6;
/** The longest walk toward the target in one go; shorter near it, and halved on an overshoot. */
const COMMIT_FRAMES = 40;
/** The finest step the steering will take once it starts converging. */
const MIN_STEP_FRAMES = 2;
/** Outcome mode: a short hop in each direction (sets facing, covers an opponent that walks up). */
const HOP_FRAMES = 14;
/** Outcome mode: the most frames spent walking back to where a hop began. */
const HOP_RETURN_FRAMES = 24;
/** Outcome mode: one step of a longer walk, followed by a strike. */
const SWEEP_CHUNK_FRAMES = 30;
/** Outcome mode: the forward walk the playbook always did, with strikes along it. */
const FORWARD_SWEEP_FRAMES = 60;
/** Outcome mode: the most frames a sideways or backward sweep may run. */
const SIDE_SWEEP_FRAMES = 120;
/** Outcome mode: the most frames spent steering back to where the step began. */
const RECENTER_FRAMES = 70;
/** Outcome mode: steer back only when the player is farther than this from where it began. */
const RECENTER_ABOVE_UNITS = 1;
/** Outcome mode: a sweep stops once it is this far from where the step began. */
const SWEEP_UNITS = 2;
const STRIKE_FRAMES = 10;
/** Smallest change in distance / position that counts as real movement (world units). */
const EPSILON = 0.02;
/** A key that moved nothing this many times is not a movement key in this game. */
const INERT_AFTER_MISSES = 2;
/** What the playbook did before this step existed: hold forward for this long. */
const LEGACY_FORWARD_FRAMES = 130;

export interface ApproachIo {
  /** Hold `code` for `frames` RAF frames, then release it. */
  press(code: string, frames: number): Promise<void>;
  /** One left click. */
  click(): Promise<void>;
  /** The game's current `window.__game.debug.snapshot()`, or null. */
  snapshot(): Promise<unknown>;
}

export interface ApproachReport {
  mode: 'distance' | 'outcome' | 'none';
  /** True when the watched field dropped below its value at the start of the step. */
  hit: boolean;
  framesUsed: number;
  /** Movement keys in the order they were tried. */
  tried: string[];
  /** Keys that never moved the player, and were dropped. */
  inert: string[];
  /** Planar player-to-opponent distance when the step ended; null without both positions. */
  finalDistance: number | null;
}

// ---------------------------------------------------------------------------
// Reading the snapshot
// ---------------------------------------------------------------------------

/** `a.b[0].c` -> ['a', 'b', '0', 'c']. */
function pathParts(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** A finite number at a dotted path, or null. Never throws. */
export function readNumber(snapshot: unknown, path: string): number | null {
  let cur: unknown = snapshot;
  for (const part of pathParts(path)) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

export interface Planar {
  a: number;
  b: number;
}

/**
 * Two numbers that place something on the ground plane. Three.js games put height in `y`, so a
 * 3D position uses (x, z); a 2D position has no `z` and uses (x, y). Accepts `{x, z}`, `{x, y}`
 * and `[x, y, z]`.
 */
export function planarOf(value: unknown): Planar | null {
  if (Array.isArray(value)) {
    const [x, y, z] = value;
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (typeof z === 'number' && Number.isFinite(z)) return { a: x, b: z };
    return typeof y === 'number' && Number.isFinite(y) ? { a: x, b: y } : null;
  }
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const num = (k: string): number | null =>
    typeof v[k] === 'number' && Number.isFinite(v[k] as number) ? (v[k] as number) : null;
  const x = num('x');
  if (x === null) return null;
  const z = num('z');
  if (z !== null) return { a: x, b: z };
  const y = num('y');
  return y === null ? null : { a: x, b: y };
}

const OPPONENT_KEY = /^(opponent|enemy|rival|foe|boss|target|npc|ai)(pos|position|xyz|location)?$/i;
const POSITION_WORD = /pos|position|location|xyz/i;

/** A position held directly, or under a field that names one (`{ pos: {x, z} }`). */
function positionIn(value: unknown): Planar | null {
  const direct = planarOf(value);
  if (direct !== null) return direct;
  if (value === null || typeof value !== 'object') return null;
  for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!POSITION_WORD.test(inner)) continue;
    const nested = planarOf(innerValue);
    if (nested !== null) return nested;
  }
  return null;
}

/** The opponent's position wherever a game might have put it. Null when it is not exposed. */
export function opponentPlanar(snapshot: unknown): Planar | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const root = snapshot as Record<string, unknown>;
  for (const [key, value] of Object.entries(root)) {
    if (!OPPONENT_KEY.test(key)) continue;
    const found = positionIn(value);
    if (found !== null) return found;
  }
  // `enemies: [{x, z}, ...]` or `enemies: [{pos: {x, z}}]`: the first is the duel's opponent.
  const list = root['enemies'] ?? root['opponents'];
  if (Array.isArray(list) && list.length > 0) return positionIn(list[0]);
  return null;
}

/** The player's position: `playerPos`, or `player` as a position / holder of one. */
export function playerPlanar(snapshot: unknown): Planar | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const root = snapshot as Record<string, unknown>;
  return (
    planarOf(root['playerPos']) ?? planarOf(root['playerPosition']) ?? positionIn(root['player'])
  );
}

export function planarDistance(from: Planar, to: Planar): number {
  return Math.hypot(from.a - to.a, from.b - to.b);
}

/** Player-to-opponent distance, or null when either position is not in the snapshot. */
export function distanceBetween(snapshot: unknown): number | null {
  const me = playerPlanar(snapshot);
  const them = opponentPlanar(snapshot);
  return me === null || them === null ? null : planarDistance(me, them);
}

// ---------------------------------------------------------------------------
// Which keys move the player
// ---------------------------------------------------------------------------

/** An action whose name carries a direction or a walking verb. "Dodge Left" qualifies: a duel's
 *  lateral step is often labelled that way, and it still moves the player left. */
const DIRECTIONAL =
  /forward|backward|back\b|retreat|advance|approach|left|right|\bup\b|\bdown\b|north|south|east|west|strafe|\bstep\b|walk|move/i;
/** Actions that are not movement even when the word "move" appears ("special move"). */
const NOT_MOVEMENT =
  /attack|strike|slash|swing|stab|thrust|punch|light|heavy|block|guard|parry|jump|special|pause|menu|restart|reset|mute|interact|use\b|taunt/i;
/** Walking away from the opponent. Searched last: it is the least likely way to close the gap. */
const BACKWARD = /back|retreat|away|\bdown\b|south/i;

/** A key code a playtest can hold down; mouse and gamepad bindings are not key steps. */
const KEYBOARD_CODE =
  /^(Key[A-Z]|Digit\d|Arrow(Up|Down|Left|Right)|Space|Enter|Shift(Left|Right)|Control(Left|Right)|Numpad\w+)$/;

/** Keys to try when the game declares too few movement actions to search with. */
const FALLBACK_KEYS = [
  'KeyW',
  'KeyD',
  'KeyA',
  'KeyS',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'ArrowDown',
] as const;
const FALLBACK_BACKWARD: ReadonlySet<string> = new Set(['KeyS', 'ArrowDown']);

export interface MovementKeys {
  /** Forward first (what the playbook always did), then the game's declared order. */
  keys: string[];
  /** The subset that walks away from the opponent. */
  backward: Set<string>;
}

/**
 * The movement keys to search with. One key per declared action; a game that declares fewer than
 * two movement keys gets the WASD / arrow defaults appended.
 */
export function movementKeys(manifest: unknown): MovementKeys {
  const keys: string[] = [];
  const backward = new Set<string>();
  const add = (code: string | null, isBackward: boolean): void => {
    if (code === null) return;
    if (!keys.includes(code)) keys.push(code);
    if (isBackward) backward.add(code);
  };
  add(resolveControlKey(manifest, 'forward'), false);
  const actions = (manifest as { actions?: unknown } | null | undefined)?.actions;
  if (Array.isArray(actions)) {
    for (const raw of actions) {
      if (raw === null || typeof raw !== 'object') continue;
      const action = raw as { id?: unknown; label?: unknown; keys?: unknown };
      const name = `${typeof action.id === 'string' ? action.id : ''} ${
        typeof action.label === 'string' ? action.label : ''
      }`;
      if (!DIRECTIONAL.test(name) || NOT_MOVEMENT.test(name)) continue;
      if (!Array.isArray(action.keys)) continue;
      const code = action.keys.find(
        (k): k is string => typeof k === 'string' && KEYBOARD_CODE.test(k),
      );
      add(code ?? null, BACKWARD.test(name));
    }
  }
  if (keys.length < 2) {
    for (const code of FALLBACK_KEYS) add(code, FALLBACK_BACKWARD.has(code));
  }
  return { keys, backward };
}

/** The key the game binds to a light attack, or J. */
export function strikeKey(manifest: unknown): string {
  return resolveControlKey(manifest, 'attack') ?? 'KeyJ';
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

export function approachBudget(step: ApproachStep): number {
  const asked = typeof step.frames === 'number' ? Math.trunc(step.frames) : APPROACH_DEFAULT_FRAMES;
  return Math.min(APPROACH_MAX_FRAMES, Math.max(APPROACH_MIN_FRAMES, asked));
}

/** Run the adaptive approach. Resolves with a report; never rejects on bad game data. */
export async function runApproach(
  io: ApproachIo,
  step: ApproachStep,
  manifest: unknown,
): Promise<ApproachReport> {
  const budget = approachBudget(step);
  const start = await io.snapshot();
  const startWatch = readNumber(start, step.watch);
  const { keys, backward } = movementKeys(manifest);
  const report: ApproachReport = {
    mode: 'none',
    hit: false,
    framesUsed: 0,
    tried: [],
    inert: [],
    finalDistance: distanceBetween(start),
  };

  const dropped = async (): Promise<boolean> => {
    if (startWatch === null) return false;
    const now = readNumber(await io.snapshot(), step.watch);
    return now !== null && now < startWatch;
  };
  const press = async (code: string, frames: number): Promise<void> => {
    await io.press(code, frames);
    report.framesUsed += frames;
  };
  const misses = new Map<string, number>();
  const noteMovement = (code: string, moved: boolean): void => {
    if (moved) {
      misses.set(code, 0);
      return;
    }
    const count = (misses.get(code) ?? 0) + 1;
    misses.set(code, count);
    if (count >= INERT_AFTER_MISSES && !report.inert.includes(code)) report.inert.push(code);
  };
  const usable = (): string[] => keys.filter((k) => !report.inert.includes(k));
  const noteTried = (code: string): void => {
    if (!report.tried.includes(code)) report.tried.push(code);
  };
  const finish = (hit: boolean): ApproachReport => {
    report.hit = hit;
    return report;
  };

  // What each key does to the player's position, per frame, as last measured. The camera decides
  // it (W is "into the screen" in one view, "up" in another), and tank-style controls change it as
  // the player turns, so it is re-measured after every move.
  const velocity = new Map<string, Planar>();
  const learn = async (code: string, frames: number): Promise<boolean> => {
    const before = playerPlanar(await io.snapshot());
    noteTried(code);
    await press(code, frames);
    const after = playerPlanar(await io.snapshot());
    // A game that does not expose the player's position cannot be told it moved nothing, so it is
    // never written off as unresponsive.
    if (before === null || after === null) return true;
    const moved = planarDistance(before, after) > EPSILON;
    if (moved) {
      velocity.set(code, { a: (after.a - before.a) / frames, b: (after.b - before.b) / frames });
    }
    // Only a probe long enough to matter may write a key off as doing nothing.
    if (frames >= PROBE_FRAMES) noteMovement(code, moved);
    return moved;
  };

  /**
   * Steer the player to `targetOf(snapshot)`: pick the key whose measured movement points most
   * toward it (a gradient step, not a blind probe), walk it, re-measure, and shrink the step each
   * time it overshoots. Ends when no key makes progress, the step is as fine as it gets, or `limit`
   * frames are spent. With `stopOnHit` it ends the moment the watched field drops.
   */
  const steer = async (
    targetOf: (snapshot: unknown) => Planar | null,
    limit: number,
    commitFrames: number,
    stopOnHit: boolean,
  ): Promise<{ hit: boolean; distance: number | null }> => {
    const gapOf = (snapshot: unknown): { gap: Planar; distance: number } | null => {
      const me = playerPlanar(snapshot);
      const to = targetOf(snapshot);
      if (me === null || to === null) return null;
      const gap = { a: to.a - me.a, b: to.b - me.b };
      return { gap, distance: Math.hypot(gap.a, gap.b) };
    };
    let now = gapOf(await io.snapshot());
    if (now === null) return { hit: false, distance: null };
    // Learn what every key does, once. The probes are short and, for opposite keys, cancel out.
    for (const code of usable()) {
      if (velocity.has(code) || report.framesUsed >= limit) continue;
      await learn(code, PROBE_FRAMES);
      if (stopOnHit && (await dropped())) {
        return { hit: true, distance: gapOf(await io.snapshot())?.distance ?? now.distance };
      }
    }
    let commit = commitFrames;
    let best = Number.POSITIVE_INFINITY;
    let stalls = 0;
    while (report.framesUsed < limit) {
      const here = gapOf(await io.snapshot());
      if (here === null) break;
      now = here;
      best = Math.min(best, now.distance);
      let pick: { code: string; speed: number; along: number } | null = null;
      for (const code of usable()) {
        const v = velocity.get(code);
        if (v === undefined) continue;
        const speed = Math.hypot(v.a, v.b);
        if (speed <= 0) continue;
        const along = (v.a * now.gap.a + v.b * now.gap.b) / (speed * Math.max(now.distance, 1e-9));
        if (along > 0.2 && (pick === null || along > pick.along)) pick = { code, speed, along };
      }
      if (pick === null) break; // no key points toward the target
      // Close to the target, take only the step that gets there: a full one overshoots.
      const needed = Math.ceil((now.distance * pick.along) / pick.speed);
      const frames = Math.max(MIN_STEP_FRAMES, Math.min(commit, needed));
      await learn(pick.code, frames);
      if (stopOnHit && (await dropped())) {
        return { hit: true, distance: gapOf(await io.snapshot())?.distance ?? now.distance };
      }
      const next = gapOf(await io.snapshot());
      if (next === null) break;
      if (next.distance < best - EPSILON) {
        best = next.distance;
        stalls = 0;
      } else {
        // Overshot or blocked: finer steps, and give up after a few in a row.
        stalls += 1;
        commit = Math.max(MIN_STEP_FRAMES, Math.floor(commit / 2));
        if (stalls >= 3) break;
      }
    }
    return { hit: false, distance: gapOf(await io.snapshot())?.distance ?? now.distance };
  };

  // Nothing to steer by: do what the playbook always did.
  if (startWatch === null && report.finalDistance === null) {
    const forward = keys[0] ?? 'KeyW';
    noteTried(forward);
    await press(forward, Math.min(budget, LEGACY_FORWARD_FRAMES));
    return report;
  }

  // ── Distance mode ────────────────────────────────────────────────────────
  if (report.finalDistance !== null) {
    report.mode = 'distance';
    const result = await steer(opponentPlanar, budget, COMMIT_FRAMES, true);
    report.finalDistance = result.distance ?? report.finalDistance;
    return finish(result.hit);
  }

  // ── Outcome mode ─────────────────────────────────────────────────────────
  report.mode = 'outcome';
  const attack = strikeKey(manifest);
  const origin = playerPlanar(start);
  const fromOrigin = (snapshot: unknown): number | null => {
    const me = playerPlanar(snapshot);
    return origin === null || me === null ? null : planarDistance(origin, me);
  };

  /** A strike from wherever the player stands. The click covers games that bind attack to it. */
  const strike = async (): Promise<boolean> => {
    await press(attack, STRIKE_FRAMES);
    await io.click();
    report.framesUsed += 2;
    return dropped();
  };
  /**
   * Walk `code` in chunks, striking after each. True once a strike lands. A chunk that moved the
   * player nowhere ends the sweep (a wall, or a key that does nothing). With `stopAtUnits`, it also
   * ends once the player is far from the start AND still moving away, so a sweep that begins on
   * the far side of the start walks back through it and out the other side.
   */
  const sweep = async (code: string, maxFrames: number, stopAtUnits: boolean): Promise<boolean> => {
    noteTried(code);
    let previous = fromOrigin(await io.snapshot());
    for (
      let spent = 0;
      spent < maxFrames && report.framesUsed < budget;
      spent += SWEEP_CHUNK_FRAMES
    ) {
      const moved = await learn(code, SWEEP_CHUNK_FRAMES);
      if (!moved) return false;
      if (await strike()) return true;
      const away = fromOrigin(await io.snapshot());
      if (
        stopAtUnits &&
        away !== null &&
        away >= SWEEP_UNITS &&
        (previous === null || away > previous)
      ) {
        return false;
      }
      previous = away;
    }
    return false;
  };

  /** Steer back to where the step began, so what follows starts from the middle instead of from
   *  wherever the last walk left the player. Needs the player's position. */
  const recenter = async (): Promise<void> => {
    if (origin === null) return;
    const here = fromOrigin(await io.snapshot());
    if (here === null || here <= RECENTER_ABOVE_UNITS) return;
    const limit = Math.min(budget, report.framesUsed + RECENTER_FRAMES);
    await steer(() => origin, limit, COMMIT_FRAMES, false);
  };

  // 1. Forward, as the playbook always did, now striking along the way. Bounded by distance as
  //    well as frames: the farther it walks, the farther from every other direction it strikes.
  const forward = keys[0];
  if (forward !== undefined && (await sweep(forward, FORWARD_SWEEP_FRAMES, true))) {
    return finish(true);
  }
  // 2. Back to the start, then a short hop in every other direction, striking after each. This
  //    sets the player's facing each way and covers an opponent that walks up to the player.
  await recenter();
  const others = (): string[] => usable().filter((k) => k !== forward);
  for (const code of others()) {
    if (report.framesUsed >= budget) break;
    const base = playerPlanar(await io.snapshot());
    const moved = await learn(code, HOP_FRAMES);
    if (moved && (await strike())) return finish(true);
    // Back to where the hop began. Left then right would otherwise cancel, and the right-hand
    // side would never be struck from at all.
    if (base !== null) {
      const limit = Math.min(budget, report.framesUsed + HOP_RETURN_FRAMES);
      await steer(() => base, limit, COMMIT_FRAMES, false);
    }
  }
  // 3. Walk each remaining direction outward from the start; backward last.
  await recenter();
  const ordered = [
    ...others().filter((k) => !backward.has(k)),
    ...others().filter((k) => backward.has(k)),
  ];
  for (const code of ordered) {
    if (report.framesUsed >= budget) break;
    if (report.inert.includes(code)) continue;
    if (await sweep(code, SIDE_SWEEP_FRAMES, true)) return finish(true);
  }
  return report;
}
