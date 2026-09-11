/**
 * The depth floor and the circle-only-subject floor are for games that throw
 * escalating opposition at the player — not for every game with an opponent.
 *
 * Run 550cef11 ("simple ping pong… The twist: Nothing changes") declared
 * hasEnemies:true for the AI paddle and escalates:false. Both floors fired as
 * FATAL, `done` rejected the finished game three times, then force-accepted it.
 */
import { describe, expect, it } from 'vitest';
import type { CompletabilitySpec } from './assert-game-invariants.js';
import { makeDoneTool } from './done.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

function makeFs(initial: Record<string, string>): TextEditorFsCallbacks {
  const map = new Map(Object.entries(initial));
  return {
    view(path) {
      const c = map.get(path);
      return c === undefined ? null : { content: c, numLines: c.split('\n').length };
    },
    create(path, content) {
      map.set(path, content);
      return { path };
    },
    strReplace() {
      throw new Error('not used');
    },
    insert() {
      throw new Error('not used');
    },
    listDir() {
      return [...map.keys()];
    },
  };
}

/** Paddles are rectangles and the ball is a circle — by definition. */
const RECT_AND_BALL_GAME = {
  'index.html':
    '<!doctype html><html lang="en"><head><title>g</title></head><body><canvas id="game"></canvas>' +
    '<script type="module" src="src/main.js"></script></body></html>',
  'src/main.js': `
    const ctx = document.getElementById('game').getContext('2d');
    let score = 0;
    function sfx() { new AudioContext().resume(); }
    function draw() {
      ctx.fillRect(10, 10, 12, 90);
      ctx.beginPath(); ctx.arc(50, 50, 8, 0, Math.PI * 2); ctx.fill();
    }
    window.__game.debug.track({ score: () => score });
    requestAnimationFrame(draw);
  `,
};

async function floorSourcesFor(spec: CompletabilitySpec): Promise<string[]> {
  const tool = makeDoneTool(
    makeFs(RECT_AND_BALL_GAME),
    undefined,
    undefined,
    'game',
    undefined,
    'make a game',
    () => 1,
    () => 1,
    () => spec,
  );
  const res = await tool.execute('floors', { path: 'index.html' });
  return res.details.errors.map((e) => e.source ?? '');
}

const pong = {
  genre: 'other',
  winCondition: 'First to 7 points wins',
  loseCondition: 'Opponent reaches 7 points first',
  capabilities: {
    escalates: false,
    hasEnemies: true,
    contentPlan: { mechanicVariety: 1, progressionMechanic: 'none', distinctEnemyBehaviors: 1 },
  },
} as CompletabilitySpec;

describe('opposition floors', () => {
  it('leave a non-escalating head-to-head game (Pong) alone', async () => {
    const sources = await floorSourcesFor(pong);
    expect(sources).not.toContain('game.invariant.fatal.content-plan');
    expect(sources).not.toContain('game.invariant.fatal.circle-only-subject');
  });

  it('still hold a wave shooter with one enemy behaviour to the depth + subject floors', async () => {
    const sources = await floorSourcesFor({
      ...pong,
      genre: 'shmup',
      winCondition: 'Clear all waves',
      loseCondition: 'HP hits 0',
    } as CompletabilitySpec);
    expect(sources).toContain('game.invariant.fatal.content-plan');
    expect(sources).toContain('game.invariant.fatal.circle-only-subject');
  });

  it('hold any game that declares escalation, whatever its genre', async () => {
    const sources = await floorSourcesFor({
      ...pong,
      capabilities: { ...pong.capabilities, escalates: true },
    } as CompletabilitySpec);
    expect(sources).toContain('game.invariant.fatal.content-plan');
    expect(sources).toContain('game.invariant.fatal.circle-only-subject');
  });

  it('keep the subject floor for representational genres even without enemies', async () => {
    const sources = await floorSourcesFor({
      genre: 'platformer',
      winCondition: 'Reach the flag',
      loseCondition: 'Fall in a pit',
      capabilities: { escalates: false, hasEnemies: false },
    } as CompletabilitySpec);
    expect(sources).toContain('game.invariant.fatal.circle-only-subject');
    expect(sources).not.toContain('game.invariant.fatal.content-plan');
  });
});
