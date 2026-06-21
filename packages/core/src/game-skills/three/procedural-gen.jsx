// when_to_use: Seeded procedural generation utilities for Three.js worlds —
// deterministic from a numeric seed so the same seed always produces the same
// layout. Reach for this when a game needs randomised-but-reproducible maps,
// enemy placements, loot drops, or terrain noise. scatterInVolume returns
// THREE.Vector3 positions ready to pass to Object3D; generateGrid builds
// typed 2-D maps; pickWeighted selects from a weighted table; noiseField
// samples a value-noise 2-D grid (heightmaps, biome blending). All randomness
// routes through mulberry32 so nothing is frame-order-dependent.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32; fast, high quality for games, 32-bit state.
// ---------------------------------------------------------------------------

/** Returns a PRNG function seeded with `seed`. Call rng() → float in [0, 1). */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
export function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Float in [min, max). */
export function randFloat(rng, min, max) {
  return rng() * (max - min) + min;
}

// ---------------------------------------------------------------------------
// scatterInVolume — place `count` non-overlapping points inside a Box3.
// ---------------------------------------------------------------------------

/** Scatter `count` random positions inside `box3`, rejecting any that land
 *  within `minDist` of an already-placed point. Returns THREE.Vector3[].
 *  maxAttempts per point is `attempts` (default 30); unresolved slots are
 *  skipped so the returned array may be shorter than count in tight boxes. */
export function scatterInVolume(count, box3, rng, opts = {}) {
  const minDist = opts.minDist ?? 1;
  const attempts = opts.attempts ?? 30;
  const positions = [];
  const size = new THREE.Vector3();
  box3.getSize(size);
  const origin = box3.min;

  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let a = 0; a < attempts; a++) {
      const candidate = new THREE.Vector3(
        origin.x + rng() * size.x,
        origin.y + rng() * size.y,
        origin.z + rng() * size.z,
      );
      let tooClose = false;
      for (const p of positions) {
        if (p.distanceTo(candidate) < minDist) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        positions.push(candidate);
        placed = true;
        break;
      }
    }
    // If !placed after all attempts, skip this point (box may be too crowded).
    if (!placed && opts.warnOnFail) {
      console.warn(`scatterInVolume: could not place point ${i} after ${attempts} attempts`);
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// generateGrid — typed 2-D tile map from a weighted table + optional CA pass.
// ---------------------------------------------------------------------------

/** Generate a `cols × rows` 2-D grid where each cell is a tile type chosen
 *  from `tileset` (weighted). Returns a flat Uint8Array (row-major) + helper
 *  fns. Pass `smooth: true` for one cellular-automata pass (good for caves). */
export function generateGrid(cols, rows, tileset, rng, opts = {}) {
  const cells = new Uint8Array(cols * rows);
  const keys = Object.keys(tileset).map(Number);
  const weights = keys.map((k) => tileset[k]);
  const total = weights.reduce((a, b) => a + b, 0);

  for (let i = 0; i < cells.length; i++) {
    let r = rng() * total;
    let chosen = keys[0];
    for (let k = 0; k < keys.length; k++) {
      r -= weights[k];
      if (r <= 0) {
        chosen = keys[k];
        break;
      }
    }
    cells[i] = chosen;
  }

  if (opts.smooth) {
    const copy = new Uint8Array(cells);
    for (let row = 1; row < rows - 1; row++) {
      for (let col = 1; col < cols - 1; col++) {
        const idx = row * cols + col;
        const neighbors = [
          copy[idx - cols - 1],
          copy[idx - cols],
          copy[idx - cols + 1],
          copy[idx - 1],
          copy[idx + 1],
          copy[idx + cols - 1],
          copy[idx + cols],
          copy[idx + cols + 1],
        ];
        // Majority vote.
        const freq = {};
        for (const n of neighbors) freq[n] = (freq[n] ?? 0) + 1;
        let best = copy[idx];
        let bestN = 0;
        for (const [tile, count] of Object.entries(freq)) {
          if (count > bestN) {
            bestN = count;
            best = Number(tile);
          }
        }
        cells[idx] = best;
      }
    }
  }

  return {
    cells,
    cols,
    rows,
    get(col, row) {
      return cells[row * cols + col];
    },
    set(col, row, val) {
      cells[row * cols + col] = val;
    },
    /** Convert grid cell to world XZ (y = opts.groundY ?? 0). */
    toWorld(col, row, cellSize = 1, groundY = 0) {
      return new THREE.Vector3(col * cellSize, groundY, row * cellSize);
    },
  };
}

// ---------------------------------------------------------------------------
// pickWeighted — generic weighted random selection.
// ---------------------------------------------------------------------------

/** Pick one item from `table` where table is [{ item, weight }, ...].
 *  Returns item (or undefined if table is empty). */
export function pickWeighted(table, rng) {
  if (table.length === 0) return undefined;
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = rng() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry.item;
  }
  return table[table.length - 1]?.item;
}

