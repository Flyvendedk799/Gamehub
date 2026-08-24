/**
 * Premium-by-default MODULAR starters (premium pivot 2026-06-23; modular
 * scaffold 2026-08-24).
 *
 * The confirm runs proved a guide-level premium skeleton gets only PARTIAL
 * adoption — the model copies the palette but skips the screens / draw-the-subject /
 * juice / sfx structure. The fix is to SEED a complete, bootable, premium project
 * into the working tree the moment the engine is chosen (services/worker setEngine),
 * so the agent EDITS a premium scaffold instead of writing a bare loop from scratch.
 * It would have to actively delete the structure to make the game non-premium.
 *
 * WHY MODULES, NOT ONE FILE (docs/BUILD_SPEED_FROM_BOXER_RUNS.md §1)
 * -----------------------------------------------------------------
 * Run 3 (`6ea60c10`) created `src/main.js` in ONE call carrying 52,334 bytes, then
 * edited it 17 times with 37 views interleaved. Every consequence of a single
 * 1419-line file is expensive:
 *
 *   - the first write is one enormous output burst with no checkpoint;
 *   - every later edit targets a file too large to hold in working memory, so it
 *     needs a look first — 37 views for 17 mutations;
 *   - a single-byte edit invalidates the prompt-cache suffix for the whole file.
 *
 * So the scaffold ships as SMALL MODULES: a thin `src/main.js` bootstrap plus
 * `player` / `enemies` / `waves` / `fx` / `hud` / `theme`. Each is short enough to
 * read whole — no map, no ranged read — edits are local, and cache invalidation is
 * scoped to the one module that changed.
 *
 * WHY THE ENGINE IS IN THE TREE (docs/BUILD_SPEED_FROM_BOXER_RUNS.md §2)
 * ---------------------------------------------------------------------
 * Run 2 proved RECOMMENDING a foundational engine module does not work: it was
 * imported, read across nine `view` calls, never called, and swept as dead code
 * (`skillsImported` rose, `usesSkillFns` stayed 0 — eight minutes gone). By the
 * time a recommendation is read the agent has committed to its own architecture;
 * a feature skill can bolt on, a foundational loop cannot. So `src/engine/core.js`
 * is WRITTEN INTO THE TREE before the agent's first turn and `main.js` already
 * imports and runs on it. The scaffold and the engine are the same piece of work.
 *
 * Guardrail: measure `usesSkillFns` and `engineImports` (which the seed makes
 * non-zero by construction), never `skillsImported`. A run where they fall back to
 * zero is a run that deleted or bypassed the scaffold — that is the signal.
 *
 * Each starter is a COMPLETE, runnable game (a tiny dodge-the-falling-things toy) so
 * the project boots premium even before the agent adapts it: art direction (palette +
 * gradient/sky), a Title -> Play -> Over screen flow (a no-fail/sandbox game collapses
 * to one screen), juice (shake + particles) + WebAudio sfx() called on events, the
 * subject DRAWN by a dedicated function (not a tinted circle), the required
 * debug.track contract, and preserveDrawingBuffer on WebGL (readable for the juice
 * meter + thumbnails). The agent is told (choose_engine result) to adapt, not replace.
 */

export type StarterEngine = 'canvas2d' | 'phaser' | 'three';

/** One seeded project: relative path -> file content. */
export type StarterFiles = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// canvas2d
// ---------------------------------------------------------------------------

