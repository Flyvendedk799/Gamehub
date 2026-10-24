/** Visual variation without constraining the user's game to a genre or setting.
 * Preserve declared camera choices; use visual suggestions only where compatible
 * with the brief. This catalog never introduces new gameplay rules. */

export interface Option {
  id: string;
  /** Short human label. */
  label: string;
  /** Concrete, buildable instruction. */
  how: string;
}

export const CAMERAS_3D: Option[] = [
  {
    id: 'side-on',
    label: 'side-on view',
    how: 'Frame the meaningful interaction plane clearly, with stable framing and no automatic orbit.',
  },
  {
    id: 'iso-high',
    label: 'isometric overview',
    how: 'Use an elevated oblique view that makes spatial relationships and selectable objects easy to read.',
  },
  {
    id: 'orbital',
    label: 'inspectable orbit',
    how: 'Allow deliberate orbit and zoom when inspection is part of the idea. Keep orientation and selection stable.',
  },
  {
    id: 'over-shoulder',
    label: 'third-person follow',
    how: 'Follow the controlled subject with damping and maintain clear sightlines to relevant interactions.',
  },
  {
    id: 'top-down',
    label: 'top-down overview',
    how: 'Show spatial relationships clearly from above; keep interaction targets and labels legible.',
  },
  {
    id: 'first-person',
    label: 'first-person view',
    how: 'Use the player viewpoint with responsive look controls, comfortable field of view and readable interaction cues.',
  },
];

export const LAYOUTS_2D: Option[] = [
  {
    id: 'fixed',
    label: 'single fixed screen',
    how: 'One screen, fixed camera; strong background layers for depth.',
  },
  {
    id: 'parallax',
    label: 'side view with parallax layers',
    how: 'Side-on view with 3-4 parallax background layers and a ground strip.',
  },
  {
    id: 'top-down',
    label: 'top-down with zoom pulse',
    how: 'Top-down view with a subtle zoom pulse on impacts and a vignette.',
  },
  {
    id: 'close-up',
    label: 'tight close framing',
    how: 'Tight framing that follows the action; large readable characters.',
  },
];

export const STYLES: Option[] = [
  {
    id: 'flat-lowpoly',
    label: 'flat-shaded low-poly',
    how: 'Flat-shaded faceted geometry, strong rim light, no textures.',
  },
  {
    id: 'toon-outline',
    label: 'toon / cel-shaded with outlines',
    how: 'Hard 2-3 band shading and dark outlines (inverted-hull shells or edge meshes).',
  },
  {
    id: 'voxel',
    label: 'blocky voxel look',
    how: 'Everything built from cubes and chunky blocks; stepped silhouettes.',
  },
  {
    id: 'painterly',
    label: 'soft painterly pastel',
    how: 'Soft gradients, gentle fog, glowing sprite highlights, warm bounce light.',
  },
  {
    id: 'noir',
    label: 'high-contrast noir with one accent colour',
    how: 'Near-monochrome world with a single saturated accent for the important things.',
  },
  {
    id: 'neon',
    label: 'neon synthwave',
    how: 'Dark scene with emissive neon edges, glow quads, reflective floor.',
  },
  {
    id: 'dusty-film',
    label: 'dusty desaturated film look',
    how: 'Muted palette, heavy vignette, drifting dust motes, grainy contrast.',
  },
  {
    id: 'diorama',
    label: 'chunky toy diorama',
    how: 'Miniature-set look: rounded chunky shapes, bright materials, tilt-shift feel.',
  },
];

// Composition suggestions work with the user's world; they do not choose a world for them.

export const SETTINGS: Option[] = [
  {
    id: 'layered',
    label: 'layered depth',
    how: 'Separate foreground interaction, middle-distance context and background atmosphere using the requested setting.',
  },
  {
    id: 'landmark',
    label: 'distinctive focal landmark',
    how: 'Give the requested world or board a recognizable focal motif while leaving interactive areas clear.',
  },
  {
    id: 'zones',
    label: 'readable regions',
    how: 'Group related spaces or information into visually distinct regions, using consistent boundaries and a coherent palette.',
  },
  {
    id: 'crafted',
    label: 'crafted details',
    how: 'Use small theme-specific details and varied silhouettes to make the requested objects recognizable.',
  },
  {
    id: 'negative-space',
    label: 'deliberate negative space',
    how: 'Give important interactions breathing room; concentrate detail around relevant choices rather than filling every surface.',
  },
  {
    id: 'changing-world',
    label: 'visible state changes',
    how: 'Let the scene or board visibly reflect the rules and changes already requested by the user.',
  },
];

export const LIGHTING: Option[] = [
  { id: 'golden-hour', label: 'golden hour', how: 'Low warm sun, long shadows, orange rim light.' },
  {
    id: 'moonlit',
    label: 'moonlit night',
    how: 'Cold moon key light, warm lantern or torch pools.',
  },
  { id: 'overcast', label: 'overcast fog', how: 'Flat cold light, thick fog, muted colours.' },
  {
    id: 'storm',
    label: 'storm with lightning flashes',
    how: 'Dark sky, periodic lightning that flashes the whole scene.',
  },
  {
    id: 'ember',
    label: 'red dawn / ember glow',
    how: 'Deep red horizon, drifting embers, hot rim light.',
  },
  {
    id: 'torchlight',
    label: 'underground torchlight',
    how: 'Almost dark with pools of flickering torch light.',
  },
  {
    id: 'harsh-noon',
    label: 'harsh midday sun',
    how: 'Hard white light, crisp black shadows, bleached colours.',
  },
  { id: 'blue-hour', label: 'blue hour', how: 'Deep blue ambient with a bright cool rim light.' },
];

