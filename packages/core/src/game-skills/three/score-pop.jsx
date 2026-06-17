// when_to_use: Three.js floating score / damage numbers in 3D space ("+100",
// "-25") that rise toward the camera and fade at the point of action. Because
// Three has no text primitive, this draws the number to a tiny canvas, maps
// it onto a camera-facing Sprite (always readable from any angle), then
// drifts + fades it and disposes. The single best way to communicate scoring
// and damage in a 3D game. For a flat HUD number, render to a DOM overlay
// instead — but in-world sprites read as more "juicy".

import * as THREE from 'three';

function makeTextTexture(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 72px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#000000';
  ctx.strokeText(text, 128, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Spawn a floating number at `pos`. Returns `{ update(dt), done }`; tick
 *  each frame until done. Auto-removes + disposes texture/material. */
export function floatingScore(scene, pos, text, opts = {}) {
  const tex = makeTextTexture(String(text), opts.color ?? '#ffd166');
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = opts.scale ?? 1;
  sprite.scale.set(2 * scale, 1 * scale, 1);
  sprite.position.copy(pos);
  sprite.renderOrder = 9999;
  scene.add(sprite);

  const life = opts.life ?? 0.9;
  const rise = opts.rise ?? 2;
  let elapsed = 0;
  let done = false;

  return {
    get done() {
      return done;
    },
    update(dt) {
      if (done) return;
      elapsed += dt;
      const t = elapsed / life;
      if (t >= 1) {
        scene.remove(sprite);
        mat.dispose();
        tex.dispose();
        done = true;
        return;
      }
      sprite.position.y = pos.y + rise * t;
      mat.opacity = 1 - t;
      const pop = 1 + 0.3 * Math.max(0, 1 - t * 4); // brief grow at spawn
      sprite.scale.set(2 * scale * pop, 1 * scale * pop, 1);
    },
  };
}

// Usage:
//   const pops = [];
//   function onEnemyHit(enemy, dmg) {
//     pops.push(floatingScore(scene, enemy.position.clone(), `-${dmg}`, { color: '#ff5a5a' }));
//   }
//   function onUpdate(dt) {
//     for (let i = pops.length - 1; i >= 0; i -= 1) {
//       pops[i].update(dt);
//       if (pops[i].done) pops.splice(i, 1);
//     }
//   }
