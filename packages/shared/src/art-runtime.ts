/**
 * Representational-art layer (engine-evolution roadmap, GAME_QUALITY_LEVERS #3 —
 * "the highest share-worthiness lever"). The renderer used to offer only
 * primitives, so a named noun shipped as a tinted circle: "there is no fish", a
 * burger was the word "Burger", a chef was a `fillCircle`. This injects a
 * zero-import procedural-silhouette library at `window.__game.art` so EVERY game
 * (canvas2d directly; phaser via `addCanvas`, three via `CanvasTexture`) can draw
 * an actual fish / coin / rocket / heart in one call — and ANY noun it doesn't
 * recognise still gets a distinctive labelled crest instead of a bare circle.
 *
 * The roadmap said: ship the SCAFFOLD, defer the auto-check (a "did you draw the
 * subject" heuristic is noisy). So this is capability + guidance only — no gate.
 *
 * Source of truth: the kind list, synonym table, and `resolveArtKind()` live in
 * TypeScript (directly unit-tested). `artLibSource()` emits the browser IIFE and
 * embeds the SAME tables as JSON, so the in-iframe resolver can never drift from
 * the TS one. Authored in ES5 (var/function, no template literals) so it nests
 * safely inside the bootstrap's `<script>` string and runs in any sandbox.
 */

/** Canonical silhouettes the library can draw. MUST stay in lockstep with the
 *  `DRAW` registry in `artLibSource()` — `art-lib.test.ts` evaluates the emitted
 *  IIFE and asserts `art.list()` deep-equals this array, so a drawer added in one
 *  place but not the other fails the build. */
export const ART_KINDS = [
  'fish',
  'bird',
  'cat',
  'dog',
  'bug',
  'snake',
  'slime',
  'ghost',
  'butterfly',
  'frog',
  'person',
  'tree',
  'flower',
  'mushroom',
  'cloud',
  'star',
  'sun',
  'moon',
  'leaf',
  'apple',
  'coin',
  'gem',
  'heart',
  'key',
  'sword',
  'shield',
  'bomb',
  'rocket',
  'car',
  'house',
  'crab',
  'octopus',
  'jellyfish',
  'whale',
  'anchor',
  'snail',
  'spider',
  'robot',
  'banana',
  'potion',
] as const;

export type ArtKind = (typeof ART_KINDS)[number];

/** noun → canonical kind. Lets the agent (or a brief) say "salmon", "spaceship",
 *  "monster", "puppy" and still get the right silhouette. Every value MUST be a
 *  member of `ART_KINDS` (asserted in the test). */
export const ART_SYNONYMS: Record<string, ArtKind> = {
  // fish
  salmon: 'fish',
  cod: 'fish',
  tuna: 'fish',
  goldfish: 'fish',
  koi: 'fish',
  shark: 'fish',
  // bird
  chick: 'bird',
  chicken: 'bird',
  duck: 'bird',
  eagle: 'bird',
  sparrow: 'bird',
  owl: 'bird',
  parrot: 'bird',
  penguin: 'bird',
  // cat
  kitty: 'cat',
  kitten: 'cat',
  // dog
  puppy: 'dog',
  hound: 'dog',
  wolf: 'dog',
  fox: 'dog',
  // bug
  beetle: 'bug',
  ant: 'bug',
  ladybug: 'bug',
  insect: 'bug',
  bee: 'bug',
  // snake
  serpent: 'snake',
  worm: 'snake',
  // slime
  blob: 'slime',
  jelly: 'slime',
  ooze: 'slime',
  monster: 'slime',
  enemy: 'slime',
  foe: 'slime',
  // ghost
  spirit: 'ghost',
  phantom: 'ghost',
  specter: 'ghost',
  spectre: 'ghost',
  // butterfly
  moth: 'butterfly',
  // frog
  toad: 'frog',
  // person
  player: 'person',
  hero: 'person',
  human: 'person',
  man: 'person',
  woman: 'person',
  guy: 'person',
  girl: 'person',
  boy: 'person',
  character: 'person',
  knight: 'person',
  villager: 'person',
  chef: 'person',
  // tree
  oak: 'tree',
  pine: 'tree',
  palm: 'tree',
  bush: 'tree',
  // flower
  rose: 'flower',
  tulip: 'flower',
  daisy: 'flower',
  bloom: 'flower',
  // mushroom
  toadstool: 'mushroom',
  fungus: 'mushroom',
  // cloud
  fog: 'cloud',
  // star
  sparkle: 'star',
  // sun
  sunshine: 'sun',
  // moon
  crescent: 'moon',
  // leaf
  foliage: 'leaf',
  // apple
  fruit: 'apple',
  tomato: 'apple',
  cherry: 'apple',
  // coin
  gold: 'coin',
  money: 'coin',
  token: 'coin',
  ring: 'coin',
  // gem
  diamond: 'gem',
  crystal: 'gem',
  jewel: 'gem',
  emerald: 'gem',
  ruby: 'gem',
  // heart
  love: 'heart',
  life: 'heart',
  // key
  unlock: 'key',
  // sword
  blade: 'sword',
  knife: 'sword',
  dagger: 'sword',
  // shield
  defense: 'shield',
  armor: 'shield',
  // bomb
  mine: 'bomb',
  grenade: 'bomb',
  tnt: 'bomb',
  // rocket
  ship: 'rocket',
  spaceship: 'rocket',
  spacecraft: 'rocket',
  ufo: 'rocket',
  missile: 'rocket',
  // car
  vehicle: 'car',
  truck: 'car',
  auto: 'car',
  // house
  home: 'house',
  building: 'house',
  hut: 'house',
  castle: 'house',
  // crab
  lobster: 'crab',
  // octopus
  squid: 'octopus',
  kraken: 'octopus',
  // jellyfish
  medusa: 'jellyfish',
  // whale
  dolphin: 'whale',
  orca: 'whale',
  // snail
  slug: 'snail',
  // spider
  tarantula: 'spider',
  // robot
  bot: 'robot',
  android: 'robot',
  droid: 'robot',
  mech: 'robot',
  // potion
  flask: 'potion',
  elixir: 'potion',
  brew: 'potion',
};

