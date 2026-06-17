/**
 * Phase-1.5 — the STATIC design-completability floor inside `done`.
 *
 * `assertGameInvariants` was previously warn-only and never consulted by
 * the `done` gate, so a fail-state-less toy (Pong with no score cap and
 * no lose path) or a silent-on-hit game could ship under a green gate.
 * This suite proves the floor now BLOCKS such artifacts for completable
 * genres while honouring the sandbox/idle/endless escape hatches.
 *
 * Boundary note: the floor only activates when the host wires
 * `getGameSpec` (the last makeDoneTool arg). All other done suites leave
 * it undefined, so the floor is inert there — these tests wire it
 * explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCompletabilityFloor,
  isCompletableSpec,
} from './assert-game-invariants.js';
import { type GetDoneGameSpecFn, makeDoneTool } from './done.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

/** Minimal in-memory fs whose listDir surfaces every staged file so the
 *  floor's working-tree walk picks up sibling JS modules. */
function makeFs(initial: Record<string, string> = {}): TextEditorFsCallbacks {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    view(path) {
      const c = map.get(path);
      return c === undefined ? null : { content: c, numLines: c.split('\n').length };
    },
    create(path, content) {
      map.set(path, content);
      return { path };
    },
    strReplace(path, oldStr, newStr) {
      const cur = map.get(path);
      if (cur === undefined) throw new Error('not found');
      map.set(path, cur.replace(oldStr, newStr));
      return { path };
    },
    insert(path) {
      return { path };
    },
    listDir() {
      return [...map.keys()];
    },
  };
}

/** Index.html with a clean React-Babel game body but NO fail/restart/
 *  feedback — a Pong-like toy: paddles move a ball forever, no score cap,
 *  no way to lose, no on-hit sound/particle. The structural lint passes
 *  (valid JSX, full doc), so without the floor `done` would accept it. */
const PONG_NO_LOSE = `<!doctype html><html lang="en"><head><title>Pong</title></head>
<body><div id="root"></div>
<script type="text/babel">
function App() {
  let ballX = 0;
  function tick() { ballX += 1; }
  return <canvas />;
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script></body></html>`;

/** Same game but now complete: a lose path (gameOver), a restart binding
 *  (R key → reset), and on-hit feedback (a sound). Should clear the floor. */
const PONG_COMPLETE = `<!doctype html><html lang="en"><head><title>Pong</title></head>
<body><div id="root"></div>
<script type="text/babel">
function App() {
  let score = 0;
  function onPaddleHit() { score += 1; new Audio('blip.wav').play(); }
  function checkLose() { if (score <= 0) { gameOver(); } }
  function gameOver() { /* lose */ }
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') resetGame(); });
  function resetGame() { score = 0; }
  return <canvas />;
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script></body></html>`;

function specFn(spec: {
  genre: string;
  winCondition?: string;
  loseCondition?: string;
}): GetDoneGameSpecFn {
  return () => spec;
}

