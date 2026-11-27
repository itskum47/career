/**
 * PHASE 3 - BENCHMARK A: BASELINE
 * 5 jobs, sequential, ALL optimization feature flags DISABLED
 * (JD/match/artifact/LLM cache flags = 0, no debounce).
 * Command:
 *   BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_a_baseline.test.ts --reporter=verbose
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Optimization flags DISABLED (baseline) - must be set before src/core/config.ts loads
process.env.DB_PATH = './data/bench-a.db';
process.env.JD_CACHE_ENABLED = '0';
process.env.MATCH_CACHE_ENABLED = '0';
process.env.ARTIFACT_CACHE_ENABLED = '0';
process.env.LLM_CACHE_ENABLED = '0';
process.env.EXCEL_SYNC_DEBOUNCE_MS = '0';
process.env.JOB_CONCURRENCY = '1';

import { runSequentialBenchmark } from './sequential.ts';

const COMMAND =
  'BROWSER_HEADLESS=false JD_CACHE_ENABLED=0 MATCH_CACHE_ENABLED=0 ARTIFACT_CACHE_ENABLED=0 ' +
  'LLM_CACHE_ENABLED=0 EXCEL_SYNC_DEBOUNCE_MS=0 JOB_CONCURRENCY=1 ' +
  'npx vitest run tests/e2e/phase3/bench_a_baseline.test.ts --reporter=verbose';

describe('Phase 3 Benchmark A: BASELINE (5 jobs sequential, caches disabled)', () => {
  it('runs 5 jobs through the real pipeline and reports raw timings', async () => {
    const r = await runSequentialBenchmark({
      name: 'bench_a_baseline',
      command: COMMAND,
      tag: 'A',
      port: 32610,
      dbPath: './data/bench-a.db',
      jobCount: 5,
      cacheFlags: {
        JD_CACHE_ENABLED: '0', MATCH_CACHE_ENABLED: '0',
        ARTIFACT_CACHE_ENABLED: '0', LLM_CACHE_ENABLED: '0',
        EXCEL_SYNC_DEBOUNCE_MS: '0', JOB_CONCURRENCY: '1',
      },
    });

    expect(r.outcomes.length).toBe(5);
    expect(r.outcomes.every(o => o.success)).toBe(true);
    expect(r.outcomes.every(o => o.state === 'CONFIRMED')).toBe(true);
    expect(r.dbApplications).toBe(5);
    expect(r.excelExists).toBe(true);
    expect(r.stageStats.length).toBeGreaterThan(0);
  }, 300000);
});
