import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Controllers are plain JS modules the agent imports into the game VFS —
// load them the same way (CJS interop via createRequire / dynamic import).

describe('S4 character controllers', () => {
  it('platformer controller coyote-jumps after leaving a ledge', async () => {
    const mod = await import('../game-skills/phaser/character-controller-2d.js');
    const ctl = mod.createPlatformerController({ coyoteMs: 100, jumpBufferMs: 50 });
    ctl.step(0.016, { onGround: true });
    ctl.step(0.016, { onGround: false }); // just left ledge
    const after = ctl.step(0.016, { onGround: false, jumpPressed: true, jumpDown: true });
    expect(after.vy).toBeLessThan(0); // upward
  });

  it('fps controller moves on camera basis (not inverted yaw)', async () => {
    const mod = await import('../game-skills/three/fps-controller.jsx');
    const ctl = mod.createFpsController({ moveSpeed: 10 });
    ctl.setPointerLocked(true);
    ctl.look(0, 0);
    // Face +Z initially (yaw=0): forward should decrease z
    const a = ctl.step(1, { forward: 1, strafe: 0 });
    expect(a.position.z).toBeLessThan(0);
    // Strafe right should increase x
    ctl.reset();
    const b = ctl.step(1, { forward: 0, strafe: 1 });
    expect(b.position.x).toBeGreaterThan(0);
  });

  it('fps look is a no-op until pointer lock', async () => {
    const mod = await import('../game-skills/three/fps-controller.jsx');
    const ctl = mod.createFpsController();
    const before = ctl.getState();
    ctl.look(100, 50);
    expect(ctl.getState().yaw).toBe(before.yaw);
    ctl.setPointerLocked(true);
    ctl.look(100, 0);
    expect(ctl.getState().yaw).not.toBe(before.yaw);
  });

  it('tps controller is exported from dedicated skill file', async () => {
    const mod = await import('../game-skills/three/tps-controller.jsx');
    expect(typeof mod.createTpsController).toBe('function');
    const ctl = mod.createTpsController({ moveSpeed: 5 });
    ctl.setPointerLocked(true);
    const s = ctl.step(0.5, { forward: 1 });
    expect(s.mode).toBe('tps');
    expect(s.position.z).toBeLessThan(0);
  });
});
