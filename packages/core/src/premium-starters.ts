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

// DRAW THE SUBJECT — give each named noun its own draw fn (procedural silhouette or a
// generate_image_asset sprite). Replace these with YOUR subject; never leave a bare circle for a named thing.
function drawBackground(W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, PAL.bg0); g.addColorStop(1, PAL.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function drawPlayer(p) {
  ctx.save(); ctx.translate(p.x, p.y);
  ctx.fillStyle = PAL.accent; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.arc(p.r * 0.4, -p.r * 0.3, p.r * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawThing(t) {
  ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.spin);
  ctx.fillStyle = PAL.bad; ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * t.r, Math.sin(a) * t.r); }
  ctx.closePath(); ctx.fill(); ctx.restore();
}
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
    // DRAW THE SUBJECT in code (or a generate_image_asset sprite) — never a loaded png you didn't create.
    this.player = this.add.ellipse(400, 540, 90, 22, 0xffcc4d);
    this.physics.add.existing(this.player);
    this.player.body.setCollideWorldBounds(true);
    this.things = this.physics.add.group();
    this.scoreText = this.add.text(16, 14, 'Score 0', { ...TITLE_FONT, fontSize: '20px', color: PAL.ink });
    this.spawn = this.time.addEvent({ delay: 800, loop: true, callback: () => {
      const x = 30 + Math.random() * (this.scale.width - 60);
      const t = this.add.star(x, -20, 6, 6, 13, PAL.bad); this.things.add(t); t.body.setVelocityY(160 + this.score * 6);
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
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ART DIRECTION — a real sky + fog + lighting rig, never a black void.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10131c);
scene.fog = new THREE.Fog(0x10131c, 14, 48);
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
camera.position.set(0, 6, 11);
camera.lookAt(0, 0.5, 0);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202830, 0.9));
const sun = new THREE.DirectionalLight(0xffe9b0, 1.4);
sun.position.set(6, 12, 6); sun.castShadow = true; scene.add(sun);

// GROUND + the SUBJECT with real materials (use generate_3d_asset for real models).
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x2b3350, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const player = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), new THREE.MeshStandardMaterial({ color: 0xffcc4d, flatShading: true, roughness: 0.4 }));
player.position.y = 0.6; player.castShadow = true; scene.add(player);

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

window.__game.controls.define({ actions: [
  { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
  { id: 'up',    label: 'Forward',    keys: ['ArrowUp', 'KeyW'] },
  { id: 'down',  label: 'Back',       keys: ['ArrowDown', 'KeyS'] },
] });

let score = 0;
window.__game.debug.track({
  score: () => score,
  playerPos: () => player.position, // Vector3 — reflectPos handles .x/.y/.z
  cameraYaw: () => camera.rotation.y,
});

let last = 0;
function tick(t) {
  const dt = Math.min((t - last) / 1000, 0.05); last = t;
  const speed = window.__game.params.player_speed ?? 5;
  if (window.__game.controls.isDown('left')) player.position.x -= speed * dt;
  if (window.__game.controls.isDown('right')) player.position.x += speed * dt;
  if (window.__game.controls.isDown('up')) player.position.z -= speed * dt;
  if (window.__game.controls.isDown('down')) player.position.z += speed * dt;
  player.rotation.y += dt;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
});
window.addEventListener('beforeunload', () => renderer.dispose());
`;

export const PREMIUM_STARTERS: Record<StarterEngine, string> = {
  canvas2d: CANVAS2D_STARTER,
  phaser: PHASER_STARTER,
  three: THREE_STARTER,
};

/** The path the premium starter is seeded at — the agent's entry module. */
export const PREMIUM_STARTER_PATH = 'src/main.js';
