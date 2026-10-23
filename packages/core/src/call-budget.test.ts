import { describe, expect, it } from 'vitest';
import {
  FREE_INSPECTION_CALLS,
  WRAP_UP_WARNING_CALLS,
  isInspectionCall,
  shouldWarnWrapUp,
  wrapUpReminder,
} from './call-budget';

describe('isInspectionCall', () => {
  it('treats listings, views, searches and todo updates as inspection', () => {
    expect(isInspectionCall('list_files', {})).toBe(true);
    expect(isInspectionCall('set_todos', { items: [] })).toBe(true);
    expect(isInspectionCall('str_replace_based_edit_tool', { command: 'view', path: 'a.js' })).toBe(
      true,
    );
    expect(isInspectionCall('str_replace_based_edit_tool', { command: 'find', query: 'x' })).toBe(
      true,
    );
  });

  it('never treats a write or a verification as inspection', () => {
    for (const command of ['create', 'str_replace', 'insert', 'patch', 'delete']) {
      expect(isInspectionCall('str_replace_based_edit_tool', { command })).toBe(false);
    }
    for (const tool of ['verify_artifact', 'playtest_game', 'validate_game_scene', 'done']) {
      expect(isInspectionCall(tool, {})).toBe(false);
    }
    expect(isInspectionCall(undefined, undefined)).toBe(false);
  });

  it('keeps the free allowance bounded', () => {
    expect(FREE_INSPECTION_CALLS).toBeGreaterThan(0);
    expect(FREE_INSPECTION_CALLS).toBeLessThanOrEqual(60);
  });
});

describe('wrap-up warning', () => {
  it('fires once when the cap is near, and not before', () => {
    expect(shouldWarnWrapUp(WRAP_UP_WARNING_CALLS + 1, false)).toBe(false);
    expect(shouldWarnWrapUp(WRAP_UP_WARNING_CALLS, false)).toBe(true);
    expect(shouldWarnWrapUp(2, false)).toBe(true);
    expect(shouldWarnWrapUp(2, true)).toBe(false);
  });

  it('asks for a fix, a verify, and a done that says what was chosen', () => {
    const text = wrapUpReminder(6);
    expect(text).toContain('6 tool calls left');
    expect(text).toMatch(/exact wording/);
    expect(text).toMatch(/call done/);
    expect(text).toMatch(/the world, who the player is, the core loop and the twist/);
    expect(wrapUpReminder(-3)).toContain('0 tool calls left');
  });
});