const ART_KIND_SET = new Set<string>(ART_KINDS);

/**
 * Resolve a free-text noun to a canonical silhouette kind, or `null` when there
 * is no built-in silhouette (the caller then falls back to the labelled crest).
 * Mirrors the in-iframe resolver byte-for-byte (case-insensitive, synonym table,
 * naive plural strip). Pure + exported so the agent tooling / tests can reuse it.
 */
export function resolveArtKind(name: string | null | undefined): ArtKind | null {
  const n = String(name ?? '')
    .toLowerCase()
    .trim();
  if (!n) return null;
  if (ART_KIND_SET.has(n)) return n as ArtKind;
  if (ART_SYNONYMS[n]) return ART_SYNONYMS[n];
  if (n.charAt(n.length - 1) === 's') {
    const g = n.slice(0, -1);
    if (ART_KIND_SET.has(g)) return g as ArtKind;
    if (ART_SYNONYMS[g]) return ART_SYNONYMS[g];
  }
  return null;
}

/** Canonical default fill per kind — used when the caller passes no `fill`, so a
 *  tree is green and a coin is gold even before the agent themes it. */
const DEFAULT_FILL: Record<ArtKind, string> = {
  fish: '#ff8a3d',
  bird: '#4db6ff',
  cat: '#f0a23b',
  dog: '#c79a5b',
  bug: '#e5484d',
  snake: '#4caf6a',
  slime: '#7ad14f',
  ghost: '#eef1fb',
  butterfly: '#ff7ad1',
  frog: '#5fbf57',
  person: '#5b8cff',
  tree: '#3fae5a',
  flower: '#ff6aa8',
  mushroom: '#e5484d',
  cloud: '#eef2fb',
  star: '#ffcf4d',
  sun: '#ffd23d',
  moon: '#e8edff',
  leaf: '#46b35a',
  apple: '#e5484d',
  coin: '#ffcf4d',
  gem: '#36d6e6',
  heart: '#ff4d6d',
  key: '#f4c542',
  sword: '#cdd6e6',
  shield: '#5b8cff',
  bomb: '#2b2f3a',
  rocket: '#ff5d5d',
  car: '#ff5d5d',
  house: '#e0c089',
  crab: '#e5563b',
  octopus: '#b25fd6',
  jellyfish: '#ff8fcf',
  whale: '#5b8cff',
  anchor: '#9aa7bd',
  snail: '#c79a5b',
  spider: '#2b2f3a',
  robot: '#9aa7bd',
  banana: '#ffd23d',
  potion: '#7ad14f',
};

/**
 * Emit the browser IIFE that installs `window.__game.art`. Embeds the synonym +
 * default-fill tables as JSON so the in-iframe resolver matches `resolveArtKind`.
 * Injected verbatim into the bootstrap `<script>` by `gameGlobalSetupSnippet`.
 *
 * API surface (mirrored in the engine guides):
 *   art.draw(ctx, kind, x, y, size, opts?) → canonical kind | null. Draws a
 *       silhouette of `kind` centred at (x,y), fitting a `size`×`size` box.
 *       opts: { fill, stroke, accent, rotate (rad), flip (bool) }. Unknown nouns
 *       draw a labelled crest (never a bare circle). Wrapped in try/catch so a
 *       bad call can never crash the game loop.
 *   art.sprite(kind, size, opts?) → HTMLCanvasElement | null. Bakes a silhouette
 *       to an offscreen canvas for phaser `scene.textures.addCanvas(key, cv)` or
 *       a three `CanvasTexture(cv)`.
 *   art.has(name) → boolean (a real silhouette exists, not just the crest).
 *   art.list() → string[] of canonical kinds.  art.resolve(name) → kind | null.
 */
