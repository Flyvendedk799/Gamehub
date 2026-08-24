import { describe, expect, it } from 'vitest';
import {
  PREMIUM_STARTER_ENGINE_PATH,
  PREMIUM_STARTER_FILES,
  PREMIUM_STARTER_PATH,
  type StarterEngine,
  starterPathsFor,
} from './premium-starters.js';

const ENGINES: StarterEngine[] = ['canvas2d', 'phaser', 'three'];

/** The whole seeded project as one blob — for content that may live in any module. */
function joined(engine: StarterEngine): string {
  return Object.values(PREMIUM_STARTER_FILES[engine]).join('\n\n');
}

function entry(engine: StarterEngine): string {
  const src = PREMIUM_STARTER_FILES[engine][PREMIUM_STARTER_PATH];
  if (src === undefined) throw new Error(`${engine} starter has no ${PREMIUM_STARTER_PATH}`);
  return src;
}

describe('PREMIUM_STARTER_FILES', () => {
  it('seeds at the agent entry path', () => {
    expect(PREMIUM_STARTER_PATH).toBe('src/main.js');
  });

  for (const engine of ENGINES) {
    describe(engine, () => {
      const src = joined(engine);

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
    expect(joined('canvas2d')).toMatch(/screen = 'title'|screen === 'over'/);
    expect(joined('phaser')).toContain('TitleScene');
    expect(joined('phaser')).toContain('OverScene');
    // three was previously just "move a shape"; now it's a complete game too.
    expect(joined('three')).toMatch(/screen = 'title'|screen === 'over'/);
    for (const engine of ENGINES) {
      expect(joined(engine), `${engine} should increment a score`).toMatch(
        /score \+= 1|score \+= ev\.scored/,
      );
    }
  });

  it('the three starter composes a real subject — no bare default-shape player', () => {
    // The guide bans a default IcosahedronGeometry/BoxGeometry as the SUBJECT. The
    // craft is a composed Group; a leftover icosahedron is only generic debris.
    expect(joined('three')).toContain('buildCraft');
    expect(joined('three')).not.toMatch(
      /const player = new THREE\.Mesh\(new THREE\.IcosahedronGeometry/,
    );
  });

  it('WebGL starters preserve the drawing buffer (juice meter + thumbnails readable)', () => {
    expect(joined('phaser')).toContain('preserveDrawingBuffer');
    expect(joined('three')).toContain('preserveDrawingBuffer');
  });

  it('teaches the representational-art layer (every starter references window.__game.art)', () => {
    // canvas2d DEMONSTRATES it (the seeded subject is drawn via art.draw); phaser +
    // three POINT at it (art.sprite → texture) so the agent draws an actual noun, not a circle.
    expect(joined('canvas2d')).toContain('window.__game.art.draw');
    expect(joined('phaser')).toContain('window.__game.art.sprite');
    expect(joined('three')).toContain('window.__game.art.sprite');
  });
});

// ---------------------------------------------------------------------------
// The modular contract itself (docs/BUILD_SPEED_FROM_BOXER_RUNS.md §1 + §2)
// ---------------------------------------------------------------------------

describe('the scaffold is modular, not one file', () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      const files = PREMIUM_STARTER_FILES[engine];
      const paths = starterPathsFor(engine);

      it('seeds a module SET, one concern per file', () => {
        expect(paths.length).toBeGreaterThanOrEqual(6);
        expect(paths).toContain(PREMIUM_STARTER_PATH);
        // The concerns §1 named. `player`/`enemies`/`waves` may sit under scenes/
        // for Phaser, so match on the basename appearing somewhere in the set.
        for (const concern of ['theme', 'player', 'enemies', 'waves', 'hud']) {
          expect(
            paths.some((p) => p.includes(concern)),
            `${engine} needs a ${concern} module`,
          ).toBe(true);
        }
      });

      it('keeps every module small enough to read whole', () => {
        for (const [path, content] of Object.entries(files)) {
          const lines = content.split('\n').length;
          // 300 lines is the §1 threshold: below it a module needs neither a map
          // nor a ranged read, so an edit costs one call instead of two.
          expect(lines, `${path} is ${lines} lines`).toBeLessThanOrEqual(300);
        }
      });

      it('keeps main.js a THIN bootstrap', () => {
        expect(entry(engine).split('\n').length).toBeLessThanOrEqual(80);
      });

      it('writes the engine into the tree and boots on it from the entry', () => {
        // §2: recommending a foundational module does not work — it has to already
        // be running before the agent's first turn.
        expect(files[PREMIUM_STARTER_ENGINE_PATH]).toBeDefined();
        expect(joined(engine)).toMatch(/from '\.{1,2}\/engine\/core\.js'/);
      });

      it('calls the engine, not merely imports it (the usesSkillFns guardrail)', () => {
        // `import` without a call is exactly the run-2 failure mode the metric
        // watches for: skillsImported rises, usesSkillFns stays 0, sweeper deletes.
        const engineSrc = files[PREMIUM_STARTER_ENGINE_PATH] ?? '';
        const exported = [...engineSrc.matchAll(/export function (\w+)/g)].map((m) => m[1]);
        expect(exported.length).toBeGreaterThan(0);
        const others = Object.entries(files)
          .filter(([p]) => p !== PREMIUM_STARTER_ENGINE_PATH)
          .map(([, c]) => c)
          .join('\n');
        const called = exported.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(others));
        expect(called.length, `no engine export is called: ${exported.join(', ')}`).toBeGreaterThan(
          0,
        );
      });

      it('resolves every relative import to a file that exists in the set', () => {
        const known = new Set(paths);
        for (const [path, content] of Object.entries(files)) {
          const specs = [...content.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1] ?? '');
          for (const spec of specs) {
            const dir = path.slice(0, path.lastIndexOf('/'));
            const parts = dir === '' ? [] : dir.split('/');
            for (const seg of spec.split('/')) {
              if (seg === '.' || seg === '') continue;
              if (seg === '..') parts.pop();
              else parts.push(seg);
            }
            expect(known, `${path} imports '${spec}' which does not exist`).toContain(
              parts.join('/'),
            );
          }
        }
      });

      it('has no orphan module — every file is reachable from the entry', () => {
        const reached = new Set<string>([PREMIUM_STARTER_PATH]);
        const queue = [PREMIUM_STARTER_PATH];
        while (queue.length > 0) {
          const current = queue.shift();
          if (current === undefined) continue;
          const content = files[current] ?? '';
          for (const m of content.matchAll(/from '(\.[^']+)'/g)) {
            const dir = current.slice(0, current.lastIndexOf('/'));
            const parts = dir === '' ? [] : dir.split('/');
            for (const seg of (m[1] ?? '').split('/')) {
              if (seg === '.' || seg === '') continue;
              if (seg === '..') parts.pop();
              else parts.push(seg);
            }
            const target = parts.join('/');
            if (files[target] !== undefined && !reached.has(target)) {
              reached.add(target);
              queue.push(target);
            }
          }
        }
        // An unreachable module is dead weight the sweeper would delete at ship.
        expect([...paths].sort()).toEqual([...reached].sort());
      });
    });
  }
});
