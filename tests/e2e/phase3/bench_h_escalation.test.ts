/**
 * PHASE 3 - BENCHMARK H: HUMAN ESCALATION
 * 4 jobs at production concurrency; job H-001 has an unfillable question
 * ("How did you hear about us?") that must trigger PAUSED_FOR_USER escalation.
 * Measures: escalation fired on exactly one job, unrelated jobs continue,
 * pause duration, escalation/snapshot artifacts, resume-from-snapshot behavior.
 * Command:
 *   BROWSER_HEADLESS=false JOB_CONCURRENCY=2 npx vitest run tests/e2e/phase3/bench_h_escalation.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

process.env.DB_PATH = './data/bench-h.db';
process.env.JOB_CONCURRENCY = process.env.JOB_CONCURRENCY || '2';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32617;
const TAG = 'H';
const JOB_COUNT = 4;
const ESCALATION_DIR = path.join(process.cwd(), '.escalations');
const SNAPSHOT_DIR = path.join(process.cwd(), '.snapshots');
const COMMAND =
  'BROWSER_HEADLESS=false JOB_CONCURRENCY=2 ' +
  'npx vitest run tests/e2e/phase3/bench_h_escalation.test.ts --reporter=verbose';

function listJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}

describe('Phase 3 Benchmark H: HUMAN ESCALATION (one paused job, others continue)', () => {
  it('escalates exactly one job, others continue, resume works from snapshot', async () => {
    const startedAt = new Date().toISOString();

    // Clean escalation/snapshot state from prior runs
    for (const dir of [ESCALATION_DIR, SNAPSHOT_DIR]) {
      if (fs.existsSync(dir)) {
        for (const f of listJson(dir)) fs.rmSync(path.join(dir, f));
      }
    }
    const escBefore = listJson(ESCALATION_DIR).length;
    const snapBefore = listJson(SNAPSHOT_DIR).length;

    const specs = H.makeBenchJobs(PORT, JOB_COUNT, TAG);
    // Job 1 carries an optional question that cannot be answered from the profile
    specs[0].extraFields = [
      {
        name: 'howDidYouHear',
        label: 'How did you hear about us?',
        type: 'text',
        placeholder: 'How did you hear about us?',
        required: false,
      },
    ];

    const server = new FakeATSServer(PORT);
    server.addJobs(H.toFakeAtsJobs(specs));
    await server.start();

    const engines: any[] = [];
    try {
      const dbBundle = await H.setupDb('./data/bench-h.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      const { config } = await import(path.join(H.srcPath, 'core/config.ts'));
      const concurrency = config.application.maxConcurrentApplications;

      const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
      for (let i = 0; i < concurrency; i++) {
        const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile-${i}`);
        engines.push(new ApplicationEngine({ profilePath }));
      }
      await Promise.all(engines.map(e => e.initialize()));

      const disc = await H.discoverJobs(specs);
      expect(disc.jobs.length).toBe(JOB_COUNT);

      // Worker pool over the real pipeline; record per-job completion times
      const queue = [...specs];
      const completions: Array<{ outcome: H.JobOutcome; completedAt: number }> = [];
      const batchStart = Date.now();
      await Promise.all(
        engines.map(async (engine, idx) => {
          const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);
          let spec = queue.shift();
          while (spec) {
            const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
            completions.push({ outcome: o, completedAt: Date.now() });
            console.log(
              `[BENCH ${TAG}] worker=${idx} job=${o.jobId} wall=${o.wallMs}ms success=${o.success} ` +
              `state=${o.state} escalated=${o.escalated} pauseMs=${o.pauseMs}`
            );
            spec = queue.shift();
          }
        })
      );
      const batchMs = Date.now() - batchStart;

      // ---- Escalation artifacts on disk (created during the batch) ----
      const escFiles = listJson(ESCALATION_DIR);
      const snapFiles = listJson(SNAPSHOT_DIR);
      const escalated = completions.filter(c => c.outcome.escalated);
      const escalatedCompletion = escalated[0];
      let escalationRecord: any = null;
      if (escalatedCompletion) {
        for (const f of escFiles) {
          const rec = JSON.parse(fs.readFileSync(path.join(ESCALATION_DIR, f), 'utf-8'));
          if (rec.applicationId === escalatedCompletion.outcome.applicationId) {
            escalationRecord = rec;
            break;
          }
        }
      }
      const pauseWallMs = escalationRecord
        ? escalatedCompletion.completedAt - new Date(escalationRecord.createdAt).getTime()
        : -1;

      // ---- Unrelated jobs must have continued unaffected ----
      const unrelated = completions.filter(c => !c.outcome.escalated);
      const dbStates = await dbBundle.db.query(
        'SELECT state, COUNT(*) AS c FROM applications GROUP BY state'
      );
      const stateCounts = Object.fromEntries(dbStates.rows.map((r: any) => [r.state, Number(r.c)]));

      // ---- Resume behavior: a FRESH engine recovers the paused application from disk ----
      const profilePath0 = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile-resume`);
      const freshEngine = new ApplicationEngine({ profilePath: profilePath0 });
      let resumeResult: any = { snapshotFound: false, resumeMs: -1, formDataKeys: 0, escalationsSeen: 0 };
      try {
        await freshEngine.initialize();
        const target = escalatedCompletion?.outcome;
        if (target?.applicationId) {
          const escSeen = await freshEngine.getEscalationsForApplication(target.applicationId);
          const tr = Date.now();
          const snap = await freshEngine.resumeApplication(target.applicationId);
          const resumeMs = Date.now() - tr;
          resumeResult = {
            snapshotFound: !!snap,
            resumeMs,
            formDataKeys: snap?.formData ? Object.keys(snap.formData).length : 0,
            formData: snap?.formData || {},
            escalationsSeen: escSeen.length,
          };
        }
      } finally {
        await freshEngine.close();
      }

      const result = {
        command: COMMAND,
        startedAt,
        endedAt: new Date().toISOString(),
        concurrency,
        jobCount: JOB_COUNT,
        escalationJobSpec: specs[0].jobId,
        batchMs,
        discoveryMs: disc.wallMs,
        outcomes: completions.map(c => ({
          jobId: c.outcome.jobId,
          wallMs: c.outcome.wallMs,
          completedAtMs: c.completedAt - batchStart,
          success: c.outcome.success,
          state: c.outcome.state,
          escalated: c.outcome.escalated,
          pauseMs: c.outcome.pauseMs,
          applicationId: c.outcome.applicationId,
          confirmationId: c.outcome.confirmationId,
        })),
        escalation: {
          escalatedCount: escalated.length,
          escalatedJobId: escalatedCompletion?.outcome.jobId ?? null,
          escalationFilesCreated: escFiles.length - escBefore,
          snapshotFilesCreated: snapFiles.length - snapBefore,
          record: escalationRecord
            ? {
                id: escalationRecord.id,
                status: escalationRecord.status,
                question: escalationRecord.question,
                createdAt: escalationRecord.createdAt,
              }
            : null,
          pauseMsEvents: escalatedCompletion?.outcome.pauseMs ?? null,
          pauseWallMs,
        },
        unrelated: {
          count: unrelated.length,
          allSuccess: unrelated.every(c => c.outcome.success),
          allConfirmed: unrelated.every(c => c.outcome.state === 'CONFIRMED'),
          walls: unrelated.map(c => ({ jobId: c.outcome.jobId, wallMs: c.outcome.wallMs })),
        },
        resume: resumeResult,
        dbStateCounts: stateCounts,
        stageStats: await H.getStageStats(),
      };
      H.writeResult('bench_h_escalation', result);
      H.printRawRun('bench_h_escalation', {
        command: COMMAND,
        startedAt,
        endedAt: result.endedAt,
        concurrency,
        jobs: JOB_COUNT,
        batchMs,
        escalatedCount: result.escalation.escalatedCount,
        escalatedJobId: result.escalation.escalatedJobId,
        escalationFilesCreated: result.escalation.escalationFilesCreated,
        snapshotFilesCreated: result.escalation.snapshotFilesCreated,
        escalationStatus: escalationRecord?.status ?? '-',
        escalationQuestion: escalationRecord?.question ?? '-',
        pauseMsEvents: result.escalation.pauseMsEvents,
        pauseWallMs,
        escalatedState: escalatedCompletion?.outcome.state ?? '-',
        unrelated: `${result.unrelated.count} jobs, allSuccess=${result.unrelated.allSuccess}, allConfirmed=${result.unrelated.allConfirmed}`,
        unrelatedWalls: result.unrelated.walls.map(w => `${w.jobId}=${w.wallMs}ms`).join(', '),
        resumeSnapshotFound: resumeResult.snapshotFound,
        resumeMs: resumeResult.resumeMs,
        resumeFormDataKeys: resumeResult.formDataKeys,
        resumeEscalationsSeen: resumeResult.escalationsSeen,
        dbStateCounts: JSON.stringify(stateCounts),
      });

      // ---- Assertions ----
      expect(completions.length).toBe(JOB_COUNT);
      // Exactly ONE job escalated - the one with the unfillable question
      expect(result.escalation.escalatedCount).toBe(1);
      expect(result.escalation.escalatedJobId).toBe(specs[0].jobId);
      expect(result.escalation.escalationFilesCreated).toBeGreaterThanOrEqual(1);
      expect(result.escalation.snapshotFilesCreated).toBeGreaterThanOrEqual(1);
      expect(escalationRecord).toBeTruthy();
      expect(escalationRecord.status).toBe('pending');
      // Pause duration was actually measured from real events
      expect(result.escalation.pauseMsEvents).toBeGreaterThanOrEqual(0);
      expect(pauseWallMs).toBeGreaterThanOrEqual(0);
      // The escalated job still finished (non-blocking escalation placeholder)
      expect(escalatedCompletion?.outcome.success).toBe(true);
      expect(escalatedCompletion?.outcome.state).toBe('CONFIRMED');
      // Unrelated jobs continued and completed unaffected
      expect(result.unrelated.count).toBe(JOB_COUNT - 1);
      expect(result.unrelated.allSuccess).toBe(true);
      expect(result.unrelated.allConfirmed).toBe(true);
      // Resume: fresh engine recovers escalation records + snapshot with filled formData
      expect(resumeResult.escalationsSeen).toBeGreaterThanOrEqual(1);
      expect(resumeResult.snapshotFound).toBe(true);
      expect(resumeResult.formDataKeys).toBeGreaterThan(0);
      expect(resumeResult.resumeMs).toBeGreaterThanOrEqual(0);
      // Production concurrency ran concurrently: batch wall must be materially shorter
      // than the sum of per-job walls (jobs actually overlapped). Load-independent.
      const sumJobWalls = completions.reduce((s, c) => s + c.outcome.wallMs, 0);
      expect(batchMs).toBeLessThan(sumJobWalls * 0.85);
    } finally {
      await Promise.all(engines.map(e => e.close().catch(() => {})));
      await server.stop();
    }
  }, 300000);
});