const CANVAS2D_FILES: StarterFiles = {
  'src/engine/core.js': `// src/engine/core.js — THE ENGINE. main.js already runs on it; extend it rather
// than hand-rolling a second loop. Stage + fixed-max-step frame loop + WebAudio sfx.

/** Mount the canvas, keep its backing store in sync with devicePixelRatio. */
export function createStage(canvasId) {
  const canvas = document.getElementById(canvasId || 'game');
  const ctx = canvas.getContext('2d');
  function resize() {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);
  return { canvas, ctx, get width() { return canvas.clientWidth; }, get height() { return canvas.clientHeight; } };
}

/** Per-frame loop. dt is seconds, clamped so a background tab can't teleport the world. */
export function runLoop(step) {
  let last = 0;
  function frame(t) {
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    step(dt, t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// REAL audio, synthesised in-browser — never a reference to an audio file that
// does not exist in this project.
let audioCtx;
export function sfx(freq, dur, type) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type || 'square'; o.frequency.value = freq || 440;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (dur || 0.08));
  o.start(); o.stop(audioCtx.currentTime + (dur || 0.08));
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
`,

  'src/theme.js': `// src/theme.js — ART DIRECTION. Pick a palette that fits YOUR theme; every other
// module reads its colours from here, so one edit re-skins the whole game.
export const PAL = { bg0: '#10131c', bg1: '#222a44', ink: '#eef2ff', accent: '#ffcc4d', good: '#5ad6a0', bad: '#ff5d7a' };
export const FONT = "'Space Grotesk', system-ui, sans-serif"; // optionally <link> a font in index.html

/** Never a flat fill — a gradient sky reads as art direction, a solid colour reads as unfinished. */
export function drawBackground(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, PAL.bg0); g.addColorStop(1, PAL.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
`,

  'src/fx.js': `// src/fx.js — JUICE. Call burst() + shake on every meaningful event; a game with
// no fx reads as a prototype no matter how good the mechanics are.
export function createFx() { return { shake: 0, parts: [] }; }

export function burst(fx, x, y, color) {
  for (let i = 0; i < 16; i++) {
    fx.parts.push({ x: x, y: y, a: Math.random() * 7, sp: 50 + Math.random() * 160, life: 0.55, color: color });
  }
}

export function kick(fx, amount) { fx.shake = Math.max(fx.shake, amount); }

/** Offset the whole frame while shaking. Call inside a ctx.save()/restore() pair. */
export function shakeCtx(ctx, fx, dt) {
  if (fx.shake <= 0) return;
  ctx.translate((Math.random() - 0.5) * fx.shake, (Math.random() - 0.5) * fx.shake);
  fx.shake = Math.max(0, fx.shake - dt * 40);
}

export function updateFx(fx, dt) {
  for (const p of fx.parts) {
    p.x += Math.cos(p.a) * p.sp * dt; p.y += Math.sin(p.a) * p.sp * dt; p.life -= dt;
  }
  for (let i = fx.parts.length - 1; i >= 0; i--) if (fx.parts[i].life <= 0) fx.parts.splice(i, 1);
}

export function drawFx(ctx, fx) {
  for (const p of fx.parts) {
    ctx.globalAlpha = Math.max(0, p.life * 1.8);
    ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 3, 3);
  }
  ctx.globalAlpha = 1;
}
`,

  'src/player.js': `// src/player.js — THE SUBJECT. window.__game.art.draw(ctx, NOUN, x, y, size, opts) is a
// built-in silhouette library (fish, bird, cat, coin, gem, heart, rocket, car, tree, star,
// person, …; any noun it doesn't know becomes a distinctive labelled crest). SWAP the noun
// for YOUR subject — never leave a bare circle for a named thing. opts: { fill, stroke,
// accent, rotate (rad), flip }. Want something fully custom? Write your own ctx paths here,
// or call generate_image_asset for a sprite.
import { clamp } from './engine/core.js';
import { PAL } from './theme.js';

export function createPlayer() { return { x: 200, y: 320, r: 16 }; }

export function updatePlayer(p, dt, W, H) {
  const speed = window.__game.params.player_speed ?? 240;
  if (window.__game.controls.isDown('left')) p.x -= speed * dt;
  if (window.__game.controls.isDown('right')) p.x += speed * dt;
  p.x = clamp(p.x, p.r, W - p.r);
  p.y = H - 60;
}

export function drawPlayer(ctx, p) {
  window.__game.art.draw(ctx, 'rocket', p.x, p.y, p.r * 2.8, { fill: PAL.accent });
}
`,

  'src/enemies.js': `// src/enemies.js — the things the player deals with. SWAP the noun for YOUR hazard.
import { PAL } from './theme.js';

export function createThing(x, speed) { return { x: x, y: -20, r: 14, spin: 0, v: speed }; }

/** Advance every thing; returns { scored, hitPlayer } so main.js owns the consequences. */
export function updateThings(things, dt, H, player) {
  let scored = 0;
  let hitPlayer = false;
  for (const t of things) {
    t.y += t.v * dt;
    t.spin += dt * 4;
    if (Math.hypot(t.x - player.x, t.y - player.y) < t.r + player.r) hitPlayer = true;
    if (t.y > H + 20) { t.dead = true; scored += 1; }
  }
  for (let i = things.length - 1; i >= 0; i--) if (things[i].dead) things.splice(i, 1);
  return { scored: scored, hitPlayer: hitPlayer };
}

export function drawThings(ctx, things) {
  for (const t of things) {
    window.__game.art.draw(ctx, 'star', t.x, t.y, t.r * 2.4, { fill: PAL.bad, rotate: t.spin });
  }
}
`,

  'src/waves.js': `// src/waves.js — PACING. Difficulty escalation lives here so it can be tuned without
// touching the entity or render code.
import { createThing } from './enemies.js';

export function createWaves() { return { timer: 0 }; }

export function resetWaves(w) { w.timer = 0; }

/** Spawns into \`things\` on a score-driven cadence. Faster and denser as the run goes on. */
export function tickWaves(w, dt, score, W, things) {
  w.timer -= dt;
  if (w.timer > 0) return;
  w.timer = Math.max(0.25, 0.9 - score * 0.01);
  things.push(createThing(30 + Math.random() * (W - 60), 120 + score * 4));
}
`,

  'src/hud.js': `// src/hud.js — READABLE STATE + the Title/Over screens. A player who can't tell what
// is happening reads the game as broken, however good the simulation is.
import { FONT, PAL } from './theme.js';

export function drawScore(ctx, score) {
  ctx.fillStyle = PAL.ink; ctx.font = '20px ' + FONT; ctx.textAlign = 'left';
  ctx.fillText('Score ' + score, 16, 30);
}

export function drawCenter(ctx, W, H, title, sub) {
  ctx.fillStyle = 'rgba(8,10,18,0.62)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = PAL.ink; ctx.font = 'bold 54px ' + FONT; ctx.fillText(title, W / 2, H / 2 - 8);
  ctx.fillStyle = PAL.accent; ctx.font = '20px ' + FONT; ctx.fillText(sub, W / 2, H / 2 + 34);
}
`,

  'src/main.js': `// src/main.js — PREMIUM STARTER BOOTSTRAP. Keep this file THIN: it wires the modules
// together and owns the screen flow. Gameplay belongs in the module it names —
// player.js, enemies.js, waves.js, fx.js, hud.js — each small enough to read whole.
import { createStage, runLoop, sfx } from './engine/core.js';
import { PAL, drawBackground } from './theme.js';
import { burst, createFx, drawFx, kick, shakeCtx, updateFx } from './fx.js';
import { createPlayer, drawPlayer, updatePlayer } from './player.js';
import { drawThings, updateThings } from './enemies.js';
import { createWaves, resetWaves, tickWaves } from './waves.js';
import { drawCenter, drawScore } from './hud.js';

const stage = createStage('game');
const fx = createFx();
const player = createPlayer();
const waves = createWaves();
const things = [];

// CONTROLS — every action the player can take, declared once.
window.__game.controls.define({ actions: [
  { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
] });

// SCREENS: title -> play -> over. A no-fail SANDBOX/zen game: set screen='play' and
// delete the 'over' branch.
let screen = 'title';
let score = 0;
function resetGame() { score = 0; player.x = stage.width / 2; things.length = 0; resetWaves(waves); screen = 'play'; }
function start() { if (screen !== 'play') { resetGame(); sfx(520, 0.1, 'triangle'); } }
window.addEventListener('pointerdown', start);
window.addEventListener('keydown', (e) => { if (e.code === 'Space') start(); });

// DEBUG CONTRACT (required so the playtest can read the game).
window.__game.debug.track({ score: () => score, player: () => player });

runLoop((dt) => {
  const ctx = stage.ctx, W = stage.width, H = stage.height;
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, W, H);

  ctx.save();
  shakeCtx(ctx, fx, dt);
  if (screen === 'play') {
    updatePlayer(player, dt, W, H);
    tickWaves(waves, dt, score, W, things);
    const ev = updateThings(things, dt, H, player);
    if (ev.scored > 0) { score += ev.scored; sfx(660, 0.05, 'square'); }
    if (ev.hitPlayer) { burst(fx, player.x, player.y, PAL.bad); kick(fx, 14); sfx(140, 0.18, 'sawtooth'); screen = 'over'; }
    drawThings(ctx, things);
    drawPlayer(ctx, player);
  }
  updateFx(fx, dt);
  drawFx(ctx, fx);
  ctx.restore();

  if (screen === 'play') drawScore(ctx, score);
  if (screen === 'title') drawCenter(ctx, W, H, 'YOUR GAME', 'Click or press Space to play');
  if (screen === 'over') drawCenter(ctx, W, H, 'GAME OVER', 'Score ' + score + ' \\u00b7 Space to retry');
});
`,
};

