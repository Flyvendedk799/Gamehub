/**
 * may9 Phase 9 — genre playtest playbooks.
 *
 * The brawler `c44763af…` run shipped a sign error (rotation.y =
 * -playerAngle) through three snapshots because nobody asserted that
 * pressing D actually moved the player toward +x. Phase 4's spec gate
 * captures `genre`; this module turns that genre into a canonical
 * input → state assertion list the agent can hand to `playtest_game`.
 *
 * The playbooks below are deliberately small (≤ 12 steps each) and
 * generic across engines. They cover the empirically-broken cases:
 *
 *   - fighting   — lateral move + attack + opponent damage
 *   - fps        — pointer-lock acquire + mousemove yaw delta
 *   - platformer — jump → y rises → land → y stable
 *   - puzzle     — drag/swap → grid permutation
 *   - topdown    — cardinal moves → x/y deltas
 *   - runner     — auto-forward + jump → y delta only
 *   - shmup      — fire → score rises (hit loop) + lateral move
 *   - racing     — accelerate → speed rises + steer → x delta
 *   - rpg        — cardinal moves → x/y deltas
 *   - roguelike  — grid steps → x/y deltas
 *   - tps        — strafe → x delta + forward → z delta
 *   - tower_defense — enemies spawn + advance + waves escalate; place tower → kill
 *
 * The agent reads `getPlaytestPlaybook(genre)` and adapts the keycodes
 * + assertions to its own input bindings. The host's `playtest_game`
 * stays generic — it just dispatches the steps and reads back
 * `window.__game.debug.snapshot()` between them.
 */
import type { GameGenre } from '@playforge/shared';
import type { PlaytestPredicate } from './eval/playtest-score.js';

/** A single recommended playtest step in the same shape as the
 *  `playtest_game` tool's `Step` discriminated union. We re-encode here
 *  rather than importing the TypeBox schema so consumers (renderer,
 *  docs, future eval harness) don't pull TypeBox transitively. */
export interface PlaybookStep {
  kind: 'key' | 'mouse' | 'wait';
  /** For 'key': DOM KeyboardEvent.code. */
  code?: string;
  /** For 'key' / 'mouse': how many RAF frames to hold. */
  frames?: number;
  /** For 'mouse': pointer-lock relative-delta. */
  movementX?: number;
  movementY?: number;
  /** For 'mouse': button index (0=left, 2=right). Default 0. */
  button?: number;
  /** For 'wait': how many RAF frames to advance with no input. */
  durationFrames?: number;
  /** Human-readable assertion the agent should evaluate against the
   *  snapshot returned by playtest_game AFTER this step. Free-form so
   *  per-engine state shapes don't constrain the playbook. */
  assert?: string;
  /** Phase 5.4 — MACHINE-CHECKABLE predicates that promote the free-form
   *  `assert` above into something a pure evaluator (`scorePlaytest`) can
   *  check DETERMINISTICALLY, no LLM. These reference snapshot fields by
   *  dotted path and a frame index into the trace; the agent maps its
   *  own debug-snapshot shape onto the named fields. The deferred
   *  boot-and-repair loop (#1.6) gates on these. Frames here are relative
   *  to the playbook's own step ordering (the harness wires the absolute
   *  trace indices). When omitted, only the English `assert` applies. */
  predicates?: ReadonlyArray<PlaytestPredicate>;
}

export interface PlaytestPlaybook {
  schemaVersion: 1;
  genre: GameGenre;
  /** One sentence on what this playbook proves. Surfaced to the agent
   *  in the result text so it understands the shape of the test. */
  intent: string;
  steps: PlaybookStep[];
  /** Free-form notes on common mismatches the agent should watch for. */
  watchFor: string[];
}

