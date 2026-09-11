/**
 * list_game_feel for a canvas2d game.
 *
 * Run 550cef11 called list_game_feel({ engine: 'canvas2d' }) and got a schema
 * validation failure; the retry without a filter returned only Phaser snippets,
 * none of which a canvas2d game can use.
 */
import { describe, expect, it } from 'vitest';
import { makeListGameFeelTool } from './game-feel-library.js';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('list_game_feel — canvas2d', () => {
  it('declares canvas2d as a valid engine filter', () => {
    expect(JSON.stringify(makeListGameFeelTool().parameters)).toContain('"canvas2d"');
  });

  it('points a canvas2d game at the feel helpers its starter already ships', async () => {
    const result = await makeListGameFeelTool().execute('1', { engine: 'canvas2d' });
    expect(result.details.skills).toEqual([]);
    const text = textOf(result);
    expect(text).toContain('src/fx.js');
    expect(text).toContain('sfx(');
    expect(text).not.toMatch(/phaser\//);
  });

  it('still lists engine snippets for phaser', async () => {
    const result = await makeListGameFeelTool().execute('1', { engine: 'phaser' });
    expect(result.details.skills.length).toBeGreaterThan(0);
    expect(result.details.skills.every((s) => s.engine === 'phaser')).toBe(true);
  });
});