describe('done — Phase-1.5 completability floor', () => {
  it('BLOCKS a completable (arcade) game with no lose / restart / feedback', async () => {
    const fs = makeFs({ 'index.html': PONG_NO_LOSE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'make pong',
      () => 1, // validate_game_scene called (pre-gate satisfied)
      () => 1, // playtest_game called
      specFn({ genre: 'topdown_arcade', winCondition: 'Reach 11 points', loseCondition: 'Opponent reaches 11' }),
    );
    const res = await tool.execute('pong-block', { path: 'index.html' });
    expect(res.details.status).toBe('has_errors');
    // The blocking issues are sourced under game.invariant.fatal.*
    const fatalSources = res.details.errors
      .filter((e) => e.source?.startsWith('game.invariant.fatal.'))
      .map((e) => e.source);
    expect(fatalSources).toContain('game.invariant.fatal.fail-state');
    expect(fatalSources).toContain('game.invariant.fatal.restart');
    expect(fatalSources).toContain('game.invariant.fatal.feedback');
  });

  it('ACCEPTS the same game once a lose state, restart, and feedback are wired', async () => {
    const fs = makeFs({ 'index.html': PONG_COMPLETE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'make pong',
      () => 1,
      () => 1,
      specFn({ genre: 'topdown_arcade', winCondition: 'Reach 11 points', loseCondition: 'Opponent reaches 11' }),
    );
    const res = await tool.execute('pong-ok', { path: 'index.html' });
    expect(res.details.status).toBe('ok');
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.fatal.')),
    ).toBe(false);
  });

  it('ESCAPE HATCH: an idle game with winCondition "—" is accepted despite no lose state', async () => {
    const fs = makeFs({ 'index.html': PONG_NO_LOSE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'make an idle clicker',
      () => 1,
      () => 1,
      specFn({ genre: 'idle', winCondition: '—', loseCondition: '—' }),
    );
    const res = await tool.execute('idle-ok', { path: 'index.html' });
    expect(res.details.status).toBe('ok');
    // The floor downgrades — no fatal invariant rows, but the missing
    // invariants still ride along as advisory for transparency.
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.fatal.')),
    ).toBe(false);
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.advisory.')),
    ).toBe(true);
  });

  it('ESCAPE HATCH: a sandbox game is accepted even with a real winCondition', async () => {
    const fs = makeFs({ 'index.html': PONG_NO_LOSE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'voxel sandbox',
      () => 1,
      () => 1,
      specFn({ genre: 'sandbox', winCondition: 'Build a castle', loseCondition: '—' }),
    );
    const res = await tool.execute('sandbox-ok', { path: 'index.html' });
    expect(res.details.status).toBe('ok');
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.fatal.')),
    ).toBe(false);
  });

  it('ENDLESS-but-LOSABLE arcade game is held to the floor (declared loseCondition pins it completable)', async () => {
    const fs = makeFs({ 'index.html': PONG_NO_LOSE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'endless runner',
      () => 1,
      () => 1,
      // Endless win ('—') but a REAL lose condition → still completable.
      specFn({ genre: 'runner', winCondition: '—', loseCondition: 'Hit an obstacle' }),
    );
    const res = await tool.execute('runner-block', { path: 'index.html' });
    expect(res.details.status).toBe('has_errors');
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.fatal.')),
    ).toBe(true);
  });

  it('is INERT when getGameSpec is not wired (preserves existing call-counter behavior)', async () => {
    // Same fail-state-less Pong, game mode, both pre-gate counters > 0,
    // but NO getGameSpec → floor never runs → status is whatever the
    // static lint says (ok here). This is the exact shape every other
    // done suite relies on staying green.
    const fs = makeFs({ 'index.html': PONG_NO_LOSE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'make pong',
      () => 1,
      () => 1,
      // getGameSpec omitted
    );
    const res = await tool.execute('inert', { path: 'index.html' });
    expect(res.details.status).toBe('ok');
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.')),
    ).toBe(false);
  });

  it('pre-done call-counter gate still fires BEFORE the floor (validate/playtest missing)', async () => {
    // Even with getGameSpec wired, a missing validate_game_scene call must
    // still short-circuit with the pre_done_gate error — the floor never
    // gets a chance to run. Confirms the two gates compose, not collide.
    const fs = makeFs({ 'index.html': PONG_COMPLETE });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'make pong',
      () => 0, // validate_game_scene NOT called
      () => 1,
      specFn({ genre: 'topdown_arcade', winCondition: 'win', loseCondition: 'lose' }),
    );
    const res = await tool.execute('pregate-first', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(res.details.status).toBe('has_errors');
    expect(text).toContain('validate_game_scene');
    // No floor rows — the pre-gate returned early.
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.')),
    ).toBe(false);
  });

  it('floor walks SIBLING js modules, not just index.html', async () => {
    // The completable game logic lives in src/game.js; index.html only
    // bootstraps it. The floor's working-tree walk must read the sibling
    // so it sees the lose/restart/feedback and clears.
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>g</title></head><body><script type="module" src="src/game.js"></script></body></html>',
      'src/game.js': `
        let hp = 3;
        function onHit() { hp -= 1; new Audio('hit.wav').play(); if (hp <= 0) gameOver(); }
        function gameOver() {}
        window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') resetGame(); });
        function resetGame() { hp = 3; }
      `,
    });
    const tool = makeDoneTool(
      fs,
      undefined,
      undefined,
      'game',
      undefined,
      'make a shooter',
      () => 1,
      () => 1,
      specFn({ genre: 'shmup', winCondition: 'Clear all waves', loseCondition: 'HP hits 0' }),
    );
    const res = await tool.execute('sibling-ok', { path: 'index.html' });
    expect(res.details.status).toBe('ok');
    expect(
      res.details.errors.some((e) => e.source?.startsWith('game.invariant.fatal.')),
    ).toBe(false);
  });
});

describe('isCompletableSpec / evaluateCompletabilityFloor (pure)', () => {
  it('classifies escape-hatch genres as non-completable', () => {
    expect(isCompletableSpec({ genre: 'sandbox' })).toBe(false);
    expect(isCompletableSpec({ genre: 'idle' })).toBe(false);
    expect(isCompletableSpec({ genre: 'tycoon' })).toBe(false);
    expect(isCompletableSpec({ genre: 'visual_novel' })).toBe(false);
  });

  it('classifies a declared lose condition as completable regardless of genre/win', () => {
    expect(
      isCompletableSpec({ genre: 'runner', winCondition: '—', loseCondition: 'Crash' }),
    ).toBe(true);
  });

  it('treats endless-with-no-lose as non-completable (creative toy)', () => {
    expect(
      isCompletableSpec({ genre: 'other', winCondition: '—', loseCondition: '—' }),
    ).toBe(false);
  });

  it('holds win-but-no-lose to the floor (the toy-not-a-game case)', () => {
    expect(
      isCompletableSpec({ genre: 'platformer', winCondition: 'Reach the flag', loseCondition: '—' }),
    ).toBe(true);
  });

  it('splits a fail-state-less completable game into fatal floor issues', () => {
    const floor = evaluateCompletabilityFloor(
      { listFiles: () => [{ path: 'g.js', content: 'let x = 0; function move() { x += 1; }' }] },
      { genre: 'platformer', winCondition: 'reach flag', loseCondition: 'fall in pit' },
    );
    expect(floor.blocked).toBe(true);
    expect(floor.downgraded).toBe(false);
    const inv = floor.fatal.map((i) => i.invariant);
    expect(inv).toContain('fail-state');
    expect(inv).toContain('restart');
    expect(inv).toContain('feedback');
    // score-or-state stays advisory even when missing.
    expect(floor.fatal.some((i) => i.invariant === 'score-or-state')).toBe(false);
    expect(floor.advisory.some((i) => i.invariant === 'score-or-state')).toBe(true);
  });

  it('downgrades all floor issues to advisory for a sandbox spec', () => {
    const floor = evaluateCompletabilityFloor(
      { listFiles: () => [{ path: 'g.js', content: 'let x = 0; function move() { x += 1; }' }] },
      { genre: 'sandbox', winCondition: 'build', loseCondition: '—' },
    );
    expect(floor.blocked).toBe(false);
    expect(floor.downgraded).toBe(true);
    expect(floor.fatal).toHaveLength(0);
  });
});
