/**
 * PHASE 4D - CACHE WIRING BENCHMARK (real production pipeline)
 *
 * Same job, five runs, artifact cache ENABLED:
 *   P1 MISS  - cold start (cache dir emptied at setup)
 *   P2 HIT   - identical inputs -> artifact PDFs served from cache
 *   P3 MISS  - profile mutated (candidate/profile hash changes -> invalidation)
 *   P4 MISS  - JD description mutated server-side (JD hash changes -> invalidation)
 *   P5 MISS  - original inputs restored, but the cached file was overwritten by
 *              a later run -> byte-integrity guard must refuse the stale entry
 *
 * Measures: per-phase stage durations (artifact.pdf.resume / artifact.pdf.cover),
 * cacheObserver hit/miss/write deltas, cache dir file counts, walls, DB rows.
 *
 * Command:
 *   BENCH_RESULTS_DIR=benchmarks/results-phase4 ARTIFACT_CACHE_ENABLED=1 \
 *   BROWSER_HEADLESS=true npx vitest run tests/e2e/phase4/bench_cache_wiring.test.ts
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from '../phase3/harness.ts';

process.env.DB_PATH = './data/bench-p4-cache.db';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32619;
const TAG = 'P4C';
const COMMAND =
  'BENCH_RESULTS_DIR=benchmarks/results-phase4 JD_CACHE_ENABLED=1 MATCH_CACHE_ENABLED=1 ' +
  'ARTIFACT_CACHE_ENABLED=1 LLM_CACHE_ENABLED=1 BROWSER_HEADLESS=true ' +
  'npx vitest run tests/e2e/phase4/bench_cache_wiring.test.ts --reporter=verbose';

const ARTIFACT_CACHE_DIR = '.cache/artifacts';

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).length;
}

interface PhaseSnap {
  name: string;
  wallMs: number;
  success: boolean;
  state?: string;
  observer: { hits: number; misses: number; writes: number };
  artifactResume?: { count: number; avgMs: number };
  artifactCover?: { count: number; avgMs: number };
  cacheFiles: number;
}

describe('Phase 4D: cache wiring — miss / hit / invalidation / integrity', () => {
  it('runs the same job 5 times and proves hit, invalidation, and stale-entry refusal', async () => {
    const startedAt = new Date().toISOString();
    const specs = H.makeBenchJobs(PORT, 1, TAG);
    const spec = specs[0];
    const fakeJobs = H.toFakeAtsJobs(specs);
    const originalDescription = fakeJobs[0].description;

    const server = new FakeATSServer(PORT);
    server.addJobs(fakeJobs);
    await server.start();

    // Deterministic cold start: wipe the on-disk artifact cache (L1 memory is
    // empty anyway in this fresh vitest process).
    if (fs.existsSync(ARTIFACT_CACHE_DIR)) {
      fs.rmSync(ARTIFACT_CACHE_DIR, { recursive: true, force: true });
    }

    let engine: any = null;
    try {
      const dbBundle = await H.setupDb('./data/bench-p4-cache.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile`);
      const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
      engine = new ApplicationEngine({ profilePath });
      await engine.initialize();

      const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);

      const { performanceCollector } = await import(path.join(H.srcPath, 'performance/hooks.ts'));
      const { cacheObserver } = await import(path.join(H.srcPath, 'cache/cache-observability.ts'));
      const obs = () => {
        const s = cacheObserver.snapshot();
        return { hits: s.artifact.hits, misses: s.artifact.misses, writes: s.artifact.writes };
      };

      const phases: PhaseSnap[] = [];
      const runPhase = async (
        name: string,
        runCtx: any
      ): Promise<PhaseSnap> => {
        performanceCollector.clear();
        const before = countFiles(ARTIFACT_CACHE_DIR);
        const t = Date.now();
        const run = await H.runPipelineJob(runCtx, spec, { autoSubmit: true });
        const wallMs = Date.now() - t;
        const stats = H.stageMap(await H.getStageStats());
        const resumeStat = stats['artifact.pdf.resume'];
        const coverStat = stats['artifact.pdf.cover'];
        phases.push({
          name,
          wallMs,
          success: run.success,
          state: run.state,
          observer: obs(),
          artifactResume: resumeStat
            ? { count: resumeStat.count, avgMs: Math.round(resumeStat.average) }
            : undefined,
          artifactCover: coverStat
            ? { count: coverStat.count, avgMs: Math.round(coverStat.average) }
            : undefined,
          cacheFiles: countFiles(ARTIFACT_CACHE_DIR) - before,
        });
        return phases[phases.length - 1];
      };

      // P1 — cold MISS
      const p1 = await runPhase('P1_cold_miss', ctx);

      // P2 — identical inputs -> HIT
      const p2 = await runPhase('P2_identical_hit', ctx);

      // P3 — profile invalidation (candidate/profile hash changes)
      const mutatedProfile = structuredClone(profile);
      mutatedProfile.personal.email = 'phase4-invalidation@example.com';
      const ctxMutated = await H.createPipelineContext(dbBundle.db, dbBundle, mutatedProfile, engine);
      const p3 = await runPhase('P3_profile_invalidated_miss', ctxMutated);

      // P4 — JD invalidation (server-side description changes; same jobId/url)
      server.addJobs([{ ...fakeJobs[0], description: `${originalDescription} [Phase4 JD v2]` }]);
      const p4 = await runPhase('P4_jd_invalidated_miss', ctx);

      // P5 — original inputs restored, but the file was last written by P4:
      // the P1 entry's contentHash no longer matches the bytes on disk.
      server.addJobs([{ ...fakeJobs[0], description: originalDescription }]);
      const p5 = await runPhase('P5_stale_entry_refused_miss', ctx);

      const dbApplications = Number(
        (await dbBundle.db.query('SELECT COUNT(*) AS c FROM applications')).rows[0].c
      );
      const states = (
        await dbBundle.db.query('SELECT state, COUNT(*) AS c FROM applications GROUP BY state')
      ).rows.reduce((acc: Record<string, number>, r: any) => {
        acc[r.state] = Number(r.c);
        return acc;
      }, {});

      const deltas = {
        p2_hits: p2.observer.hits - p1.observer.hits,
        p2_misses: p2.observer.misses - p1.observer.misses,
        p3_hits: p3.observer.hits - p2.observer.hits,
        p3_misses: p3.observer.misses - p2.observer.misses,
        p4_hits: p4.observer.hits - p3.observer.hits,
        p4_misses: p4.observer.misses - p3.observer.misses,
        p5_hits: p5.observer.hits - p4.observer.hits,
        p5_misses: p5.observer.misses - p4.observer.misses,
      };

      const result = {
        command: COMMAND,
        startedAt,
        endedAt: new Date().toISOString(),
        jobId: spec.jobId,
        atsJobId: spec.atsJobId,
        flags: 'JD_CACHE_ENABLED=1 MATCH_CACHE_ENABLED=1 ARTIFACT_CACHE_ENABLED=1 LLM_CACHE_ENABLED=1',
        phases,
        deltas,
        stageCompare: {
          resumeMissMs: p1.artifactResume?.avgMs,
          resumeHitMs: p2.artifactResume?.avgMs,
          coverMissMs: p1.artifactCover?.avgMs,
          coverHitMs: p2.artifactCover?.avgMs,
        },
        llmCalls: 0,
        dbApplications,
        dbStates: states,
        cacheFilesTotal: countFiles(ARTIFACT_CACHE_DIR),
      };
      H.writeResult('bench_cache_wiring', result);
      H.printRawRun('bench_cache_wiring', {
        command: COMMAND,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        phases: phases.map(
          p =>
            `${p.name}: wall=${p.wallMs}ms success=${p.success} state=${p.state} ` +
            `hits=${p.observer.hits} misses=${p.observer.misses} writes=${p.observer.writes} ` +
            `artifactResume=${JSON.stringify(p.artifactResume)} artifactCover=${JSON.stringify(p.artifactCover)} ` +
            `newCacheFiles=${p.cacheFiles}`
        ),
        deltas: JSON.stringify(deltas),
        dbApplications,
        dbStates: JSON.stringify(states),
      });

      // ---- Assertions: every claim is backed by the measured run above ----
      for (const p of phases) {
        expect(p.success, `${p.name} should succeed`).toBe(true);
        expect(p.state, `${p.name} should be CONFIRMED`).toBe('CONFIRMED');
      }
      // P1: cold — misses, no hits, writes on disk
      expect(p1.observer.hits).toBe(0);
      expect(p1.observer.misses).toBeGreaterThanOrEqual(2);
      expect(p1.observer.writes).toBeGreaterThanOrEqual(2);
      // P2: identical inputs — real HIT, artifacts served from cache
      expect(deltas.p2_hits).toBeGreaterThanOrEqual(2);
      expect(deltas.p2_misses).toBe(0);
      // Hit path must actually be cheaper than regeneration (measured, not assumed)
      expect(p2.artifactResume!.avgMs).toBeLessThan(p1.artifactResume!.avgMs);
      expect(p2.artifactCover!.avgMs).toBeLessThan(p1.artifactCover!.avgMs);
      // P3/P4/P5: invalidation — keys change, no stale hit may occur
      expect(deltas.p3_hits).toBe(0);
      expect(deltas.p3_misses).toBeGreaterThanOrEqual(2);
      expect(deltas.p4_hits).toBe(0);
      expect(deltas.p4_misses).toBeGreaterThanOrEqual(2);
      expect(deltas.p5_hits).toBe(0);
      expect(deltas.p5_misses).toBeGreaterThanOrEqual(2);
      // Correctness: 5 submissions, 5 confirmed applications, no duplicates dropped
      expect(dbApplications).toBe(5);
      expect(states.CONFIRMED).toBe(5);
    } finally {
      if (engine) await engine.close();
      await server.stop();
    }
  }, 300000);
});
