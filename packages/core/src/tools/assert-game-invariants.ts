/**
 * gameplan §E2 — `assert_game_invariants` tool.
 *
 * Cross-engine static-analysis check for the design-level invariants every
 * game must hit: a restart binding, a fail state, score / state change,
 * and *some* feedback within the collision/hit handler. These cut across
 * engine boundaries, so we run pattern checks over the project's source
 * tree (.js / .ts / .html) instead of dispatching to per-engine
 * validators.
 *
 * v1 is intentionally pattern-based — fast, cheap, runs over the whole
 * file bundle. A real "play test" that ticks the game forward N frames
 * needs an iframe runtime to drive (Phase E follow-up); this tool buys
 * 80% of the value without that infrastructure.
 *
 * The agent is told to call this before `done` alongside
 * `validate_game_scene`. validate_game_scene catches engine-specific
 * structural foot-guns; assert_game_invariants catches game-design
 * gaps (e.g. shipped a Pong that has no way to lose).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { TextEditorFsCallbacks } from './text-editor.js';

/** Genre values match the spec-block menu in game-workflow.v1.txt §2. */
export const GAME_GENRES = [
  'brawler',
  'shooter',
  'platformer',
  'puzzle',
  'racer',
  'runner',
  'tower-defense',
  'survival',
  'rhythm',
  'other',
] as const;
export type GameGenre = (typeof GAME_GENRES)[number];

const AssertGameInvariantsParams = Type.Object({
  /** Genre token from the Mechanic spec block (Sequence 1). When set,
   *  the cross-engine pass adds genre-specific checks (e.g. brawler →
   *  combo + hitstop + visible limbs + aim/hitbox parity). Optional so
   *  the tool stays backward-compatible with the design-mode pre-`done`
   *  invariant pass. */
  genre: Type.Optional(
    Type.Union([
      Type.Literal('brawler'),
      Type.Literal('shooter'),
      Type.Literal('platformer'),
      Type.Literal('puzzle'),
      Type.Literal('racer'),
      Type.Literal('runner'),
      Type.Literal('tower-defense'),
      Type.Literal('survival'),
      Type.Literal('rhythm'),
      Type.Literal('other'),
    ]),
  ),
  /** Declared capabilities (Phase 1) — when supplied, the pass reflects the
   *  game's intent: pointer/drag/touch schemes skip the keyboard-controls
   *  warning, `escalates` enforces difficulty ramp regardless of genre, and
   *  `hasFailState: false` exempts a deliberately-endless toy. */
  capabilities: Type.Optional(
    Type.Object({
      controlScheme: Type.Optional(Type.String()),
      escalates: Type.Optional(Type.Boolean()),
      hasFailState: Type.Optional(Type.Boolean()),
      hasEnemies: Type.Optional(Type.Boolean()),
      hasProgression: Type.Optional(Type.Boolean()),
    }),
  ),
});

export type GameInvariant =
  | 'restart'
  | 'fail-state'
  | 'score-or-state'
  | 'feedback'
  | 'controls'
  | 'camera-relative'
  | 'escalation'
  | 'decoy-engine'
  | 'debug-snapshot'
  | 'brawler-combo'
  | 'brawler-hitstop'
  | 'brawler-per-attack-limb'
  | 'brawler-aim-hitbox-parity';

/** Engine Evolution Phase 1 — the capability slice this module reasons about.
 *  Structural (not the zod type) so the module stays dependency-free; the host
 *  passes the declared GameSpec.capabilities, a superset. When present these make
 *  the checks reflect the game's DECLARED intent instead of a genre/regex guess:
 *  pointer-only games don't get a keyboard-controls warning, a game that declares
 *  escalation is held to it regardless of genre token, and a game that declares
 *  no fail state isn't nagged for one. */
export interface InvariantCapabilities {
  controlScheme?: string | undefined;
  escalates?: boolean | undefined;
  hasFailState?: boolean | undefined;
  hasEnemies?: boolean | undefined;
  hasProgression?: boolean | undefined;
}

export interface InvariantIssue {
  invariant: GameInvariant;
  message: string;
  severity: 'warn' | 'error';
}

export interface AssertGameInvariantsDetails {
  ok: boolean;
  checked: GameInvariant[];
  issues: InvariantIssue[];
  genre: GameGenre | null;
}

const SOURCE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.html'] as const;

export interface AssertGameInvariantsDeps {
  /** Returns every authored project file the agent has written. The host
   *  wires this from the in-memory virtual FS — same source the
   *  text_editor tool mutates. */
  listFiles: () => Array<{ path: string; content: string }>;
}

