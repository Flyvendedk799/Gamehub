/**
 * gameplan §E2 — assert_game_invariants tests.
 */

import { describe, expect, it } from 'vitest';
import { assertGameInvariants, makeAssertGameInvariantsTool } from './assert-game-invariants';

function deps(files: Array<{ path: string; content: string }>) {
  return { listFiles: () => files };
}

describe('assertGameInvariants', () => {
  it('returns ok=true when all four invariants are present in JS source', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            window.__game.controls.define({ actions: [{ id: 'restart', label: 'Restart', keys: ['KeyR'] }] });
            function onCollision() {
              score += 10;
              new Audio('coin.wav').play();
            }
            function onGameOver() { /* lose */ }
            window.addEventListener('keydown', (e) => {
              if (e.code === 'KeyR') restartGame();
            });
            function restartGame() { score = 0; }
          `,
        },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('warns on missing restart', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onGameOver() {}
            function onHit() { score += 1; new Audio('hit.wav').play(); }
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('restart');
  });

  it('warns on missing fail state', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onCoin() { score += 1; new Audio('coin.wav').play(); }
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('fail-state');
  });

  it('warns on missing score / state mutation', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            function onHit() { gameOver(); new Audio('hit.wav').play(); }
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') reset(); });
            function reset() {}
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('score-or-state');
  });

  it('warns on missing feedback', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onHit() { score += 1; gameOver(); }
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('feedback');
  });

  it('skips data:base64 binary content (e.g. inlined PNGs / WAVs)', () => {
    const result = assertGameInvariants(
      deps([
        { path: 'assets/sprite.png', content: 'data:base64,iVBORw0KGgo=' },
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            window.__game.controls.define({ actions: [{ id: 'restart', label: 'Restart', keys: ['KeyR'] }] });
            function onCollision() { score += 1; new Audio().play(); }
            function onGameOver() {}
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('produces all four invariant warnings for an empty / unhelpful project', () => {
    const result = assertGameInvariants(
      deps([{ path: 'src/main.js', content: 'console.log("hi")' }]),
    );
    expect(result.issues.length).toBe(4);
    expect(result.issues.map((i) => i.invariant).sort()).toEqual([
      'fail-state',
      'feedback',
      'restart',
      'score-or-state',
    ]);
  });
});

describe('makeAssertGameInvariantsTool', () => {
  it('returns a no-op-args tool that surfaces a friendly summary', async () => {
    const tool = makeAssertGameInvariantsTool({
      listFiles: () => [{ path: 'src/main.js', content: 'console.log("hi")' }],
    });
    const result = await tool.execute('call-1', {});
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('4 game invariant(s) appear missing');
    expect(text).toContain('restart');
    expect(result.details?.ok).toBe(false);
  });

  it('returns the green-light text when everything passes', async () => {
    const tool = makeAssertGameInvariantsTool({
      listFiles: () => [
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            window.__game.controls.define({ actions: [{ id: 'restart', label: 'Restart', keys: ['KeyR'] }] });
            function onCollision() { score += 1; new Audio().play(); }
            function onGameOver() {}
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ],
    });
    const result = await tool.execute('call-2', {});
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('game invariants present');
    expect(result.details?.ok).toBe(true);
  });
});

describe('assertGameInvariants brawler-specific checks (Sequence 6)', () => {
  const baseFour = `
    let score = 0;
    function onCollision() { score += 1; new Audio().play(); }
    function onGameOver() {}
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
  `;

  it('flags missing combo, hitstop, limbs on a bare brawler skeleton (and tags genre)', () => {
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: baseFour }]), {
      genre: 'brawler',
    });
    const ids = result.issues.map((i) => i.invariant);
    expect(ids).toContain('brawler-combo');
    expect(ids).toContain('brawler-hitstop');
    expect(ids).toContain('brawler-per-attack-limb');
    expect(result.checked).toContain('brawler-combo');
    expect(result.genre).toBe('brawler');
  });

  it('passes the brawler combo check when combo / multiplier / lastAttack are wired', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nlet combo = 0; let multiplier = 1; const lastAttack = null;`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-combo');
  });

  it('passes hitstop when any of the wake-words appear', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nfunction applyHitstop() { staggerFrames = 6; }`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-hitstop');
  });

  it('passes per-attack-limb when at least two limb identifiers are present', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nconst leftArm = mesh; const rightFist = mesh; jab();`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-per-attack-limb');
  });

  it('flags the c44763af `rotation.y = -playerAngle` bug as an aim/hitbox parity violation', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nplayerGroup.rotation.y = -playerAngle;`,
        },
      ]),
      { genre: 'brawler' },
    );
    const issue = result.issues.find((i) => i.invariant === 'brawler-aim-hitbox-parity');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/c44763af/);
  });

  it('does NOT flag aim/hitbox parity on the corrected `rotation.y = playerAngle`', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nplayerGroup.rotation.y = playerAngle;`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-aim-hitbox-parity');
  });

  it('does NOT add brawler checks when genre is not "brawler" (e.g. puzzle game)', () => {
    const result = assertGameInvariants(
      deps([{ path: 'src/main.js', content: `${baseFour}\nrotation.y = -playerAngle;` }]),
      { genre: 'puzzle' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-combo');
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-aim-hitbox-parity');
    expect(result.checked).not.toContain('brawler-combo');
  });

  it('design-mode (no genre) keeps the original four-check behaviour unchanged', () => {
    const result = assertGameInvariants(
      deps([{ path: 'src/main.js', content: `${baseFour}\nrotation.y = -playerAngle;` }]),
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-aim-hitbox-parity');
    expect(result.checked).toEqual([
      'restart',
      'fail-state',
      'score-or-state',
      'feedback',
      'controls',
      'decoy-engine',
    ]);
    expect(result.genre).toBeNull();
  });

  it('controls invariant: warns when keyboard is read directly without declaring controls', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `const cursors = this.input.keyboard.createCursorKeys();
            if (cursors.left.isDown) player.x -= 2;`,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('controls');
  });

  it('controls invariant: no warning when the game declares controls + reads via the layer', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `window.__game.controls.define({ actions: [{ id: 'left', label: 'Left', keys: ['ArrowLeft'] }] });
            if (window.__game.controls.isDown('left')) player.x -= 2;`,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('controls');
  });

  it('camera-relative: warns on a 3D moving-camera game with world-relative movement (the real bug)', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `const renderer = new THREE.WebGLRenderer();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
            const input = new THREE.Vector3(strafe, 0, forward);
            player.position.addScaledVector(input, speed * dt);
            camera.position.lerp(desired, 0.1);
            camera.lookAt(player.position);`,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('camera-relative');
  });

  it('camera-relative: no warning when movement uses the camera basis', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `const renderer = new THREE.WebGLRenderer();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
            camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
            right.crossVectors(fwd, UP).normalize();
            const move = fwd.multiplyScalar(forward).addScaledVector(right, strafe);
            player.position.addScaledVector(move, speed * dt);
            camera.lookAt(player.position);`,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('camera-relative');
  });

  it('camera-relative: skips a fixed-camera 3D game', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `const renderer = new THREE.WebGLRenderer();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
            camera.position.set(0, 12, 12);
            const input = new THREE.Vector3(strafe, 0, forward);
            player.position.addScaledVector(input, speed * dt);`,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('camera-relative');
  });
});

