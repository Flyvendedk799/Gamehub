import { describe, expect, it } from 'vitest';
import { PREMIUM_STARTER_FILES } from '../premium-starters';
import { describeMissingDomId, findMissingDomIds, restoreCanvasId } from './dom-ids';

const SHELL = (canvas: string, css = 'canvas#game { display:block }') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${canvas}<script type="module" src="src/main.js"></script></body></html>`;

describe('findMissingDomIds', () => {
  it('flags the live bug: page canvas renamed to gameCanvas, code still does createStage("game")', () => {
    const files = [
      { path: 'index.html', content: SHELL('<canvas id="gameCanvas"></canvas>') },
      { path: 'src/main.js', content: "const stage = createStage('game');" },
    ];
    const missing = findMissingDomIds(files);
    expect(missing).toEqual([{ from: 'src/main.js', id: 'game', via: 'createStage' }]);
    const text = describeMissingDomId(missing[0] as never, files);
    expect(text).toContain('#game');
    expect(text).toContain('<canvas id="gameCanvas">');
  });

  it('does not flag ids built at runtime inside JS template strings, or scoped lookups', () => {
    const files = [
      { path: 'index.html', content: SHELL('<canvas id="game"></canvas>') },
      {
        path: 'src/hud.js',
        content:
          "bar.innerHTML = '<div id=\"hp-bar\"></div>';\nconst el = document.getElementById('hp-bar');\nconst x = panel.querySelector('#not-defined-but-scoped');",
      },
    ];
    expect(findMissingDomIds(files)).toEqual([]);
  });

  it('ignores lookups that only appear in comments, and projects without an index.html', () => {
    expect(
      findMissingDomIds([
        { path: 'index.html', content: SHELL('<canvas id="game"></canvas>') },
        { path: 'src/a.js', content: "// document.getElementById('ghost')" },
      ]),
    ).toEqual([]);
    expect(findMissingDomIds([{ path: 'src/a.js', content: "createStage('game')" }])).toEqual([]);
  });

  it('every seeded starter, on the standard shell, has no missing ids (no false alarms)', () => {
    for (const engine of Object.keys(PREMIUM_STARTER_FILES) as Array<
      keyof typeof PREMIUM_STARTER_FILES
    >) {
      const files = [
        { path: 'index.html', content: SHELL('<canvas id="game"></canvas>') },
        ...Object.entries(PREMIUM_STARTER_FILES[engine]).map(([path, content]) => ({
          path,
          content,
        })),
      ];
      expect(findMissingDomIds(files), engine).toEqual([]);
    }
  });
});

describe('restoreCanvasId', () => {
  it('renames the single canvas back (and its CSS selector) when nothing else uses the new id', () => {
    const files = [
      {
        path: 'index.html',
        content: SHELL('<canvas id="gameCanvas"></canvas>', 'canvas#gameCanvas { display:block }'),
      },
      { path: 'src/main.js', content: "createStage('game');" },
    ];
    const fixed = restoreCanvasId(files, 'game');
    expect(fixed).toContain('<canvas id="game">');
    expect(fixed).toContain('canvas#game {');
    expect(fixed).not.toContain('gameCanvas');
  });

  it('adds an id to a canvas that has none', () => {
    const files = [{ path: 'index.html', content: SHELL('<canvas></canvas>') }];
    expect(restoreCanvasId(files, 'game')).toContain('<canvas id="game">');
  });

  it('leaves the page alone when a script looks up the current id, or there are several canvases', () => {
    const lookedUp = [
      { path: 'index.html', content: SHELL('<canvas id="gameCanvas"></canvas>') },
      { path: 'src/other.js', content: "document.getElementById('gameCanvas')" },
    ];
    expect(restoreCanvasId(lookedUp, 'game')).toBeNull();
    const two = [
      { path: 'index.html', content: SHELL('<canvas id="a"></canvas><canvas id="b"></canvas>') },
    ];
    expect(restoreCanvasId(two, 'game')).toBeNull();
    const already = [{ path: 'index.html', content: SHELL('<canvas id="game"></canvas>') }];
    expect(restoreCanvasId(already, 'game')).toBeNull();
  });
});
