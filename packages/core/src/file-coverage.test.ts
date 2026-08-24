/**
 * Coverage-based retention.
 *
 * The lead test replays the exact shape that cost run 5f7e6510 twenty-six
 * minutes: a file paged in six chunks, then a patch. Under the old
 * count-based window the patch evicted a chunk and the model re-read the whole
 * file; here the six chunks survive because together they are the file.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { buildFileCoverageResultIds, isCovered, spanOf } from './file-coverage.js';

const TOOL = 'str_replace_based_edit_tool';
const FILE = 'src/main.js';

let nextId = 0;
function call(args: Record<string, unknown>, id = `t${++nextId}`): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: TOOL, arguments: args }],
  } as unknown as AgentMessage;
}

const view = (start: number, end: number, path = FILE) =>
  call({ command: 'view', path, view_range: [start, end] });

const wholeFile = (path = FILE) => call({ command: 'view', path });
const patch = (path = FILE) => call({ command: 'patch', path, patch: '...' });

/** The six-chunk read from the real run. */
function pagedRead(): AgentMessage[] {
  return [
    view(1, 50),
    view(50, 135),
    view(135, 220),
    view(220, 320),
    view(320, 430),
    view(430, 540),
  ];
}

describe('span parsing', () => {
  it('reads an explicit range', () => {
    expect(spanOf({ view_range: [10, 20] })).toEqual({ start: 10, end: 20 });
  });

  it('treats a missing range as the whole file', () => {
    expect(spanOf({})).toEqual({ start: 1, end: null });
  });

  it('treats a nonsense end as to-end-of-file', () => {
    expect(spanOf({ view_range: [5, -1] })).toEqual({ start: 5, end: null });
    expect(spanOf({ view_range: [5] })).toEqual({ start: 5, end: null });
  });
});

describe('coverage arithmetic', () => {
  it('recognises an exactly-covered span', () => {
    expect(isCovered({ start: 10, end: 20 }, [{ start: 10, end: 20 }])).toBe(true);
  });

  it('recognises a span covered by two adjacent spans', () => {
    // 1-50 and 51-100 together cover 10-60 with no gap.
    expect(
      isCovered({ start: 10, end: 60 }, [
        { start: 1, end: 50 },
        { start: 51, end: 100 },
      ]),
    ).toBe(true);
  });

  it('does not consider a span with a gap covered', () => {
    // Missing line 51 — the model would have to go back for it, which is the
    // whole failure mode.
    expect(
      isCovered({ start: 10, end: 60 }, [
        { start: 1, end: 50 },
        { start: 52, end: 100 },
      ]),
    ).toBe(false);
  });

  it('treats partial overlap as not covered', () => {
    expect(isCovered({ start: 10, end: 60 }, [{ start: 1, end: 30 }])).toBe(false);
  });

  it('handles open-ended spans', () => {
    expect(isCovered({ start: 10, end: 60 }, [{ start: 1, end: null }])).toBe(true);
    expect(isCovered({ start: 1, end: null }, [{ start: 1, end: 500 }])).toBe(false);
    expect(isCovered({ start: 1, end: null }, [{ start: 1, end: null }])).toBe(true);
  });

  it('covers nothing with nothing', () => {
    expect(isCovered({ start: 1, end: 10 }, [])).toBe(false);
  });
});

