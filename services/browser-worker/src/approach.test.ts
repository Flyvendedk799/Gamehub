import { describe, expect, it } from 'vitest';
import {
  APPROACH_DEFAULT_FRAMES,
  APPROACH_MAX_FRAMES,
  APPROACH_MIN_FRAMES,
  type ApproachIo,
  type ApproachStep,
  approachBudget,
  distanceBetween,
  gameEnded,
  movementKeys,
  opponentPlanar,
  planarOf,
  playerPlanar,
  readNumber,
  runApproach,
  strikeKey,
} from './approach';

/** The manifest the shipped duel from run a985c47a declared. */
const DUEL = {
  actions: [
    { id: 'forward', label: 'Step Forward', keys: ['KeyW', 'ArrowUp'] },
    { id: 'backward', label: 'Step Back', keys: ['KeyS', 'ArrowDown'] },
    { id: 'stepLeft', label: 'Dodge Left', keys: ['KeyA', 'ArrowLeft'] },
    { id: 'stepRight', label: 'Dodge Right', keys: ['KeyD', 'ArrowRight'] },
    { id: 'light', label: 'Light Attack', keys: ['KeyJ', 'Mouse0'] },
    { id: 'heavy', label: 'Heavy Attack', keys: ['KeyK'] },
    { id: 'block', label: 'Block', keys: ['KeyL', 'Mouse2'] },
    { id: 'parry', label: 'Parry', keys: ['Space'] },
  ],
};

const STEP: ApproachStep = { kind: 'approach', watch: 'opponentHp' };

interface WorldOptions {
  /** World-plane direction each key walks: [dx, dz] per frame at speed 1. */
  dirs: Record<string, [number, number]>;
  opponent: [number, number];
  reach?: number;
  speed?: number;
  /** The arena wall: the player cannot leave [-bound, bound] on either axis. */
  bound?: number;
  /** The snapshot carries `opponentPos`. */
  exposeOpponent?: boolean;
  /** The snapshot carries no `playerPos`. */
  hidePlayer?: boolean;
  /** An empty snapshot: nothing to read at all. */
  empty?: boolean;
  /** The opponent walks toward the player whenever a key is pressed (an AI that closes in). */
  approaches?: boolean;
}

/** A tiny duel: a player that walks where the keys say, an opponent, and a strike with a reach. */
function makeWorld(o: WorldOptions) {
  let x = 0;
  let z = 0;
  let hp = 100;
  let ox = o.opponent[0];
  let oz = o.opponent[1];
  const reach = o.reach ?? 0.8;
  const speed = o.speed ?? 0.05;
  const bound = o.bound ?? 50;
  const log: Array<{ code: string; frames: number }> = [];
  const clamp = (v: number): number => Math.max(-bound, Math.min(bound, v));
  const dist = (): number => Math.hypot(x - ox, z - oz);
  const io: ApproachIo = {
    async press(code, frames) {
      log.push({ code, frames });
      const d = o.dirs[code];
      if (d !== undefined) {
        x = clamp(x + d[0] * speed * frames);
        z = clamp(z + d[1] * speed * frames);
      }
      if (o.approaches === true) {
        const gap = dist();
        const step = Math.min(gap - reach * 0.5, speed * frames * 0.8);
        if (step > 0) {
          ox += ((x - ox) / gap) * step;
          oz += ((z - oz) / gap) * step;
        }
      }
      if (code === 'KeyJ' && dist() <= reach) hp -= 10;
    },
    async click() {
      log.push({ code: 'click', frames: 2 });
    },
    async snapshot() {
      if (o.empty === true) return {};
      return {
        opponentHp: hp,
        ...(o.hidePlayer === true ? {} : { playerPos: { x, y: 0, z } }),
        ...(o.exposeOpponent === true ? { opponentPos: { x: ox, y: 0, z: oz } } : {}),
      };
    },
  };
  return { io, log, state: () => ({ x, z, hp, dist: dist() }) };
}

/** W walks into the screen, S out of it, A and D walk left and right: a classic third-person duel. */
const BEHIND_THE_SHOULDER: Record<string, [number, number]> = {
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};
/** Side-on: W and S only move in depth, and the opponent stands off to the side. */
const SIDE_ON = BEHIND_THE_SHOULDER;