/** Concatenated source of every text file that's a candidate for source-
 *  level pattern matching. Binary/asset paths are filtered out so we
 *  don't scan PNGs / WAVs by accident. */
function gatherSource(deps: AssertGameInvariantsDeps): string {
  const files = deps.listFiles();
  const sources: string[] = [];
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (!SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    if (f.content.startsWith('data:')) continue;
    sources.push(f.content);
  }
  return sources.join('\n\n');
}

/** Restart binding — any of: an explicit reset()/restart() function,
 *  a key handler for R / Space that mutates state back, or `location.reload`. */
const RESTART_PATTERNS: readonly RegExp[] = [
  /\b(restart|reset|new[_]?game|reset[_]?game)\s*\(/i,
  /K_r\b|key\s*===?\s*['"]r['"]|key\s*===?\s*['"]R['"]|\.code\s*===?\s*['"]KeyR['"]/,
  /location\.reload\b/,
];

const FAIL_PATTERNS: readonly RegExp[] = [
  // Match `gameOver`, `GameOver`, `game_over`, `game over` even when they
  // appear in camelCase identifiers (`onGameOver`, `isGameOver`). The
  // leading boundary is dropped because game-design code very commonly
  // wraps these names without a word break.
  /(?:game[_\s]?over|gameover|lose|lost|defeat|fail(?:ed)?|died|deaths?)/i,
  /\bif\s*\(\s*hp\s*<=?\s*0\s*\)/i,
  /\bif\s*\(\s*health\s*<=?\s*0\s*\)/i,
  /\bif\s*\(\s*lives\s*<=?\s*0\s*\)/i,
];

const SCORE_PATTERNS: readonly RegExp[] = [
  /\b(score|points?|coins?|stars?|kills?|level|wave|round)\s*[+\-*/]?=\s*[+\-]?\s*\d/i,
  /\b(score|points?|coins?)\s*\+\+/i,
  /\bsetScore\s*\(/i,
];

const FEEDBACK_PATTERNS: readonly RegExp[] = [
  // Audio playback (any engine)
  /\bplay\s*\(\s*\)/i,
  /\bnew\s+Audio\s*\(/,
  /\.sound\.add\b|\.sound\.play\b/i,
  // Visual / particle / shake
  /\b(flash|shake|particle|emit_particle|spark|ripple)/i,
  /\bcontext\.fillRect\b|\bdrawRect\b/i,
  // Tween / camera shake
  /\btween\.|camera\.shake\b|setShake\b/i,
];

// WS-A controls contract — a keyboard game must DECLARE its scheme via
// window.__game.controls.define(...) and read input through it, so the builder's
// Controls tab populates and users can rebind keys live. These detect input read
// DIRECTLY (bypassing the rebindable layer); the runtime layer is already present
// in every game, so the only thing missing when these match without a
// controls.define is the declaration + adoption.
const KEYBOARD_INPUT_PATTERNS: readonly RegExp[] = [
  /addEventListener\s*\(\s*['"]key(down|up|press)['"]/i,
  /\.input\.keyboard/i,
  /createCursorKeys\s*\(/i,
  /\.addKey\s*\(/i,
  /\bKeyboardEvent\b/,
  /\bcursors?\s*\.\s*(left|right|up|down)/i,
];
const CONTROLS_DEFINE_PATTERN = /\bcontrols\s*\.\s*define\s*\(/;

// v2 P2 — the deterministic verdict layer (playbooks + contracts) reads
// window.__game.debug.snapshot(); a game with gameplay state that never wires it
// can't be play-verified and ships no_verdict. Any of these counts as wired:
// debug.track({...}), an explicit debug.snapshot assignment, or window.__game.state.
const SNAPSHOT_WIRING_PATTERNS: readonly RegExp[] = [
  /\bdebug\s*\.\s*track\s*\(/,
  /\bdebug\s*\.\s*snapshot\s*=/,
  /__game\s*\.\s*state\b/,
];

// Camera-relative movement (3D's #1 recurring bug). A 3D game with a MOVING
// camera (follow / first-person / third-person) that applies movement input to
// position WITHOUT projecting onto the camera basis ships controls that "feel
// inverted/mismatched" the moment the camera turns. We only flag when the camera
// actually moves AND movement hits position AND no camera-relative transform is
// present — a fixed-camera 3D game (isometric / locked) is unaffected.
const IS_3D_PATTERNS: readonly RegExp[] = [
  /\bWebGLRenderer\b/,
  /\bPerspectiveCamera\b/,
  /THREE\.Scene\b/,
];
const CAMERA_DYNAMIC_PATTERNS: readonly RegExp[] = [
  // Per-frame camera motion (follow / look) — NOT a one-time `.set` at setup, so
  // a static/locked camera isn't flagged.
  /camera\s*\.\s*lookAt\s*\(/,
  /camera\s*\.\s*position\s*\.\s*(lerp|copy|add|addScaledVector)\b/,
  /camera\s*\.\s*rotation\s*\.\s*[xyz]/,
];
const MOVE_TO_POSITION_PATTERNS: readonly RegExp[] = [
  /\.\s*position\s*\.\s*(add|addScaledVector)\s*\(/,
  /\.\s*position\s*\.\s*[xyz]\s*[+\-]=/,
];
const CAMERA_RELATIVE_PATTERNS: readonly RegExp[] = [
  /getWorldDirection\s*\(/,
  /applyQuaternion\s*\(/,
  /camera\s*\.\s*quaternion/,
  /setFromMatrixColumn\s*\(/,
  /crossVectors\s*\(/,
  /\bOrbitControls\b|\bPointerLockControls\b/,
  /makeCameraController\s*\(/,
];

function anyMatch(source: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(source));
}

// Sequence-6 (genre-specific invariants) — brawler patterns. Brawler =
// melee-combat game where hand alternation, hit telegraphing, and aim/
// hitbox parity decide whether the game feels skilled or random. These
// checks are pattern-based, not AST-level, so a brawler that genuinely
// implements the mechanic but uses unusual identifiers (e.g. Danish
// `venstreHaand`) will trip the warning. Severity stays `warn` so the
// agent can ignore-and-justify, same as the design-level invariants.

// Patterns deliberately do NOT use leading `\b` so identifiers like
// `applyHitstop` and `leftArm` (camelCase) match. Each pattern is
// distinctive enough that false positives are unlikely.

const BRAWLER_COMBO_PATTERNS: readonly RegExp[] = [
  /combo[A-Z_a-z]*/i,
  /alternation/i,
  /multiplier/i,
  /lastAttack/i,
  /lastHand/i,
];

const BRAWLER_HITSTOP_PATTERNS: readonly RegExp[] = [
  /hit[_-]?stop/i,
  /hit[_-]?stun/i,
  /hit[_-]?pause/i,
  /hit[_-]?freeze/i,
  /stagger/i,
  /freezeFrames?/i,
  /timeScale\s*=/,
];

const BRAWLER_LIMB_PATTERNS: readonly RegExp[] = [
  /(left|l)[_-]?(Arm|Fist|Hand)/i,
  /(right|r)[_-]?(Arm|Fist|Hand)/i,
  /arms?\.(left|right|l|r)/i,
  /\bjab\b/i,
  /\bcross\b/i,
  /\bhook\b/i,
];

/** A brawler must visibly distinguish at least two limbs/attack
 *  identifiers — counting unique pattern hits, not just one. */
function brawlerLimbCount(source: string): number {
  let hits = 0;
  for (const re of BRAWLER_LIMB_PATTERNS) {
    if (re.test(source)) hits += 1;
  }
  return hits;
}

/** Difficulty-escalation signals — a game in a "must ramp" genre that has
 *  none of these reads as a flat tech demo (anti-slop §pacing). We match the
 *  common ways a build raises pressure over time/waves: a wave counter that
 *  advances, a difficulty multiplier, a shrinking spawn interval, enemy
 *  speed/hp/count scaled by wave/level/time, or use of the bundled
 *  wave-spawner / endlessRamp skills. Pattern-based + warn-only like the rest. */
const ESCALATION_PATTERNS: readonly RegExp[] = [
  /\bwave\s*(\+\+|\+=|=\s*wave\s*\+|number\s*\+\+)/i,
  /\b(nextWave|startNextWave|spawnWave|advanceWave|incrementWave)\b/i,
  /\b(createWaveSystem|endlessRamp|waveSpawner|WaveSystem)\b/,
  /\bdifficulty(Multiplier|Scale|Factor|Mult)?\s*[*+]?=/i,
  /\b1\.\d+\s*\*\*/, // geometric ramp e.g. 1.15 ** wave
  /Math\.pow\(\s*1\.\d+/, // geometric ramp via Math.pow
  /\b(spawn(Rate|Interval|Delay|Cooldown|Timer|Every))\b[^\n;]{0,40}[*]\s*0?\.\d/i, // shrinking spawn interval
  /Math\.max\([^)]*spawn(Interval|Delay|Rate|Cooldown)/i, // clamped shrinking interval
  /\b(enemySpeed|enemyHp|enemyHealth|enemyCount|maxEnemies|spawnCount)\b[^\n;]{0,40}[*+]/i,
  /\b(speed|hp|health|count|enemies?)\b[^\n;]{0,30}\*[^\n;]{0,20}\b(wave|level|elapsed|time|difficulty)\b/i,
];

/** LEVEL-RAMP escalation signals (v2 P5) — a progression game (platformer,
 *  puzzle-with-stages) that legitimately gets harder via HANDCRAFTED LEVELS has
 *  none of the wave/spawn signals above, so judging it by ESCALATION_PATTERNS
 *  alone is a false "no escalation" (the Loop-1 platformer). These match the
 *  level-advance vocabulary + use of the level-orchestrator skill. */
const LEVEL_RAMP_PATTERNS: readonly RegExp[] = [
  /\b(nextLevel|loadLevel|advanceLevel|gotoLevel|setLevel)\b/i,
  /\blevel(Index|Num|Number)?\s*(\+\+|\+=)/i,
  /\b(createLevelOrchestrator|levelOrchestrator|LEVELS\s*\[)/,
  /\bunlock(Level|Stage|Next)\b/i,
];

/** GameGenre tokens (game-workflow §2 menu) whose games MUST get harder over
 *  time to feel like a game rather than a demo. Survival/arcade/runner/TD all
 *  ramp; brawler/puzzle/racer/rhythm/platformer pace differently (handcrafted
 *  levels, fixed bouts) so they are exempt from this soft check. */
const SHOULD_ESCALATE_GENRES: ReadonlySet<GameGenre> = new Set<GameGenre>([
  'shooter',
  'runner',
  'tower-defense',
  'survival',
]);

/** Control schemes that do NOT drive the keyboard-controls contract. A game the
 *  player steers entirely by mouse/touch (Phase 5) should not be nagged to call
 *  controls.define just because it binds a stray R-to-restart keydown — that was
 *  a false positive on the tide/boats probe run. */
const NON_KEYBOARD_SCHEMES: ReadonlySet<string> = new Set<string>(['pointer', 'drag', 'touch']);

/** Decoy-engine honesty check (Phase 4). The tide/boats probe run declared
 *  engine `phaser` but shipped a vanilla-canvas game, leaving a dead Phaser shim
 *  in the entry file (`if (false && window.Phaser) { class … extends Phaser.Scene {} }`)
 *  purely to pass validate_game_scene. Detect that dishonesty so the engine
 *  validates the REAL game, not a decoy. Build raw-canvas games honestly instead. */
// Tightened to the UNAMBIGUOUS decoy signature so honest code isn't flagged: a
// dead branch that constructs the declared engine ONLY to be seen by the
// validator (`if (false && window.Phaser)` / `if (false && THREE)`), or an entry
// file that openly states the real game runs elsewhere. We deliberately do NOT
// match a bare empty subclass (`class Boot extends Phaser.Scene {}` — a legit
// skeleton) or a generic disabled feature flag (`if (false && debug)`).
const DECOY_ENGINE_PATTERNS: readonly RegExp[] = [
  /if\s*\(\s*false\s*&&[^)]*\b(Phaser|THREE)\b/i,
  /sandbox-safe\s+entry\s+placeholder/i,
  /the\s+(playable|real|actual)\b[^\n]*\bis\s+loaded\s+by\b/i,
];

const ROTATION_NEGATED_ANGLE: readonly RegExp[] = [
  /rotation\.y\s*=\s*-\s*playerAngle/i,
  /rotation\.y\s*=\s*-\s*aimAngle/i,
  /rotation\.y\s*=\s*-\s*ea\b/i,
  /rotation\.y\s*=\s*-\s*enemyAngle/i,
];

/** Tries to extract the agent's `Genre:` choice from the system / user
 *  / assistant transcript when the tool is called without an explicit
 *  argument. Exported for reuse by the renderer (Sequence 7). */
export function parseGenreFromTranscript(text: string): GameGenre | null {
  const match = /Genre:\s*([a-z-]+)/i.exec(text);
  if (match === null) return null;
  const token = (match[1] ?? '').toLowerCase() as GameGenre;
  return GAME_GENRES.includes(token) ? token : null;
}

export function assertGameInvariants(
  deps: AssertGameInvariantsDeps,
  opts: { genre?: GameGenre; capabilities?: InvariantCapabilities } = {},
): AssertGameInvariantsDetails {
  const source = gatherSource(deps);
  const caps = opts.capabilities;
  const issues: InvariantIssue[] = [];
  const checked: GameInvariant[] = [
    'restart',
    'fail-state',
    'score-or-state',
    'feedback',
    'controls',
    'decoy-engine',
    'debug-snapshot',
  ];

  if (!anyMatch(source, RESTART_PATTERNS)) {
    issues.push({
      invariant: 'restart',
      severity: 'warn',
      message:
        'No restart binding detected. Wire R or Space to reset state without a page reload — losing without restart is a hard fail per the gameplan §3.',
    });
  }
  if (caps?.hasFailState !== false && !anyMatch(source, FAIL_PATTERNS)) {
    issues.push({
      invariant: 'fail-state',
      severity: 'warn',
      message:
        'No fail state detected. Add a way for the player to lose — hp <= 0, time runs out, all lives gone — otherwise the brief is a toy, not a game.',
    });
  }
  if (!anyMatch(source, SCORE_PATTERNS)) {
    issues.push({
      invariant: 'score-or-state',
      severity: 'warn',
      message:
        'No score / state change detected. The player needs a measurable signal of progress — score, level, wave, kills — that mutates as they play.',
    });
  }
  if (!anyMatch(source, FEEDBACK_PATTERNS)) {
    issues.push({
      invariant: 'feedback',
      severity: 'warn',
      message:
        'No feedback cue detected. Hits / pickups / impacts need a visible AND audible response within 100 ms — a sound effect, particle burst, or screen shake. Silence reads as broken.',
    });
  }
  // Controls contract — only for keyboard-driven games. A pointer/drag/touch
  // scheme (Phase 5) steers by mouse/touch, so a stray restart keydown must not
  // trip this (the tide/boats false positive).
  const isKeyboardScheme =
    caps?.controlScheme === undefined || !NON_KEYBOARD_SCHEMES.has(caps.controlScheme);
  if (
    isKeyboardScheme &&
    anyMatch(source, KEYBOARD_INPUT_PATTERNS) &&
    !CONTROLS_DEFINE_PATTERN.test(source)
  ) {
    issues.push({
      invariant: 'controls',
      severity: 'warn',
      message:
        'Keyboard input is read directly without declaring a controls scheme. The runtime layer is already present — call window.__game.controls.define({ actions: [{ id, label, keys: ["ArrowLeft","KeyA"] }, …] }) and read input via controls.isDown(id) / controls.on(id, fn). This populates the builder Controls tab and lets players rebind keys live; reading cursors/keydown directly bypasses it, so the controls are invisible and unmappable.',
    });
  }

  // Debug-snapshot wiring (v2 P2) — a game with gameplay state (a score/state
  // mutation or a fail state) that never exposes window.__game.debug.snapshot
  // can't be play-verified and ships no_verdict. Pointer/static toys with no
  // state are exempt. Imported skills wire their getState() here automatically.
  // Gated on the DECLARED capability (present on real runs via the spec), so a
  // game that commits to a fail state — i.e. wants a real play verdict — is held
  // to exposing one. Standalone invariant calls without capabilities are exempt.
  const wantsVerdict = caps?.hasFailState === true;
  if (wantsVerdict && !anyMatch(source, SNAPSHOT_WIRING_PATTERNS)) {
    issues.push({
      invariant: 'debug-snapshot',
      severity: 'warn',
      message:
        'No debug snapshot wired, so the deterministic playtest can read nothing and the run ships unverified (no_verdict). Expose your state in ONE line: window.__game.debug.track({ player: thePlayerSprite, score: () => score, wave: () => wave }) — or set window.__game.state = { score, wave }. Imported skills (import_skill) expose a getState() you can pass straight into debug.track.',
    });
  }

  // Decoy-engine honesty (Phase 4) — a faked engine entry that exists only to
  // pass validate_game_scene while the real game runs elsewhere.
  if (anyMatch(source, DECOY_ENGINE_PATTERNS)) {
    issues.push({
      invariant: 'decoy-engine',
      severity: 'warn',
      message:
        'Decoy engine entry detected — dead/placeholder framework code (e.g. `if (false && window.Phaser)` or an empty `extends Phaser.Scene {}`) that exists only to satisfy validate_game_scene while the real game runs in another file. Build honestly: if a raw <canvas> + requestAnimationFrame loop fits the idea better than the declared engine, write that as the actual entry (it is allowed) and wire window.__game from it — do NOT fake a scene.',
    });
  }
  if (anyMatch(source, IS_3D_PATTERNS)) {
    checked.push('camera-relative');
    if (
      anyMatch(source, CAMERA_DYNAMIC_PATTERNS) &&
      anyMatch(source, MOVE_TO_POSITION_PATTERNS) &&
      !anyMatch(source, CAMERA_RELATIVE_PATTERNS)
    ) {
      issues.push({
        invariant: 'camera-relative',
        severity: 'warn',
        message:
          'A 3D game with a moving camera applies movement directly to world position with no camera-basis transform — the controls will feel inverted/mismatched the moment the camera turns (3D\'s #1 bug). Project input onto the camera basis: camera.getWorldDirection(fwd); fwd.y=0; fwd.normalize(); right.crossVectors(fwd, UP); move = fwd*forward + right*strafe. Or adapt view_game_feel({ name: "three/camera-controller.jsx" }). Also clamp mouse-look pitch and keep sensitivity ~0.002 rad/px so the camera is not springy.',
      });
    }
  }

  const genre = opts.genre ?? null;
  if (genre === 'brawler') {
    checked.push(
      'brawler-combo',
      'brawler-hitstop',
      'brawler-per-attack-limb',
      'brawler-aim-hitbox-parity',
    );
    if (!anyMatch(source, BRAWLER_COMBO_PATTERNS)) {
      issues.push({
        invariant: 'brawler-combo',
        severity: 'warn',
        message:
          'Brawler with no combo / alternation system detected. Two-handed brawlers reward sequence (Jab→Cross→Jab → multiplier) — without a `combo`, `lastAttack`, or `multiplier` mutation the skill ceiling collapses. The 2026-05-03 c44763af trace needed a final user prompt to spell this out; bake it in up-front.',
      });
    }
    if (!anyMatch(source, BRAWLER_HITSTOP_PATTERNS)) {
      issues.push({
        invariant: 'brawler-hitstop',
        severity: 'warn',
        message:
          'Brawler with no hitstop / hitstun detected. Heavy hits should freeze the attacker for 30-80 ms (`hitstop`, `hitstun`, `staggerFrames`, or `timeScale = 0.05` for one tick) so the impact reads as weighty rather than ghostly.',
      });
    }
    if (brawlerLimbCount(source) < 2) {
      issues.push({
        invariant: 'brawler-per-attack-limb',
        severity: 'warn',
        message:
          'Brawler without two visible attack limbs detected. The lead/rear hand distinction (Jab vs Cross) requires distinct meshes / sprites the player can SEE — at least one each of `leftArm`/`rightArm` (or `jab`/`cross`/`hook`). Without this the user cannot read which hand is firing and the combo system becomes invisible.',
      });
    }
    if (anyMatch(source, ROTATION_NEGATED_ANGLE)) {
      issues.push({
        invariant: 'brawler-aim-hitbox-parity',
        severity: 'warn',
        message:
          'Suspect aim/hitbox sign error — `rotation.y = -playerAngle` (or -ea / -aimAngle / -enemyAngle) detected. In Three.js with `atan2(dx, dz)` the rotation is the angle directly, NOT its negative. The 2026-05-03 c44763af trace shipped this exact bug through three snapshots; switch to `rotation.y = playerAngle` and re-run `playtest_game` to confirm the player faces the cursor.',
      });
    }
  }

  // Difficulty escalation — a game that must ramp but never gets harder is a tech
  // demo (anti-slop §pacing). Triggered by EITHER the genre token OR the declared
  // capability `escalates` — the latter closes the genre-vocabulary gap that let
  // the survival-shooter probe (declared genre 'topdown_arcade', not 'shooter')
  // slip the escalation check entirely.
  if ((genre !== null && SHOULD_ESCALATE_GENRES.has(genre)) || caps?.escalates === true) {
    checked.push('escalation');
    // Mode (v2 P5): a progression game with no combat ramps via LEVELS, not
    // waves — accept the level-ramp vocabulary so it isn't false-flagged for
    // lacking spawn-rate signals. (The garden/rhythm/platformer mis-declarations
    // are already demoted upstream by validateCapabilities, so this only sees
    // games that genuinely should escalate.)
    const levelRampMode = caps?.hasProgression === true && caps?.hasEnemies !== true;
    const escalationPatterns = levelRampMode
      ? [...ESCALATION_PATTERNS, ...LEVEL_RAMP_PATTERNS]
      : ESCALATION_PATTERNS;
    if (!anyMatch(source, escalationPatterns)) {
      issues.push({
        invariant: 'escalation',
        severity: 'warn',
        message: levelRampMode
          ? 'No escalation detected for a progression game. Make later levels/stages genuinely harder and advance them (nextLevel / a level-orchestrator), or ramp a difficulty value — a game that never gets harder reads as a tech demo. The bundled `level-orchestrator` skill (import_skill) sequences escalating levels.'
          : 'No difficulty escalation detected for a genre that must ramp. A wave that never gets harder reads as a tech demo — drift the spawn rate, enemy speed/HP, or enemy count up over time or per wave (e.g. difficulty = 1.15 ** wave), and SIGNAL the rising pressure (a wave counter, a "Wave N" banner). Import the bundled `wave-spawner` skill (import_skill({ name: "<engine>/wave-spawner.<js|jsx>" })) — escalating count/speed/hp per wave with a telegraphed countdown — and `enemy-ai` gives the enemies real behaviour to fight.',
      });
    }
  }

  return {
    ok: issues.length === 0,
    checked,
    issues,
    genre,
  };
}

/**
 * Phase-1.5 — the COMPLETABILITY FLOOR.
 *
 * `assertGameInvariants` above is genre-token (`brawler`/`shooter`/…)
 * aware but warn-only. The `done` gate needs to know, per the declared
 * GameSpec, which of the four design invariants are *blocking* (a game
 * that can't be lost or restarted is broken) vs which are *advisory*
 * (polish — score presence). It also needs to recognise genres that
 * legitimately have no lose state and downgrade the whole floor to
 * advisory for them.
 *
 * The GameSpec genre vocabulary (`@playforge/shared` — `sandbox`,
 * `idle`, `fps`, …) is DIFFERENT from this module's `GameGenre`
 * (`brawler`, `shooter`, … from game-workflow.v1.txt §2). We classify
 * off the *spec* genre + `winCondition` so the floor reasons about the
 * artifact the agent actually committed to, not a transcript guess.
 */

/** The three invariants whose ABSENCE makes a completable game broken:
 *  no fail state (can't lose), no restart (can't retry after losing),
 *  no on-hit/on-event feedback (silent-on-hit reads as broken). These
 *  are FATAL for completable genres. `score-or-state` and the genre-
 *  specific brawler-* checks stay advisory (polish, not completability). */
export const FATAL_FLOOR_INVARIANTS: ReadonlySet<GameInvariant> = new Set<GameInvariant>([
  'fail-state',
  'restart',
  'feedback',
]);

/** GameSpec (`@playforge/shared`) genres that legitimately have no lose
 *  state — sandbox/creative/idle toys. The floor downgrades to advisory
 *  for these so a Minecraft-like or an incremental clicker isn't blocked
 *  for "no fail state". Kept as a string set (not the zod enum) so this
 *  module has no runtime dependency on @playforge/shared. */
const NON_COMPLETABLE_SPEC_GENRES: ReadonlySet<string> = new Set<string>([
  'sandbox',
  'idle',
  'tycoon',
  'visual_novel',
]);

/** Sentinel the GameSpec schema uses for "endless / no fail state":
 *  `winCondition: '—'` (em-dash) or `loseCondition: '—'`. An empty or
 *  whitespace-only condition is treated the same way. */
function isNoneSentinel(condition: string | undefined | null): boolean {
  if (condition === undefined || condition === null) return true;
  const trimmed = condition.trim();
  return trimmed === '' || trimmed === '—' || trimmed === '-' || trimmed === 'none';
}

/** Minimal shape of the declared GameSpec the floor reads. Structural
 *  (not the zod type) so this module stays dependency-free; the host
 *  passes the real `@playforge/shared` GameSpec, which is a superset. */
export interface CompletabilitySpec {
  genre: string;
  winCondition?: string | undefined;
  loseCondition?: string | undefined;
  capabilities?: InvariantCapabilities | undefined;
}

/**
 * Decide whether the completability floor should BLOCK for this spec.
 *
 * Escape hatches (→ advisory, never block):
 *   - genre is a non-completable / creative one (sandbox / idle /
 *     tycoon / visual_novel), OR
 *   - the spec declares no fail state (loseCondition '—'/none), OR
 *   - the spec declares it's endless (winCondition '—'/none) AND no
 *     explicit lose condition — a pure endless toy with no lose path is
 *     a legitimate sandbox-class artifact.
 *
 * A spec with a real loseCondition is ALWAYS completable (it claims a
 * fail state), even for an endless win — that's an arcade high-score
 * game and absolutely must have a working lose + restart path.
 */
export function isCompletableSpec(spec: CompletabilitySpec): boolean {
  if (NON_COMPLETABLE_SPEC_GENRES.has(spec.genre)) return false;
  // A declared lose condition pins the game as completable regardless of
  // the win sentinel (endless arcade games still must be losable).
  if (!isNoneSentinel(spec.loseCondition)) return true;
  // No declared lose condition: if the win is also endless/none, this is
  // a creative / endless toy — downgrade. Otherwise (a real win but no
  // declared lose) we still hold it to the floor: a game you can win but
  // never lose is the exact "toy not a game" failure the floor targets.
  if (isNoneSentinel(spec.winCondition)) return false;
  return true;
}

export interface CompletabilityFloorResult {
  /** True when the spec is completable AND a FATAL-floor invariant is
   *  missing → `done` must block. */
  blocked: boolean;
  /** The FATAL-floor invariant issues (fail-state / restart / feedback)
   *  detected as missing. Empty when the spec is non-completable
   *  (escape-hatch) or all three are present. */
  fatal: InvariantIssue[];
  /** The remaining invariant issues — score-or-state, brawler-*, and
   *  (when the escape hatch fired) the downgraded floor invariants.
   *  Always advisory; surfaced but never blocking. */
  advisory: InvariantIssue[];
  /** Whether the escape hatch downgraded the floor for this spec. */
  downgraded: boolean;
}

/**
 * Run `assertGameInvariants` and split its issues into the blocking
 * completability floor vs advisory polish, honouring the spec's escape
 * hatches. Pure — no I/O beyond the `deps.listFiles` the caller supplies.
 *
 * This is the function `done` composes: it re-derives the static design-
 * completability verdict over the current working tree and decides
 * whether to refuse acceptance.
 */
export function evaluateCompletabilityFloor(
  deps: AssertGameInvariantsDeps,
  spec: CompletabilitySpec,
  opts: { genre?: GameGenre; capabilities?: InvariantCapabilities } = {},
): CompletabilityFloorResult {
  const result = assertGameInvariants(deps, opts);
  const completable = isCompletableSpec(spec);
  const fatal: InvariantIssue[] = [];
  const advisory: InvariantIssue[] = [];
  for (const issue of result.issues) {
    if (completable && FATAL_FLOOR_INVARIANTS.has(issue.invariant)) {
      // Promote to error severity for the FATAL set so downstream
      // surfaces (and the `game.invariant.*` done source) read it as a
      // blocker, not a nudge.
      fatal.push({ ...issue, severity: 'error' });
    } else {
      advisory.push(issue);
    }
  }
  return {
    blocked: fatal.length > 0,
    fatal,
    advisory,
    downgraded: !completable,
  };
}

export function makeAssertGameInvariantsTool(
  deps: AssertGameInvariantsDeps,
  _fs?: TextEditorFsCallbacks,
): AgentTool<typeof AssertGameInvariantsParams, AssertGameInvariantsDetails> {
  return {
    name: 'assert_game_invariants',
    label: 'Assert game invariants',
    description:
      'Cross-engine sanity check for the four design-level invariants every ' +
      'game must hit: a restart binding (R / Space), a fail state (lose / ' +
      'game over), a score or state-change signal, and feedback within the ' +
      'collision handler (sound / particle / shake). Pass `genre: "brawler"` ' +
      '(or another genre token from your Mechanic spec block) to also run ' +
      'genre-specific checks — e.g. brawler adds combo + hitstop + visible ' +
      'limbs + aim/hitbox parity (catches the 2026-05-03 c44763af sign-error ' +
      'class). Pattern-based static analysis over the whole project tree — ' +
      'fast and free. Call BEFORE `done` alongside `validate_game_scene`. ' +
      'Warnings are non-blocking but should be treated as a strong nudge to ' +
      'fix before shipping.',
    parameters: AssertGameInvariantsParams,
    async execute(_id, params): Promise<AgentToolResult<AssertGameInvariantsDetails>> {
      const genre = params.genre as GameGenre | undefined;
      const capabilities = params.capabilities as InvariantCapabilities | undefined;
      const result = assertGameInvariants(deps, {
        ...(genre !== undefined ? { genre } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
      const baseInvariants = [
        'restart',
        'fail-state',
        'score-or-state',
        'feedback',
        'controls',
      ].join(', ');
      const okHeadline =
        genre !== undefined
          ? `All ${result.checked.length} invariants present for genre=${genre} (${baseInvariants}${result.checked.length > 5 ? ` + ${result.checked.slice(5).join(', ')}` : ''}). No follow-up needed.`
          : `All ${result.checked.length} game invariants present (${baseInvariants}). No follow-up needed.`;
      const summary =
        result.issues.length === 0
          ? okHeadline
          : `${result.issues.length} game invariant(s) appear missing:\n${result.issues
              .map((i) => `  • [${i.invariant}] ${i.message}`)
              .join(
                '\n',
              )}\n\nThese are warnings, not blockers — review and add the missing pieces before \`done\`.`;
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  };
}
