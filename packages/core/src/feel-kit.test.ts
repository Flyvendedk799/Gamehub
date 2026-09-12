import { describe, expect, it } from 'vitest';
import { checkFeelKit, looksCircleOnlySubject } from './feel-kit.js';

describe('S5 feel-kit', () => {
  it('passes when sfx + shake + particles are present', () => {
    const src = `
      function sfx(name) {}
      function shake(mag) {}
      function burst(x, y) { emitParticle(x, y); }
      function drawSubject(ctx) { ctx.fillRect(0,0,1,1); }
    `;
    expect(checkFeelKit(src).ok).toBe(true);
    expect(looksCircleOnlySubject(src)).toBe(false);
  });

  it('flags mute flat circle games', () => {
    const src = `ctx.beginPath(); ctx.arc(10,10,5,0,Math.PI*2); ctx.fill();`;
    expect(checkFeelKit(src).ok).toBe(false);
    // looksCircleOnly requires PI*2 pattern or fillRect without drawSubject
    const circleOnly = `ctx.fillRect(0,0,10,10); ctx.fillStyle = 'red';`;
    expect(looksCircleOnlySubject(circleOnly)).toBe(true);
  });
});

describe('looksCircleOnlySubject knows a real subject when it sees one (run 54842529)', () => {
  it('accepts the platform art library as a subject path', () => {
    // The prompts tell the agent to reach for window.__game.art.draw for exactly
    // this; using the recommended API must not read as using no API.
    const src = `
      function draw(ctx, f) {
        ctx.fillRect(f.x, f.y, 20, 40);
        window.__game.art.draw(ctx, 'fighter', f.x, f.y, 48, { flip: f.dir < 0 });
      }
    `;
    expect(looksCircleOnlySubject(src)).toBe(false);
  });

  it('accepts a body built from many distinct primitives', () => {
    // An articulated 2D fighter: torso, head, arms, legs, gloves. This is what a
    // hand-drawn subject looks like — the gate used to call it a tinted box, and the
    // agent's only escape was `function drawPlayer(g, f) { f.draw(); }`.
    const body = [
      'g.fillRect(x - 14, y - 16, 13, 28);',
      'g.fillRect(x - 14, y + 12, 12, 28);',
      'g.fillRect(x + 1, y - 16, 13, 28);',
      'g.fillRect(x + 2, y + 12, 12, 28);',
      'g.fillRect(x - 16, y + 38, 16, 8);',
      'g.fillRect(x + 0, y + 38, 16, 8);',
      'g.fillRect(x - 20, y - 56, 40, 42);',
      'g.fillRect(x - 14, y - 16, 28, 6);',
      'g.fillRect(rearX, y - 52, 12, 30);',
      'g.fillRect(x - 16, y - 52, 24, 14);',
      'g.fillRect(kx - 8, y + 12, 18, 14);',
      'g.fillRect(hx - 8, hy + 20, 16, 10);',
      'g.fillRect(hx - 8, hy + 6, 16, 6);',
    ].join('\n');
    expect(looksCircleOnlySubject(body)).toBe(false);
  });

  it('still flags the one tinted box standing in for a character', () => {
    const src = `
      ctx.fillStyle = tint;
      ctx.fillRect(player.x, player.y, 16, 16);
      ctx.fillRect(enemy.x, enemy.y, 16, 16);
    `;
    expect(looksCircleOnlySubject(src)).toBe(true);
  });

  it('still flags untextured THREE primitives with no model path', () => {
    const src = 'const mesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), mat); scene.add(mesh);';
    expect(looksCircleOnlySubject(src)).toBe(true);
  });
});
