// when_to_use: Seeded procedural content generation — reach for this when the
// game needs varied, reproducible layouts, maps, or entity placement without
// hand-authored levels. mulberry32(seed) gives a deterministic pseudo-random
// number generator you can replay from the same seed (great for sharing runs).
// generateGrid creates tile maps; scatterEntities places items without overlap;
// pickWeighted draws from a loot/enemy table; roomsAndCorridors builds a simple
// dungeon layout. All results are pure data — wire them into Phaser tilemap or
// sprite placement in your own create(). Capability tag: procedural.

/**
 * mulberry32 — fast, deterministic 32-bit PRNG.
 * Returns a function `rng()` that yields numbers in [0, 1).
 * Same seed → same sequence; different seeds → independent sequences.
 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a 2-D grid of tile IDs.
 * opts:
 *   fillTile   default tile ID for open cells (default 0)
 *   wallTile   tile ID for border walls (default 1)
 *   noiseTile  sparse random tile (default 2); noiseChance controls density
 *   noiseChance probability [0-1] of a noise tile (default 0.07)
 * Returns a flat array of length w*h, row-major.
 */
export function generateGrid(w, h, rng, opts = {}) {
  const fill = opts.fillTile ?? 0;
  const wall = opts.wallTile ?? 1;
  const noise = opts.noiseTile ?? 2;
  const noiseChance = opts.noiseChance ?? 0.07;
  const grid = new Array(w * h).fill(fill);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
        grid[idx] = wall;
      } else if (rng() < noiseChance) {
        grid[idx] = noise;
      }
    }
  }
  return grid;
}

/**
 * Place `count` entities inside `bounds` ({x,y,width,height}) without
 * overlapping each other (min distance = opts.minDist, default 40).
 * Returns [{x, y}] — pure data; caller creates sprites.
 * Gives up after opts.maxAttempts per entity (default 50) to avoid hangs.
 */
export function scatterEntities(count, bounds, rng, opts = {}) {
  const minDist = opts.minDist ?? 40;
  const maxAttempts = opts.maxAttempts ?? 50;
  const minDist2 = minDist * minDist;
  const positions = [];

  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const x = bounds.x + rng() * bounds.width;
      const y = bounds.y + rng() * bounds.height;
      let ok = true;
      for (const p of positions) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy < minDist2) {
          ok = false;
          break;
        }
      }
      if (ok) {
        positions.push({ x, y });
        placed = true;
        break;
      }
    }
    // If we exhausted attempts, place anywhere so count is always honored.
    if (!placed) {
      positions.push({
        x: bounds.x + rng() * bounds.width,
        y: bounds.y + rng() * bounds.height,
      });
    }
  }
  return positions;
}

/**
 * Weighted random pick from a table of {item, weight} entries.
 * e.g. pickWeighted(rng, [{item:'coin',weight:10},{item:'gem',weight:1}])
 */
export function pickWeighted(rng, table) {
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = rng() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry.item;
  }
  return table[table.length - 1]?.item;
}

/**
 * Simple BSP dungeon: splits the area recursively into rooms connected by
 * L-shaped corridors. Returns {rooms:[{x,y,w,h}], corridors:[{x,y,w,h}]}.
 * Rooms and corridors are in grid-tile coordinates.
 * opts: minRoom (default 4), maxDepth (default 4), padding (default 1).
 */
export function roomsAndCorridors(gridW, gridH, rng, opts = {}) {
  const minRoom = opts.minRoom ?? 4;
  const maxDepth = opts.maxDepth ?? 4;
  const pad = opts.padding ?? 1;
  const rooms = [];
  const corridors = [];

  function split(x, y, w, h, depth) {
    const canSplitH = w >= minRoom * 2 + pad * 2;
    const canSplitV = h >= minRoom * 2 + pad * 2;
    if (depth >= maxDepth || (!canSplitH && !canSplitV)) {
      // Leaf — carve a room with a little inner margin.
      const rx = x + pad + Math.floor(rng() * 2);
      const ry = y + pad + Math.floor(rng() * 2);
      const rw = w - pad * 2 - Math.floor(rng() * 2);
      const rh = h - pad * 2 - Math.floor(rng() * 2);
      if (rw >= minRoom && rh >= minRoom) rooms.push({ x: rx, y: ry, w: rw, h: rh });
      return;
    }
    const horizontal = canSplitH && (!canSplitV || rng() > 0.5);
    if (horizontal) {
      const splitX = minRoom + Math.floor(rng() * (w - minRoom * 2));
      split(x, y, splitX, h, depth + 1);
      split(x + splitX, y, w - splitX, h, depth + 1);
    } else {
      const splitY = minRoom + Math.floor(rng() * (h - minRoom * 2));
      split(x, y, w, splitY, depth + 1);
      split(x, y + splitY, w, h - splitY, depth + 1);
    }
  }

  split(0, 0, gridW, gridH, 0);

  // Connect consecutive rooms with an L-shaped corridor.
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1];
    const b = rooms[i];
    const ax = Math.floor(a.x + a.w / 2);
    const ay = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2);
    const by = Math.floor(b.y + b.h / 2);
    // Horizontal leg then vertical leg.
    corridors.push({ x: Math.min(ax, bx), y: ay, w: Math.abs(bx - ax) + 1, h: 1 });
    corridors.push({ x: bx, y: Math.min(ay, by), w: 1, h: Math.abs(by - ay) + 1 });
  }

  return { rooms, corridors };
}

// Usage:
//   import { mulberry32, generateGrid, scatterEntities, pickWeighted, roomsAndCorridors }
//     from './engine/procedural-gen.js';
//   // create():
//   const seed = this.registry.get('seed') ?? Date.now();
//   const rng  = mulberry32(seed);
//   // Simple noise map (32×20 tiles):
//   const grid = generateGrid(32, 20, rng, { noiseChance: 0.1 });
//   // BSP dungeon:
//   const { rooms, corridors } = roomsAndCorridors(32, 20, rng);
//   // Scatter coins into the first room:
//   const coinPositions = scatterEntities(8, rooms[0], rng, { minDist: 32 });
//   coinPositions.forEach(({ x, y }) => this.coins.create(x * 16, y * 16, 'coin'));
//   // Weighted loot drop:
//   const drop = pickWeighted(rng, [{item:'coin',weight:10},{item:'gem',weight:2},{item:'key',weight:1}]);
//
//   // Expose seed + room count so playtests can verify determinism:
//   //   window.__game.debug.snapshot = () => ({ seed, rooms: rooms.length, corridors: corridors.length });
