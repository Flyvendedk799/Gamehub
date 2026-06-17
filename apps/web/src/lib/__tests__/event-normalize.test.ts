import { describe, expect, it } from 'vitest';
import {
  TRANSPORT_LOST_MESSAGE,
  isRawAgentType,
  isTransportError,
  normalizeAgentFrame,
  shouldOfferFix,
  toolActivityLabel,
  writePathFromTool,
  writtenPaths,
} from '../event-normalize';
import type { SseEvent } from '../types';

const ctx = { runId: 'r1', timestamp: 't' };

describe('normalizeAgentFrame — tool_execution_start (2.1)', () => {
  it('maps tool_execution_start to a tool_use row', () => {
    const out = normalizeAgentFrame(
      { type: 'tool_execution_start', toolName: 'playtest_game', args: {}, toolCallId: 'c1' },
      ctx,
    );
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe('tool_use');
    if (ev.type === 'tool_use') {
      expect(ev.toolName).toBe('playtest_game');
      expect(ev.status).toBe('start');
      expect(ev.runId).toBe('r1');
    }
  });

  it('a write tool surfaces its path + a "writing <path>" label', () => {
    const out = normalizeAgentFrame(
      {
        type: 'tool_execution_start',
        toolName: 'str_replace_based_edit_tool',
        args: { command: 'create', path: 'src/main.ts' },
        toolCallId: 'c2',
      },
      ctx,
    );
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe('tool_use');
    if (ev.type === 'tool_use') {
      expect(ev.path).toBe('src/main.ts');
      expect(ev.label).toBe('writing src/main.ts');
    }
  });

  it('returns [] when toolName is missing', () => {
    expect(normalizeAgentFrame({ type: 'tool_execution_start', args: {} }, ctx)).toEqual([]);
  });
});

describe('normalizeAgentFrame — game_spec card (2.2)', () => {
  it('declare_game_spec fans out tool_use + game_spec with genre + win/lose', () => {
    const out = normalizeAgentFrame(
      {
        type: 'tool_execution_start',
        toolName: 'declare_game_spec',
        args: {
          genre: 'platformer',
          winCondition: 'reach the flag',
          loseCondition: 'fall in a pit',
        },
        toolCallId: 'c3',
      },
      ctx,
    );
    expect(out.map((e) => e.type)).toEqual(['tool_use', 'game_spec']);
    const spec = out[1]!;
    if (spec.type === 'game_spec') {
      expect(spec.genre).toBe('platformer');
      expect(spec.winCondition).toBe('reach the flag');
      expect(spec.loseCondition).toBe('fall in a pit');
      expect(spec.amend).toBe(false);
    }
  });

  it('amend_game_spec marks the card as an amend', () => {
    const out = normalizeAgentFrame(
      { type: 'tool_execution_start', toolName: 'amend_game_spec', args: { genre: 'shooter' } },
      ctx,
    );
    const spec = out.find((e) => e.type === 'game_spec');
    expect(spec?.type).toBe('game_spec');
    if (spec?.type === 'game_spec') expect(spec.amend).toBe(true);
  });

  it('a spec tool with no usable fields yields no card', () => {
    const out = normalizeAgentFrame(
      { type: 'tool_execution_start', toolName: 'declare_game_spec', args: {} },
      ctx,
    );
    expect(out.map((e) => e.type)).toEqual(['tool_use']);
  });
});

describe('normalizeAgentFrame — tool_execution_end (2.1)', () => {
  it('maps a successful end to a tool_result with success=true', () => {
    const out = normalizeAgentFrame(
      {
        type: 'tool_execution_end',
        toolName: 'str_replace_based_edit_tool',
        args: { command: 'create', path: 'index.html' },
        toolCallId: 'c4',
        isError: false,
      },
      ctx,
    );
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe('tool_result');
    if (ev.type === 'tool_result') {
      expect(ev.success).toBe(true);
      expect(ev.path).toBe('index.html');
    }
  });

  it('maps isError=true to success=false', () => {
    const out = normalizeAgentFrame(
      { type: 'tool_execution_end', toolName: 'validate_game_scene', isError: true },
      ctx,
    );
    const ev = out[0]!;
    if (ev.type === 'tool_result') expect(ev.success).toBe(false);
  });
});

