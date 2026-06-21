import { describe, expect, it } from 'vitest';
import { analyzeSkillUsage } from './skill-usage-grep.js';
import type { SkillUsageSignals } from './skill-usage-grep.js';

describe('analyzeSkillUsage', () => {
  it('survival: two engine files both imported and called → engineImports=2, skillImportedNotCalled=[]', () => {
    const files = [
      {
        path: 'src/engine/enemy-ai.js',
        content: 'export function makeEnemyBrain(config) { return {}; }',
      },
      {
        path: 'src/engine/wave-spawner.js',
        content: 'export function createWaveSystem(opts) { return {}; }',
      },
      {
        path: 'src/main.js',
        content: `
import { makeEnemyBrain } from './engine/enemy-ai.js';
import { createWaveSystem } from './engine/wave-spawner.js';
const brain = makeEnemyBrain({ speed: 1 });
const brain2 = makeEnemyBrain({ speed: 2 });
const wave = createWaveSystem({ count: 3 });
const wave2 = createWaveSystem({ count: 5 });
const wave3 = createWaveSystem({ count: 8 });
`,
      },
    ];

    const result: SkillUsageSignals = analyzeSkillUsage(files);
    expect(result.engineFilesWritten).toBe(2);
    expect(result.engineImports).toBe(2);
    expect(result.usesSkillFns).toBe(5); // 2 makeEnemyBrain + 3 createWaveSystem
    expect(result.skillImportedNotCalled).toEqual([]);
  });

  it('roguelike: 3 engine files, none imported or called → engineImports=0, usesSkillFns=0, skillImportedNotCalled length 3', () => {
    const files = [
      {
        path: 'src/engine/procedural-gen.js',
        content: 'export function generateDungeon(seed) { return []; }',
      },
      {
        path: 'src/engine/dialog-flow.js',
        content: 'export function createDialogFlow(nodes) { return {}; }',
      },
      {
        path: 'src/engine/economy-system.js',
        content: 'export function makeEconomySystem() { return {}; }',
      },
      {
        path: 'src/main.js',
        content: `
// No imports from engine here
const dungeon = [];
`,
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.engineFilesWritten).toBe(3);
    expect(result.engineImports).toBe(0);
    expect(result.usesSkillFns).toBe(0);
    expect(result.skillImportedNotCalled).toHaveLength(3);
  });

  it('platformer: imports and calls level-orchestrator + save-state', () => {
    const files = [
      {
        path: 'src/engine/level-orchestrator.js',
        content: 'export function createLevelOrchestrator(levels) { return {}; }',
      },
      {
        path: 'src/engine/save-state.js',
        content: 'export function createSaveState(key) { return {}; }',
      },
      {
        path: 'src/main.js',
        content: `
import { createLevelOrchestrator } from './engine/level-orchestrator.js';
import { createSaveState } from './engine/save-state.js';
const orch = createLevelOrchestrator([1, 2, 3]);
const save = createSaveState('game');
save.load();
`,
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.engineFilesWritten).toBe(2);
    expect(result.engineImports).toBe(2);
    // 1 call to createLevelOrchestrator + 1 call to createSaveState
    expect(result.usesSkillFns).toBe(2);
    expect(result.skillImportedNotCalled).toEqual([]);
  });

  it('debugWired: debug.track counts; var s = window.__game.state READ does NOT count', () => {
    const files = [
      {
        path: 'src/main.js',
        content: `
debug.track({ score: () => score });
debug.track({ wave: () => wave });
var s = window.__game.state; // READ — should NOT count
`,
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.debugWired).toBe(2);
  });

  it('debugWired: debug.snapshot assignment counts; __game.state assignment counts', () => {
    const files = [
      {
        path: 'src/game.js',
        content: `
window.__game.state = { score, wave };
debug.snapshot = function() { return state; };
`,
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.debugWired).toBe(2);
  });

  it('same-named local function with no engine import → usesSkillFns stays 0', () => {
    const files = [
      {
        path: 'src/engine/wave-spawner.js',
        content: 'export function createWaveSystem(opts) { return {}; }',
      },
      {
        path: 'src/main.js',
        // Local reimplementation, no import from ./engine/wave-spawner
        content: `
function createWaveSystem(opts) {
  return { start() {}, stop() {} };
}
const ws = createWaveSystem({ count: 5 });
const ws2 = createWaveSystem({ count: 10 });
`,
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.engineFilesWritten).toBe(1);
    expect(result.engineImports).toBe(0);
    expect(result.usesSkillFns).toBe(0);
    expect(result.skillImportedNotCalled).toEqual(['wave-spawner']);
  });

  it('empty project → all zeros', () => {
    const result = analyzeSkillUsage([]);
    expect(result.engineFilesWritten).toBe(0);
    expect(result.engineImports).toBe(0);
    expect(result.usesSkillFns).toBe(0);
    expect(result.debugWired).toBe(0);
    expect(result.skillImportedNotCalled).toEqual([]);
  });

  it('engine files only, no outside files → engineImports=0, usesSkillFns=0', () => {
    const files = [
      {
        path: 'src/engine/enemy-ai.js',
        content: 'export function makeEnemyBrain() { return {}; }',
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.engineFilesWritten).toBe(1);
    expect(result.engineImports).toBe(0);
    expect(result.usesSkillFns).toBe(0);
    expect(result.skillImportedNotCalled).toEqual(['enemy-ai']);
  });

  it('data: content is skipped for outside concatenation', () => {
    const files = [
      {
        path: 'src/engine/wave-spawner.js',
        content: 'export function createWaveSystem() { return {}; }',
      },
      {
        path: 'src/assets/sprite.js',
        // data: URI content — must be skipped
        content: `data:image/png;base64,ABC123 import { createWaveSystem } from './engine/wave-spawner.js'; createWaveSystem();`,
      },
    ];

    const result = analyzeSkillUsage(files);
    // The data: file is skipped, so wave-spawner is never imported in valid outside
    expect(result.engineImports).toBe(0);
    expect(result.usesSkillFns).toBe(0);
    expect(result.skillImportedNotCalled).toEqual(['wave-spawner']);
  });

  it('import with leading path segment still matches (e.g. from ../engine/wave-spawner.js)', () => {
    const files = [
      {
        path: 'src/engine/wave-spawner.js',
        content: 'export function createWaveSystem(opts) { return {}; }',
      },
      {
        path: 'src/systems/combat.ts',
        content: `
import { createWaveSystem } from '../engine/wave-spawner.js';
createWaveSystem({ count: 1 });
`,
      },
    ];

    const result = analyzeSkillUsage(files);
    expect(result.engineImports).toBe(1);
    expect(result.usesSkillFns).toBe(1);
    expect(result.skillImportedNotCalled).toEqual([]);
  });
});
