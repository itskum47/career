/**
 * PHASE 3 - BENCHMARK B: OPTIMIZED SEQUENTIAL
 * 5 jobs, sequential, ALL current optimizations enabled (cache flags = 1, debounce default).
 * Command:
 *   BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_b_optimized.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';

// Optimization flags ENABLED (optimized) - must be set before src/core/config.ts loads
process.env.DB_PATH = './data/bench-b.db';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';
process.env.EXCEL_SYNC_DEBOUNCE_MS = '2000';
process.env.JOB_CONCURRENCY = '2';

import { runSequentialBenchmark } from './sequential.ts';

const COMMAND =
  'BROWSER_HEADLESS=false JD_CACHE_ENABLED=1 MATCH_CACHE_ENABLED=1 ARTIFACT_CACHE_ENABLED=1 ' +
  'LLM_CACHE_ENABLED=1 EXCEL_SYNC_DEBOUNCE_MS=2000 JOB_CONCURRENCY=2 ' +
  'npx vitest run tests/e2e/phase3/bench_b_optimized.test.ts --reporter=verbose';

describe('Phase 3 Benchmark B: OPTIMIZED SEQUENTIAL (5 jobs, caches enabled)', () => {
  it('runs 5 jobs through the real pipeline and reports raw timings', async () => {
    const r = await runSequentialBenchmark({
      name: 'bench_b_optimized',
      command: COMMAND,
      tag: 'B',
      port: 32611,
      dbPath: './data/bench-b.db',
      jobCount: 5,
      cacheFlags: {
        JD_CACHE_ENABLED: '1', MATCH_CACHE_ENABLED: '1',
        ARTIFACT_CACHE_ENABLED: '1', LLM_CACHE_ENABLED: '1',
        EXCEL_SYNC_DEBOUNCE_MS: '2000', JOB_CONCURRENCY: '2',
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