describe('reading the snapshot', () => {
  it('reads numbers at dotted and indexed paths, and nothing else', () => {
    const snap = { opponentHp: 80, fighters: [{ hp: 7 }], nested: { a: { b: 3 } }, text: 'x' };
    expect(readNumber(snap, 'opponentHp')).toBe(80);
    expect(readNumber(snap, 'fighters[0].hp')).toBe(7);
    expect(readNumber(snap, 'nested.a.b')).toBe(3);
    expect(readNumber(snap, 'text')).toBeNull();
    expect(readNumber(snap, 'missing.path')).toBeNull();
    expect(readNumber(null, 'opponentHp')).toBeNull();
    expect(readNumber({ hp: Number.NaN }, 'hp')).toBeNull();
  });

  it('places things on the ground plane: (x, z) in 3D, (x, y) in 2D', () => {
    expect(planarOf({ x: 1, y: 9, z: 2 })).toEqual({ a: 1, b: 2 });
    expect(planarOf({ x: 1, y: 2 })).toEqual({ a: 1, b: 2 });
    expect(planarOf([1, 9, 2])).toEqual({ a: 1, b: 2 });
    expect(planarOf([1, 2])).toEqual({ a: 1, b: 2 });
    expect(planarOf({ y: 2 })).toBeNull();
    expect(planarOf('nope')).toBeNull();
    expect(planarOf(null)).toBeNull();
  });

  it('finds the opponent wherever a game puts it, and says so when it is not exposed', () => {
    expect(opponentPlanar({ opponentPos: { x: 1, z: 2 } })).toEqual({ a: 1, b: 2 });
    expect(opponentPlanar({ enemyPosition: [1, 0, 2] })).toEqual({ a: 1, b: 2 });
    expect(opponentPlanar({ opponent: { x: 1, z: 2 } })).toEqual({ a: 1, b: 2 });
    expect(opponentPlanar({ opponent: { hp: 5, pos: { x: 1, z: 2 } } })).toEqual({ a: 1, b: 2 });
    expect(
      opponentPlanar({
        enemies: [
          { x: 1, z: 2 },
          { x: 9, z: 9 },
        ],
      }),
    ).toEqual({ a: 1, b: 2 });
    expect(opponentPlanar({ enemies: [{ position: { x: 1, z: 2 } }] })).toEqual({ a: 1, b: 2 });
    // What the shipped duels actually expose: no opponent position at all.
    expect(opponentPlanar({ opponentHp: 100, playerPos: { x: 0, y: 0, z: 3.8 } })).toBeNull();
    expect(opponentPlanar(null)).toBeNull();
  });

  it('finds the player, and measures the gap only when both are known', () => {
    expect(playerPlanar({ playerPos: { x: 1, y: 0, z: 2 } })).toEqual({ a: 1, b: 2 });
    expect(playerPlanar({ player: { pos: { x: 1, z: 2 } } })).toEqual({ a: 1, b: 2 });
    expect(playerPlanar({})).toBeNull();
    expect(distanceBetween({ playerPos: { x: 0, z: 0 }, opponentPos: { x: 3, z: 4 } })).toBe(5);
    expect(distanceBetween({ playerPos: { x: 0, z: 0 } })).toBeNull();
  });
});

