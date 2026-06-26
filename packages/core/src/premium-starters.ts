/**
 * Premium-by-default starters (premium pivot, 2026-06-23).
 *
 * The confirm runs proved a guide-level premium skeleton gets only PARTIAL
 * adoption — the model copies the palette but skips the screens / draw-the-subject /
 * juice / sfx structure. The fix is to SEED a complete, bootable, premium `src/main.js`
 * into the working tree the moment the engine is chosen (services/worker setEngine),
 * so the agent EDITS a premium scaffold instead of writing a bare loop from scratch.
 * It would have to actively delete the structure to make the game non-premium.
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

const CANVAS2D_STARTER = `// src/main.js — PREMIUM STARTER (edit this into your game; keep the structure).
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resize();
window.addEventListener('resize', resize);

// ART DIRECTION — pick a palette that fits YOUR theme.
const PAL = { bg0: '#10131c', bg1: '#222a44', ink: '#eef2ff', accent: '#ffcc4d', good: '#5ad6a0', bad: '#ff5d7a' };
const FONT = "'Space Grotesk', system-ui, sans-serif"; // optionally <link> a font in index.html

// JUICE + SFX — call on every meaningful event.
const fx = { shake: 0, parts: [] };
let audioCtx;
function sfx(freq = 440, dur = 0.08, type = 'square') {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.start(); o.stop(audioCtx.currentTime + dur);
}
function burst(x, y, color) {
  for (let i = 0; i < 16; i++) fx.parts.push({ x, y, a: Math.random() * 7, sp: 50 + Math.random() * 160, life: 0.55, color });
}

// CONTROLS
window.__game.controls.define({ actions: [
  { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
] });

// SCREENS: title -> play -> over. A no-fail SANDBOX/zen game: set screen='play' and delete the 'over' branch.
let screen = 'title';
function start() { if (screen !== 'play') { screen = 'play'; resetGame(); sfx(520, 0.1, 'triangle'); } }
window.addEventListener('pointerdown', start);
window.addEventListener('keydown', (e) => { if (e.code === 'Space') start(); });

// STATE + DEBUG CONTRACT (required so the playtest can read the game)
let score = 0;
const player = { x: 200, y: 320, r: 16 };
const things = [];
let spawnT = 0;
function resetGame() { score = 0; player.x = 200; things.length = 0; spawnT = 0; screen = 'play'; }
window.__game.debug.track({ score: () => score, player: () => player });

// DRAW THE SUBJECT — window.__game.art.draw(ctx, NOUN, x, y, size, opts) is a built-in
// silhouette library (fish, bird, cat, coin, gem, heart, rocket, car, tree, star, person, …;
// any noun it doesn't know becomes a distinctive labelled crest). SWAP the NOUN strings below
// for YOUR subject — never leave a bare circle for a named thing. opts: { fill, stroke, accent,
// rotate (rad), flip }. Want something fully custom? Write your own draw<Noun>() with ctx paths,
// or call generate_image_asset for a sprite.
function drawBackground(W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, PAL.bg0); g.addColorStop(1, PAL.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function drawPlayer(p) { window.__game.art.draw(ctx, 'rocket', p.x, p.y, p.r * 2.8, { fill: PAL.accent }); }
function drawThing(t) { window.__game.art.draw(ctx, 'star', t.x, t.y, t.r * 2.4, { fill: PAL.bad, rotate: t.spin }); }
function drawCenter(W, H, title, sub) {
  ctx.fillStyle = 'rgba(8,10,18,0.62)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = PAL.ink; ctx.font = 'bold 54px ' + FONT; ctx.fillText(title, W / 2, H / 2 - 8);
  ctx.fillStyle = PAL.accent; ctx.font = '20px ' + FONT; ctx.fillText(sub, W / 2, H / 2 + 34);
}

let lastT = 0;
function frame(t) {
  const dt = Math.min((t - lastT) / 1000, 0.05); lastT = t;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  drawBackground(W, H);

  ctx.save();
  if (fx.shake > 0) { ctx.translate((Math.random() - 0.5) * fx.shake, (Math.random() - 0.5) * fx.shake); fx.shake = Math.max(0, fx.shake - dt * 40); }

  if (screen === 'play') {
    const speed = window.__game.params.player_speed ?? 240;
    if (window.__game.controls.isDown('left')) player.x = Math.max(player.r, player.x - speed * dt);
    if (window.__game.controls.isDown('right')) player.x = Math.min(W - player.r, player.x + speed * dt);
    player.y = H - 60;
    spawnT -= dt;
    if (spawnT <= 0) { spawnT = Math.max(0.25, 0.9 - score * 0.01); things.push({ x: 30 + Math.random() * (W - 60), y: -20, r: 14, spin: 0, v: 120 + score * 4 }); }
    for (const th of things) { th.y += th.v * dt; th.spin += dt * 4;
      if (Math.hypot(th.x - player.x, th.y - player.y) < th.r + player.r) { burst(player.x, player.y, PAL.bad); fx.shake = 14; sfx(140, 0.18, 'sawtooth'); screen = 'over'; }
      if (th.y > H + 20) { th.dead = true; score += 1; sfx(660, 0.05, 'square'); }
      drawThing(th);
    }
    for (let i = things.length - 1; i >= 0; i--) if (things[i].dead) things.splice(i, 1);
    drawPlayer(player);
    ctx.fillStyle = PAL.ink; ctx.font = '20px ' + FONT; ctx.textAlign = 'left'; ctx.fillText('Score ' + score, 16, 30);
  }

  for (const p of fx.parts) { p.x += Math.cos(p.a) * p.sp * dt; p.y += Math.sin(p.a) * p.sp * dt; p.life -= dt; ctx.globalAlpha = Math.max(0, p.life * 1.8); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 3, 3); }
  ctx.globalAlpha = 1; fx.parts = fx.parts.filter((p) => p.life > 0);
  ctx.restore();

  if (screen === 'title') drawCenter(W, H, 'YOUR GAME', 'Click or press Space to play');
  if (screen === 'over') drawCenter(W, H, 'GAME OVER', 'Score ' + score + ' · Click to retry');

  window.__game.debug.particleCount = fx.parts.length;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
`;

const PHASER_STARTER = `// src/main.js — PREMIUM STARTER (edit this into your game; keep the structure).
import * as Phaser from 'phaser';

const PAL = { bg0: 0x10131c, bg1: 0x222a44, ink: '#eef2ff', accent: '#ffcc4d', bad: '#ff5d7a' };
const TITLE_FONT = { fontFamily: 'Space Grotesk, system-ui, sans-serif' };

let audioCtx;
function sfx(freq = 440, dur = 0.08, type = 'square') {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.start(); o.stop(audioCtx.currentTime + dur);
}
function gradientBg(scene) {
  const { width: W, height: H } = scene.scale;
  scene.add.graphics().fillGradientStyle(PAL.bg0, PAL.bg0, PAL.bg1, PAL.bg1, 1).fillRect(0, 0, W, H);
}
// Bake a recognisable sprite from the built-in silhouette library into a texture
// ONCE, so add.image(key) / group.create(x, y, key) draw an ACTUAL noun (fish,
// rocket, coin, …) instead of a tinted shape. Swap the noun for YOUR subject.
function artTexture(scene, key, noun, size, opts) {
  if (scene.textures.exists(key)) return key;
  const cv = window.__game.art.sprite(noun, size, opts);
  if (cv) scene.textures.addCanvas(key, cv);
  return key;
}

class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }
  create() {
    gradientBg(this);
    const { width: W, height: H } = this.scale;
    this.add.text(W / 2, H / 2 - 18, 'YOUR GAME', { ...TITLE_FONT, fontSize: '56px', color: PAL.ink }).setOrigin(0.5);
    this.add.text(W / 2, H / 2 + 34, 'Click or press Space to play', { ...TITLE_FONT, fontSize: '20px', color: PAL.accent }).setOrigin(0.5);
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('Play'));
    this.input.once('pointerdown', () => this.scene.start('Play'));
  }
}

class PlayScene extends Phaser.Scene {
  constructor() { super('Play'); }
  create() {
    gradientBg(this);
    this.score = 0;
    // DRAW THE SUBJECT — bake recognisable sprites from the silhouette library. SWAP the
    // nouns ('rocket' / 'star') for YOUR subject (fish, coin, car, person, enemy, …; an
    // unknown noun gets a distinctive labelled crest). Or generate_image_asset for a
    // custom sprite — never a loaded png you didn't create.
    artTexture(this, 'player', 'rocket', 96, { fill: '#ffcc4d' });
    artTexture(this, 'hazard', 'star', 64, { fill: '#ff5d7a' });
    this.player = this.physics.add.image(400, 540, 'player').setCollideWorldBounds(true);
    this.things = this.physics.add.group();
    this.scoreText = this.add.text(16, 14, 'Score 0', { ...TITLE_FONT, fontSize: '20px', color: PAL.ink });
    this.spawn = this.time.addEvent({ delay: 800, loop: true, callback: () => {
      const x = 30 + Math.random() * (this.scale.width - 60);
      const t = this.things.create(x, -20, 'hazard'); t.setVelocityY(160 + this.score * 6);
    } });
    window.__game.debug.track({ score: () => this.score, player: () => this.player });
  }
  hit() { this.cameras.main.shake(140, 0.008); sfx(140, 0.18, 'sawtooth'); this.scene.start('Over', { score: this.score }); }
  update() {
    const speed = window.__game.params.player_speed ?? 360;
    if (window.__game.controls.isDown('left')) this.player.body.setVelocityX(-speed);
    else if (window.__game.controls.isDown('right')) this.player.body.setVelocityX(speed);
    else this.player.body.setVelocityX(0);
    this.things.getChildren().forEach((t) => {
      if (Math.abs(t.x - this.player.x) < 50 && Math.abs(t.y - this.player.y) < 26) this.hit();
      if (t.y > this.scale.height + 20) { t.destroy(); this.score += 1; this.scoreText.setText('Score ' + this.score); sfx(660, 0.05); }
    });
  }
}

class OverScene extends Phaser.Scene {
  constructor() { super('Over'); }
  create(data) {
    gradientBg(this);
    const { width: W, height: H } = this.scale;
    this.add.text(W / 2, H / 2 - 10, 'GAME OVER', { ...TITLE_FONT, fontSize: '52px', color: PAL.ink }).setOrigin(0.5);
    this.add.text(W / 2, H / 2 + 34, 'Score ' + (data?.score ?? 0) + ' · Space to retry', { ...TITLE_FONT, fontSize: '20px', color: PAL.accent }).setOrigin(0.5);
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('Play'));
  }
}

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
`;

const THREE_STARTER = `// src/main.js — PREMIUM STARTER (edit this into your game; keep the structure).
import * as THREE from 'three';

const canvas = document.querySelector('#game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ART DIRECTION — a real sky + fog + lighting rig, never a black void.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1320);
scene.fog = new THREE.Fog(0x0f1320, 16, 60);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
camera.position.set(0, 7, 12); camera.lookAt(0, 0.5, -2);
function resize() {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight; camera.updateProjectionMatrix();
}
resize();
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202830, 0.95));
const sun = new THREE.DirectionalLight(0xffe9b0, 1.5);
sun.position.set(6, 14, 8); sun.castShadow = true; scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 220), new THREE.MeshStandardMaterial({ color: 0x232c46, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// THE SUBJECT — COMPOSE a recognisable low-poly subject (NEVER a default Box/Icosahedron
// for a named thing). Swap these meshes for YOUR subject, or load a real model with
// generate_3d_asset (GLTFLoader from three/addons). For a 2D HUD/billboard icon, bake one
// from the silhouette library: const cv = window.__game.art.sprite('star', 128).
function buildCraft() {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.9, 6, 14), new THREE.MeshStandardMaterial({ color: 0xffcc4d, metalness: 0.2, roughness: 0.4 }));
  hull.rotation.x = Math.PI / 2; hull.castShadow = true; g.add(hull);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 14), new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.5 }));
  nose.position.z = -1.0; nose.rotation.x = -Math.PI / 2; nose.castShadow = true; g.add(nose);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.1, emissive: 0x2a4a66 }));
  cockpit.position.set(0, 0.26, -0.15); g.add(cockpit);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.6), new THREE.MeshStandardMaterial({ color: 0xe5563b, roughness: 0.6 }));
  wing.position.set(0, -0.05, 0.3); wing.castShadow = true; g.add(wing);
  return g;
}
const player = buildCraft(); player.position.set(0, 0.6, 4); scene.add(player);

// JUICE — a WebAudio sfx() + a camera-shake helper, called on every meaningful event.
let shake = 0;
const camBase = camera.position.clone();
let audioCtx;
function sfx(freq = 440, dur = 0.08, type = 'square') {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.start(); o.stop(audioCtx.currentTime + dur);
}

// SCREENS — a Title -> Play -> Over HTML overlay. (A no-fail SANDBOX collapses to one
// screen: set screen='play' and delete the 'over' branch.)
const ui = document.createElement('div');
ui.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Space Grotesk',system-ui,sans-serif;color:#eef2ff;text-align:center;background:rgba(8,10,18,0.55)";
const uiTitle = document.createElement('div'); uiTitle.style.cssText = "font-size:54px;font-weight:700"; uiTitle.textContent = 'STARFALL'; ui.appendChild(uiTitle);
const uiSub = document.createElement('div'); uiSub.style.cssText = "font-size:20px;color:#ffcc4d;margin-top:8px"; uiSub.textContent = 'Click or press Space to fly'; ui.appendChild(uiSub);
document.body.appendChild(ui);
// HUD — score + a star icon baked from the silhouette library (window.__game.art.sprite).
const hud = document.createElement('div');
hud.style.cssText = "position:fixed;top:14px;left:16px;display:flex;align-items:center;gap:8px;font-family:'Space Grotesk',system-ui,sans-serif;color:#eef2ff;font-size:20px";
const starIcon = window.__game.art.sprite('star', 48, { fill: '#ffcf4d' });
if (starIcon) { starIcon.style.width = '24px'; starIcon.style.height = '24px'; hud.appendChild(starIcon); }
const scoreEl = document.createElement('span'); scoreEl.textContent = 'Score 0'; hud.appendChild(scoreEl);
document.body.appendChild(hud);

window.__game.controls.define({ actions: [
  { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
] });

let screen = 'title', score = 0, spawnT = 0;
const rocks = [];
const rockGeo = new THREE.IcosahedronGeometry(0.7, 0); // generic debris — fine as a primitive
const rockMat = new THREE.MeshStandardMaterial({ color: 0xff5d7a, flatShading: true, roughness: 0.8 });
function reset() { score = 0; player.position.set(0, 0.6, 4); for (const r of rocks) scene.remove(r); rocks.length = 0; spawnT = 0; }
function start() { if (screen !== 'play') { screen = 'play'; reset(); ui.style.display = 'none'; sfx(520, 0.1, 'triangle'); } }
window.addEventListener('pointerdown', start);
window.addEventListener('keydown', (e) => { if (e.code === 'Space') start(); });

window.__game.debug.track({ score: () => score, playerPos: () => player.position });

let last = 0;
function tick(t) {
  const dt = Math.min((t - last) / 1000, 0.05); last = t;
  if (screen === 'play') {
    const speed = window.__game.params.player_speed ?? 8;
    const left = window.__game.controls.isDown('left'), right = window.__game.controls.isDown('right');
    if (left) player.position.x = Math.max(-7, player.position.x - speed * dt);
    if (right) player.position.x = Math.min(7, player.position.x + speed * dt);
    player.rotation.z = (left ? 0.35 : 0) - (right ? 0.35 : 0); // bank into the turn
    spawnT -= dt;
    if (spawnT <= 0) { spawnT = Math.max(0.32, 1.0 - score * 0.02); const r = new THREE.Mesh(rockGeo, rockMat); r.position.set((Math.random() - 0.5) * 14, 0.7, -24); r.castShadow = true; r.userData.spin = Math.random() * 3; scene.add(r); rocks.push(r); }
    for (let i = rocks.length - 1; i >= 0; i--) {
      const r = rocks[i]; r.position.z += (11 + score * 0.3) * dt; r.rotation.x += r.userData.spin * dt; r.rotation.y += dt;
      if (Math.abs(r.position.z - player.position.z) < 0.95 && Math.abs(r.position.x - player.position.x) < 1.05) {
        shake = 0.6; sfx(120, 0.2, 'sawtooth'); screen = 'over'; ui.style.display = 'flex';
        uiTitle.textContent = 'GAME OVER'; uiSub.textContent = 'Score ' + score + ' \\u00b7 Space to retry';
      } else if (r.position.z > 8) { scene.remove(r); rocks.splice(i, 1); score += 1; scoreEl.textContent = 'Score ' + score; sfx(660, 0.05, 'square'); }
    }
  }
  if (shake > 0) { camera.position.set(camBase.x + (Math.random() - 0.5) * shake, camBase.y + (Math.random() - 0.5) * shake, camBase.z); shake = Math.max(0, shake - dt * 1.6); }
  else camera.position.copy(camBase);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', () => renderer.dispose());
`;

export const PREMIUM_STARTERS: Record<StarterEngine, string> = {
  canvas2d: CANVAS2D_STARTER,
  phaser: PHASER_STARTER,
  three: THREE_STARTER,
};

/** The path the premium starter is seeded at — the agent's entry module. */
export const PREMIUM_STARTER_PATH = 'src/main.js';