// ---------------------------------------------------------------------------
// phaser
// ---------------------------------------------------------------------------

const PHASER_FILES: StarterFiles = {
  'src/engine/core.js': `// src/engine/core.js — THE ENGINE. The scenes already run on it; extend it rather
// than re-implementing audio/backdrop/sprite baking per scene.
import * as Phaser from 'phaser';
import { PAL } from '../theme.js';

// REAL audio, synthesised in-browser — never a reference to an audio file that
// does not exist in this project.
let audioCtx;
export function sfx(freq, dur, type) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type || 'square'; o.frequency.value = freq || 440;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (dur || 0.08));
  o.start(); o.stop(audioCtx.currentTime + (dur || 0.08));
}

/** Gradient sky on every scene — a flat fill reads as unfinished. */
export function gradientBg(scene) {
  const W = scene.scale.width, H = scene.scale.height;
  scene.add.graphics().fillGradientStyle(PAL.bg0, PAL.bg0, PAL.bg1, PAL.bg1, 1).fillRect(0, 0, W, H);
}

// Bake a recognisable sprite from the built-in silhouette library into a texture
// ONCE, so add.image(key) / group.create(x, y, key) draw an ACTUAL noun (fish,
// rocket, coin, …) instead of a tinted shape. Swap the noun for YOUR subject.
export function artTexture(scene, key, noun, size, opts) {
  if (scene.textures.exists(key)) return key;
  const cv = window.__game.art.sprite(noun, size, opts);
  if (cv) scene.textures.addCanvas(key, cv);
  return key;
}

/** Screen shake + a hit sound, together — juice on every meaningful event. */
export function impact(scene, strength) {
  scene.cameras.main.shake(140, strength || 0.008);
  sfx(140, 0.18, 'sawtooth');
}

export const SceneBase = Phaser.Scene;
`,

  'src/theme.js': `// src/theme.js — ART DIRECTION. One edit here re-skins every scene.
export const PAL = { bg0: 0x10131c, bg1: 0x222a44, ink: '#eef2ff', accent: '#ffcc4d', bad: '#ff5d7a' };
export const TITLE_FONT = { fontFamily: 'Space Grotesk, system-ui, sans-serif' };
`,

  'src/player.js': `// src/player.js — THE SUBJECT. SWAP the noun ('rocket') for YOUR subject (fish, coin,
// car, person, …; an unknown noun gets a distinctive labelled crest). Or call
// generate_image_asset for a custom sprite — never a loaded png you didn't create.
import { artTexture } from './engine/core.js';

export function createPlayer(scene) {
  artTexture(scene, 'player', 'rocket', 96, { fill: '#ffcc4d' });
  return scene.physics.add.image(scene.scale.width / 2, scene.scale.height - 60, 'player').setCollideWorldBounds(true);
}

export function drivePlayer(player) {
  const speed = window.__game.params.player_speed ?? 360;
  if (window.__game.controls.isDown('left')) player.body.setVelocityX(-speed);
  else if (window.__game.controls.isDown('right')) player.body.setVelocityX(speed);
  else player.body.setVelocityX(0);
}
`,

  'src/enemies.js': `// src/enemies.js — the things the player deals with. SWAP the noun for YOUR hazard.
import { artTexture } from './engine/core.js';

export function prepareHazards(scene) { artTexture(scene, 'hazard', 'star', 64, { fill: '#ff5d7a' }); }

export function spawnHazard(scene, group, score) {
  const x = 30 + Math.random() * (scene.scale.width - 60);
  const t = group.create(x, -20, 'hazard');
  t.setVelocityY(160 + score * 6);
  return t;
}

export function overlapsPlayer(thing, player) {
  return Math.abs(thing.x - player.x) < 50 && Math.abs(thing.y - player.y) < 26;
}
`,

  'src/waves.js': `// src/waves.js — PACING. Difficulty escalation lives here so it can be tuned without
// touching the entity or scene code.
export function startWaves(scene, onSpawn) {
  return scene.time.addEvent({ delay: 800, loop: true, callback: onSpawn });
}

export function retune(waveEvent, score) {
  waveEvent.delay = Math.max(260, 800 - score * 18);
}
`,

  'src/fx.js': `// src/fx.js — JUICE. A burst of particles on every meaningful event; a game with no
// fx reads as a prototype however good the mechanics are.
import { PAL } from './theme.js';

export function burst(scene, x, y) {
  const g = scene.add.graphics();
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * 26;
    g.fillStyle(PAL.bad, 1).fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 3, 3);
  }
  scene.tweens.add({ targets: g, alpha: 0, duration: 420, onComplete: () => g.destroy() });
}
`,

  'src/hud.js': `// src/hud.js — READABLE STATE. A player who can't tell what is happening reads the
// game as broken.
import { PAL, TITLE_FONT } from './theme.js';

export function createHud(scene) {
  const text = scene.add.text(16, 14, 'Score 0', { ...TITLE_FONT, fontSize: '20px', color: PAL.ink });
  return { text: text, set: (score) => text.setText('Score ' + score) };
}

export function centerText(scene, dy, message, size, color) {
  return scene.add
    .text(scene.scale.width / 2, scene.scale.height / 2 + dy, message, { ...TITLE_FONT, fontSize: size, color: color })
    .setOrigin(0.5);
}
`,

  'src/scenes/title.js': `import { SceneBase, gradientBg } from '../engine/core.js';
import { PAL } from '../theme.js';
import { centerText } from '../hud.js';

export class TitleScene extends SceneBase {
  constructor() { super('Title'); }
  create() {
    gradientBg(this);
    centerText(this, -18, 'YOUR GAME', '56px', PAL.ink);
    centerText(this, 34, 'Click or press Space to play', '20px', PAL.accent);
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('Play'));
    this.input.once('pointerdown', () => this.scene.start('Play'));
  }
}
`,

  'src/scenes/play.js': `import { SceneBase, gradientBg, impact, sfx } from '../engine/core.js';
import { createPlayer, drivePlayer } from '../player.js';
import { overlapsPlayer, prepareHazards, spawnHazard } from '../enemies.js';
import { retune, startWaves } from '../waves.js';
import { burst } from '../fx.js';
import { createHud } from '../hud.js';

export class PlayScene extends SceneBase {
  constructor() { super('Play'); }
  create() {
    gradientBg(this);
    this.score = 0;
    prepareHazards(this);
    this.player = createPlayer(this);
    this.things = this.physics.add.group();
    this.hud = createHud(this);
    this.waves = startWaves(this, () => spawnHazard(this, this.things, this.score));
    // DEBUG CONTRACT (required so the playtest can read the game).
    window.__game.debug.track({ score: () => this.score, player: () => this.player });
  }
  hit() {
    burst(this, this.player.x, this.player.y);
    impact(this, 0.008);
    this.scene.start('Over', { score: this.score });
  }
  update() {
    drivePlayer(this.player);
    retune(this.waves, this.score);
    for (const t of [...this.things.getChildren()]) {
      if (overlapsPlayer(t, this.player)) { this.hit(); return; }
      if (t.y > this.scale.height + 20) {
        t.destroy(); this.score += 1; this.hud.set(this.score); sfx(660, 0.05);
      }
    }
  }
}
`,

  'src/scenes/over.js': `import { SceneBase, gradientBg } from '../engine/core.js';
import { PAL } from '../theme.js';
import { centerText } from '../hud.js';

export class OverScene extends SceneBase {
  constructor() { super('Over'); }
  create(data) {
    gradientBg(this);
    centerText(this, -10, 'GAME OVER', '52px', PAL.ink);
    centerText(this, 34, 'Score ' + (data?.score ?? 0) + ' \\u00b7 Space to retry', '20px', PAL.accent);
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('Play'));
  }
}
`,

  'src/main.js': `// src/main.js — PREMIUM STARTER BOOTSTRAP. Keep this file THIN: controls + the game
// config. Gameplay belongs in the module it names — scenes/, player.js, enemies.js,
// waves.js, fx.js, hud.js — each small enough to read whole.
import * as Phaser from 'phaser';
import { TitleScene } from './scenes/title.js';
import { PlayScene } from './scenes/play.js';
import { OverScene } from './scenes/over.js';

// CONTROLS — every action the player can take, declared once.
window.__game.controls.define({ actions: [
  { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
] });

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 800,
  height: 600,
  physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },
  render: { preserveDrawingBuffer: true }, // readable canvas (juice meter + thumbnails)
  scene: [TitleScene, PlayScene, OverScene], // a no-fail sandbox/zen game: just [PlayScene]
});
`,
};