describe('choosing keys', () => {
  it('searches with the keys the game declared, forward first, attacks and blocks excluded', () => {
    const { keys, backward } = movementKeys(DUEL);
    expect(keys).toEqual(['KeyW', 'KeyS', 'KeyA', 'KeyD']);
    expect([...backward]).toEqual(['KeyS']);
    expect(strikeKey(DUEL)).toBe('KeyJ');
  });

  it('counts a lateral step labelled "Dodge Left" as movement, and a bare dodge as not', () => {
    const { keys } = movementKeys({
      actions: [
        { id: 'fwd', label: 'Advance', keys: ['KeyI'] },
        { id: 'sl', label: 'Dodge Left', keys: ['KeyJ'] },
        { id: 'dodge', label: 'Roll', keys: ['KeyU'] },
        { id: 'special', label: 'Special move', keys: ['KeyO'] },
      ],
    });
    expect(keys).toEqual(['KeyI', 'KeyJ']);
  });

  it('falls back to WASD and the arrows when the game declares too little', () => {
    const { keys, backward } = movementKeys(null);
    expect(keys).toContain('KeyW');
    expect(keys).toContain('ArrowLeft');
    expect(keys[0]).toBe('KeyW');
    expect(backward.has('KeyS')).toBe(true);
    expect(movementKeys({ actions: 'garbage' }).keys.length).toBeGreaterThan(1);
    expect(strikeKey(null)).toBe('KeyJ');
  });

  it('clamps the frame budget', () => {
    expect(approachBudget(STEP)).toBe(APPROACH_DEFAULT_FRAMES);
    expect(approachBudget({ ...STEP, frames: 5 })).toBe(APPROACH_MIN_FRAMES);
    expect(approachBudget({ ...STEP, frames: 99999 })).toBe(APPROACH_MAX_FRAMES);
    expect(approachBudget({ ...STEP, frames: 200 })).toBe(200);
  });
});

describe('closing in, whatever the camera', () => {
  it('walks forward and lands the strike when forward IS the way (the old playbook case)', async () => {
    const world = makeWorld({ dirs: BEHIND_THE_SHOULDER, opponent: [0, -3], speed: 0.04 });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('outcome');
    expect(report.hit).toBe(true);
    expect(report.tried[0]).toBe('KeyW');
    expect(world.state().hp).toBeLessThan(100);
    // It found the opponent on the forward walk, well inside the budget.
    expect(report.framesUsed).toBeLessThan(APPROACH_DEFAULT_FRAMES);
  });

  it('finds an opponent standing off to the side of a side-on camera (run 98e9cf12)', async () => {
    // W only walks into the depth of the arena. The opponent is at the right of the screen, and
    // the game exposes no opponent position, so the step has to search by result.
    const world = makeWorld({ dirs: SIDE_ON, opponent: [1.6, 0], speed: 0.08 });
    // A motionless opponent off to one side is the slowest case to find by swinging, so it gets
    // the largest budget the step allows.
    const report = await runApproach(world.io, { ...STEP, frames: APPROACH_MAX_FRAMES }, DUEL);
    expect(report.hit).toBe(true);
    expect(world.state().hp).toBeLessThan(100);
    expect(report.tried).toContain('KeyD');
    expect(report.framesUsed).toBeLessThanOrEqual(APPROACH_MAX_FRAMES + 60);
  });

  it('finds an opponent to the LEFT just as well', async () => {
    const world = makeWorld({ dirs: SIDE_ON, opponent: [-1.6, 0], speed: 0.08 });
    const report = await runApproach(world.io, { ...STEP, frames: APPROACH_MAX_FRAMES }, DUEL);
    expect(report.hit).toBe(true);
    expect(report.tried).toContain('KeyA');
  });

  it('cannot find a distant, motionless opponent without a position, and stays inside its budget', async () => {
    // The honest limit of searching by result inside the server's frame budget. Games that expose
    // `opponentPos` do not have it (the engine guide asks for it); this is the old-game fallback.
    const world = makeWorld({ dirs: SIDE_ON, opponent: [6, 0], speed: 0.04 });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('outcome');
    expect(report.hit).toBe(false);
    expect(report.framesUsed).toBeLessThanOrEqual(APPROACH_DEFAULT_FRAMES + 60);
  });

  it('finds that same distant opponent once the game exposes its position', async () => {
    const world = makeWorld({
      dirs: SIDE_ON,
      opponent: [6, 0],
      speed: 0.04,
      exposeOpponent: true,
    });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('distance');
    expect(world.state().dist).toBeLessThan(1);
  });

  it('is met halfway by an opponent that walks up to the player', async () => {
    const world = makeWorld({
      dirs: SIDE_ON,
      opponent: [3, 0],
      speed: 0.05,
      approaches: true,
    });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.hit).toBe(true);
    expect(world.state().hp).toBeLessThan(100);
  });

  it('hill-climbs on distance when the game exposes both positions, and does not wander', async () => {
    const world = makeWorld({
      dirs: SIDE_ON,
      opponent: [3, 0],
      speed: 0.08,
      exposeOpponent: true,
    });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('distance');
    // It closes in and swings until the opponent's HP drops: that is the step's whole job.
    expect(report.hit).toBe(true);
    expect(world.state().hp).toBeLessThan(100);
    // Far fewer frames than the blind search needs: it walked the one direction that helped.
    expect(report.framesUsed).toBeLessThan(200);
    expect(report.tried).toContain('KeyD');
  });

  it('reaches an opponent that is diagonal to the camera, using two keys', async () => {
    const world = makeWorld({
      dirs: SIDE_ON,
      opponent: [3, -3],
      speed: 0.08,
      exposeOpponent: true,
    });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('distance');
    expect(world.state().dist).toBeLessThan(1);
    expect(report.tried).toEqual(expect.arrayContaining(['KeyD', 'KeyW']));
  });

  it('does not write a slow game off as unresponsive while it takes fine steps', async () => {
    // 0.004 units a frame: a 2-frame step moves 0.008, below the movement threshold.
    const world = makeWorld({
      dirs: SIDE_ON,
      opponent: [1, 0],
      speed: 0.004,
      exposeOpponent: true,
    });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.inert).toEqual([]);
    expect(world.state().dist).toBeLessThan(0.5);
  });

  it('works out each key from what it did, so any camera mapping is fine', async () => {
    // A mirrored, rotated mapping nobody wrote a rule for: W goes right, D goes into the screen.
    const dirs: Record<string, [number, number]> = {
      KeyW: [1, 0],
      KeyS: [-1, 0],
      KeyA: [0, 1],
      KeyD: [0, -1],
    };
    const world = makeWorld({ dirs, opponent: [-2, 2], speed: 0.08, exposeOpponent: true });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('distance');
    expect(world.state().dist).toBeLessThan(1);
  });

  it('closes the gap in distance mode even when no strike is needed to know it worked', async () => {
    const world = makeWorld({
      dirs: SIDE_ON,
      opponent: [0, 4],
      speed: 0.1,
      exposeOpponent: true,
      reach: 0.01,
    });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('distance');
    expect(report.finalDistance).not.toBeNull();
    expect(report.finalDistance as number).toBeLessThan(1);
  });
});