describe('normalizeAgentFrame — message_update text_delta (2.1)', () => {
  it('unwraps assistantMessageEvent.text_delta.delta into a text_delta event', () => {
    const out = normalizeAgentFrame(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'building...' },
      },
      ctx,
    );
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe('text_delta');
    if (ev.type === 'text_delta') expect(ev.delta).toBe('building...');
  });

  it('falls back to the `text` field when `delta` is absent', () => {
    const out = normalizeAgentFrame(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', text: 'hi' } },
      ctx,
    );
    const ev = out[0]!;
    if (ev.type === 'text_delta') expect(ev.delta).toBe('hi');
  });

  it('ignores non-text assistant message events and empty deltas', () => {
    expect(
      normalizeAgentFrame(
        { type: 'message_update', assistantMessageEvent: { type: 'tool_use_delta' } },
        ctx,
      ),
    ).toEqual([]);
    expect(
      normalizeAgentFrame(
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } },
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('normalizeAgentFrame — run_paused (2.5)', () => {
  it('maps the bare run_paused frame to a run_paused event stamped with runId', () => {
    const out = normalizeAgentFrame({ type: 'run_paused' }, ctx);
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe('run_paused');
    if (ev.type === 'run_paused') expect(ev.runId).toBe('r1');
  });
});

describe('toolActivityLabel — human-readable rows (2.1)', () => {
  it('keys labels on toolName', () => {
    expect(toolActivityLabel('validate_game_scene', {})).toBe('validating scene');
    expect(toolActivityLabel('playtest_game', {})).toBe('playtesting');
    expect(toolActivityLabel('choose_engine', { engine: 'three' })).toBe('choosing engine — three');
    expect(
      toolActivityLabel('str_replace_based_edit_tool', { command: 'create', path: 'a.js' }),
    ).toBe('writing a.js');
  });

  it('falls back to a readable form of an unknown tool name', () => {
    expect(toolActivityLabel('some_new_tool', {})).toBe('some new tool');
  });
});

describe('writePathFromTool', () => {
  it('returns the path only for write commands of the edit tool', () => {
    expect(writePathFromTool('str_replace_based_edit_tool', { command: 'create', path: 'a' })).toBe(
      'a',
    );
    expect(
      writePathFromTool('str_replace_based_edit_tool', { command: 'view', path: 'a' }),
    ).toBeUndefined();
    expect(writePathFromTool('playtest_game', { path: 'a' })).toBeUndefined();
  });
});

describe('writtenPaths — "Changed N files" source (2.6)', () => {
  it('collects unique successful write paths in first-seen order', () => {
    const events: SseEvent[] = [
      {
        type: 'tool_result',
        runId: 'r',
        toolName: 't',
        success: true,
        path: 'a.js',
        timestamp: 't',
      },
      {
        type: 'tool_result',
        runId: 'r',
        toolName: 't',
        success: true,
        path: 'b.js',
        timestamp: 't',
      },
      {
        type: 'tool_result',
        runId: 'r',
        toolName: 't',
        success: true,
        path: 'a.js',
        timestamp: 't',
      },
      {
        type: 'tool_result',
        runId: 'r',
        toolName: 't',
        success: false,
        path: 'c.js',
        timestamp: 't',
      },
    ];
    expect(writtenPaths(events)).toEqual(['a.js', 'b.js']);
  });

  it('returns [] when nothing was written', () => {
    expect(writtenPaths([{ type: 'agent_start', runId: 'r', timestamp: 't' }])).toEqual([]);
  });
});

describe('shouldOfferFix — run_error vs transport gating (2.3)', () => {
  it('offers Fix for a genuine build failure', () => {
    const err: SseEvent = {
      type: 'run_error',
      runId: 'r',
      error: 'ReferenceError: player is not defined',
      timestamp: 't',
    };
    expect(shouldOfferFix(err)).toBe(true);
  });

  it('does NOT offer Fix for the transport "Lost connection" case', () => {
    const transport: SseEvent = {
      type: 'run_error',
      runId: 'r',
      error: TRANSPORT_LOST_MESSAGE,
      timestamp: 't',
    };
    expect(isTransportError(TRANSPORT_LOST_MESSAGE)).toBe(true);
    expect(shouldOfferFix(transport)).toBe(false);
  });

  it('does NOT offer Fix for non-error events', () => {
    const complete: SseEvent = {
      type: 'run_complete',
      runId: 'r',
      snapshotPath: '',
      previewUrl: '/p',
      timestamp: 't',
    };
    expect(shouldOfferFix(complete)).toBe(false);
  });
});

describe('isRawAgentType', () => {
  it('recognizes the raw agent wire-frame types', () => {
    expect(isRawAgentType('tool_execution_start')).toBe(true);
    expect(isRawAgentType('tool_execution_end')).toBe(true);
    expect(isRawAgentType('message_update')).toBe(true);
    expect(isRawAgentType('run_paused')).toBe(true);
    expect(isRawAgentType('run_complete')).toBe(false);
    expect(isRawAgentType('tool_use')).toBe(false);
  });
});
