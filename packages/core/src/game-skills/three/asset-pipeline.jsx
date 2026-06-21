// when_to_use: Real visual depth for Three.js games — load glTF models,
// instance repeated geometry cheaply, and fall back to nice CC0-style primitives
// when no external assets exist. Reach for this for any 3D game that wants real
// models or lots of repeated geometry (terrain tiles, foliage, crowds) instead
// of bare boxes/spheres. All asset URLs must be same-origin / project-relative
// (connect-src 'self' CSP); never pass third-party URLs. GLTFLoader is loaded
// lazily via a dynamic import — if the project importmap omits three/addons the
// loader silently degrades to a labelled primitive placeholder so the game always
// renders. These are setup helpers, not per-frame code; call once at init time.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// GLTFLoader — lazy, fault-tolerant dynamic import.
// ---------------------------------------------------------------------------

let _GLTFLoader = null;
let _loaderResolved = false;

async function getGLTFLoader() {
  if (_loaderResolved) return _GLTFLoader;
  try {
    const mod = await import('three/addons/loaders/GLTFLoader.js');
    _GLTFLoader = mod.GLTFLoader ?? null;
  } catch {
    // three/addons not in importmap — will use primitive placeholders instead.
    _GLTFLoader = null;
  }
  _loaderResolved = true;
  return _GLTFLoader;
}

// ---------------------------------------------------------------------------
// createAssetLoader — cache + graceful-degrade model loader.
// ---------------------------------------------------------------------------

/** Build a caching model loader.
 *
 *  opts:
 *    onProgress(url, loaded, total) -> (optional) XHR progress callback
 *    placeholderColor               -> hex int for fallback box (default 0x7c6d9e)
 *    placeholderSize                -> side length for fallback box (default 1)
 *
 *  Returns { loadModel(url), preload(urls[]), get(url) }.
 *  loadModel always resolves to a THREE.Object3D — never rejects into the loop.
 *  Each call to loadModel returns an independent clone so transforms are safe.
 */