// ---------------------------------------------------------------------------
// three
// ---------------------------------------------------------------------------

const THREE_FILES: StarterFiles = {
  'src/engine/core.js': `// src/engine/core.js — THE ENGINE. main.js already runs on it; extend it rather than
// hand-rolling a second renderer/loop. Renderer + lighting rig + frame loop + sfx.
import * as THREE from 'three';
import { FOG, GROUND, SKY } from '../theme.js';

/** A real sky + fog + lighting rig, never a black void. */
export function createStage(canvasId) {
  const canvas = document.querySelector('#' + (canvasId || 'game'));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(FOG, 16, 60);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(0, 7, 12); camera.lookAt(0, 0.5, -2);

  function resize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202830, 0.95));
  const sun = new THREE.DirectionalLight(0xffe9b0, 1.5);
  sun.position.set(6, 14, 8); sun.castShadow = true; scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 220),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  window.addEventListener('beforeunload', () => renderer.dispose());
  return { renderer, scene, camera, canvas };
}

/** Per-frame loop. dt is seconds, clamped so a background tab can't teleport the world. */
export function runLoop(step) {
  let last = 0;
  function tick(t) {
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    step(dt, t);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// REAL audio, synthesised in-browser — never a reference to an audio file that
// does not exist in this project.
let audioCtx;
export function sfx(freq, dur, type) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type || 'square'; o.frequency.value = freq || 440;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (dur || 0.08));
  o.start(); o.stop(audioCtx.currentTime + (dur || 0.08));
}
`,

  'src/theme.js': `// src/theme.js — ART DIRECTION. One edit here re-skins the whole scene.
export const SKY = 0x0f1320;
export const FOG = 0x0f1320;
export const GROUND = 0x232c46;
export const HULL = 0xffcc4d;
export const NOSE = 0xff8a3d;
export const GLASS = 0x9fd8ff;
export const WING = 0xe5563b;
export const HAZARD = 0xff5d7a;
export const INK = '#eef2ff';
export const ACCENT = '#ffcf4d';
export const UI_FONT = "'Space Grotesk', system-ui, sans-serif";
`,

  'src/player.js': `// src/player.js — THE SUBJECT. COMPOSE a recognisable low-poly subject (NEVER a default
// Box/Icosahedron for a named thing). Swap these meshes for YOUR subject, or load a real
// model with generate_3d_asset (GLTFLoader from three/addons). For a 2D HUD/billboard icon,
// bake one from the silhouette library: window.__game.art.sprite('star', 128).
import * as THREE from 'three';
import { GLASS, HULL, NOSE, WING } from './theme.js';

export function buildCraft() {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.9, 6, 14), new THREE.MeshStandardMaterial({ color: HULL, metalness: 0.2, roughness: 0.4 }));
  hull.rotation.x = Math.PI / 2; hull.castShadow = true; g.add(hull);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 14), new THREE.MeshStandardMaterial({ color: NOSE, roughness: 0.5 }));
  nose.position.z = -1.0; nose.rotation.x = -Math.PI / 2; nose.castShadow = true; g.add(nose);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.1, emissive: 0x2a4a66 }));
  cockpit.position.set(0, 0.26, -0.15); g.add(cockpit);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.6), new THREE.MeshStandardMaterial({ color: WING, roughness: 0.6 }));
  wing.position.set(0, -0.05, 0.3); wing.castShadow = true; g.add(wing);
  return g;
}

export function updatePlayer(player, dt) {
  const speed = window.__game.params.player_speed ?? 8;
  const left = window.__game.controls.isDown('left'), right = window.__game.controls.isDown('right');
  if (left) player.position.x = Math.max(-7, player.position.x - speed * dt);
  if (right) player.position.x = Math.min(7, player.position.x + speed * dt);
  player.rotation.z = (left ? 0.35 : 0) - (right ? 0.35 : 0); // bank into the turn
}

export function resetPlayer(player) { player.position.set(0, 0.6, 4); }
`,

  'src/enemies.js': `// src/enemies.js — the things the player deals with. Generic debris is fine as a
// primitive; a NAMED thing must be composed like the craft in player.js.
import * as THREE from 'three';
import { HAZARD } from './theme.js';

const rockGeo = new THREE.IcosahedronGeometry(0.7, 0);
const rockMat = new THREE.MeshStandardMaterial({ color: HAZARD, flatShading: true, roughness: 0.8 });

export function spawnRock(scene, rocks) {
  const r = new THREE.Mesh(rockGeo, rockMat);
  r.position.set((Math.random() - 0.5) * 14, 0.7, -24);
  r.castShadow = true;
  r.userData.spin = Math.random() * 3;
  scene.add(r); rocks.push(r);
  return r;
}

export function clearRocks(scene, rocks) {
  for (const r of rocks) scene.remove(r);
  rocks.length = 0;
}

/** Advance every rock; returns { scored, hitPlayer } so main.js owns the consequences. */
export function updateRocks(scene, rocks, dt, score, player) {
  let scored = 0;
  let hitPlayer = false;
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i];
    r.position.z += (11 + score * 0.3) * dt;
    r.rotation.x += r.userData.spin * dt;
    r.rotation.y += dt;
    if (Math.abs(r.position.z - player.position.z) < 0.95 && Math.abs(r.position.x - player.position.x) < 1.05) {
      hitPlayer = true;
    } else if (r.position.z > 8) { scene.remove(r); rocks.splice(i, 1); scored += 1; }
  }
  return { scored: scored, hitPlayer: hitPlayer };
}
`,

  'src/waves.js': `// src/waves.js — PACING. Difficulty escalation lives here so it can be tuned without
// touching the entity or render code.
import { spawnRock } from './enemies.js';

export function createWaves() { return { timer: 0 }; }

export function resetWaves(w) { w.timer = 0; }

export function tickWaves(w, dt, score, scene, rocks) {
  w.timer -= dt;
  if (w.timer > 0) return;
  w.timer = Math.max(0.32, 1.0 - score * 0.02);
  spawnRock(scene, rocks);
}
`,

  'src/fx.js': `// src/fx.js — JUICE. Camera shake on every meaningful event; a game with no fx reads
// as a prototype however good the mechanics are.
export function createFx(camera) { return { shake: 0, base: camera.position.clone() }; }

export function kick(fx, amount) { fx.shake = Math.max(fx.shake, amount); }

export function applyShake(fx, camera, dt) {
  if (fx.shake > 0) {
    camera.position.set(
      fx.base.x + (Math.random() - 0.5) * fx.shake,
      fx.base.y + (Math.random() - 0.5) * fx.shake,
      fx.base.z,
    );
    fx.shake = Math.max(0, fx.shake - dt * 1.6);
  } else {
    camera.position.copy(fx.base);
  }
}
`,

  'src/hud.js': `// src/hud.js — READABLE STATE + the Title/Over overlay. A player who can't tell what
// is happening reads the game as broken.
import { ACCENT, INK, UI_FONT } from './theme.js';

export function createHud() {
  const ui = document.createElement('div');
  ui.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:' + UI_FONT + ';color:' + INK + ';text-align:center;background:rgba(8,10,18,0.55)';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:54px;font-weight:700'; title.textContent = 'STARFALL'; ui.appendChild(title);
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:20px;color:' + ACCENT + ';margin-top:8px'; sub.textContent = 'Click or press Space to fly'; ui.appendChild(sub);
  document.body.appendChild(ui);

  // Score readout + a star icon baked from the silhouette library.
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:14px;left:16px;display:flex;align-items:center;gap:8px;font-family:' + UI_FONT + ';color:' + INK + ';font-size:20px';
  const icon = window.__game.art.sprite('star', 48, { fill: ACCENT });
  if (icon) { icon.style.width = '24px'; icon.style.height = '24px'; bar.appendChild(icon); }
  const scoreEl = document.createElement('span'); scoreEl.textContent = 'Score 0'; bar.appendChild(scoreEl);
  document.body.appendChild(bar);

  return {
    setScore: (score) => { scoreEl.textContent = 'Score ' + score; },
    hide: () => { ui.style.display = 'none'; },
    showOver: (score) => {
      ui.style.display = 'flex';
      title.textContent = 'GAME OVER';
      sub.textContent = 'Score ' + score + ' \\u00b7 Space to retry';
    },
  };
}
`,

  'src/main.js': `// src/main.js — PREMIUM STARTER BOOTSTRAP. Keep this file THIN: it wires the modules
// together and owns the screen flow. Gameplay belongs in the module it names —
// player.js, enemies.js, waves.js, fx.js, hud.js — each small enough to read whole.
import { createStage, runLoop, sfx } from './engine/core.js';
import { buildCraft, resetPlayer, updatePlayer } from './player.js';
import { clearRocks, updateRocks } from './enemies.js';
import { createWaves, resetWaves, tickWaves } from './waves.js';
import { applyShake, createFx, kick } from './fx.js';
import { createHud } from './hud.js';

const stage = createStage('game');
const player = buildCraft();
resetPlayer(player);
stage.scene.add(player);

const fx = createFx(stage.camera);
const hud = createHud();
const waves = createWaves();
const rocks = [];

// CONTROLS — every action the player can take, declared once.
window.__game.controls.define({ actions: [
  { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
] });

// SCREENS: title -> play -> over. A no-fail SANDBOX/zen game: set screen='play' and
// delete the 'over' branch.
let screen = 'title';
let score = 0;
function reset() { score = 0; resetPlayer(player); clearRocks(stage.scene, rocks); resetWaves(waves); hud.setScore(0); }
function start() { if (screen !== 'play') { screen = 'play'; reset(); hud.hide(); sfx(520, 0.1, 'triangle'); } }
window.addEventListener('pointerdown', start);
window.addEventListener('keydown', (e) => { if (e.code === 'Space') start(); });

// DEBUG CONTRACT (required so the playtest can read the game).
window.__game.debug.track({ score: () => score, playerPos: () => player.position });

runLoop((dt) => {
  if (screen === 'play') {
    updatePlayer(player, dt);
    tickWaves(waves, dt, score, stage.scene, rocks);
    const ev = updateRocks(stage.scene, rocks, dt, score, player);
    if (ev.scored > 0) { score += ev.scored; hud.setScore(score); sfx(660, 0.05, 'square'); }
    if (ev.hitPlayer) { kick(fx, 0.6); sfx(120, 0.2, 'sawtooth'); screen = 'over'; hud.showOver(score); }
  }
  applyShake(fx, stage.camera, dt);
  stage.renderer.render(stage.scene, stage.camera);
});
`,
};

/**
 * The complete seeded project per engine — a MODULE SET, not one file.
 *
 * `src/main.js` is the entry (`PREMIUM_STARTER_PATH`) and stays thin; every other
 * module is small enough for the agent to read whole, so an edit needs no map and
 * no ranged read, and invalidates only its own prompt-cache suffix.
 */
export const PREMIUM_STARTER_FILES: Record<StarterEngine, StarterFiles> = {
  canvas2d: CANVAS2D_FILES,
  phaser: PHASER_FILES,
  three: THREE_FILES,
};

/** The path the premium starter is seeded at — the agent's entry module. */
export const PREMIUM_STARTER_PATH = 'src/main.js';

/** The engine module every starter boots on — written into the tree before the
 *  agent's first turn (never merely recommended). Keeping this path under
 *  `src/engine/` is what makes `engineImports` / `usesSkillFns` measurable. */
export const PREMIUM_STARTER_ENGINE_PATH = 'src/engine/core.js';

/** Every path a seeded starter writes, for the engine the run pinned. */
export function starterPathsFor(engine: StarterEngine): string[] {
  return Object.keys(PREMIUM_STARTER_FILES[engine]);
}
