/**
 * Mandatory design variation for a first draft.
 *
 * Every game used to come out as the same game: the starter's stage (dark blue void, grey ground
 * plane, one light rig, a camera fixed at the same spot) plus the model's own convergence on the
 * same arena. Asking a model to "be creative" does not fix that - it converges on its favourite.
 * So the HOST rolls the dice: each new project gets a randomly chosen camera, visual style,
 * lighting, palette, setting composition and mechanic twist, handed to the draft as a binding
 * direction. The same prompt therefore yields visibly different games, while anything the user
 * decided (the world, the genre, the feel) stays fixed.
 */

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
    label: 'side-on 2.5D duel camera',
    how: 'Fixed side view: camera at about (0, 2.4, 13) looking at (0, 1.4, 0), fov 38. Movement is along X only; the camera tracks the midpoint of the action horizontally with smoothing. It never orbits.',
  },
  {
    id: 'iso-high',
    label: 'high isometric tactical camera',
    how: 'Fixed high angle: camera at about (11, 13, 11) looking at the arena centre, fov 30. The arena reads like a diorama; punch the fov in slightly on big hits.',
  },
  {
    id: 'low-heroic',
    label: 'low-angle heroic orbit',
    how: 'Low and close: camera y about 1.2, orbiting slowly around the midpoint of the action, looking up at the fighters, fov 55. It swings wide on finishing blows.',
  },
  {
    id: 'over-shoulder',
    label: 'over-the-shoulder follow',
    how: 'Camera about 3.5 behind and 2.2 above the player, aimed at the nearest opponent, fov 60; it turns with the player and the aim.',
  },
  {
    id: 'top-down',
    label: 'top-down arena view',
    how: 'Camera straight above (y about 22) with a slight tilt, fov 40; the arena reads as a map. Use shadows and screen shake for impact.',
  },
  {
    id: 'cinematic-dolly',
    label: 'cinematic wide dolly',
    how: 'A wide camera that drifts slowly on a rail and punches in (fov animation) on impacts; fov 45; it frames both fighters at all times.',
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

export const SETTINGS: Option[] = [
  {
    id: 'bridge',
    label: 'long narrow bridge duel',
    how: 'A narrow raised platform with a visible drop on both sides; ring-out edges matter.',
  },
  {
    id: 'sunken-pit',
    label: 'sunken pit with crowd silhouettes',
    how: 'A pit below ground level ringed by tiers of crowd silhouettes and torches.',
  },
  {
    id: 'ruined-courtyard',
    label: 'ruined courtyard',
    how: 'Broken columns, rubble, a central cracked statue; cover and sightlines vary around it.',
  },
  {
    id: 'floating-dais',
    label: 'circular dais over a void',
    how: 'A round platform floating over water, lava or clouds with drifting debris.',
  },
  {
    id: 'cliff-shrine',
    label: 'cliffside shrine at the edge of the world',
    how: 'Stone steps, a shrine gate, wind-blown banners, a sheer drop behind.',
  },
  {
    id: 'lantern-ring',
    label: 'tournament ring under lanterns',
    how: 'A raised ring with rope posts under swaying paper lanterns and banners.',
  },
  {
    id: 'frozen-lake',
    label: 'frozen lake',
    how: 'A cracked ice sheet, snow drifts, breath mist; ice cracks spread on heavy hits.',
  },
  {
    id: 'ship-deck',
    label: 'storm-tossed ship deck',
    how: 'A wooden deck that rocks gently, masts and ropes, sea beyond the rail.',
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

export const TWISTS: Option[] = [
  {
    id: 'edge-hazard',
    label: 'dangerous edges',
    how: 'The arena edge is a hazard: standing near it costs health or risks a ring-out.',
  },
  {
    id: 'telegraph-colours',
    label: 'colour-coded telegraphs',
    how: 'Enemy wind-ups glow white for parry, red for dodge, so reading colours is the skill.',
  },
  {
    id: 'rhythm-parry',
    label: 'rhythmic parry window',
    how: 'Attacks land on a readable beat; perfect timing triggers a brief slow-motion flash.',
  },
  {
    id: 'rising-stakes',
    label: 'rising stakes between rounds',
    how: 'Each round changes one rule: faster foes, a hazard appears, the light dims.',
  },
  {
    id: 'stamina-ring',
    label: 'visible stamina ring',
    how: 'A ring around the player shows stamina; overextending leaves you open.',
  },
  {
    id: 'environment-kill',
    label: 'environmental finisher',
    how: 'A finishing blow near scenery (brazier, statue, rail) triggers a special kill.',
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
): Variation {
  return {
    camera: pick(engine === 'three' ? CAMERAS_3D : LAYOUTS_2D, rng),
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
    "DESIGN DIRECTION (mandatory - this is what makes THIS game look and feel different from every other game; follow it, do not fall back to the starter's default look or to a generic dark-blue arena):",
    cameraLine,
    `VISUAL STYLE - ${v.style.label}: ${v.style.how}`,
    `SETTING COMPOSITION - ${v.setting.label}: ${v.setting.how}`,
    `LIGHTING - ${v.lighting.label}: ${v.lighting.how}`,
    `PALETTE - ${v.palette.label}: background ${v.palette.colors[0]}, main ${v.palette.colors[1]}, highlight ${v.palette.colors[2]}. Derive every colour from these.`,
    `SIGNATURE TWIST - ${v.twist.label}: ${v.twist.how}`,
    'Anything the user already decided in the brief (the world, the genre, the feel, the win condition) stays EXACTLY as decided: use this direction for everything else, and where it conflicts with the brief, the brief wins. Name the arena and describe it in a short header comment in the arena module.',
  ].join('\n');
}