// ---------------------------------------------------------------------------
// noiseField — value-noise 2-D field (smooth + cheap, no Perlin patent).
// ---------------------------------------------------------------------------

/** Build a `w × h` float32 noise field in [0, 1] using value noise at
 *  `octaves` levels. Good for heightmaps and biome blending. `scale` is the
 *  base frequency in grid cells per wave (default 0.1). */
export function noiseField(w, h, seed, opts = {}) {
  const octaves = opts.octaves ?? 4;
  const scale = opts.scale ?? 0.1;
  const persistence = opts.persistence ?? 0.5;
  const rng = mulberry32(seed);

  // Build a tiny random table for hashing lattice points.
  const TABLE = 256;
  const vals = new Float32Array(TABLE);
  for (let i = 0; i < TABLE; i++) vals[i] = rng();

  function lattice(ix, iy) {
    return vals[((ix * 1619 + iy * 31337) >>> 0) % TABLE];
  }

  function valueNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    // Smoothstep.
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const v00 = lattice(ix, iy);
    const v10 = lattice(ix + 1, iy);
    const v01 = lattice(ix, iy + 1);
    const v11 = lattice(ix + 1, iy + 1);
    return v00 + (v10 - v00) * ux + (v01 - v00) * uy + (v11 - v10 - v01 + v00) * ux * uy;
  }

  const field = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let val = 0;
      let amp = 1;
      let freq = scale;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        val += valueNoise(col * freq, row * freq) * amp;
        norm += amp;
        amp *= persistence;
        freq *= 2;
      }
      field[row * w + col] = val / norm;
    }
  }
  return {
    field,
    w,
    h,
    sample(col, row) {
      return field[row * w + col];
    },
    /** Sample at floating-point coords via bilinear interpolation. */
    sampleBilinear(x, y) {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      const s = (c, r) => field[Math.min(r, h - 1) * w + Math.min(c, w - 1)] ?? 0;
      return (
        s(ix, iy) * (1 - fx) * (1 - fy) +
        s(ix + 1, iy) * fx * (1 - fy) +
        s(ix, iy + 1) * (1 - fx) * fy +
        s(ix + 1, iy + 1) * fx * fy
      );
    },
  };
}

// Usage:
//   import { mulberry32, scatterInVolume, generateGrid,
//            pickWeighted, noiseField } from './procedural-gen.jsx';
//   import * as THREE from 'three';
//
//   const SEED = 0xdeadbeef;
//   const rng  = mulberry32(SEED);
//
//   // Scatter 20 trees in a 40×5×40 world volume.
//   const box   = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 5, 20));
//   const trees = scatterInVolume(20, box, rng, { minDist: 3 });
//   trees.forEach(pos => { const m = makeTreeMesh(); m.position.copy(pos); scene.add(m); });
//
//   // 32×32 tile map: 0=floor(60%), 1=wall(30%), 2=water(10%).
//   const grid = generateGrid(32, 32, { 0: 60, 1: 30, 2: 10 }, rng, { smooth: true });
//
//   // Weighted loot drop.
//   const loot = pickWeighted([
//     { item: 'coin', weight: 60 }, { item: 'gem', weight: 30 }, { item: 'key', weight: 10 },
//   ], rng);
//
//   // Height field driving terrain Y.
//   const hf = noiseField(32, 32, SEED, { scale: 0.08, octaves: 4 });
//   const h  = hf.sampleBilinear(px, pz) * 12;   // 0-12 world units tall
//
//   window.__game.debug.snapshot = () => ({ seed: SEED, treeCount: trees.length,
//     gridCell00: grid.get(0, 0), heightAt00: hf.sample(0, 0) });
