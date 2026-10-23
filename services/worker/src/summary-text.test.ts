import { describe, expect, it } from 'vitest';
import { cleanSummary } from './summary-text';

describe('cleanSummary', () => {
  it('keeps a normal summary as it is', () => {
    expect(cleanSummary('- Strikes now chain into a combo.')).toBe(
      '- Strikes now chain into a combo.',
    );
  });

  it('strips the limit boilerplate a stopped or paused run appends', () => {
    expect(
      cleanSummary(
        '**What I chose.** A moonlit bridge duel. — Stopped after 44 steps. The project above is what landed; send a follow-up message to keep refining it. —',
      ),
    ).toBe('**What I chose.** A moonlit bridge duel.');
    expect(
      cleanSummary('Built the arena. — Paused after 1200s of work to keep this turn responsive. —'),
    ).toBe('Built the arena.');
  });

  it('returns null for nothing worth showing, and caps very long text', () => {
    expect(cleanSummary('')).toBeNull();
    expect(cleanSummary('ok')).toBeNull();
    expect(cleanSummary(undefined)).toBeNull();
    const long = cleanSummary('x'.repeat(5000), 100);
    expect(long?.length).toBeLessThanOrEqual(101);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('chatRowsForCompletedRun', () => {
  it('leaves the reply first, then the delivery card', async () => {
    const { chatRowsForCompletedRun } = await import('./summary-text');
    const rows = chatRowsForCompletedRun({
      runId: 'r1',
      message: '- Strikes now chain into a combo.',
      engine: 'three',
      snapshotId: 's1',
      quality: { status: 'verified' },
    });
    expect(rows.map((r) => r.kind)).toEqual(['assistant_text', 'artifact_delivered']);
    expect(rows[0]?.payload).toEqual({ runId: 'r1', text: '- Strikes now chain into a combo.' });
    expect(rows[1]?.payload).toMatchObject({
      runId: 'r1',
      previewUrl: '/v1/runs/r1/preview/',
      snapshotId: 's1',
    });
  });

  it('keeps the changed files on the reply, so a reloaded chat can list them', async () => {
    const { chatRowsForCompletedRun } = await import('./summary-text');
    const rows = chatRowsForCompletedRun({
      runId: 'r1',
      message: '- Better combat.',
      engine: 'three',
      snapshotId: 's1',
      quality: null,
      files: ['src/combat.js', 'src/hud.js'],
    });
    expect(rows[0]?.payload).toEqual({
      runId: 'r1',
      text: '- Better combat.',
      files: ['src/combat.js', 'src/hud.js'],
    });
  });

  it('leaves no reply row when there is nothing worth keeping', async () => {
    const { chatRowsForCompletedRun } = await import('./summary-text');
    const rows = chatRowsForCompletedRun({
      runId: 'r1',
      message: '',
      engine: null,
      snapshotId: null,
      quality: undefined,
    });
    expect(rows.map((r) => r.kind)).toEqual(['artifact_delivered']);
    expect(rows[0]?.payload['quality']).toBeNull();
  });
});
