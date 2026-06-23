import { describe, expect, it } from 'vitest';
import { PREMIUM_STARTERS, PREMIUM_STARTER_PATH, type StarterEngine } from './premium-starters.js';

const ENGINES: StarterEngine[] = ['canvas2d', 'phaser', 'three'];

describe('PREMIUM_STARTERS', () => {
  it('seeds at the agent entry path', () => {
    expect(PREMIUM_STARTER_PATH).toBe('src/main.js');
  });

  for (const engine of ENGINES) {
    describe(engine, () => {
      const src = PREMIUM_STARTERS[engine];

      it('is a substantial, complete starter', () => {
        expect(src.length).toBeGreaterThan(1500);
      });

      it('has the required debug contract + controls', () => {
        expect(src).toContain('window.__game.debug.track');
        expect(src).toContain('window.__game.controls.define');
      });

      it('has audio that is REAL (WebAudio synth), never a phantom asset ref', () => {
        expect(src).toContain('createOscillator');
        // The whole point of the premium-audio lever: no assets/audio/*.wav refs.
        expect(src).not.toMatch(/assets\/audio\//);
        expect(src).not.toMatch(/new Audio\(/);
      });

      it('has art direction + a drawn/lit subject, not bare primitives', () => {
        // canvas2d/phaser use a PAL const + draw the subject; three builds a lit,
        // fogged, real-material scene (deliberate colours via hex, not a PAL const).
        if (engine === 'three') {
          expect(src).toContain('MeshStandardMaterial');
          expect(src).toContain('DirectionalLight');
          expect(src).toContain('Fog');
        } else {
          expect(src).toMatch(/PAL\b/);
          expect(src).toMatch(/function draw[A-Z]|this\.add\.(ellipse|star|graphics)/);
        }
      });

      it('has a juice signal', () => {
        // 2D: screen shake / particle burst. 3D: animated subject + audio juice.
        if (engine === 'three') {
          expect(src).toMatch(/sfx\(/);
          expect(src).toMatch(/rotation|position/);
        } else {
          expect(src).toMatch(/fx\.shake|cameras\.main\.shake|burst\(/);
        }
      });
    });
  }

  it('canvas2d + phaser ship Title/Play/Over screens; all expose richness or a score', () => {
    expect(PREMIUM_STARTERS.canvas2d).toMatch(/screen = 'title'|screen === 'over'/);
    expect(PREMIUM_STARTERS.phaser).toContain('TitleScene');
    expect(PREMIUM_STARTERS.phaser).toContain('OverScene');
  });

  it('WebGL starters preserve the drawing buffer (juice meter + thumbnails readable)', () => {
    expect(PREMIUM_STARTERS.phaser).toContain('preserveDrawingBuffer');
    expect(PREMIUM_STARTERS.three).toContain('preserveDrawingBuffer');
  });
});
