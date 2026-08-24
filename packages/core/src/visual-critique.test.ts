import { describe, expect, it } from 'vitest';
import {
  MAX_VISUAL_CRITIQUES,
  buildVisualCritiquePrompt,
  buildVisualRepairInstruction,
  parseVisualCritique,
} from './visual-critique.js';

describe('buildVisualCritiquePrompt', () => {
  it('asks about the frame, and names the failure modes a snapshot cannot see', () => {
    const p = buildVisualCritiquePrompt('a neon endless runner');
    expect(p).toContain('a neon endless runner');
    for (const mode of ['lighting', 'silhouette', 'HUD', 'z-fighting', 'primitives']) {
      expect(p).toContain(mode);
    }
    // …and rules out the notes the agent cannot act on from one frame.
    expect(p).toMatch(/Do NOT comment on[\s\S]*difficulty/);
  });

  it('bounds the brief so a huge prompt cannot ride along into the vision call', () => {
    const p = buildVisualCritiquePrompt('x'.repeat(5000));
    expect(p.length).toBeLessThan(3000);
  });
});

describe('parseVisualCritique', () => {
  it('reads findings in order', () => {
    const c = parseVisualCritique(
      [
        'FINDING: the player is an untextured grey box against a grey floor',
        'FINDING: the score text overlaps the pause button top-right',
        'VERDICT: FIX',
      ].join('\n'),
    );
    expect(c.findings).toEqual([
      'the player is an untextured grey box against a grey floor',
      'the score text overlaps the pause button top-right',
    ]);
    expect(c.readsFinished).toBe(false);
  });

  it('reads a clean ship verdict', () => {
    const c = parseVisualCritique('VERDICT: SHIP');
    expect(c.findings).toEqual([]);
    expect(c.readsFinished).toBe(true);
  });

  it('tolerates markdown bullets and loose spacing', () => {
    const c = parseVisualCritique('- FINDING:  flat lighting\n * verdict : fix');
    expect(c.findings).toEqual(['flat lighting']);
  });

  it('caps findings at 4 so one critique cannot become a rewrite', () => {
    const many = Array.from({ length: 9 }, (_, i) => `FINDING: problem ${i}`).join('\n');
    expect(parseVisualCritique(many).findings).toHaveLength(4);
  });

  it('ignores the format block echoed back verbatim', () => {
    const c = parseVisualCritique('FINDING: <one specific, visible problem>\nVERDICT: SHIP');
    expect(c.findings).toEqual([]);
    expect(c.readsFinished).toBe(true);
  });

  it('fails safe on unparseable text — no findings, and no claim it was blessed', () => {
    const c = parseVisualCritique("Sure! Here's what I think about your game...");
    expect(c.findings).toEqual([]);
    // Crucially NOT readsFinished: we could not read it, so we cannot vouch for it.
    expect(c.readsFinished).toBe(false);
  });

  it('lets concrete findings win over a contradictory SHIP verdict', () => {
    const c = parseVisualCritique('FINDING: the canvas is empty\nVERDICT: SHIP');
    expect(c.findings).toEqual(['the canvas is empty']);
    expect(c.readsFinished).toBe(false);
  });
});

describe('buildVisualRepairInstruction', () => {
  it('lists the findings and scopes the fix to rendering', () => {
    const instruction = buildVisualRepairInstruction(['flat lighting', 'HUD clipped']);
    expect(instruction).toContain('1. flat lighting');
    expect(instruction).toContain('2. HUD clipped');
    expect(instruction).toMatch(/Change nothing unrelated/);
    // The gameplay is already deterministically verified — don't invite a rewrite.
    expect(instruction).toMatch(/not in the gameplay logic/);
  });
});

describe('the bound', () => {
  it('is two calls, not a loop', () => {
    expect(MAX_VISUAL_CRITIQUES).toBe(2);
  });
});