describe('assert_game_invariants tool (genre param wiring)', () => {
  it('forwards the genre arg into assertGameInvariants', async () => {
    const tool = makeAssertGameInvariantsTool({
      listFiles: () => [{ path: 'src/main.js', content: 'rotation.y = -playerAngle;' }],
    });
    const result = await tool.execute('call-x', { genre: 'brawler' });
    const details = result.details as {
      issues: Array<{ invariant: string }>;
      genre: string | null;
    };
    expect(details.genre).toBe('brawler');
    expect(details.issues.map((i) => i.invariant)).toContain('brawler-aim-hitbox-parity');
  });
});

describe('assertGameInvariants — difficulty escalation (genre-gated)', () => {
  // A complete game (restart + fail + score + feedback + controls) so the ONLY
  // thing the escalation check can flag is the absence of difficulty ramp.
  const COMPLETE_BASE = `
    window.__game.controls.define({ actions: [{ id: 'fire', label: 'Fire', keys: ['Space'] }] });
    let score = 0, lives = 3;
    function update() { if (window.__game.controls.isDown('fire')) shoot(); }
    function onHit() { score += 1; new Audio('hit.wav').play(); camera.shake(); }
    function tick() { if (lives <= 0) restart(); }
    function restart() { score = 0; lives = 3; }
  `;

  it('warns a flat shooter that never gets harder', () => {
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: COMPLETE_BASE }]), {
      genre: 'shooter',
    });
    expect(result.checked).toContain('escalation');
    expect(result.issues.map((i) => i.invariant)).toContain('escalation');
  });

  it('warns a flat tower-defense + survival', () => {
    for (const genre of ['tower-defense', 'survival', 'runner'] as const) {
      const result = assertGameInvariants(deps([{ path: 'src/main.js', content: COMPLETE_BASE }]), {
        genre,
      });
      expect(
        result.issues.map((i) => i.invariant),
        genre,
      ).toContain('escalation');
    }
  });

  it('passes when the wave-spawner skill is used', () => {
    const content = `${COMPLETE_BASE}\n const sys = createWaveSystem(scene, { spawn });`;
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content }]), {
      genre: 'shooter',
    });
    expect(result.checked).toContain('escalation');
    expect(result.issues.map((i) => i.invariant)).not.toContain('escalation');
  });

  it('passes when a geometric difficulty ramp is present', () => {
    const content = `${COMPLETE_BASE}\n const diff = 1.15 ** wave; enemySpeed = base * diff;`;
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content }]), {
      genre: 'survival',
    });
    expect(result.issues.map((i) => i.invariant)).not.toContain('escalation');
  });

  it('does NOT apply the escalation check to genres that pace differently', () => {
    for (const genre of ['puzzle', 'brawler', 'racer'] as const) {
      const result = assertGameInvariants(deps([{ path: 'src/main.js', content: COMPLETE_BASE }]), {
        genre,
      });
      expect(result.checked, genre).not.toContain('escalation');
      expect(
        result.issues.map((i) => i.invariant),
        genre,
      ).not.toContain('escalation');
    }
  });
});

