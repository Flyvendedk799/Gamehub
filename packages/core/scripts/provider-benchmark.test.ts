import { describe, expect, it } from 'vitest';
import { BENCHMARK_PATHS, buildBenchmarkPlan } from './provider-benchmark';

describe('offline provider benchmark preparation', () => {
  it('pairs all briefs across three paths and independent repetitions without claiming results', () => {
    const fixtures = Array.from({ length: 14 }, (_, i) => ({
      slug: `brief-${i}`,
      brief: `Game ${i}`,
    }));
    const plan = buildBenchmarkPlan(fixtures);
    expect(plan.cases).toHaveLength(126);
    expect(new Set(plan.cases.map((item) => item.id)).size).toBe(126);
    for (const provider of BENCHMARK_PATHS) {
      expect(plan.cases.filter((item) => item.providerPath === provider)).toHaveLength(42);
    }
    expect(plan).toEqual(buildBenchmarkPlan(fixtures));
    expect(plan.cases).not.toEqual(buildBenchmarkPlan(fixtures, 'different-seed').cases);
    expect(plan.status).toBe('prepared_not_run');
    expect(plan.configuration.every((item) => item.exactModelId === null)).toBe(true);
  });
});
