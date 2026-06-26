import { describe, expect, it } from 'vitest';
import {
  INTERACTIVITY_FLOOR_IDLE_STEPS,
  buildInteractivityFloorPlan,
  detectInteractivityResponse,
  planPlaytest,
} from './playtest-planner';

/** Build a floor-probe trace: a pre-input baseline, then one idle frame, then
 *  the given input frames. Matches what the browser worker returns. */
function floorTrace(baseline: unknown, idle: unknown, ...inputs: unknown[]) {
  return {
    baselineSnapshot: baseline,
    steps: [{ snapshotAfter: idle }, ...inputs.map((s) => ({ snapshotAfter: s }))],
  };
}

describe('planPlaytest (Phase 6)', () => {
  it('skips playtest on a static artifact (no form / onclick / nav)', () => {
    const html = '<html><body><h1>Hi</h1><p>just text</p></body></html>';
    expect(planPlaytest(html).shouldPlaytest).toBe(false);
    expect(planPlaytest(html).steps).toHaveLength(0);
  });

  it('plans fill + submit for a form', () => {
    const html = `
      <form action="/contact">
        <input name="email" type="email" required>
        <input name="message" type="text" required>
        <button type="submit">Send</button>
      </form>
    `;
    const plan = planPlaytest(html);
    expect(plan.shouldPlaytest).toBe(true);
    const fills = plan.steps.filter((s) => s.action === 'fill');
    expect(fills).toHaveLength(2);
    expect(fills[0]?.value).toBe('test@example.com');
    expect(fills[1]?.value).toBe('playtest');
    expect(plan.steps.some((s) => s.action === 'submit')).toBe(true);
  });

  it('plans click for inline onclick handlers', () => {
    const html = `<button onclick="doTheThing()">Click</button>`;
    const plan = planPlaytest(html);
    expect(plan.shouldPlaytest).toBe(true);
    expect(plan.steps[0]?.action).toBe('click');
  });

  it('plans hover for navigation', () => {
    const html = `<nav><a href="/a">A</a><a href="/b">B</a></nav>`;
    const plan = planPlaytest(html);
    expect(plan.shouldPlaytest).toBe(true);
    expect(plan.steps[0]?.action).toBe('hover');
  });

  it('caps at MAX_STEPS = 5 even on heavily interactive artifacts', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => `<input name="f${i}" type="text"/>`).join(
      '',
    );
    const html = `<form>${inputs}<button onclick="submit()">Submit</button></form>`;
    const plan = planPlaytest(html);
    expect(plan.steps.length).toBeLessThanOrEqual(5);
  });

  it('every step carries a non-empty reason for telemetry', () => {
    const html = `<form><input name="email" type="email"></form>`;
    for (const step of planPlaytest(html).steps) {
      expect(step.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('buildInteractivityFloorPlan', () => {
  it('leads with the idle baseline step and drives BOTH arrow + WASD schemes', () => {
    const plan = buildInteractivityFloorPlan();
    // The first INTERACTIVITY_FLOOR_IDLE_STEPS steps must be idle waits (ambient baseline).
    for (let i = 0; i < INTERACTIVITY_FLOOR_IDLE_STEPS; i++) {
      expect(plan.steps[i]?.kind).toBe('wait');
    }
    const keyCodes = plan.steps.flatMap((s) => (s.kind === 'key' ? [s.code] : []));
    expect(keyCodes).toContain('ArrowRight');
    expect(keyCodes).toContain('ArrowUp');
    expect(keyCodes).toContain('KeyW'); // WASD scheme too — covers either control mapping
    expect(keyCodes).toContain('KeyD');
    expect(keyCodes).toContain('Space');
    expect(plan.steps.some((s) => s.kind === 'mouseDown')).toBe(true);
    expect(plan.predicates).toHaveLength(0); // floor mints NO scorePlaytest predicate (M1/M2)
  });
});

describe('detectInteractivityResponse (ambient-subtracted interactivity floor)', () => {
  it('reports responded=true when input changes a field beyond ambient drift', () => {
    // `t` drifts during idle (ambient); `score` only moves under input.
    const trace = floorTrace(
      { score: 0, t: 0 },
      { score: 0, t: 5 }, // idle: only the clock advanced
      { score: 1, t: 9 },
      { score: 3, t: 13 },
    );
    const r = detectInteractivityResponse(trace);
    expect(r.analyzable).toBe(true);
    expect(r.responded).toBe(true);
    expect(r.ambientFields).toEqual(['t']);
    expect(r.inputFields).toEqual(['score']);
  });

  it('reports responded=false for a dead game (nothing changes at all)', () => {
    const trace = floorTrace({ score: 0 }, { score: 0 }, { score: 0 }, { score: 0 });
    const r = detectInteractivityResponse(trace);
    expect(r.analyzable).toBe(true);
    expect(r.responded).toBe(false);
  });

  it('does NOT count pure ambient drift as a response (the M1/M2 false-signal)', () => {
    // A ticking clock that advances every frame, idle or not, and NOTHING responds
    // to input. The ambient subtraction must reject it (responded=false).
    const trace = floorTrace({ t: 0 }, { t: 5 }, { t: 9 }, { t: 13 });
    const r = detectInteractivityResponse(trace);
    expect(r.analyzable).toBe(true);
    expect(r.responded).toBe(false);
    expect(r.inputFields).toEqual([]);
  });

  it('registers a nested {x,y} position change under input', () => {
    const trace = floorTrace(
      { playerPos: { x: 100, y: 100 } },
      { playerPos: { x: 100, y: 100 } }, // no idle drift
      { playerPos: { x: 130, y: 100 } }, // moved under input
    );
    const r = detectInteractivityResponse(trace);
    expect(r.responded).toBe(true);
    expect(r.inputFields).toEqual(['playerPos']);
  });

  it('is not analyzable when the baseline/idle snapshot is empty or null', () => {
    expect(detectInteractivityResponse(floorTrace(null, null, { score: 1 })).analyzable).toBe(
      false,
    );
    expect(detectInteractivityResponse(floorTrace({}, {}, { score: 1 })).analyzable).toBe(false);
    // Too few frames (only the idle step) — nothing to compare.
    expect(
      detectInteractivityResponse({
        baselineSnapshot: { s: 0 },
        steps: [{ snapshotAfter: { s: 0 } }],
      }).analyzable,
    ).toBe(false);
  });
});
