/**
 * PHASE 3 - BENCHMARK E: BROWSER POOL BENEFIT
 * Mode 1: browser-per-job (fresh ApplicationEngine per job: initialize + close)
 * Mode 2: engine reuse (one ApplicationEngine for all jobs)
 * Mode 3: BrowserPool real acquire/release timings (context acquisition)
 * Command:
 *   BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_e_browser_pool.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

process.env.DB_PATH = './data/bench-e.db';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32614;
const TAG = 'E';
const JOB_COUNT = 4;
const COMMAND =
  'BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_e_browser_pool.test.ts --reporter=verbose';

describe('Phase 3 Benchmark E: BROWSER POOL BENEFIT (per-job vs reuse vs pool)', () => {
  it('measures browser-per-job vs engine reuse vs BrowserPool acquire', async () => {
    const startedAt = new Date().toISOString();
    const specs = H.makeBenchJobs(PORT, JOB_COUNT, TAG);

    const server = new FakeATSServer(PORT);
    server.addJobs(H.toFakeAtsJobs(specs));
    await server.start();

    try {
      const dbBundle = await H.setupDb('./data/bench-e.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
      const { performanceCollector } = await import(path.join(H.srcPath, 'performance/hooks.ts'));
      let results: any = {
        command: COMMAND,
        startedAt,
        endedAt: '',
        jobCount: JOB_COUNT,
      };

      // ---- MODE 1: browser-per-job ----
      performanceCollector.clear();
      const m1: H.JobOutcome[] = [];
      const initTimesM1: number[] = [];
      const t1 = Date.now();
      for (const spec of specs) {
        const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-m1-profile`);
        const engine = new ApplicationEngine({ profilePath });
        const ti = Date.now();
        await engine.initialize();
        initTimesM1.push(Date.now() - ti);
        const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);
        const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
        m1.push(o);
        await engine.close();
        console.log(
          `[BENCH ${TAG}] mode1 job=${o.jobId} wall=${o.wallMs}ms init=${initTimesM1[initTimesM1.length - 1]}ms success=${o.success}`
        );
      }
      const wallMode1 = Date.now() - t1;

      // ---- MODE 2: engine reuse ----
      performanceCollector.clear();
      const profilePathM2 = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-m2-profile`);
      const engineM2 = new ApplicationEngine({ profilePath: profilePathM2 });
      const ti2 = Date.now();
      await engineM2.initialize();
      const initTimeM2 = Date.now() - ti2;
      const m2: H.JobOutcome[] = [];
      const t2 = Date.now();
      try {
        for (const spec of specs) {
          const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engineM2);
          const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
          m2.push(o);
          console.log(`[BENCH ${TAG}] mode2 job=${o.jobId} wall=${o.wallMs}ms success=${o.success}`);
        }
        const wallMode2 = Date.now() - t2;

        // ---- MODE 3: BrowserPool real acquire/release ----
        const { BrowserPool } = await import(path.join(H.srcPath, 'browser/pool.ts'));
        const pool = new BrowserPool();
        await pool.initialize();
        const acquires: Array<{ acquireMs: number; contextId: string }> = [];
        const released: string[] = [];
        const acquired: any[] = [];
        for (const spec of specs) {
          const ta = Date.now();
          const ctxP = await pool.acquire(`APP-${spec.atsJobId}`);
          acquires.push({ acquireMs: Date.now() - ta, contextId: (ctxP as any).id });
          acquired.push(ctxP);
        }
        for (const ctxP of acquired) {
          await pool.release((ctxP as any).id);
          released.push((ctxP as any).id);
        }
        await pool.shutdown();

        const acquireTimes = acquires.map(a => a.acquireMs);
        const poolSummary = H.summarize(acquireTimes, acquireTimes.reduce((s, t) => s + t, 0));

        results = {
          command: COMMAND,
          startedAt,
          endedAt: new Date().toISOString(),
          jobCount: JOB_COUNT,
          mode1_browserPerJob: {
            description: 'fresh ApplicationEngine (initialize + close) per job',
            initCount: initTimesM1.length,
            initTimesMs: initTimesM1,
            initTotalMs: initTimesM1.reduce((s, t) => s + t, 0),
            batchMs: wallMode1,
            outcomes: m1,
            summary: H.summarize(m1.map(o => o.wallMs), wallMode1),
          },
          mode2_engineReuse: {
            description: 'one ApplicationEngine reused for all jobs',
            initCount: 1,
            initTimesMs: [initTimeM2],
            initTotalMs: initTimeM2,
            batchMs: wallMode2,
            outcomes: m2,
            summary: H.summarize(m2.map(o => o.wallMs), wallMode2),
          },
          savings: {
            initMsSaved: initTimesM1.reduce((s, t) => s + t, 0) - initTimeM2,
            batchMsSaved: wallMode1 - wallMode2,
          },
          mode3_browserPool: {
            description: 'BrowserPool acquire/release (context acquisition)',
            acquires,
            releaseCount: released.length,
            acquireSummary: poolSummary,
          },
          stageStats: await H.getStageStats(),
        };
        H.writeResult('bench_e_browser_pool', results);
        H.printRawRun('bench_e_browser_pool', {
          command: COMMAND,
          startedAt: results.startedAt,
          endedAt: results.endedAt,
          jobs: JOB_COUNT,
          mode1: `initCount=${initTimesM1.length} initTotalMs=${initTimesM1.reduce((s, t) => s + t, 0)} batchMs=${wallMode1} avgMs=${results.mode1_browserPerJob.summary.avgMs} jobsPerHour=${results.mode1_browserPerJob.summary.jobsPerHour}`,
          mode2: `initCount=1 initTotalMs=${initTimeM2} batchMs=${wallMode2} avgMs=${results.mode2_engineReuse.summary.avgMs} jobsPerHour=${results.mode2_engineReuse.summary.jobsPerHour}`,
          savings: `initMsSaved=${results.savings.initMsSaved} batchMsSaved=${results.savings.batchMsSaved}`,
          poolAcquires: acquires.map(a => `${a.contextId}=${a.acquireMs}ms`).join(', '),
          poolAcquireAvgMs: poolSummary.avgMs,
          poolReleases: released.length,
          mode1Success: m1.filter(o => o.success).length,
          mode2Success: m2.filter(o => o.success).length,
        });

        expect(m1.every(o => o.success)).toBe(true);
        expect(m2.every(o => o.success)).toBe(true);
        // Pool benefit must be MEASURED: reuse must not do more browser inits than per-job mode
        expect(initTimesM1.length).toBe(JOB_COUNT);
        expect(acquires.length).toBe(JOB_COUNT);
        expect(released.length).toBe(JOB_COUNT);
      } finally {
        await engineM2.close();
      }
    } finally {
      await server.stop();
    }
  }, 420000);
});