describe('the run that cost 26 minutes', () => {
  it('keeps all six chunks of a paged read', () => {
    const report = buildFileCoverageResultIds(pagedRead(), [FILE], TOOL);
    // Under ACTIVE_FILE_WINDOW=6 this was exactly at the limit, so anything
    // that followed broke the picture.
    expect(report.keep.size).toBe(6);
  });

  it('still keeps them after a patch — the eviction that started the spiral', () => {
    const messages = [...pagedRead(), patch()];
    const report = buildFileCoverageResultIds(messages, [FILE], TOOL);

    // The patch is kept as a mutation AND all six reads survive, because
    // retention is bounded by coverage rather than by a count of results.
    expect(report.keep.size).toBe(7);
    expect(report.redundantReads).toBe(0);
  });

  it('survives many interleaved mutations without losing the file', () => {
    const messages = [...pagedRead(), patch(), patch(), patch(), patch(), patch()];
    const report = buildFileCoverageResultIds(messages, [FILE], TOOL);

    const spans = report.coverage.get(FILE) ?? [];
    expect(spans).toHaveLength(6);
    // Mutations are capped so they cannot crowd out the reads.
    expect(report.keep.size).toBeLessThanOrEqual(6 + 3);
  });

  it('collapses a repeated full re-read instead of pinning both copies', () => {
    // What actually happened fourteen times: page the file, then page it again.
    const messages = [...pagedRead(), patch(), ...pagedRead()];
    const report = buildFileCoverageResultIds(messages, [FILE], TOOL);

    // Only the newest read is retained; the older identical one is dropped.
    expect(report.redundantReads).toBe(6);
    expect(report.coverage.get(FILE)).toHaveLength(6);
    // Strictly less context than the old scheme kept, on the history that
    // broke it.
    expect(report.keep.size).toBeLessThanOrEqual(7);
  });

  it('prefers the newest read when two overlap', () => {
    const older = view(1, 100);
    const newer = view(1, 100);
    const report = buildFileCoverageResultIds([older, newer], [FILE], TOOL);

    expect(report.keep.size).toBe(1);
    // Newest wins: it is what the file says now.
    const keptId = [...report.keep][0];
    const newerId = (newer as unknown as { content: Array<{ id: string }> }).content[0]?.id;
    expect(keptId).toBe(newerId);
  });
});

describe('bounds', () => {
  it('caps results per file so a pathological history cannot pin everything', () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 60; i += 1) messages.push(view(i * 10 + 1, i * 10 + 10));
    const report = buildFileCoverageResultIds(messages, [FILE], TOOL, { maxResultsPerFile: 12 });
    expect(report.keep.size).toBe(12);
  });

  it('caps mutations independently of reads', () => {
    const messages = [...pagedRead(), patch(), patch(), patch(), patch(), patch(), patch()];
    const report = buildFileCoverageResultIds(messages, [FILE], TOOL, { maxMutationsPerFile: 2 });
    expect(report.keep.size).toBe(6 + 2);
  });

  it('stops once a whole-file read covers everything', () => {
    // Oldest first: the partial reads happened, then a whole-file read.
    const messages = [view(1, 50), view(50, 100), wholeFile()];
    const report = buildFileCoverageResultIds(messages, [FILE], TOOL);
    // The newest read is the entire file, so the older partial reads add
    // nothing.
    expect(report.keep.size).toBe(1);
    expect(report.redundantReads).toBe(2);
  });
});

describe('multiple files', () => {
  it('tracks coverage per path', () => {
    const messages = [
      view(1, 50, 'a.js'),
      view(50, 100, 'a.js'),
      view(1, 50, 'b.js'),
      view(1, 50, 'a.js'),
    ];
    const report = buildFileCoverageResultIds(messages, ['a.js', 'b.js'], TOOL);

    // a.js: newest [1,50] plus [50,100]; the older [1,50] is redundant.
    expect(report.coverage.get('a.js')).toHaveLength(2);
    expect(report.coverage.get('b.js')).toHaveLength(1);
    expect(report.redundantReads).toBe(1);
  });

  it('ignores files that are not active', () => {
    const messages = [view(1, 50, 'a.js'), view(1, 50, 'unrelated.js')];
    const report = buildFileCoverageResultIds(messages, ['a.js'], TOOL);
    expect(report.keep.size).toBe(1);
    expect(report.coverage.has('unrelated.js')).toBe(false);
  });

  it('returns nothing when there is no active file', () => {
    const report = buildFileCoverageResultIds(pagedRead(), [], TOOL);
    expect(report.keep.size).toBe(0);
  });
});

describe('robustness', () => {
  it('ignores malformed calls rather than throwing', () => {
    const messages = [
      call({ command: 'view' } as Record<string, unknown>),
      { role: 'assistant', content: 'not an array' } as unknown as AgentMessage,
      { role: 'user', content: [] } as unknown as AgentMessage,
      view(1, 10),
    ];
    expect(() => buildFileCoverageResultIds(messages, [FILE], TOOL)).not.toThrow();
  });

  it('ignores calls from other tools', () => {
    const other = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'x', name: 'playtest_game', arguments: { path: FILE } }],
    } as unknown as AgentMessage;
    const report = buildFileCoverageResultIds([other, view(1, 10)], [FILE], TOOL);
    expect(report.keep.size).toBe(1);
  });
});
