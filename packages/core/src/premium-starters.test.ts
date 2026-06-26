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
          // The subject is drawn — either a per-noun draw fn (canvas2d) or a sprite
          // baked from the representational-art layer (phaser artTexture/art.sprite).
          expect(src).toMatch(/function draw[A-Z]|__game\.art\.(draw|sprite)|artTexture/);
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

  it('all three engines ship a Title/Play/Over flow + a real scoring loop (premium parity)', () => {
    expect(PREMIUM_STARTERS.canvas2d).toMatch(/screen = 'title'|screen === 'over'/);
    expect(PREMIUM_STARTERS.phaser).toContain('TitleScene');
    expect(PREMIUM_STARTERS.phaser).toContain('OverScene');
    // three was previously just "move a shape"; now it's a complete game too.
    expect(PREMIUM_STARTERS.three).toMatch(/screen = 'title'|screen === 'over'/);
    for (const engine of ENGINES) {
      expect(PREMIUM_STARTERS[engine], `${engine} should increment a score`).toMatch(/score \+= 1/);
    }
  });

  it('the three starter composes a real subject — no bare default-shape player', () => {
    // The guide bans a default IcosahedronGeometry/BoxGeometry as the SUBJECT. The
    // craft is a composed Group; a leftover icosahedron is only generic debris.
    expect(PREMIUM_STARTERS.three).toContain('buildCraft');
    expect(PREMIUM_STARTERS.three).not.toMatch(
      /const player = new THREE\.Mesh\(new THREE\.IcosahedronGeometry/,
    );
  });

  it('WebGL starters preserve the drawing buffer (juice meter + thumbnails readable)', () => {
    expect(PREMIUM_STARTERS.phaser).toContain('preserveDrawingBuffer');
    expect(PREMIUM_STARTERS.three).toContain('preserveDrawingBuffer');
  });

  it('teaches the representational-art layer (every starter references window.__game.art)', () => {
    // canvas2d DEMONSTRATES it (the seeded subject is drawn via art.draw); phaser +
    // three POINT at it (art.sprite → texture) so the agent draws an actual noun, not a circle.
    expect(PREMIUM_STARTERS.canvas2d).toContain('window.__game.art.draw');
    expect(PREMIUM_STARTERS.phaser).toContain('window.__game.art.sprite');
    expect(PREMIUM_STARTERS.three).toContain('window.__game.art.sprite');
  });
});