describe('assertGameInvariants — capability-aware (Engine Evolution P4/P5/P6)', () => {
  const POINTER_GAME = `
    // a drag/pointer game with a stray restart keydown
    canvas.addEventListener('pointermove', onDrag);
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') restart(); });
    let boatsSaved = 0;
    function onArrive() { boatsSaved += 1; new Audio('chime.wav').play(); }
    function restart() { boatsSaved = 0; }
  `;

  it('P5: a pointer/drag scheme does NOT get the keyboard-controls warning', () => {
    const withCap = assertGameInvariants(deps([{ path: 'src/main.js', content: POINTER_GAME }]), {
      capabilities: { controlScheme: 'drag' },
    });
    expect(withCap.issues.map((i) => i.invariant)).not.toContain('controls');
    // …but the same source WITHOUT the capability still warns (back-compat).
    const noCap = assertGameInvariants(deps([{ path: 'src/main.js', content: POINTER_GAME }]));
    expect(noCap.issues.map((i) => i.invariant)).toContain('controls');
  });

  it('P6: capabilities.escalates enforces the escalation check regardless of genre token', () => {
    // genre topdown_arcade is NOT in SHOULD_ESCALATE_GENRES, but the capability is set.
    const flat = `${POINTER_GAME}\n const cursors = this.input.keyboard.createCursorKeys();`;
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: flat }]), {
      capabilities: { escalates: true },
    });
    expect(result.checked).toContain('escalation');
    expect(result.issues.map((i) => i.invariant)).toContain('escalation');
  });

  it('P6: hasFailState:false exempts a deliberately-endless toy from the fail-state warning', () => {
    const noFail = `let score = 0; function tick(){ score += 1; new Audio('x.wav').play(); } function reset(){ score = 0; }`;
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: noFail }]), {
      capabilities: { hasFailState: false },
    });
    expect(result.issues.map((i) => i.invariant)).not.toContain('fail-state');
  });

  it('P4: flags a decoy engine entry (fake Phaser shim while the real game runs elsewhere)', () => {
    const decoy = `
      // Sandbox-safe entry placeholder; the playable canvas game is loaded by src/main-vanilla.js.
      if (false && window.Phaser) {
        class PhaserValidationScene extends Phaser.Scene {}
        new Phaser.Game({ scene: PhaserValidationScene });
      }
    `;
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: decoy }]));
    expect(result.checked).toContain('decoy-engine');
    expect(result.issues.map((i) => i.invariant)).toContain('decoy-engine');
  });

  it('P4: an honest game produces no decoy-engine warning', () => {
    const honest = `
      const game = new Phaser.Game({ scene: { create, update } });
      function create() { this.add.text(10, 10, 'hi'); }
      function update() {}
    `;
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: honest }]));
    expect(result.issues.map((i) => i.invariant)).not.toContain('decoy-engine');
  });
});
