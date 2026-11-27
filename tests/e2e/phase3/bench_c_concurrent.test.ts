/**
 * PHASE 3 - BENCHMARK C: OPTIMIZED CONCURRENT
 * 10 jobs at production concurrency (config.application.maxConcurrentApplications),
 * each worker has its OWN ApplicationEngine (independent persistent browser contexts,
 * distinct profilePath - no shared Chromium SingletonLock).
 * Command:
 *   BROWSER_HEADLESS=false JOB_CONCURRENCY=2 npx vitest run tests/e2e/phase3/bench_c_concurrent.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

process.env.DB_PATH = './data/bench-c.db';
process.env.JOB_CONCURRENCY = process.env.JOB_CONCURRENCY || '2';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32612;
const TAG = 'C';
const JOB_COUNT = 10;
const COMMAND =
  'BROWSER_HEADLESS=false JOB_CONCURRENCY=2 ' +
  'npx vitest run tests/e2e/phase3/bench_c_concurrent.test.ts --reporter=verbose';

interface CResult {
  command: string;
  startedAt: string;
  endedAt: string;
  concurrency: number;
  jobCount: number;
  discoveryMs: number;
  enginesInitMs: number;
  batchMs: number;
  outcomes: H.JobOutcome[];
  summary: H.TimingSummary;
  sequentialEstimateMs: number;
  dbApplications: number;
  stageStats: H.StageStat[];
}

describe('Phase 3 Benchmark C: OPTIMIZED CONCURRENT (10 jobs, production concurrency)', () => {
  it('runs 10 jobs across independent browser contexts and reports raw timings', async () => {
    const startedAt = new Date().toISOString();
    const specs = H.makeBenchJobs(PORT, JOB_COUNT, TAG);

    const server = new FakeATSServer(PORT);
    server.addJobs(H.toFakeAtsJobs(specs));
    await server.start();

    const engines: any[] = [];
    try {
      const dbBundle = await H.setupDb('./data/bench-c.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      // Production concurrency value
      const { config } = await import(path.join(H.srcPath, 'core/config.ts'));
      const concurrency = config.application.maxConcurrentApplications;

      // One engine (= one persistent Chromium context) per worker
      const t0 = Date.now();
      for (let i = 0; i < concurrency; i++) {
        const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile-${i}`);
        const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
        const engine = new ApplicationEngine({ profilePath });
        engines.push(engine);
      }
      await Promise.all(engines.map(e => e.initialize()));
      const enginesInitMs = Date.now() - t0;

      const disc = await H.discoverJobs(specs);
      expect(disc.jobs.length).toBe(JOB_COUNT);

      // Worker pool: each worker runs the full real pipeline on its own engine
      const queue = [...specs];
      const outcomes: H.JobOutcome[] = [];
      const batchStart = Date.now();
      await Promise.all(
        engines.map(async (engine, idx) => {
          const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);
          let spec = queue.shift();
          while (spec) {
            const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
            outcomes.push(o);
            console.log(
              `[BENCH ${TAG}] worker=${idx} job=${o.jobId} wall=${o.wallMs}ms ` +
              `success=${o.success} state=${o.state} conf=${o.confirmationId || '-'}`
            );
            spec = queue.shift();
          }
        })
      );
      const batchMs = Date.now() - batchStart;

      const appCountRes = await dbBundle.db.query('SELECT COUNT(*) AS c FROM applications');
      const dbApplications = Number(appCountRes.rows[0].c);
      const stageStats = await H.getStageStats();
      const summary = H.summarize(outcomes.map(o => o.wallMs), batchMs);
      const sequentialEstimateMs = summary.avgMs * JOB_COUNT;

      const result: CResult = {
        command: COMMAND,
        startedAt,
        endedAt: new Date().toISOString(),
        concurrency,
        jobCount: JOB_COUNT,
        discoveryMs: disc.wallMs,
        enginesInitMs,
        batchMs,
        outcomes,
        summary,
        sequentialEstimateMs,
        dbApplications,
        stageStats,
      };
      H.writeResult('bench_c_concurrent', result);
      H.printRawRun('bench_c_concurrent', {
        command: COMMAND,
        startedAt,
        endedAt: result.endedAt,
        concurrency,
        jobs: JOB_COUNT,
        success: outcomes.filter(o => o.success).length,
        failed: outcomes.filter(o => !o.success).length,
        enginesInitMs,
        discoveryMs: disc.wallMs,
        batchMs,
        avgMs: summary.avgMs,
        medianMs: summary.medianMs,
        p95Ms: summary.p95Ms,
        minMs: summary.minMs,
        maxMs: summary.maxMs,
        jobsPerHour: summary.jobsPerHour,
        sequentialEstimateMs,
        speedup: Math.round((sequentialEstimateMs / batchMs) * 100) / 100,
        dbApplications,
        stages: stageStats.map(s => `${s.stage}=${s.count}(${Math.round(s.average)}ms)`),
      });

      expect(outcomes.length).toBe(JOB_COUNT);
      expect(outcomes.every(o => o.success)).toBe(true);
      expect(outcomes.every(o => o.state === 'CONFIRMED')).toBe(true);
      expect(dbApplications).toBe(JOB_COUNT);
      // Concurrency must be REAL: the batch wall must be materially shorter than the
      // sum of per-job walls (i.e. jobs actually overlapped). Load-independent proof.
      const sumJobWalls = outcomes.reduce((s, o) => s + o.wallMs, 0);
      expect(batchMs).toBeLessThan(sumJobWalls * 0.85);
    } finally {
      await Promise.all(engines.map(e => e.close().catch(() => {})));
      await server.stop();
    }
  }, 420000);
});
