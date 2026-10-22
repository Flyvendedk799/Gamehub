import { describe, expect, it } from 'vitest';
import { describeUnknownControlsCall, findUnknownControlsCalls } from './runtime-api';

describe('findUnknownControlsCalls', () => {
  it('flags the live bug: controls.active does not exist', () => {
    const calls = findUnknownControlsCalls([
      {
        path: 'src/main.js',
        content: "const dx = window.__game.controls.active('right') ? 1 : 0;",
      },
    ]);
    expect(calls).toEqual([{ from: 'src/main.js', member: 'active' }]);
    const text = describeUnknownControlsCall(calls[0] as never);
    expect(text).toContain('controls.active');
    expect(text).toContain('isDown');
  });

  it('accepts the real API and ignores comments and the host shell', () => {
    expect(
      findUnknownControlsCalls([
        {
          path: 'src/main.js',
          content:
            "window.__game.controls.define({ actions: [] });\nwindow.__game.controls.isDown('a');\nwindow.__game.controls.on('a', () => {});\n// window.__game.controls.active('x')",
        },
        { path: 'index.html', content: 'window.__game.controls.whatever' },
      ]),
    ).toEqual([]);
  });
});
