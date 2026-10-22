/**
 * may9 Phase 9b follow-up #24 — mandatory pre-done validation gate.
 *
 * The FPS Wave Defense run shipped 1 validate_game_scene + 1
 * playtest_game call across 28 snapshots (defect D1 in docs/may9.md).
 * This gate forces both into the critical path of every game-mode
 * done, returning has_errors with steering text when either is 0.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeDoneTool } from './done';
import type { TextEditorFsCallbacks } from './text-editor';

function fakeFs(content = '<html></html>'): TextEditorFsCallbacks {
  return {
    view: vi.fn(() => ({ content, numLines: 1 })),
    create: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    listDir: vi.fn(() => ['index.html']),
  };
}

describe('done — pre-done gate (Phase 9b #24)', () => {
  it('REJECTS game-mode done when validate_game_scene was never called', async () => {
    const tool = makeDoneTool(
      fakeFs(),
      undefined,
      undefined,
      'game',
      undefined,
      'create FPS',
      () => 0, // validate not called
      () => 1, // playtest called
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('has_errors');
    expect(text).toContain('validate_game_scene');
    expect(res.details.status).toBe('has_errors');
  });

  it('REJECTS game-mode done when playtest_game was never called', async () => {
    const tool = makeDoneTool(
      fakeFs(),
      undefined,
      undefined,
      'game',
      undefined,
      'create platformer',
      () => 1,
      () => 0,
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('playtest_game');
    expect(text).toContain('get_playtest_playbook');
  });

  it('REJECTS with BOTH calls listed when both were missed', async () => {
    const tool = makeDoneTool(
      fakeFs(),
      undefined,
      undefined,
      'game',
      undefined,
      'p',
      () => 0,
      () => 0,
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('validate_game_scene');
    expect(text).toContain('playtest_game');
    expect(res.details.errors?.length).toBe(2);
  });

  it('PASSES game-mode done when both counts > 0', async () => {
    const tool = makeDoneTool(
      fakeFs(),
      undefined,
      undefined,
      'game',
      undefined,
      'p',
      () => 1,
      () => 1,
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('Mandatory pre-done call missing');
  });

  it('does NOT fire on design-mode runs', async () => {
    const tool = makeDoneTool(
      fakeFs(),
      undefined,
      undefined,
      'design',
      undefined,
      'p',
      () => 0,
      () => 0,
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('pre_done_gate');
  });

  it('does NOT fire when host did not wire counters (vitest path)', async () => {
    const tool = makeDoneTool(fakeFs(), undefined, undefined, 'game');
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('pre_done_gate');
  });
});

describe('done — unmodified-starter gate', () => {
  it('REJECTS a fresh game build that never wrote a file (the seeded toy would ship)', async () => {
    const tool = makeDoneTool(
      fakeFs(),
      undefined,
      undefined,
      'game',
      undefined,
      'a sword fighting game',
      () => 1,
      () => 1,
      undefined,
      () => true, // tree is still the seeded starter
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(res.details.status).toBe('has_errors');
    expect(text).toContain('unmodified STARTER');
  });

  it('does not gate when the starter was changed, or when no check is supplied', async () => {
    for (const starterUnmodified of [() => false, undefined]) {
      const tool = makeDoneTool(
        fakeFs(),
        undefined,
        undefined,
        'game',
        undefined,
        'a sword fighting game',
        () => 1,
        () => 1,
        undefined,
        starterUnmodified,
      );
      const res = await tool.execute('id-1', { path: 'index.html' });
      const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
      expect(text).not.toContain('unmodified STARTER');
    }
  });
});

describe('done — unresolved ES imports', () => {
  it('rejects with a precise message naming the importer, the target and the missing exports', async () => {
    const files = [
      { path: 'src/engine/core.js', content: "import { FOG, GROUND } from '../theme.js';" },
      { path: 'src/theme.js', content: 'export const THEME = {};' },
    ];
    const fs = { ...fakeFs(), textFiles: () => files };
    const tool = makeDoneTool(
      fs,
      async () => [],
      undefined,
      'game',
      undefined,
      'a sword fighting game',
      () => 1,
      () => 1,
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(res.details.status).toBe('has_errors');
    expect(text).toContain('src/engine/core.js imports FOG, GROUND');
    expect(text).toContain('src/theme.js does not export it');
  });
});