export function createAssetLoader(opts = {}) {
  const { onProgress, placeholderColor = 0x7c6d9e, placeholderSize = 1 } = opts;

  // url → { proto: THREE.Object3D (source), promise: Promise }
  const cache = new Map();

  function makePlaceholder(url) {
    const geo = new THREE.BoxGeometry(placeholderSize, placeholderSize, placeholderSize);
    const mat = new THREE.MeshStandardMaterial({
      color: placeholderColor,
      roughness: 0.8,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Label so developers can spot placeholders in the inspector.
    const label = url.split('/').pop() ?? 'model';
    mesh.name = `placeholder:${label}`;
    const group = new THREE.Group();
    group.name = mesh.name;
    group.add(mesh);
    return group;
  }

  async function fetchModel(url) {
    const Loader = await getGLTFLoader();
    if (!Loader) return makePlaceholder(url);
    return new Promise((resolve) => {
      const loader = new Loader();
      loader.load(
        url,
        (gltf) => resolve(gltf.scene),
        onProgress ? (e) => onProgress(url, e.loaded, e.total) : undefined,
        (err) => {
          console.warn(`[asset-pipeline] Failed to load "${url}":`, err?.message ?? err);
          resolve(makePlaceholder(url));
        },
      );
    });
  }

  function ensureCached(url) {
    if (!cache.has(url)) {
      const entry = { proto: null, promise: null };
      entry.promise = fetchModel(url).then((obj) => {
        entry.proto = obj;
        return obj;
      });
      cache.set(url, entry);
    }
    return cache.get(url);
  }

  /** Load (or retrieve from cache) a model. Always resolves; falls back to a
   *  labelled primitive if GLTFLoader is absent or the fetch fails.
   *  Returns a CLONE of the cached prototype — safe to position independently. */
  async function loadModel(url) {
    const entry = ensureCached(url);
    await entry.promise;
    return entry.proto.clone(true);
  }

  /** Kick off parallel fetches for all urls so they are warm in cache before
   *  the game loop starts. Resolves when all are settled (never rejects). */
  async function preload(urls) {
    await Promise.allSettled(urls.map((u) => ensureCached(u).promise));
  }

  /** Synchronous cache read. Returns a clone if already loaded, null otherwise. */
  function get(url) {
    const entry = cache.get(url);
    if (!entry?.proto) return null;
    return entry.proto.clone(true);
  }

  return { loadModel, preload, get };
}

// ---------------------------------------------------------------------------
// makeInstancedField — GPU-instanced repeated geometry (foliage, tiles, crowds).
// ---------------------------------------------------------------------------

/** Build a THREE.InstancedMesh from `geometry` + `material` positioned at each
 *  transform in `transforms`.
 *
 *  transforms: Array of { position: {x,y,z}, rotation?: {x,y,z}, scale?: number|{x,y,z} }
 *
 *  Returns the InstancedMesh — add it to the scene once; draw calls = 1 for N copies.
 *  Much cheaper than N separate Mesh objects for terrain tiles, forests, crowds. */
export function makeInstancedField(geometry, material, transforms) {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    dummy.position.set(t.position.x, t.position.y, t.position.z);

    if (t.rotation) {
      dummy.rotation.set(t.rotation.x ?? 0, t.rotation.y ?? 0, t.rotation.z ?? 0);
    } else {
      dummy.rotation.set(0, 0, 0);
    }

    if (t.scale !== undefined) {
      if (typeof t.scale === 'number') {
        dummy.scale.setScalar(t.scale);
      } else {
        dummy.scale.set(t.scale.x ?? 1, t.scale.y ?? 1, t.scale.z ?? 1);
      }
    } else {
      dummy.scale.setScalar(1);
    }

    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// primitiveKit — decent-looking CC0 procedural objects with zero external deps.
// ---------------------------------------------------------------------------

/** A set of nice-looking procedural primitives built entirely from Three.js
 *  geometry + MeshStandardMaterial. Use when you want real-looking objects
 *  without any external asset files.
 *
 *  Each factory accepts an optional opts object to tune colours / dimensions.
 *  Returns a THREE.Group / THREE.Mesh ready to add to the scene.
 *
 *  Exports: lowPolyTree(opts), crate(opts), rock(opts), pickup(opts). */
export function primitiveKit() {
  /** A stylised low-poly tree: dark green cone on a brown cylinder trunk. */
  function lowPolyTree(opts = {}) {
    const group = new THREE.Group();
    const trunkH = opts.trunkHeight ?? 0.6;
    const crownH = opts.crownHeight ?? 1.4;
    const crownR = opts.crownRadius ?? 0.55;

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.14, trunkH, 6),
      new THREE.MeshStandardMaterial({ color: opts.trunkColor ?? 0x5c3d1e, roughness: 0.95 }),
    );
    trunk.position.y = trunkH / 2;

    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(crownR, crownH, 7),
      new THREE.MeshStandardMaterial({ color: opts.crownColor ?? 0x2d6a2f, roughness: 0.85 }),
    );
    crown.position.y = trunkH + crownH / 2;

    group.add(trunk, crown);
    group.name = 'lowPolyTree';
    return group;
  }

  /** A textured-looking crate: box with darker edge lines via an emissive tint. */
  function crate(opts = {}) {
    const size = opts.size ?? 0.8;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({
        color: opts.color ?? 0xc8930a,
        roughness: 0.9,
        metalness: 0.05,
        emissive: 0x1a0f00,
        emissiveIntensity: 0.15,
      }),
    );
    mesh.castShadow = true;
    mesh.name = 'crate';
    return mesh;
  }

  /** A lumpy rock: scaled icosahedron with a grey stone material. */
  function rock(opts = {}) {
    const r = opts.radius ?? 0.5;
    const geo = new THREE.IcosahedronGeometry(r, 1);
    // Randomly displace vertices slightly for a non-uniform look.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const jitter = opts.jitter ?? 0.12;
      pos.setXYZ(
        i,
        pos.getX(i) * (1 + (Math.random() - 0.5) * jitter),
        pos.getY(i) * (1 + (Math.random() - 0.5) * jitter),
        pos.getZ(i) * (1 + (Math.random() - 0.5) * jitter),
      );
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: opts.color ?? 0x888080,
        roughness: 0.92,
        metalness: 0.08,
      }),
    );
    mesh.castShadow = true;
    mesh.name = 'rock';
    return mesh;
  }

  /** A glowing pickup sphere: emissive + point-light for visual pop. */
  function pickup(opts = {}) {
    const group = new THREE.Group();
    const r = opts.radius ?? 0.22;
    const col = opts.color ?? 0xffe050;

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(r, 10, 7),
      new THREE.MeshStandardMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: opts.emissiveIntensity ?? 0.7,
        roughness: 0.2,
        metalness: 0.6,
      }),
    );

    const light = new THREE.PointLight(col, opts.lightIntensity ?? 0.8, opts.lightRange ?? 3);
    group.add(sphere, light);
    group.name = 'pickup';
    return group;
  }

  return { lowPolyTree, crate, rock, pickup };
}

// Usage:
//   import { createAssetLoader, makeInstancedField, primitiveKit } from './asset-pipeline.jsx';
//   import * as THREE from 'three';
//
//   // --- Model loading with graceful primitive fallback ---
//   const assets = createAssetLoader({ placeholderColor: 0x7c6d9e });
//   await assets.preload(['/models/tree.glb', '/models/rock.glb']);
//
//   const treeModel = await assets.loadModel('/models/tree.glb');
//   // If GLTFLoader is absent or the file 404s, treeModel is a labelled box —
//   // the render loop never sees a throw/rejection.
//   scene.add(treeModel);
//
//   // Synchronous clone after preload (for tight spawn loops):
//   const rockClone = assets.get('/models/rock.glb');
//   if (rockClone) scene.add(rockClone);
//
//   // --- Instanced forest (1 draw call for 200 trees) ---
//   const treeGeo = new THREE.ConeGeometry(0.5, 1.6, 7);
//   const treeMat = new THREE.MeshStandardMaterial({ color: 0x2d6a2f });
//   const transforms = Array.from({ length: 200 }, () => ({
//     position: { x: (Math.random() - 0.5) * 60, y: 0, z: (Math.random() - 0.5) * 60 },
//     rotation: { x: 0, y: Math.random() * Math.PI * 2, z: 0 },
//     scale: 0.8 + Math.random() * 0.6,
//   }));
//   const forest = makeInstancedField(treeGeo, treeMat, transforms);
//   scene.add(forest);
//
//   // --- CC0 procedural objects (zero external assets) ---
//   const kit = primitiveKit();
//   const tree = kit.lowPolyTree({ crownColor: 0x3a7d3c });
//   tree.position.set(3, 0, -5);
//   scene.add(tree);
//   scene.add(kit.crate({ size: 1 }));
//   const gem = kit.pickup({ color: 0x40e0d0, lightIntensity: 1.2 });
//   gem.position.set(0, 0.5, 0);
//   scene.add(gem);