export function artLibSource(): string {
  const syn = JSON.stringify(ART_SYNONYMS);
  const fills = JSON.stringify(DEFAULT_FILL);
  return `(function () {
  if (typeof window === 'undefined') return;
  window.__game = window.__game || {};
  if (window.__game.art) return;
  var TAU = Math.PI * 2;
  var SYN = ${syn};
  var DEFAULT_FILL = ${fills};

  function dot(ctx, x, y, r, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function clamp(v) { v = v | 0; return v < 0 ? 0 : v > 255 ? 255 : v; }
  function hexRGB(hex) {
    if (typeof hex !== 'string') return null;
    var m = hex.replace('#', '');
    if (m.length === 3) m = m.charAt(0) + m.charAt(0) + m.charAt(1) + m.charAt(1) + m.charAt(2) + m.charAt(2);
    if (m.length !== 6 || /[^0-9a-f]/i.test(m)) return null;
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  }
  function darken(hex, f) { var c = hexRGB(hex); if (!c) return hex; return 'rgb(' + clamp(c[0] * f) + ',' + clamp(c[1] * f) + ',' + clamp(c[2] * f) + ')'; }
  function lighten(hex, f) { var c = hexRGB(hex); if (!c) return hex; return 'rgb(' + clamp(c[0] + (255 - c[0]) * (f - 1)) + ',' + clamp(c[1] + (255 - c[1]) * (f - 1)) + ',' + clamp(c[2] + (255 - c[2]) * (f - 1)) + ')'; }
  function inkFor(base) {
    var c = hexRGB(base);
    if (c) { var l = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; return l > 0.6 ? '#10131c' : '#f6f8ff'; }
    var m = /hsl\\(\\s*\\d+\\s*,\\s*\\d+%\\s*,\\s*(\\d+)%/.exec(String(base));
    if (m) return (+m[1]) > 62 ? '#10131c' : '#f6f8ff';
    return '#10131c';
  }
  function hashColor(s) { s = String(s || ''); var h = 0, i; for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return 'hsl(' + (h % 360) + ',64%,58%)'; }

  function resolve(name) {
    var n = String(name == null ? '' : name).toLowerCase().trim();
    if (!n) return null;
    if (DRAW[n]) return n;
    if (SYN[n]) return SYN[n];
    if (n.charAt(n.length - 1) === 's') { var g = n.slice(0, -1); if (DRAW[g]) return g; if (SYN[g]) return SYN[g]; }
    return null;
  }
  function colors(opts, kind) {
    var base = (opts && opts.fill) || DEFAULT_FILL[kind] || hashColor(kind);
    return {
      fill: base,
      dark: (opts && opts.stroke) || darken(base, 0.62),
      light: lighten(base, 1.25),
      accent: (opts && opts.accent) || null,
      eye: '#15151c',
      ink: inkFor(base)
    };
  }

  var DRAW = {
    fish: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.9, s * 0.58, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.68, 0); ctx.lineTo(-s * 1.12, -s * 0.5); ctx.lineTo(-s * 1.12, s * 0.5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.dark; ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.52); ctx.lineTo(s * 0.22, -s * 0.92); ctx.lineTo(s * 0.4, -s * 0.48); ctx.closePath(); ctx.fill();
      dot(ctx, s * 0.5, -s * 0.12, s * 0.13, '#fff'); dot(ctx, s * 0.54, -s * 0.12, s * 0.06, c.eye);
    },
    bird: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.ellipse(0, s * 0.12, s * 0.68, s * 0.58, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.45, -s * 0.42, s * 0.42, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffb13d'; ctx.beginPath(); ctx.moveTo(s * 0.82, -s * 0.5); ctx.lineTo(s * 1.2, -s * 0.34); ctx.lineTo(s * 0.82, -s * 0.18); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.dark; ctx.beginPath(); ctx.moveTo(-s * 0.2, 0); ctx.quadraticCurveTo(-s * 0.9, s * 0.2, -s * 0.1, s * 0.52); ctx.closePath(); ctx.fill();
      dot(ctx, s * 0.55, -s * 0.48, s * 0.09, c.eye);
    },
    cat: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(-s * 0.7, -s * 0.2); ctx.lineTo(-s * 0.45, -s * 0.98); ctx.lineTo(-s * 0.08, -s * 0.45); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s * 0.7, -s * 0.2); ctx.lineTo(s * 0.45, -s * 0.98); ctx.lineTo(s * 0.08, -s * 0.45); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(0, s * 0.05, s * 0.72, 0, TAU); ctx.fill();
      dot(ctx, -s * 0.28, -s * 0.04, s * 0.1, c.eye); dot(ctx, s * 0.28, -s * 0.04, s * 0.1, c.eye);
      dot(ctx, 0, s * 0.22, s * 0.07, c.dark);
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.035);
      ctx.beginPath();
      ctx.moveTo(s * 0.12, s * 0.24); ctx.lineTo(s * 0.72, s * 0.14); ctx.moveTo(s * 0.12, s * 0.32); ctx.lineTo(s * 0.72, s * 0.36);
      ctx.moveTo(-s * 0.12, s * 0.24); ctx.lineTo(-s * 0.72, s * 0.14); ctx.moveTo(-s * 0.12, s * 0.32); ctx.lineTo(-s * 0.72, s * 0.36);
      ctx.stroke();
    },
    dog: function (ctx, s, c) {
      ctx.fillStyle = c.dark;
      ctx.beginPath(); ctx.ellipse(-s * 0.6, -s * 0.08, s * 0.28, s * 0.6, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.6, -s * 0.08, s * 0.28, s * 0.6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.arc(0, 0, s * 0.7, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, s * 0.46, s * 0.4, s * 0.3, 0, 0, TAU); ctx.fill();
      dot(ctx, -s * 0.26, -s * 0.1, s * 0.1, c.eye); dot(ctx, s * 0.26, -s * 0.1, s * 0.1, c.eye);
      dot(ctx, 0, s * 0.4, s * 0.12, c.eye);
    },
    bug: function (ctx, s, c) {
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.06);
      var i; for (i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(-s * 0.4, i * s * 0.35); ctx.lineTo(-s * 0.95, i * s * 0.52); ctx.moveTo(s * 0.4, i * s * 0.35); ctx.lineTo(s * 0.95, i * s * 0.52); ctx.stroke(); }
      ctx.fillStyle = c.dark; ctx.beginPath(); ctx.arc(0, -s * 0.72, s * 0.32, 0, TAU); ctx.fill();
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.ellipse(0, s * 0.05, s * 0.72, s * 0.85, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.dark; ctx.beginPath(); ctx.moveTo(0, -s * 0.78); ctx.lineTo(0, s * 0.9); ctx.stroke();
      dot(ctx, -s * 0.32, -s * 0.08, s * 0.12, c.dark); dot(ctx, s * 0.32, s * 0.3, s * 0.12, c.dark); dot(ctx, -s * 0.3, s * 0.46, s * 0.1, c.dark); dot(ctx, s * 0.28, -s * 0.26, s * 0.1, c.dark);
    },
    snake: function (ctx, s, c) {
      ctx.strokeStyle = c.fill; ctx.lineWidth = s * 0.46; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-s * 0.9, s * 0.45); ctx.quadraticCurveTo(-s * 0.2, -s * 0.6, s * 0.2, s * 0.1); ctx.quadraticCurveTo(s * 0.5, s * 0.6, s * 0.82, -s * 0.3); ctx.stroke();
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.arc(s * 0.82, -s * 0.3, s * 0.3, 0, TAU); ctx.fill();
      dot(ctx, s * 0.92, -s * 0.4, s * 0.07, c.eye);
      ctx.strokeStyle = '#e5484d'; ctx.lineWidth = Math.max(1, s * 0.05); ctx.beginPath(); ctx.moveTo(s * 1.08, -s * 0.3); ctx.lineTo(s * 1.32, -s * 0.42); ctx.stroke();
    },
    slime: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.moveTo(-s * 0.9, s * 0.7); ctx.quadraticCurveTo(-s * 0.95, -s * 0.9, 0, -s * 0.85); ctx.quadraticCurveTo(s * 0.95, -s * 0.9, s * 0.9, s * 0.7);
      ctx.lineTo(s * 0.6, s * 0.5); ctx.lineTo(s * 0.3, s * 0.76); ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.3, s * 0.76); ctx.lineTo(-s * 0.6, s * 0.5);
      ctx.closePath(); ctx.fill();
      dot(ctx, -s * 0.3, -s * 0.1, s * 0.15, '#fff'); dot(ctx, s * 0.3, -s * 0.1, s * 0.15, '#fff');
      dot(ctx, -s * 0.27, -s * 0.05, s * 0.07, c.eye); dot(ctx, s * 0.33, -s * 0.05, s * 0.07, c.eye);
    },
    ghost: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(0, -s * 0.1, s * 0.75, Math.PI, 0);
      ctx.lineTo(s * 0.75, s * 0.7); ctx.lineTo(s * 0.45, s * 0.46); ctx.lineTo(s * 0.15, s * 0.72); ctx.lineTo(-s * 0.15, s * 0.46); ctx.lineTo(-s * 0.45, s * 0.72); ctx.lineTo(-s * 0.75, s * 0.46);
      ctx.closePath(); ctx.fill();
      dot(ctx, -s * 0.28, -s * 0.15, s * 0.13, c.eye); dot(ctx, s * 0.28, -s * 0.15, s * 0.13, c.eye);
    },
    butterfly: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.ellipse(-s * 0.45, -s * 0.32, s * 0.45, s * 0.4, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.45, -s * 0.32, s * 0.45, s * 0.4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = c.dark;
      ctx.beginPath(); ctx.ellipse(-s * 0.4, s * 0.42, s * 0.36, s * 0.3, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.4, s * 0.42, s * 0.36, s * 0.3, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = c.eye; ctx.beginPath(); ctx.ellipse(0, s * 0.02, s * 0.1, s * 0.68, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.eye; ctx.lineWidth = Math.max(1, s * 0.04);
      ctx.beginPath(); ctx.moveTo(0, -s * 0.6); ctx.quadraticCurveTo(-s * 0.2, -s, -s * 0.36, -s * 0.95); ctx.moveTo(0, -s * 0.6); ctx.quadraticCurveTo(s * 0.2, -s, s * 0.36, -s * 0.95); ctx.stroke();
    },
    frog: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.arc(-s * 0.4, -s * 0.52, s * 0.3, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.4, -s * 0.52, s * 0.3, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, s * 0.18, s * 0.85, s * 0.62, 0, 0, TAU); ctx.fill();
      dot(ctx, -s * 0.4, -s * 0.52, s * 0.13, '#fff'); dot(ctx, s * 0.4, -s * 0.52, s * 0.13, '#fff');
      dot(ctx, -s * 0.4, -s * 0.48, s * 0.06, c.eye); dot(ctx, s * 0.4, -s * 0.48, s * 0.06, c.eye);
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.05); ctx.beginPath(); ctx.arc(0, s * 0.12, s * 0.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    },
    person: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.moveTo(-s * 0.5, s * 0.92); ctx.lineTo(-s * 0.32, -s * 0.08); ctx.quadraticCurveTo(-s * 0.3, -s * 0.26, -s * 0.1, -s * 0.26);
      ctx.lineTo(s * 0.1, -s * 0.26); ctx.quadraticCurveTo(s * 0.3, -s * 0.26, s * 0.32, -s * 0.08); ctx.lineTo(s * 0.5, s * 0.92);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.light; ctx.beginPath(); ctx.arc(0, -s * 0.56, s * 0.34, 0, TAU); ctx.fill();
    },
    tree: function (ctx, s, c) {
      ctx.fillStyle = '#6b4a2b'; ctx.fillRect(-s * 0.14, s * 0.1, s * 0.28, s * 0.85);
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.arc(0, -s * 0.38, s * 0.55, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(-s * 0.45, s * 0.0, s * 0.42, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.45, s * 0.0, s * 0.42, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(0, s * 0.12, s * 0.5, 0, TAU); ctx.fill();
    },
    flower: function (ctx, s, c) {
      ctx.strokeStyle = '#3aa35a'; ctx.lineWidth = Math.max(2, s * 0.12); ctx.beginPath(); ctx.moveTo(0, s * 0.95); ctx.lineTo(0, s * 0.05); ctx.stroke();
      ctx.fillStyle = c.fill;
      var i; for (i = 0; i < 6; i++) { var a = i / 6 * TAU; ctx.beginPath(); ctx.ellipse(Math.cos(a) * s * 0.42, -s * 0.28 + Math.sin(a) * s * 0.42, s * 0.26, s * 0.4, a, 0, TAU); ctx.fill(); }
      dot(ctx, 0, -s * 0.28, s * 0.27, c.accent || '#ffd34d');
    },
    mushroom: function (ctx, s, c) {
      ctx.fillStyle = '#f4f1e8';
      ctx.beginPath(); ctx.moveTo(-s * 0.32, s * 0.9); ctx.quadraticCurveTo(-s * 0.42, 0, 0, -s * 0.05); ctx.quadraticCurveTo(s * 0.42, 0, s * 0.32, s * 0.9); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.ellipse(0, -s * 0.05, s * 0.95, s * 0.72, 0, Math.PI, TAU); ctx.fill();
      dot(ctx, -s * 0.4, -s * 0.22, s * 0.14, '#fff'); dot(ctx, s * 0.36, -s * 0.32, s * 0.12, '#fff'); dot(ctx, s * 0.06, -s * 0.48, s * 0.1, '#fff');
    },
    cloud: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(-s * 0.5, s * 0.1, s * 0.4, 0, TAU);
      ctx.arc(0, -s * 0.2, s * 0.55, 0, TAU);
      ctx.arc(s * 0.55, s * 0.0, s * 0.45, 0, TAU);
      ctx.arc(s * 0.15, s * 0.28, s * 0.4, 0, TAU);
      ctx.rect(-s * 0.9, s * 0.1, s * 1.6, s * 0.4);
      ctx.fill();
    },
    star: function (ctx, s, c) {
      ctx.fillStyle = c.fill; ctx.beginPath();
      var i, a, r; for (i = 0; i < 10; i++) { a = -Math.PI / 2 + i * Math.PI / 5; r = (i % 2 === 0) ? s : s * 0.45; if (i) ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.closePath(); ctx.fill();
    },
    sun: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      var i; for (i = 0; i < 12; i++) { var a = i / 12 * TAU; ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(s * 0.7, -s * 0.08); ctx.lineTo(s * 1.05, 0); ctx.lineTo(s * 0.7, s * 0.08); ctx.closePath(); ctx.fill(); ctx.restore(); }
      ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, TAU); ctx.fill();
    },
    moon: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.82, Math.PI * 0.5, Math.PI * 1.5, false);
      ctx.arc(s * 0.3, 0, s * 0.74, Math.PI * 1.5, Math.PI * 0.5, true);
      ctx.closePath(); ctx.fill();
    },
    leaf: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(0, s * 0.9); ctx.quadraticCurveTo(-s * 0.9, 0, 0, -s * 0.9); ctx.quadraticCurveTo(s * 0.9, 0, 0, s * 0.9); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.06); ctx.beginPath(); ctx.moveTo(0, s * 0.8); ctx.lineTo(0, -s * 0.8); ctx.stroke();
    },
    apple: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.arc(-s * 0.32, s * 0.05, s * 0.55, 0, TAU); ctx.arc(s * 0.32, s * 0.05, s * 0.55, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, s * 0.15, s * 0.7, s * 0.62, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#6b4a2b'; ctx.lineWidth = Math.max(2, s * 0.1); ctx.beginPath(); ctx.moveTo(0, -s * 0.4); ctx.quadraticCurveTo(s * 0.12, -s * 0.72, s * 0.26, -s * 0.62); ctx.stroke();
      ctx.fillStyle = '#3aa35a'; ctx.beginPath(); ctx.ellipse(s * 0.3, -s * 0.6, s * 0.22, s * 0.1, -0.6, 0, TAU); ctx.fill();
    },
    coin: function (ctx, s, c) {
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.arc(0, 0, s * 0.9, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.08); ctx.beginPath(); ctx.arc(0, 0, s * 0.66, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(-s * 0.3, -s * 0.3, s * 0.12, s * 0.28, -0.7, 0, TAU); ctx.fill();
    },
    gem: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.8); ctx.lineTo(s * 0.85, -s * 0.2); ctx.lineTo(0, s * 0.85); ctx.lineTo(-s * 0.85, -s * 0.2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.beginPath(); ctx.moveTo(-s * 0.85, -s * 0.2); ctx.lineTo(s * 0.85, -s * 0.2); ctx.moveTo(0, -s * 0.8); ctx.lineTo(-s * 0.3, -s * 0.2); ctx.lineTo(0, s * 0.85); ctx.moveTo(0, -s * 0.8); ctx.lineTo(s * 0.3, -s * 0.2); ctx.lineTo(0, s * 0.85); ctx.stroke();
    },
    heart: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(0, s * 0.75);
      ctx.bezierCurveTo(-s * 1.1, -s * 0.1, -s * 0.5, -s * 0.95, 0, -s * 0.3);
      ctx.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.1, -s * 0.1, 0, s * 0.75);
      ctx.closePath(); ctx.fill();
    },
    key: function (ctx, s, c) {
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.arc(-s * 0.5, 0, s * 0.45, 0, TAU); ctx.fill();
      ctx.fillStyle = c.dark; ctx.beginPath(); ctx.arc(-s * 0.5, 0, s * 0.18, 0, TAU); ctx.fill();
      ctx.fillStyle = c.fill; ctx.fillRect(-s * 0.1, -s * 0.13, s * 0.95, s * 0.26);
      ctx.fillRect(s * 0.6, 0, s * 0.14, s * 0.4); ctx.fillRect(s * 0.35, 0, s * 0.12, s * 0.32);
    },
    sword: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.95); ctx.lineTo(s * 0.16, -s * 0.6); ctx.lineTo(s * 0.16, s * 0.35); ctx.lineTo(-s * 0.16, s * 0.35); ctx.lineTo(-s * 0.16, -s * 0.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#7a5a2e'; ctx.fillRect(-s * 0.5, s * 0.35, s, s * 0.16);
      ctx.fillStyle = '#9a6b34'; ctx.fillRect(-s * 0.1, s * 0.51, s * 0.2, s * 0.4);
      ctx.fillStyle = '#caa24a'; ctx.beginPath(); ctx.arc(0, s * 0.93, s * 0.13, 0, TAU); ctx.fill();
    },
    shield: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.moveTo(-s * 0.75, -s * 0.7); ctx.lineTo(s * 0.75, -s * 0.7); ctx.lineTo(s * 0.75, s * 0.1);
      ctx.quadraticCurveTo(s * 0.7, s * 0.7, 0, s * 0.95); ctx.quadraticCurveTo(-s * 0.7, s * 0.7, -s * 0.75, s * 0.1);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = c.accent || '#ffd34d'; ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.beginPath(); ctx.moveTo(0, -s * 0.5); ctx.lineTo(0, s * 0.6); ctx.moveTo(-s * 0.45, s * 0.0); ctx.lineTo(s * 0.45, s * 0.0); ctx.stroke();
    },
    bomb: function (ctx, s, c) {
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.arc(0, s * 0.2, s * 0.7, 0, TAU); ctx.fill();
      ctx.fillStyle = c.dark; ctx.fillRect(-s * 0.16, -s * 0.55, s * 0.32, s * 0.3);
      ctx.strokeStyle = '#b88a3a'; ctx.lineWidth = Math.max(1, s * 0.08); ctx.beginPath(); ctx.moveTo(0, -s * 0.5); ctx.quadraticCurveTo(s * 0.4, -s * 0.85, s * 0.5, -s * 0.5); ctx.stroke();
      dot(ctx, s * 0.5, -s * 0.5, s * 0.12, '#ffcf4d'); dot(ctx, s * 0.5, -s * 0.5, s * 0.06, '#ff6a3d');
      dot(ctx, -s * 0.25, -s * 0.02, s * 0.16, 'rgba(255,255,255,0.22)');
    },
    rocket: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.95); ctx.quadraticCurveTo(s * 0.5, -s * 0.3, s * 0.4, s * 0.5); ctx.lineTo(-s * 0.4, s * 0.5); ctx.quadraticCurveTo(-s * 0.5, -s * 0.3, 0, -s * 0.95); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.dark;
      ctx.beginPath(); ctx.moveTo(-s * 0.4, s * 0.2); ctx.lineTo(-s * 0.75, s * 0.7); ctx.lineTo(-s * 0.4, s * 0.55); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s * 0.4, s * 0.2); ctx.lineTo(s * 0.75, s * 0.7); ctx.lineTo(s * 0.4, s * 0.55); ctx.closePath(); ctx.fill();
      dot(ctx, 0, -s * 0.2, s * 0.2, '#9fd8ff');
      ctx.fillStyle = '#ff9f1c'; ctx.beginPath(); ctx.moveTo(-s * 0.22, s * 0.5); ctx.lineTo(0, s); ctx.lineTo(s * 0.22, s * 0.5); ctx.closePath(); ctx.fill();
    },
    car: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      rrect(ctx, -s * 0.95, -s * 0.1, s * 1.9, s * 0.6, s * 0.15); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.5, -s * 0.1); ctx.lineTo(-s * 0.3, -s * 0.6); ctx.lineTo(s * 0.35, -s * 0.6); ctx.lineTo(s * 0.55, -s * 0.1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9fd8ff'; ctx.beginPath(); ctx.moveTo(-s * 0.35, -s * 0.13); ctx.lineTo(-s * 0.22, -s * 0.5); ctx.lineTo(s * 0.28, -s * 0.5); ctx.lineTo(s * 0.42, -s * 0.13); ctx.closePath(); ctx.fill();
      dot(ctx, -s * 0.5, s * 0.5, s * 0.24, '#1c1f27'); dot(ctx, s * 0.5, s * 0.5, s * 0.24, '#1c1f27');
      dot(ctx, -s * 0.5, s * 0.5, s * 0.1, '#5b626f'); dot(ctx, s * 0.5, s * 0.5, s * 0.1, '#5b626f');
    },
    house: function (ctx, s, c) {
      ctx.fillStyle = c.fill; ctx.fillRect(-s * 0.7, -s * 0.1, s * 1.4, s * 0.95);
      ctx.fillStyle = c.dark; ctx.beginPath(); ctx.moveTo(-s * 0.9, -s * 0.05); ctx.lineTo(0, -s * 0.85); ctx.lineTo(s * 0.9, -s * 0.05); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#7a5a2e'; ctx.fillRect(-s * 0.18, s * 0.3, s * 0.36, s * 0.55);
      ctx.fillStyle = '#9fd8ff'; ctx.fillRect(s * 0.25, s * 0.05, s * 0.3, s * 0.3);
    },
    crab: function (ctx, s, c) {
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.06); ctx.lineCap = 'round';
      var i; for (i = 0; i < 3; i++) { var yy = i * s * 0.22; ctx.beginPath(); ctx.moveTo(-s * 0.5, yy); ctx.lineTo(-s * 0.95, yy + s * 0.14); ctx.moveTo(s * 0.5, yy); ctx.lineTo(s * 0.95, yy + s * 0.14); ctx.stroke(); }
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.ellipse(0, s * 0.1, s * 0.75, s * 0.5, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-s * 0.85, -s * 0.25, s * 0.26, s * 0.18, -0.5, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.85, -s * 0.25, s * 0.26, s * 0.18, 0.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.fill; ctx.lineWidth = Math.max(1, s * 0.06); ctx.beginPath(); ctx.moveTo(-s * 0.2, -s * 0.3); ctx.lineTo(-s * 0.2, -s * 0.55); ctx.moveTo(s * 0.2, -s * 0.3); ctx.lineTo(s * 0.2, -s * 0.55); ctx.stroke();
      dot(ctx, -s * 0.2, -s * 0.58, s * 0.1, '#fff'); dot(ctx, s * 0.2, -s * 0.58, s * 0.1, '#fff');
      dot(ctx, -s * 0.2, -s * 0.58, s * 0.05, c.eye); dot(ctx, s * 0.2, -s * 0.58, s * 0.05, c.eye);
    },
    octopus: function (ctx, s, c) {
      ctx.fillStyle = c.fill; ctx.strokeStyle = c.fill; ctx.lineCap = 'round';
      var i; for (i = 0; i < 5; i++) { var x = -s * 0.55 + i * s * 0.275; ctx.lineWidth = s * 0.18; ctx.beginPath(); ctx.moveTo(x, s * 0.05); ctx.quadraticCurveTo(x - s * 0.1, s * 0.6, x + (i % 2 ? 1 : -1) * s * 0.16, s * 0.9); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.6, Math.PI, 0); ctx.lineTo(s * 0.6, s * 0.12); ctx.lineTo(-s * 0.6, s * 0.12); ctx.closePath(); ctx.fill();
      dot(ctx, -s * 0.22, -s * 0.25, s * 0.14, '#fff'); dot(ctx, s * 0.22, -s * 0.25, s * 0.14, '#fff');
      dot(ctx, -s * 0.22, -s * 0.22, s * 0.07, c.eye); dot(ctx, s * 0.22, -s * 0.22, s * 0.07, c.eye);
    },
    jellyfish: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.arc(0, -s * 0.05, s * 0.62, Math.PI, 0); var k; for (k = 0; k < 4; k++) { var x0 = s * 0.62 - k * s * 0.31; ctx.quadraticCurveTo(x0 - s * 0.155, s * 0.12, x0 - s * 0.31, -s * 0.05); } ctx.closePath(); ctx.fill();
      ctx.strokeStyle = c.fill; ctx.lineWidth = Math.max(1, s * 0.05); ctx.lineCap = 'round';
      var i; for (i = 0; i < 5; i++) { var tx = -s * 0.45 + i * s * 0.225; ctx.beginPath(); ctx.moveTo(tx, s * 0.05); ctx.quadraticCurveTo(tx + s * 0.12, s * 0.55, tx - s * 0.06, s * 0.92); ctx.stroke(); }
      dot(ctx, -s * 0.18, -s * 0.18, s * 0.08, 'rgba(255,255,255,0.6)'); dot(ctx, s * 0.18, -s * 0.18, s * 0.08, 'rgba(255,255,255,0.6)');
    },
    whale: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.ellipse(-s * 0.1, s * 0.05, s * 0.85, s * 0.5, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s * 0.6, 0); ctx.lineTo(s * 1.05, -s * 0.35); ctx.lineTo(s * 0.92, s * 0.05); ctx.lineTo(s * 1.05, s * 0.4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.ellipse(-s * 0.2, s * 0.28, s * 0.55, s * 0.2, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.fill; ctx.lineWidth = Math.max(1, s * 0.06); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-s * 0.5, -s * 0.4); ctx.lineTo(-s * 0.58, -s * 0.78); ctx.moveTo(-s * 0.5, -s * 0.4); ctx.lineTo(-s * 0.38, -s * 0.74); ctx.stroke();
      dot(ctx, -s * 0.45, -s * 0.05, s * 0.08, c.eye);
    },
    anchor: function (ctx, s, c) {
      ctx.strokeStyle = c.fill; ctx.lineWidth = Math.max(2, s * 0.15); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.arc(0, -s * 0.68, s * 0.2, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -s * 0.48); ctx.lineTo(0, s * 0.62); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.35, -s * 0.22); ctx.lineTo(s * 0.35, -s * 0.22); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, s * 0.62); ctx.quadraticCurveTo(-s * 0.72, s * 0.5, -s * 0.6, s * 0.02); ctx.moveTo(0, s * 0.62); ctx.quadraticCurveTo(s * 0.72, s * 0.5, s * 0.6, s * 0.02); ctx.stroke();
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.02); ctx.lineTo(-s * 0.78, s * 0.12); ctx.lineTo(-s * 0.48, s * 0.2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s * 0.6, s * 0.02); ctx.lineTo(s * 0.78, s * 0.12); ctx.lineTo(s * 0.48, s * 0.2); ctx.closePath(); ctx.fill();
    },
    snail: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.moveTo(-s * 0.9, s * 0.5); ctx.quadraticCurveTo(-s * 0.95, s * 0.78, -s * 0.55, s * 0.78); ctx.lineTo(s * 0.5, s * 0.78); ctx.quadraticCurveTo(s * 0.95, s * 0.78, s * 0.72, s * 0.32); ctx.lineTo(-s * 0.4, s * 0.32); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.62, s * 0.35, s * 0.22, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.fill; ctx.lineWidth = Math.max(1, s * 0.05); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(s * 0.6, s * 0.15); ctx.lineTo(s * 0.6, -s * 0.18); ctx.moveTo(s * 0.74, s * 0.18); ctx.lineTo(s * 0.86, -s * 0.12); ctx.stroke();
      dot(ctx, s * 0.6, -s * 0.2, s * 0.06, c.eye); dot(ctx, s * 0.88, -s * 0.14, s * 0.06, c.eye);
      ctx.fillStyle = c.accent || '#e0a44d'; ctx.beginPath(); ctx.arc(-s * 0.15, s * 0.1, s * 0.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.06); ctx.beginPath(); ctx.arc(-s * 0.15, s * 0.1, s * 0.33, 0, TAU * 0.85); ctx.stroke(); ctx.beginPath(); ctx.arc(-s * 0.1, s * 0.12, s * 0.16, 0, TAU * 0.85); ctx.stroke();
    },
    spider: function (ctx, s, c) {
      ctx.strokeStyle = c.fill; ctx.lineWidth = Math.max(1, s * 0.06); ctx.lineCap = 'round';
      var i; for (i = 0; i < 4; i++) { var yy = -s * 0.2 + i * s * 0.2; ctx.beginPath(); ctx.moveTo(-s * 0.2, yy); ctx.quadraticCurveTo(-s * 0.7, yy - s * 0.1, -s * 0.85, yy + s * 0.28); ctx.stroke(); ctx.beginPath(); ctx.moveTo(s * 0.2, yy); ctx.quadraticCurveTo(s * 0.7, yy - s * 0.1, s * 0.85, yy + s * 0.28); ctx.stroke(); }
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.ellipse(0, s * 0.18, s * 0.42, s * 0.5, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -s * 0.35, s * 0.3, 0, TAU); ctx.fill();
      dot(ctx, -s * 0.12, -s * 0.4, s * 0.08, '#fff'); dot(ctx, s * 0.12, -s * 0.4, s * 0.08, '#fff');
      dot(ctx, -s * 0.12, -s * 0.38, s * 0.04, c.eye); dot(ctx, s * 0.12, -s * 0.38, s * 0.04, c.eye);
    },
    robot: function (ctx, s, c) {
      ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1, s * 0.05); ctx.beginPath(); ctx.moveTo(0, -s * 0.55); ctx.lineTo(0, -s * 0.85); ctx.stroke();
      dot(ctx, 0, -s * 0.88, s * 0.08, c.accent || '#ff5d7a');
      ctx.fillStyle = c.fill; rrect(ctx, -s * 0.45, -s * 0.55, s * 0.9, s * 0.55, s * 0.12); ctx.fill();
      dot(ctx, -s * 0.18, -s * 0.28, s * 0.1, '#46e6f0'); dot(ctx, s * 0.18, -s * 0.28, s * 0.1, '#46e6f0');
      ctx.fillStyle = c.fill; rrect(ctx, -s * 0.55, s * 0.05, s * 1.1, s * 0.7, s * 0.1); ctx.fill();
      ctx.fillStyle = c.dark; rrect(ctx, -s * 0.78, s * 0.1, s * 0.2, s * 0.5, s * 0.08); ctx.fill(); rrect(ctx, s * 0.58, s * 0.1, s * 0.2, s * 0.5, s * 0.08); ctx.fill();
      dot(ctx, 0, s * 0.35, s * 0.1, c.accent || '#ffcf4d');
    },
    banana: function (ctx, s, c) {
      ctx.fillStyle = c.fill;
      ctx.beginPath(); ctx.arc(s * 0.1, -s * 0.35, s * 0.95, Math.PI * 0.35, Math.PI * 0.92, false); ctx.arc(s * 0.1, -s * 0.35, s * 0.62, Math.PI * 0.92, Math.PI * 0.35, true); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.dark; dot(ctx, -s * 0.5, s * 0.2, s * 0.08, c.dark); dot(ctx, s * 0.62, s * 0.18, s * 0.08, c.dark);
    },
    potion: function (ctx, s, c) {
      ctx.fillStyle = 'rgba(225,235,245,0.22)'; ctx.fillRect(-s * 0.18, -s * 0.55, s * 0.36, s * 0.55); ctx.beginPath(); ctx.arc(0, s * 0.25, s * 0.55, 0, TAU); ctx.fill();
      ctx.fillStyle = c.fill; ctx.beginPath(); ctx.arc(0, s * 0.3, s * 0.45, 0, TAU); ctx.fill(); ctx.fillRect(-s * 0.12, -s * 0.2, s * 0.24, s * 0.5);
      ctx.fillStyle = '#9a6b34'; ctx.fillRect(-s * 0.2, -s * 0.72, s * 0.4, s * 0.22);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.ellipse(-s * 0.22, s * 0.18, s * 0.08, s * 0.18, -0.5, 0, TAU); ctx.fill();
      dot(ctx, s * 0.12, s * 0.28, s * 0.06, 'rgba(255,255,255,0.55)'); dot(ctx, -s * 0.04, s * 0.46, s * 0.04, 'rgba(255,255,255,0.5)');
    }
  };

  function crest(ctx, s, c, name) {
    ctx.fillStyle = c.fill; rrect(ctx, -s * 0.8, -s * 0.85, s * 1.6, s * 1.7, s * 0.32); ctx.fill();
    ctx.strokeStyle = c.dark; ctx.lineWidth = Math.max(1.5, s * 0.1); rrect(ctx, -s * 0.8, -s * 0.85, s * 1.6, s * 1.7, s * 0.32); ctx.stroke();
    var label = String(name == null ? '' : name).replace(/[^a-z0-9]/gi, '');
    label = label ? label.slice(0, 2).toUpperCase() : '?';
    ctx.fillStyle = c.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold ' + Math.max(8, Math.floor(s * 0.92)) + 'px system-ui, sans-serif';
    ctx.fillText(label, 0, s * 0.04);
  }

  function draw(ctx, kind, x, y, size, opts) {
    if (!ctx) return null;
    opts = opts || {};
    size = (typeof size === 'number' && size > 0) ? size : 32;
    var s = size / 2;
    var resolved = resolve(kind);
    var c = colors(opts, resolved || kind);
    ctx.save();
    try {
      ctx.translate(x || 0, y || 0);
      if (opts.rotate) ctx.rotate(opts.rotate);
      if (opts.flip) ctx.scale(-1, 1);
      if (resolved && DRAW[resolved]) DRAW[resolved](ctx, s, c);
      else crest(ctx, s, c, kind);
    } catch (e) { /* a bad shape must never crash the game loop */ }
    ctx.restore();
    return resolved;
  }

  function sprite(kind, size, opts) {
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      var sz = (typeof size === 'number' && size > 0) ? size : 64;
      var cv = document.createElement('canvas'); cv.width = sz; cv.height = sz;
      var g = cv.getContext && cv.getContext('2d'); if (!g) return null;
      draw(g, kind, sz / 2, sz / 2, sz * 0.9, opts);
      return cv;
    } catch (e) { return null; }
  }

  function has(name) { return resolve(name) !== null; }
  function list() { var out = [], k; for (k in DRAW) out.push(k); return out; }

  window.__game.art = { draw: draw, sprite: sprite, has: has, list: list, kinds: list, resolve: resolve };
})();`;
}

/** Marker so a double pass (or a bootstrap that already embedded it) doesn't inject
 *  the art runtime twice. Mirrors the controls-runtime markers. */
export const ART_RUNTIME_MARKER = 'pf-art-runtime';

/** Script-tagged, marker-guarded art runtime for serve-time injection. The game
 *  bootstrap embeds this, and `injectControlsRuntime` re-injects it when serving a
 *  game whose author REPLACED index.html (so it lost the bootstrap shim) — exactly
 *  the case the controls runtime guards. The inner IIFE is idempotent (`if
 *  (window.__game.art) return`), so a stray double-include is harmless. */
export const ART_RUNTIME_SNIPPET = `<script data-pf="${ART_RUNTIME_MARKER}">${artLibSource()}</script>`;