describe('when nothing works', () => {
  it('drops keys that never move the player, and stops inside its budget', async () => {
    const world = makeWorld({ dirs: {}, opponent: [3, 0] });
    const report = await runApproach(world.io, { ...STEP, frames: 300 }, DUEL);
    expect(report.hit).toBe(false);
    // No key moves the player, however it is asked: every one ends up written off.
    expect(report.tried).toContain('KeyW');
    expect([...report.inert].sort()).toEqual(['KeyA', 'KeyD', 'KeyS', 'KeyW']);
    expect(report.framesUsed).toBeLessThanOrEqual(300 + 80);
  });

  it('stops inside its budget when the opponent can never be reached', async () => {
    const world = makeWorld({ dirs: SIDE_ON, opponent: [100, 100], bound: 5, speed: 0.1 });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.hit).toBe(false);
    expect(report.framesUsed).toBeLessThanOrEqual(APPROACH_MAX_FRAMES + 80);
  });

  it('honours a small budget', async () => {
    const world = makeWorld({ dirs: SIDE_ON, opponent: [100, 100], speed: 0.05 });
    const report = await runApproach(world.io, { ...STEP, frames: 100 }, DUEL);
    expect(report.hit).toBe(false);
    expect(report.framesUsed).toBeLessThanOrEqual(100 + 80);
  });

  it('holds forward for the legacy 130 frames when there is nothing to read', async () => {
    const world = makeWorld({ dirs: SIDE_ON, opponent: [3, 0], empty: true });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('none');
    expect(world.log).toEqual([{ code: 'KeyW', frames: 130 }]);
  });

  it('still searches by outcome when the game exposes no player position', async () => {
    const world = makeWorld({ dirs: SIDE_ON, opponent: [0, -3], speed: 0.04, hidePlayer: true });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.mode).toBe('outcome');
    expect(report.hit).toBe(true);
  });

  it('survives a manifest and snapshot full of garbage', async () => {
    const io: ApproachIo = {
      async press() {},
      async click() {},
      async snapshot() {
        return { opponentHp: 'a lot', playerPos: 'here', opponentPos: [null, undefined] };
      },
    };
    const report = await runApproach(io, STEP, {
      actions: [null, 7, { keys: 'KeyW' }, { id: {} }],
    });
    expect(report.hit).toBe(false);
    expect(report.mode).toBe('none');
  });
});