export const PALETTES: Array<Option & { colors: string[] }> = [
  { id: 'ember-ash', label: 'ember and ash', colors: ['#1b1416', '#c2410c', '#f5d0a9'], how: '' },
  { id: 'jade-ink', label: 'jade and ink', colors: ['#0b1f1a', '#2dd4a7', '#e8f5ef'], how: '' },
  {
    id: 'indigo-gold',
    label: 'indigo and gold',
    colors: ['#12123a', '#5b5bd6', '#fbbf24'],
    how: '',
  },
  { id: 'rust-teal', label: 'rust and teal', colors: ['#2a1a14', '#b45309', '#2c8c99'], how: '' },
  {
    id: 'bone-crimson',
    label: 'bone and crimson',
    colors: ['#1a1414', '#dc2626', '#f1e9dd'],
    how: '',
  },
  {
    id: 'violet-mint',
    label: 'violet and mint',
    colors: ['#1e1033', '#8b5cf6', '#a7f3d0'],
    how: '',
  },
  {
    id: 'slate-amber',
    label: 'slate and amber',
    colors: ['#1c2430', '#64748b', '#f59e0b'],
    how: '',
  },
  { id: 'sand-azure', label: 'sand and azure', colors: ['#3a2f22', '#d9b97a', '#38bdf8'], how: '' },
];

// Distinctive treatment of existing mechanics, never mandatory extra mechanics.

export const TWISTS: Option[] = [
  {
    id: 'anticipation',
    label: 'readable anticipation',
    how: 'Where a rule has a delayed consequence, show what is about to happen using a cue appropriate to the theme.',
  },
  {
    id: 'consequence',
    label: 'persistent consequences',
    how: "Make the consequences of the player's existing choices legible in the world or UI.",
  },
  {
    id: 'discovery',
    label: 'guided discovery',
    how: 'Introduce the requested mechanic through a small readable example before exposing its full possibilities.',
  },
  {
    id: 'expression',
    label: 'expressive feedback',
    how: 'Give the core interaction a recognizable visual or musical response suited to this game.',
  },
  {
    id: 'relationships',
    label: 'visible relationships',
    how: 'Reveal useful relationships between objects, choices or resources when the player focuses on them.',
  },
  {
    id: 'continuity',
    label: 'coherent transitions',
    how: 'Preserve context through state changes so the player understands how one action led to the next.',
  },
];

export interface Variation {
  camera: Option;
  style: Option;
  setting: Option;
  lighting: Option;
  palette: Option & { colors: string[] };
  twist: Option;
}

function pick<T>(items: T[], rng: () => number): T {
  const i = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[i] as T;
}

/** Roll a variation. `rng` returns [0,1); inject a seeded one in tests. */

export function pickVariation(
  engine: 'three' | 'phaser' | 'canvas2d',
  rng: () => number = Math.random,
  spec?: { perspective?: string; cameraKind?: string },
): Variation {
  const selectedCamera = pick(engine === 'three' ? CAMERAS_3D : LAYOUTS_2D, rng);
  const camera = spec?.perspective
    ? {
        id: 'declared-view',
        label: spec.perspective.replaceAll('_', ' '),
        how: `Preserve the declared ${spec.perspective} perspective and ${spec.cameraKind ?? 'appropriate'} camera. Compose and size the view around this game's actual interactions; never change its movement plane to fit a visual suggestion.`,
      }
    : selectedCamera;
  return {
    camera,
    style: pick(STYLES, rng),
    setting: pick(SETTINGS, rng),
    lighting: pick(LIGHTING, rng),
    palette: pick(PALETTES, rng),
    twist: pick(TWISTS, rng),
  };
}

/** The binding direction block for the draft prompt. */

export function describeVariation(v: Variation, engine: 'three' | 'phaser' | 'canvas2d'): string {
  const cameraLine =
    engine === 'three'
      ? `CAMERA - ${v.camera.label}: ${v.camera.how}`
      : `VIEW / LAYOUT - ${v.camera.label}: ${v.camera.how}`;
  return [
    'DESIGN DIRECTION (mandatory: preserve the brief and declared mechanics; the following visual starting points are optional where compatible):',
    cameraLine,
    `VISUAL STYLE - ${v.style.label}: ${v.style.how}`,
    `COMPOSITION - ${v.setting.label}: ${v.setting.how}`,
    `LIGHTING - ${v.lighting.label}: ${v.lighting.how}`,
    `PALETTE - ${v.palette.label}: background ${v.palette.colors[0]}, main ${v.palette.colors[1]}, highlight ${v.palette.colors[2]}. Use these only if the user has not requested another palette; retain sufficient contrast.`,
    `INTERACTION TREATMENT - ${v.twist.label}: ${v.twist.how}`,
    'Anything the user already decided in the brief (the world, the genre, the feel, the win condition) stays EXACTLY as decided: the brief wins. These suggestions must not introduce enemies, hazards, combat, a scoring system or a different world. Adapt the visual treatment to the selected renderer (2D art for Phaser/Canvas2D). Choose a different treatment when these suggestions do not fit.',
  ].join('\n');
}

/**
 * A plain-language account of the choices the host rolled for a game, for the closing message
 * when the run stops before the agent could write its own. The brief asks the builder to "say
 * what you chose"; a run that is cut off must still answer, and these are the choices that were
 * actually made, not a guess.
 */

export function summarizeVariation(v: Variation): string {
  return [
    `Setting: ${v.setting.label}.`,
    `Look: ${v.style.label}, with ${v.palette.label} colours and ${v.lighting.label} lighting.`,
    `Camera: ${v.camera.label}.`,
    `Interaction treatment: ${v.twist.label}.`,
  ].join(' ');
}