const PLATFORMER: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'platformer',
  intent:
    'Jump arc: pressing the jump key raises the player y, then gravity returns y to a ground-stable value.',
  steps: [
    { kind: 'wait', durationFrames: 30, assert: 'Player is on ground; y is stable.' },
    {
      kind: 'key',
      code: 'Space',
      frames: 5,
      assert: 'Player y is RISING (jump initiated).',
      // World-up varies by engine: many 2D engines treat y-up as a
      // DECREASE in screen-space. The playbook asserts the y CHANGED on
      // jump; the agent picks increased/decreased for its coordinate
      // system. `changed` is the engine-agnostic floor that still catches
      // a no-op jump (y never moves).
      predicates: [
        { field: 'playerPos.y', op: 'changed', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    { kind: 'wait', durationFrames: 30, assert: 'Player y peaks then descends.' },
    {
      kind: 'wait',
      durationFrames: 60,
      assert: 'Player is back on ground; y matches the pre-jump value within ±1.',
      predicates: [
        {
          field: 'playerPos.y',
          op: 'unchanged',
          frame: { step: 3 },
          against: { step: 0 },
          epsilon: 1,
        },
      ],
    },
  ],
  watchFor: [
    'No gravity (player floats after jump).',
    'No max-jump-height (key held forever -> y unbounded).',
    'Landing inside a platform (y goes below ground level).',
  ],
};

const FIGHTING: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'fighting',
  intent:
    'Lateral movement + attack: pressing right increases x, pressing the attack key reduces opponent HP.',
  steps: [
    {
      kind: 'key',
      code: 'KeyD',
      frames: 30,
      assert: 'Player x is INCREASING (rightward).',
      predicates: [
        { field: 'playerPos.x', op: 'increased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
    {
      kind: 'key',
      code: 'KeyA',
      frames: 30,
      assert: 'Player x is DECREASING (leftward).',
      predicates: [
        { field: 'playerPos.x', op: 'decreased', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    {
      kind: 'wait',
      durationFrames: 10,
      assert: 'Player is within striking range (close to opponent).',
    },
    {
      kind: 'key',
      code: 'KeyJ',
      frames: 5,
      assert: 'Attack animation triggered; opponent HP DECREASED by > 0 within 30 frames.',
      predicates: [
        { field: 'opponentHp', op: 'decreased', frame: { step: 3 }, against: { step: 2 } },
      ],
    },
  ],
  watchFor: [
    'Lateral keys reversed (pressing D moves left): the c44763af sign-error class.',
    'Attack registers on enemy AT or PAST player position (hitbox sign error).',
    'Lead-vs-rear hand confusion: both attacks should fire forward, not toward keypress side.',
  ],
};

const FPS: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'fps',
  intent:
    'Pointer-lock + look: clicking the canvas acquires lock, mouse movementX rotates the camera yaw.',
  steps: [
    {
      kind: 'mouse',
      button: 0,
      assert: 'Pointer lock acquired (document.pointerLockElement === canvas).',
    },
    {
      kind: 'mouse',
      movementX: 50,
      movementY: 0,
      assert: 'Camera yaw INCREASED (positive movementX → +yaw).',
    },
    {
      kind: 'mouse',
      movementX: -100,
      movementY: 0,
      assert: 'Camera yaw DECREASED below the prior value.',
    },
    {
      kind: 'key',
      code: 'KeyW',
      frames: 30,
      assert: 'Player position moved FORWARD along camera basis (not world +z).',
      // Plan step 3 — the one universal, unambiguous FPS check: holding forward
      // MOVES the player. Forward = -z by the Three default-camera convention the
      // three-engine guide pins (`playerPos` tracked, "verified to CHANGE on WASD").
      // This alone makes hasPredicates=true so fps no longer ships no_verdict. Yaw
      // stays an English assert until step 9's synthetic pointer-lock makes a
      // cameraYaw predicate testable WITHOUT the strafe-vs-turn ambiguity of keys.
      predicates: [
        { field: 'playerPos.z', op: 'changed', frame: { step: 3 }, against: 'baseline' },
      ],
    },
  ],
  watchFor: [
    'Pointer-lock SecurityError on rapid re-acquire — engine guides require 1.25 s cooldown after Esc.',
    'WASD moves world-axis instead of camera-relative axis.',
    'movementX inverted (look right → camera yaws left).',
  ],
};

const PUZZLE: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'puzzle',
  intent:
    'Tile interaction: clicking adjacent tiles swaps their grid positions; matches clear from the grid.',
  steps: [
    {
      kind: 'mouse',
      button: 0,
      assert: 'A tile becomes selected (highlight visible OR state.selected non-null).',
    },
    {
      kind: 'mouse',
      button: 0,
      assert: 'Selected tile swapped with the clicked-adjacent tile (grid permuted).',
    },
    {
      kind: 'wait',
      durationFrames: 60,
      assert:
        'If the swap completed a match, those tiles cleared from the grid AND the score increased.',
    },
  ],
  watchFor: [
    'Match detection only checks one axis (rows but not columns or vice versa).',
    'Score never increments (the score is decorative).',
    'Tiles overlap after swap (rendering layer issue).',
  ],
};

const TOPDOWN: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'topdown_arcade',
  intent: 'Cardinal movement: WASD keys map to N/W/S/E movement deltas in screen-relative axes.',
  steps: [
    {
      kind: 'key',
      code: 'KeyW',
      frames: 20,
      assert: 'Player y DECREASED (north / up the screen).',
      predicates: [
        { field: 'playerPos.y', op: 'decreased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
    {
      kind: 'key',
      code: 'KeyS',
      frames: 20,
      assert: 'Player y INCREASED (south / down the screen).',
      predicates: [
        { field: 'playerPos.y', op: 'increased', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    {
      kind: 'key',
      code: 'KeyA',
      frames: 20,
      assert: 'Player x DECREASED (west / left).',
      predicates: [
        { field: 'playerPos.x', op: 'decreased', frame: { step: 2 }, against: { step: 1 } },
      ],
    },
    {
      kind: 'key',
      code: 'KeyD',
      frames: 20,
      assert: 'Player x INCREASED (east / right).',
      predicates: [
        { field: 'playerPos.x', op: 'increased', frame: { step: 3 }, against: { step: 2 } },
      ],
    },
  ],
  watchFor: [
    'World y-axis flipped (W moves player down because the engine uses screen-coord y).',
    'Diagonal movement is faster than cardinal (no normalization on the input vector).',
  ],
};

const RUNNER: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'runner',
  intent:
    'Endless-runner: player auto-advances along the run axis; jump key affects only y, never the run axis. Expose `score` (distance/survival) and `playerPos` in window.__game.debug.snapshot().',
  steps: [
    {
      kind: 'wait',
      durationFrames: 60,
      assert: 'Distance accrued automatically with no input — `score` INCREASED.',
      // v2 P6 — RUNNER previously shipped ZERO predicates → hasPredicates=false →
      // no_verdict (the faller probe). Distance-as-score is the universal runner
      // signal; the jump step proves input affects y.
      predicates: [{ field: 'score', op: 'increased', frame: { step: 0 }, against: 'baseline' }],
    },
    {
      kind: 'key',
      code: 'Space',
      frames: 5,
      assert: 'Jump moved the player on the vertical axis — `playerPos.y` CHANGED.',
      predicates: [
        { field: 'playerPos.y', op: 'changed', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
  ],
  watchFor: [
    'Jump pauses the run axis (player x stops advancing while in the air).',
    'No floor collision — player falls forever on landing.',
  ],
};

const SHMUP: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'shmup',
  intent:
    'Shoot-em-up: firing spawns projectiles that destroy enemies (score rises); lateral keys move the ship in x. Expose `score` and `playerPos.x` in debug.snapshot().',
  steps: [
    { kind: 'wait', durationFrames: 20, assert: 'Ship at spawn; a wave of enemies is on screen.' },
    {
      kind: 'key',
      code: 'Space',
      frames: 60,
      assert:
        'Holding fire from the spawn position spawns projectiles travelling toward the enemies.',
    },
    {
      kind: 'wait',
      durationFrames: 90,
      // The keystone: proves the WHOLE shoot→travel→collide→score loop, not just
      // that a bullet sprite appeared. This is the "bullets never hit enemies"
      // bug class (score stays 0 forever) made deterministic.
      assert: 'A projectile hit an enemy: `score` INCREASED — the core fire→hit→score loop works.',
      predicates: [{ field: 'score', op: 'increased', frame: { step: 2 }, against: { step: 0 } }],
    },
    {
      kind: 'key',
      code: 'ArrowLeft',
      frames: 20,
      assert: 'Ship x DECREASED (moved left).',
      predicates: [
        { field: 'playerPos.x', op: 'decreased', frame: { step: 3 }, against: { step: 2 } },
      ],
    },
    {
      kind: 'key',
      code: 'ArrowRight',
      frames: 30,
      assert: 'Ship x INCREASED past the left position (moved right).',
      predicates: [
        { field: 'playerPos.x', op: 'increased', frame: { step: 4 }, against: { step: 3 } },
      ],
    },
  ],
  watchFor: [
    'Bullets spawn but never collide with enemies (score never rises) — the most common shmup bug.',
    'Fire key does nothing (no projectile on press).',
    'Enemies cannot damage the player (lives never change).',
  ],
};

const RACING: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'racing',
  intent:
    'Racing: accelerating raises `speed`; steering changes the lateral `playerPos.x`. Expose `speed` and `playerPos.x` in debug.snapshot().',
  steps: [
    { kind: 'wait', durationFrames: 20, assert: 'Car at the start line, idle (speed ~0).' },
    {
      kind: 'key',
      code: 'ArrowUp',
      frames: 40,
      assert: 'Accelerating raised `speed` above the idle value.',
      predicates: [{ field: 'speed', op: 'increased', frame: { step: 1 }, against: { step: 0 } }],
    },
    {
      kind: 'key',
      code: 'ArrowLeft',
      frames: 20,
      assert: 'Steering left changed the car x position.',
      predicates: [
        { field: 'playerPos.x', op: 'changed', frame: { step: 2 }, against: { step: 1 } },
      ],
    },
    {
      kind: 'key',
      code: 'ArrowRight',
      frames: 30,
      assert: 'Steering right moved x the other way.',
      predicates: [
        { field: 'playerPos.x', op: 'changed', frame: { step: 3 }, against: { step: 2 } },
      ],
    },
  ],
  watchFor: [
    'Accelerate does nothing (speed stays 0, the car never moves).',
    'Steering rotates the sprite but never changes lateral position.',
    'No sense of forward motion / the track never scrolls.',
  ],
};

const RPG: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'rpg',
  intent:
    'RPG overworld: WASD moves the character in the four cardinal directions. Expose `playerPos.x` / `playerPos.y`.',
  steps: [
    {
      kind: 'key',
      code: 'KeyW',
      frames: 20,
      assert: 'Player y DECREASED (north/up).',
      predicates: [
        { field: 'playerPos.y', op: 'decreased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
    {
      kind: 'key',
      code: 'KeyS',
      frames: 20,
      assert: 'Player y INCREASED (south/down).',
      predicates: [
        { field: 'playerPos.y', op: 'increased', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    {
      kind: 'key',
      code: 'KeyD',
      frames: 20,
      assert: 'Player x INCREASED (east/right).',
      predicates: [
        { field: 'playerPos.x', op: 'increased', frame: { step: 2 }, against: { step: 1 } },
      ],
    },
  ],
  watchFor: [
    'Movement keys do nothing (the character is decorative).',
    'Player walks through walls / collisions never block movement.',
  ],
};

const ROGUELIKE: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'roguelike',
  intent:
    'Roguelike: movement keys step the player across the grid in x/y. Expose `playerPos.x` / `playerPos.y`.',
  steps: [
    {
      kind: 'key',
      code: 'KeyD',
      frames: 20,
      assert: 'Player x INCREASED (stepped east).',
      predicates: [
        { field: 'playerPos.x', op: 'increased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
    {
      kind: 'key',
      code: 'KeyW',
      frames: 20,
      assert: 'Player y DECREASED (stepped north).',
      predicates: [
        { field: 'playerPos.y', op: 'decreased', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    {
      kind: 'key',
      code: 'KeyA',
      frames: 20,
      assert: 'Player x DECREASED (stepped west).',
      predicates: [
        { field: 'playerPos.x', op: 'decreased', frame: { step: 2 }, against: { step: 1 } },
      ],
    },
  ],
  watchFor: ['Movement keys do nothing.', 'Player steps onto/through walls (no grid collision).'],
};

const TPS: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'tps',
  intent:
    'Third-person: strafe keys change `playerPos.x`, forward moves `playerPos.z`. Expose `playerPos.x` / `playerPos.z`.',
  steps: [
    {
      kind: 'key',
      code: 'KeyD',
      frames: 30,
      assert: 'Strafe right: player x INCREASED.',
      predicates: [
        { field: 'playerPos.x', op: 'increased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
    {
      kind: 'key',
      code: 'KeyA',
      frames: 30,
      assert: 'Strafe left: player x DECREASED back.',
      predicates: [
        { field: 'playerPos.x', op: 'decreased', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    {
      kind: 'key',
      code: 'KeyW',
      frames: 30,
      assert: 'Forward: player z CHANGED (moved along the forward axis).',
      predicates: [
        { field: 'playerPos.z', op: 'changed', frame: { step: 2 }, against: { step: 1 } },
      ],
    },
  ],
  watchFor: ['WASD does nothing (player frozen).', 'Camera moves but the character never does.'],
};

const TOWER_DEFENSE: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'tower_defense',
  intent:
    'Tower defense: enemies spawn and advance along a path toward your base; you click buildable tiles to place towers (money drops) that auto-fire and kill advancing enemies (score/kills rise); waves escalate in count/speed/HP. Expose `enemiesAlive`, `towers`, `money`, `lives`, `wave`, and `score` (or `kills`) in window.__game.debug.snapshot(). Adapt the click position in step 2 to a buildable tile in YOUR map.',
  steps: [
    {
      kind: 'wait',
      durationFrames: 40,
      assert: 'Enemies spawn from the path entrance and begin advancing toward the base.',
      predicates: [
        { field: 'enemiesAlive', op: 'increased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
    {
      kind: 'mouse',
      button: 0,
      assert:
        'Moving to a buildable tile and clicking places a tower: `towers` INCREASED and `money` DECREASED. (Translate to mouseMove(tileX,tileY)+mouseDown+mouseUp at a valid tile in your layout.)',
      predicates: [{ field: 'towers', op: 'increased', frame: { step: 1 }, against: { step: 0 } }],
    },
    {
      kind: 'wait',
      durationFrames: 120,
      // The keystone: proves the place→fire→kill→score loop, the "towers never
      // actually kill anything" bug class made deterministic.
      assert:
        'A placed tower auto-fired and killed an advancing enemy — `score` rose (use `kills` if that is your field).',
      predicates: [{ field: 'score', op: 'increased', frame: { step: 2 }, against: { step: 1 } }],
    },
    {
      kind: 'wait',
      durationFrames: 200,
      assert:
        'Pressure escalates — the next wave starts with more/faster/tougher enemies (`wave` advanced).',
      predicates: [{ field: 'wave', op: 'increased', frame: { step: 3 }, against: 'baseline' }],
    },
  ],
  watchFor: [
    'Enemies spawn but never path to the base — there is no threat and `lives` is never at risk.',
    'Towers place but never fire or never kill — `score`/`kills` stay 0 (the core loop is broken).',
    'Clicking does nothing — no tower placed, `money` never spent.',
    'Every wave is identical — difficulty never rises, so it reads as a tech demo, not a game.',
  ],
};

// v2 P6 — backfill the no-playbook genres that shipped no_verdict in the data
// (visual_novel, rhythm, idle, sandbox). Each carries machine-checkable
// predicates so the genre reaches a real pass/fail instead of shipping unverified.

const VISUAL_NOVEL: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'visual_novel',
  intent:
    'Visual novel: advancing dialogue increments the line/node index; choices change the route/flags. The verdict reads the EXACT field `dialogueIndex` — wire it at startup: `window.__game.debug.track({ dialogueIndex: () => currentLineIndex, choiceCount: () => choicesMade })` (a snapshot exposing only `dialogOpen`/`isOpen` reports "field missing" → 0/2). Adapt the advance binding to a click if your VN advances on click.',
  steps: [
    { kind: 'wait', durationFrames: 20, assert: 'The first line of dialogue is shown.' },
    {
      kind: 'key',
      code: 'Space',
      frames: 5,
      assert: 'Pressing advance moves to the next line — `dialogueIndex` INCREASED.',
      predicates: [
        { field: 'dialogueIndex', op: 'increased', frame: { step: 1 }, against: { step: 0 } },
      ],
    },
    {
      kind: 'key',
      code: 'Enter',
      frames: 5,
      assert: 'Advancing again continues the script — `dialogueIndex` keeps rising.',
      predicates: [
        { field: 'dialogueIndex', op: 'increased', frame: { step: 2 }, against: { step: 1 } },
      ],
    },
  ],
  watchFor: [
    'Advance does nothing — dialogueIndex frozen (the script is not wired).',
    'Choices do not branch — route/flags never change.',
  ],
};

const RHYTHM: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'rhythm',
  intent:
    'Rhythm: notes scroll to a hit line; pressing the correct lane key as a note arrives scores a hit (score/combo rise); a miss breaks the combo. Expose `score` and `combo` in window.__game.debug.snapshot().',
  steps: [
    { kind: 'wait', durationFrames: 30, assert: 'Notes are scrolling toward the hit line.' },
    {
      kind: 'key',
      code: 'KeyJ',
      frames: 90,
      assert:
        'Tapping a lane key over a window registers hits — `score` INCREASED. (Adapt the key to one of your lanes; the long window tolerates timing.)',
      predicates: [{ field: 'score', op: 'increased', frame: { step: 1 }, against: { step: 0 } }],
    },
  ],
  watchFor: [
    'Lane keys never score — note/hit detection is not wired.',
    'Score rises with NO key press — autoplay, not input-driven.',
  ],
};

const IDLE: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'idle',
  intent:
    'Idle/incremental: clicking the main earner increases currency; buying a producer raises the per-second rate. The verdict reads the EXACT field `credits` (NOT `score`/`money`/`balance` — the resolver does no aliasing, so a differently-named field reports "field missing"). Wire it at startup: `window.__game.debug.track({ credits: () => credits, rate: () => perSecond })`.',
  steps: [
    {
      kind: 'mouse',
      button: 0,
      assert:
        'Clicking the main earner increases currency — `credits` INCREASED. (Translate to mouseMove to your button + mouseDown/up.)',
      predicates: [{ field: 'credits', op: 'increased', frame: { step: 0 }, against: 'baseline' }],
    },
    {
      kind: 'wait',
      durationFrames: 180,
      assert: 'Currency keeps accruing from passive producers (if any were bought).',
    },
  ],
  watchFor: [
    'Clicking does nothing — credits never rise (the core earn loop is broken).',
    'No way to spend / no producers — a pure number with no decisions.',
  ],
};

const SANDBOX: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'sandbox',
  intent:
    'Physics sandbox / toy: the player spawns or places objects with the mouse; the object count rises and physics acts on them. Expose `entityCount` (or `objects`) in window.__game.debug.snapshot().',
  steps: [
    {
      kind: 'mouse',
      button: 0,
      assert:
        'Clicking spawns/places an object — `entityCount` INCREASED. (Translate to mouseMove + mouseDown/up at a spawn point.)',
      predicates: [
        { field: 'entityCount', op: 'increased', frame: { step: 0 }, against: 'baseline' },
      ],
    },
  ],
  watchFor: [
    'Clicking spawns nothing — entityCount stays flat.',
    'Spawned objects are static — gravity/physics never act (a placement grid, not a sandbox).',
  ],
};

// Plan step 4 — the genre run2 was actually about (3D collect-em-up), previously
// force-fit to `fps` (the worst-covered genre) and shipped NO_VERDICT. The GATING
// predicate is the safe, universal one — forward input MOVES the player (forward =
// -z by the three-engine-guide convention). The core loop (count rises on pickup)
// stays an English assert because blind synthetic movement can't be guaranteed to
// reach a pickup; the universal interactivity floor (step 5) backs it.
const COLLECTATHON: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'collectathon',
  intent:
    'Explore + collect: moving the player into pickups raises a collected count / score; reaching the target wins. Expose `playerPos` and `score` (or `itemsCollected`) in window.__game.debug.track().',
  steps: [
    {
      kind: 'wait',
      durationFrames: 30,
      assert: 'Game booted; player + at least one pickup are present.',
    },
    {
      kind: 'key',
      code: 'KeyW',
      frames: 40,
      assert: 'Holding forward MOVES the player through the world (toward pickups).',
      predicates: [
        { field: 'playerPos.z', op: 'changed', frame: { step: 1 }, against: 'baseline' },
      ],
    },
    {
      kind: 'wait',
      durationFrames: 60,
      assert:
        'When the player overlaps a pickup, `itemsCollected`/`score` INCREASES and that pickup disappears; reaching the target count shows a win screen.',
    },
  ],
  watchFor: [
    'Collected count is decorative — never increases on overlap.',
    'Pickups have no overlap/collision test (the player passes through them).',
    'No win condition when the target count is reached.',
  ],
};

const PLAYBOOKS: Partial<Record<GameGenre, PlaytestPlaybook>> = {
  collectathon: COLLECTATHON,
  platformer: PLATFORMER,
  fighting: FIGHTING,
  fps: FPS,
  puzzle: PUZZLE,
  topdown_arcade: TOPDOWN,
  runner: RUNNER,
  shmup: SHMUP,
  racing: RACING,
  rpg: RPG,
  roguelike: ROGUELIKE,
  tps: TPS,
  tower_defense: TOWER_DEFENSE,
  visual_novel: VISUAL_NOVEL,
  rhythm: RHYTHM,
  idle: IDLE,
  sandbox: SANDBOX,
};

/** Return the canonical playbook for a genre, or null when no
 *  playbook is bundled yet. The agent can fall back to its own
 *  improvised step list. */
export function getPlaytestPlaybook(genre: GameGenre): PlaytestPlaybook | null {
  return PLAYBOOKS[genre] ?? null;
}

/** List the genres that ship a built-in playbook. Used by the
 *  `get_playtest_playbook` tool's description so the agent knows what's
 *  available without trial-and-error. */
export function listSupportedGenres(): GameGenre[] {
  return Object.keys(PLAYBOOKS) as GameGenre[];
}