describe('when the round ends or the arena has walls', () => {
  it('knows when a game is over', () => {
    expect(gameEnded({ state: 'over' })).toBe(true);
    expect(gameEnded({ state: 'GAME_OVER' })).toBe(true);
    expect(gameEnded({ phase: 'victory' })).toBe(true);
    expect(gameEnded({ screen: 'dead' })).toBe(true);
    expect(gameEnded({ playerHp: 0 })).toBe(true);
    expect(gameEnded({ playerHp: -3 })).toBe(true);
    expect(gameEnded({ state: 'play', playerHp: 40 })).toBe(false);
    expect(gameEnded({ state: 'playing' })).toBe(false);
    expect(gameEnded({ opponentHp: 0 })).toBe(false);
    expect(gameEnded(null)).toBe(false);
    expect(gameEnded('over')).toBe(false);
  });

  it('stops the moment the player dies, instead of testing a dead game (run 1e896c13)', async () => {
    let frames = 0;
    const log: string[] = [];
    const io: ApproachIo = {
      async press(code, n) {
        log.push(code);
        frames += n;
      },
      async click() {},
      async snapshot() {
        // An opponent that kills the player after 40 frames of any input.
        return {
          opponentHp: 100,
          playerPos: { x: 0, y: 0, z: 0 },
          ...(frames >= 40 ? { state: 'over', playerHp: 0 } : { state: 'play', playerHp: 50 }),
        };
      },
    };
    const report = await runApproach(io, STEP, DUEL);
    expect(report.ended).toBe(true);
    expect(report.hit).toBe(false);
    // It did not go on pressing keys at a dead game, and it did not call the keys dead either.
    expect(report.framesUsed).toBeLessThanOrEqual(40 + 30);
    expect(report.inert).toEqual([]);
  });

  it('does nothing at all when the game is already over', async () => {
    const world = makeWorld({ dirs: SIDE_ON, opponent: [3, 0] });
    const over: ApproachIo = {
      ...world.io,
      async snapshot() {
        return { opponentHp: 100, state: 'over', playerPos: { x: 0, y: 0, z: 0 } };
      },
    };
    const report = await runApproach(over, STEP, DUEL);
    expect(report.ended).toBe(true);
    expect(report.framesUsed).toBe(0);
    expect(world.log).toEqual([]);
  });

  it('counts a strike that lands on the press that ended the round', async () => {
    let hp = 100;
    let frames = 0;
    const io: ApproachIo = {
      async press(code, n) {
        frames += n;
        if (code === 'KeyJ') hp = 0;
      },
      async click() {},
      async snapshot() {
        return {
          opponentHp: hp,
          playerPos: { x: frames * 0.01, y: 0, z: 0 },
          state: hp === 0 ? 'over' : 'play',
        };
      },
    };
    const report = await runApproach(io, STEP, DUEL);
    expect(report.hit).toBe(true);
    expect(report.ended).toBe(true);
  });

  it('does not write off keys that hit the arena wall: they work, they are just blocked', async () => {
    // A narrow arena: the player can step 0.3 either way and no further. Every key moves it once
    // and is then blocked, which is a wall and not a dead key.
    const world = makeWorld({ dirs: SIDE_ON, opponent: [100, 100], bound: 0.3, speed: 0.1 });
    const report = await runApproach(world.io, STEP, DUEL);
    expect(report.inert).toEqual([]);
    expect(report.hit).toBe(false);
  });
});
