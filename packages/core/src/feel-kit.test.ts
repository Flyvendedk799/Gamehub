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
