/**
 * PHASE 3 - BENCHMARK G: RECOVERY
 * One job submitted through the REAL MemoryQueue (production defaults:
 * maxRetries=3, retryDelayMs=5000, backoff x2) with ONE injected transient
 * 500 on GET /apply (Fake ATS). Measures: failure, retry, recovery time,
 * final state and DUPLICATE submission check.
 * Command:
 *   BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_g_recovery.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

process.env.DB_PATH = './data/bench-g.db';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32616;
const TAG = 'G';
const COMMAND =
  'BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_g_recovery.test.ts --reporter=verbose';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Phase 3 Benchmark G: RECOVERY (one injected transient failure)', () => {
  it('fails once, retries, recovers without duplicate submission', async () => {
    const startedAt = new Date().toISOString();
    const specs = H.makeBenchJobs(PORT, 1, TAG);
    const spec = specs[0];

    const server = new FakeATSServer(PORT);
    server.addJobs(H.toFakeAtsJobs(specs));
    // Inject 1 transient 500 on the BROWSER's GET /apply (skip 1: the pipeline's
    // JD-extraction fetch performs its own GET before the browser navigates)
    server.injectTransientFailures(spec.atsJobId, 1, 1);
    await server.start();

    let engine: any = null;
    try {
      const dbBundle = await H.setupDb('./data/bench-g.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
      const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile`);
      engine = new ApplicationEngine({ profilePath });
      await engine.initialize();

      const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);
      const disc = await H.discoverJobs(specs);
      expect(disc.jobs.length).toBe(1);

      // Real queue with PRODUCTION retry defaults (maxRetries 3, retryDelayMs 5000, backoff 2)
      const { MemoryQueue } = await import(path.join(H.srcPath, 'worker/queue.ts'));
      const handlers = new Map();
      handlers.set('apply', async (_job: any) => {
        const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
        if (!o.success) {
          throw new Error(`pipeline failed: ${o.error || 'unknown'}`);
        }
        return o;
      });
      const queue = new MemoryQueue({ name: 'bench-g-worker', handlers, config: { concurrency: 1 } });

      const events: Array<{ type: string; at: number; delayMs?: number; error?: string; result?: any }> = [];
      queue.addEventListener((e: any) => {
        events.push({
          type: e.type,
          at: Date.now(),
          delayMs: e.data?.delayMs,
          error: typeof e.error === 'string' ? e.error : e.error?.message,
          result: e.data?.result,
        });
        console.log(`[BENCH ${TAG}] queue event=${e.type} delayMs=${e.data?.delayMs ?? '-'} error=${typeof e.error === 'string' ? e.error : e.error?.message ?? '-'}`);
      });

      server.clearRequestLog();
      const t0 = Date.now();
      const jobId = await queue.add('apply', { jobId: spec.jobId });
      const startPromise = queue.start(); // processing loop (not awaited - runs until stop)

      // Wait for completion; bail out early if the retry never re-executes (stuck detection)
      const deadline = t0 + 120000;
      let stuck = false;
      while (Date.now() < deadline && !events.some(e => e.type === 'job:completed')) {
        const retried = events.find(e => e.type === 'job:retried');
        if (retried && !events.some(e => e.type === 'job:completed')) {
          const waitBudget = (retried.delayMs || 5000) + 25000;
          if (Date.now() - retried.at > waitBudget && !events.some(e => e.type === 'job:started' && e.at > retried.at)) {
            stuck = true;
            break;
          }
        }
        if (events.some(e => e.type === 'job:failed')) break;
        await sleep(250);
      }
      const tEnd = Date.now();

      await queue.stop();
      await startPromise.catch(() => {});

      // ---- Measurements ----
      const starteds = events.filter(e => e.type === 'job:started');
      const retried = events.find(e => e.type === 'job:retried');
      const completed = events.find(e => e.type === 'job:completed');
      const failed = events.filter(e => e.type === 'job:failed');

      const reqLog = server.getRequestLog();
      const injected500s = reqLog.filter(r => r.path === '/apply' && r.status === 500).length;
      const applyPosts = reqLog.filter(r => r.path === '/apply' && r.method === 'POST').length;
      const atsSubmissions = server.applicationsForJob(spec.atsJobId).length; // duplicate check

      const dbRows = await dbBundle.db.query(
        "SELECT state, COUNT(*) AS c FROM applications GROUP BY state"
      );
      const stateCounts = Object.fromEntries(dbRows.rows.map((r: any) => [r.state, Number(r.c)]));
      const confirmedRows = stateCounts['CONFIRMED'] || 0;

      const recoveryMs = completed && retried ? completed.at - retried.at : -1;
      const totalMs = completed ? completed.at - t0 : tEnd - t0;

      const result = {
        command: COMMAND,
        startedAt,
        endedAt: new Date().toISOString(),
        jobId: spec.jobId,
        atsJobId: spec.atsJobId,
        queueConfig: { maxRetries: 3, retryDelayMs: 5000, retryBackoffMultiplier: 2, concurrency: 1 },
        injectedFailures: 1,
        injectedFailureSkipGets: 1,
        observed: {
          attemptsStarted: starteds.length,
          failureEvents: failed.length,
          retried: !!retried,
          retryDelayMs: retried?.delayMs,
          completed: !!completed,
          stuckAfterRetry: stuck,
          jobState: completed ? completed.result?.state : null,
          confirmationId: completed ? completed.result?.confirmationId : null,
          success: completed ? completed.result?.success : false,
        },
        timing: {
          t0,
          attempt1StartMs: starteds[0] ? starteds[0].at - t0 : -1,
          attempt1FailMs: retried ? retried.at - t0 : -1,
          attempt2StartMs: starteds[1] ? starteds[1].at - t0 : -1,
          completedMs: completed ? completed.at - t0 : -1,
          recoveryMs, // from first failure (retried) to successful completion
          totalMs,
        },
        fakeAts: {
          injected500s,
          applyGets200: reqLog.filter(r => r.path === '/apply' && r.method === 'GET' && r.status === 200).length,
          applyPosts,
          submissionsForJob: atsSubmissions,
        },
        db: { stateCounts, confirmedRows },
        eventTimeline: events.map(e => ({ type: e.type, atMs: e.at - t0, delayMs: e.delayMs, error: e.error })),
        stageStats: await H.getStageStats(),
      };
      H.writeResult('bench_g_recovery', result);
      H.printRawRun('bench_g_recovery', {
        command: COMMAND,
        startedAt,
        endedAt: result.endedAt,
        attemptsStarted: starteds.length,
        failureEvents: failed.length,
        retried: !!retried,
        retryDelayMs: retried?.delayMs,
        completed: !!completed,
        stuckAfterRetry: stuck,
        attempt1StartMs: result.timing.attempt1StartMs,
        attempt1FailMs: result.timing.attempt1FailMs,
        attempt2StartMs: result.timing.attempt2StartMs,
        completedMs: result.timing.completedMs,
        recoveryMs,
        totalMs,
        injected500s,
        applyPosts,
        atsSubmissionsForJob: atsSubmissions,
        dbStateCounts: JSON.stringify(stateCounts),
        finalState: result.observed.jobState,
        confirmationId: result.observed.confirmationId,
        timeline: events.map(e => `${e.type}@${e.at - t0}ms${e.delayMs ? `(delay=${e.delayMs})` : ''}`).join(' -> '),
      });

      // ---- Assertions ----
      // Injected fault actually happened
      expect(injected500s).toBe(1);
      // Queue scheduled a retry with the production delay
      expect(retried).toBeTruthy();
      expect(retried?.delayMs).toBe(5000);
      // Retry must RE-EXECUTE the job (attempt 2 started)
      expect(starteds.length).toBe(2);
      expect(completed).toBeTruthy();
      expect(result.observed.success).toBe(true);
      expect(result.observed.jobState).toBe('CONFIRMED');
      expect(result.observed.confirmationId).toBeTruthy();
      // NO duplicate submission: exactly one POST /apply and one application on the ATS
      expect(applyPosts).toBe(1);
      expect(atsSubmissions).toBe(1);
      expect(confirmedRows).toBe(1);
      // Recovery happened within a bounded window (fail + 5s delay + retry run)
      expect(recoveryMs).toBeGreaterThan(0);
      expect(recoveryMs).toBeLessThan(40000);
    } finally {
      if (engine) await engine.close();
      await server.stop();
    }
  }, 240000);
});
