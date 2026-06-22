import type { LoadedSkill } from '@playforge/shared';
import { describe, expect, it } from 'vitest';
import { makeViewSkillRuleTool } from './view-skill-rule.js';

// Minimal LoadedSkill fixtures — only the fields view_skill_rule reads.
const folderSkill = {
  id: 'remotion-best-practices',
  rules: [
    { path: 'rules/timing.md', content: '# Timing\nUse interpolate.' },
    { path: 'rules/audio.md', content: '# Audio\nSync to fps.' },
  ],
} as unknown as LoadedSkill;

const flatSkill = { id: 'phaser' } as unknown as LoadedSkill;

function textOf(result: { content: ReadonlyArray<unknown> }): string {
  return result.content
    .map((c) => {
      const t = (c as { text?: unknown }).text;
      return typeof t === 'string' ? t : '';
    })
    .join('');
}

describe('view_skill_rule', () => {
  it('returns the rule body for a valid (skillId, rulePath)', async () => {
    const tool = makeViewSkillRuleTool([folderSkill]);
    const res = await tool.execute('v1', {
      skillId: 'remotion-best-practices',
      rulePath: 'rules/timing.md',
    });
    expect(textOf(res)).toContain('Use interpolate.');
    expect(res.details.ok).toBe(true);
  });

  it('LISTS available rules when rulePath is omitted (the missing-rulePath fix — no tool validation failure)', async () => {
    // Regression guard: rulePath is Optional; omitting it must list the rules to
    // pick from, NOT fail tool validation (the pre-c93c994 behaviour that caused
    // ~9 failed calls where the model passed only skillId).
    const tool = makeViewSkillRuleTool([folderSkill]);
    const res = await tool.execute('v2', { skillId: 'remotion-best-practices' });
    const text = textOf(res);
    expect(text).toMatch(/has these rules/);
    expect(text).toContain('rules/timing.md');
    expect(text).toContain('rules/audio.md');
    expect(res.details.ok).toBe(false);
  });

  it('explains a flat-format skill has no rule subpages', async () => {
    const tool = makeViewSkillRuleTool([flatSkill]);
    const res = await tool.execute('v3', { skillId: 'phaser' });
    expect(textOf(res)).toMatch(/flat-format skill with no rule subpages/);
    expect(res.details.ok).toBe(false);
  });

  it('reports an unknown skillId with the available list', async () => {
    const tool = makeViewSkillRuleTool([folderSkill]);
    const res = await tool.execute('v4', { skillId: 'does-not-exist' });
    expect(textOf(res)).toMatch(/is not loaded for this run/);
    expect(textOf(res)).toContain('remotion-best-practices');
  });

  it('reports an unknown rulePath with the known list', async () => {
    const tool = makeViewSkillRuleTool([folderSkill]);
    const res = await tool.execute('v5', {
      skillId: 'remotion-best-practices',
      rulePath: 'rules/nope.md',
    });
    expect(textOf(res)).toMatch(/no rule "rules\/nope\.md"/);
    expect(textOf(res)).toContain('rules/timing.md');
  });
});
