import { describe, expect, it } from 'vitest';
import {
  LINEAR_SCAN_THRESHOLD,
  type TraceEvent,
  analyzeRunTiming,
  analyzeTrace,
  analyzeViews,
} from './trace-analysis.js';

let seq = 0;
function ev(atMs: number, event: Record<string, unknown>): TraceEvent {
  seq += 1;
  return { seq, atMs, event };
}

function view(atMs: number, path: string, range?: [number, number], symbol?: string): TraceEvent {
  return ev(atMs, {
    type: 'tool_execution_start',
    toolName: 'str_replace_based_edit_tool',
    args: {
      command: 'view',
      path,
      ...(range !== undefined ? { view_range: range } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    },
  });
}

function edit(atMs: number, path: string, command = 'str_replace'): TraceEvent {
  return ev(atMs, {
    type: 'tool_execution_start',
    toolName: 'str_replace_based_edit_tool',
    args: { command, path },
  });
}

function toolEnd(atMs: number, toolName: string): TraceEvent {
  return ev(atMs, { type: 'tool_execution_end', toolName });
}

describe('1. wall clock vs AI runtime', () => {
  it('separates the agent loop from the queue wait', () => {
    const t = analyzeRunTiming({
      createdAtMs: 0,
      finishedAtMs: 1_000_000,
      aiRuntimeMs: 600_000,
      nowMs: 2_000_000,
    });
    expect(t.wallClockMs).toBe(1_000_000);
    expect(t.aiRuntimeMs).toBe(600_000);
    expect(t.queueMs).toBe(400_000);
    expect(t.aiShare).toBeCloseTo(0.6);
  });

  it('uses now for a run that has not finished', () => {
    const t = analyzeRunTiming({
      createdAtMs: 0,
      finishedAtMs: null,
      aiRuntimeMs: 100,
      nowMs: 500,
    });
    expect(t.wallClockMs).toBe(500);
  });

  it('never reports a negative queue wait when ai_runtime overshoots wall clock', () => {
    const t = analyzeRunTiming({
      createdAtMs: 0,
      finishedAtMs: 100,
      aiRuntimeMs: 900,
      nowMs: 100,
    });
    expect(t.queueMs).toBe(0);
    expect(t.aiShare).toBe(1);
  });
});

describe('2. tool histogram', () => {
  it('counts calls by tool, most-used first', () => {
    const a = analyzeTrace([
      view(0, 'src/main.js'),
      view(1, 'src/main.js'),
      edit(2, 'src/main.js'),
      ev(3, { type: 'tool_execution_start', toolName: 'playtest_game' }),
    ]);
    expect(a.toolHistogram).toEqual([
      { name: 'str_replace_based_edit_tool', calls: 3 },
      { name: 'playtest_game', calls: 1 },
    ]);
    expect(a.toolCallTotal).toBe(4);
  });
});

describe('3. latency attribution', () => {
  it('attributes the gap AFTER a tool ends — that is model thinking, not the tool', () => {
    const a = analyzeTrace([
      toolEnd(0, 'str_replace_based_edit_tool'),
      ev(10_000, { type: 'turn_end' }), // 10s of thinking after the view
      toolEnd(11_000, 'str_replace_based_edit_tool'),
      ev(16_000, { type: 'turn_end' }), // 5s
      toolEnd(17_000, 'playtest_game'),
      ev(18_000, { type: 'turn_end' }), // 1s
    ]);
    const editTool = a.latency.find((l) => l.name === 'str_replace_based_edit_tool');
    expect(editTool?.totalMs).toBe(15_000);
    expect(editTool?.calls).toBe(2);
    expect(editTool?.perCallMs).toBe(7_500);
    // Sorted by total, so the dominant cost is the first row.
    expect(a.latency[0]?.name).toBe('str_replace_based_edit_tool');
    expect(a.latencyTotalMs).toBe(16_000);
  });

  it('ignores a trailing tool_execution_end — there is no next event to measure to', () => {
    const a = analyzeTrace([ev(0, { type: 'turn_end' }), toolEnd(1_000, 'playtest_game')]);
    expect(a.latency).toEqual([]);
    expect(a.latencyTotalMs).toBe(0);
  });
});

describe('4. view ranges', () => {
  it('flags a marching sequence as a linear scan', () => {
    // The doc's own example: [160,240] [200,290] [240,320] [295,380].
    const a = analyzeViews([
      view(0, 'src/main.js', [160, 240]),
      view(1, 'src/main.js', [200, 290]),
      view(2, 'src/main.js', [240, 320]),
      view(3, 'src/main.js', [295, 380]),
    ]);
    const seqOne = a.sequences[0];
    expect(seqOne?.path).toBe('src/main.js');
    expect(seqOne?.longestForwardRun).toBe(4);
    expect(seqOne?.isLinearScan).toBe(true);
  });

  it('does NOT flag targeted jumps around a file', () => {
    const a = analyzeViews([
      view(0, 'src/main.js', [400, 440]),
      view(1, 'src/main.js', [100, 140]),
      view(2, 'src/main.js', [900, 940]),
      view(3, 'src/main.js', [50, 90]),
    ]);
    expect(a.sequences[0]?.isLinearScan).toBe(false);
  });

  it('needs three in a row — two forward reads are ordinary', () => {
    const a = analyzeViews([view(0, 'src/main.js', [10, 40]), view(1, 'src/main.js', [40, 80])]);
    expect(a.sequences[0]?.longestForwardRun).toBe(2);
    expect(a.sequences[0]?.isLinearScan).toBe(false);
    expect(LINEAR_SCAN_THRESHOLD).toBe(3);
  });

  it('splits ranged / symbol / whole-file views', () => {
    const a = analyzeViews([
      view(0, 'src/main.js'),
      view(1, 'src/main.js', [1, 50]),
      view(2, 'src/main.js', undefined, 'PlayScene'),
    ]);
    expect(a.total).toBe(3);
    expect(a.ranged).toBe(1);
    expect(a.bySymbol).toBe(1);
    expect(a.wholeFile).toBe(1);
  });

  it('tracks each file separately', () => {
    const a = analyzeViews([
      view(0, 'src/main.js', [1, 50]),
      view(1, 'src/player.js', [1, 50]),
      view(2, 'src/main.js', [50, 100]),
    ]);
    expect(a.sequences.map((s) => s.path).sort()).toEqual(['src/main.js', 'src/player.js']);
    expect(a.sequences.find((s) => s.path === 'src/main.js')?.views).toBe(2);
  });
});

describe('views per mutation — the §1 cost, in one number', () => {
  it('is the run-3 ratio when the game is one huge file', () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 37; i += 1) events.push(view(i, 'src/main.js', [i * 10, i * 10 + 40]));
    for (let i = 0; i < 17; i += 1) events.push(edit(100 + i, 'src/main.js'));
    const a = analyzeTrace(events);
    expect(a.views.total).toBe(37);
    expect(a.viewsPerMutation).toBeCloseTo(37 / 17, 4);
    expect(a.views.sequences[0]?.isLinearScan).toBe(true);
  });

  it('counts create/insert/patch as mutations too', () => {
    const a = analyzeTrace([
      edit(0, 'a.js', 'create'),
      edit(1, 'a.js', 'insert'),
      edit(2, 'a.js', 'patch'),
      view(3, 'a.js'),
    ]);
    expect(a.viewsPerMutation).toBeCloseTo(1 / 3, 4);
  });

  it('is null when nothing was mutated (no division by zero)', () => {
    expect(analyzeTrace([view(0, 'a.js')]).viewsPerMutation).toBeNull();
  });
});
