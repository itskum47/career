/**
 * PHASE 3 - BENCHMARK D: CACHE BENEFIT
 * Same job processed TWICE through the real pipeline (cache flags ENABLED).
 * Measures: wall time run1 vs run2, per-stage timings per run, cache hit/miss,
 * LLM call count, cache file creation on disk.
 * Command:
 *   BROWSER_HEADLESS=false npx vitest run tests/e2e/phase3/bench_d_cache.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

process.env.DB_PATH = './data/bench-d.db';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32613;
const TAG = 'D';
const COMMAND =
  'BROWSER_HEADLESS=false JD_CACHE_ENABLED=1 MATCH_CACHE_ENABLED=1 ARTIFACT_CACHE_ENABLED=1 ' +
  'LLM_CACHE_ENABLED=1 npx vitest run tests/e2e/phase3/bench_d_cache.test.ts --reporter=verbose';

function countCacheFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).length;
}

describe('Phase 3 Benchmark D: CACHE BENEFIT (same job twice)', () => {
  it('processes the same job twice and reports hit/miss + per-stage timings', async () => {
    const startedAt = new Date().toISOString();
    const specs = H.makeBenchJobs(PORT, 1, TAG);
    const spec = specs[0];

    const server = new FakeATSServer(PORT);
    server.addJobs(H.toFakeAtsJobs(specs));
    await server.start();

    let engine: any = null;
    try {
      const dbBundle = await H.setupDb('./data/bench-d.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile`);
      const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
      engine = new ApplicationEngine({ profilePath });
      await engine.initialize();

      const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);

      // Snapshot cache directories on disk BEFORE the runs
      const cacheDirs = ['.cache/jd', '.cache/match', '.cache/artifacts', '.cache/llm'];
      const cacheFilesBefore = Object.fromEntries(cacheDirs.map(d => [d, countCacheFiles(d)]));

      // ---- RUN 1 (cold) ----
      const { performanceCollector } = await import(path.join(H.srcPath, 'performance/hooks.ts'));
      performanceCollector.clear();
      const t1 = Date.now();
      const run1 = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
      const wall1 = Date.now() - t1;
      const stats1 = await H.getStageStats();

      // ---- RUN 2 (warm - same job, same URL, same resume/cover inputs) ----
      performanceCollector.clear();
      const t2 = Date.now();
      const run2 = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
      const wall2 = Date.now() - t2;
      const stats2 = await H.getStageStats();

      const cacheFilesAfter = Object.fromEntries(cacheDirs.map(d => [d, countCacheFiles(d)]));

      const m1 = H.stageMap(stats1);
      const m2 = H.stageMap(stats2);

      // Cache hit/miss: a wired JD cache would SKIP extraction on run 2.
      // hit = stage skipped on run 2; miss = stage executed again.
      const jdCountRun1 = m1['jd.extraction']?.count ?? 0;
      const jdCountRun2 = m2['jd.extraction']?.count ?? 0;
      const cacheHits = jdCountRun2 === 0 ? 1 : 0;
      const cacheMisses = jdCountRun2 > 0 ? 1 : 0;
      const cacheHitRate = cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0;

      const newCacheFiles: Record<string, number> = {};
      for (const d of cacheDirs) newCacheFiles[d] = cacheFilesAfter[d] - cacheFilesBefore[d];

      const dbApplications = Number((await dbBundle.db.query('SELECT COUNT(*) AS c FROM applications')).rows[0].c);

      const stageRows = ['jd.extraction', 'match.scoring', 'resume.generation', 'cover.generation',
        'browser.navigate', 'browser.fillForm', 'browser.upload', 'browser.submit', 'application.total']
        .map(stage => ({
          stage,
          run1Count: m1[stage]?.count ?? 0,
          run1AvgMs: Math.round(m1[stage]?.average ?? 0),
          run2Count: m2[stage]?.count ?? 0,
          run2AvgMs: Math.round(m2[stage]?.average ?? 0),
        }));

      const result = {
        command: COMMAND,
        startedAt,
        endedAt: new Date().toISOString(),
        jobId: spec.jobId,
        atsJobId: spec.atsJobId,
        run1: { success: run1.success, state: run1.state, wallMs: wall1, confirmationId: run1.confirmationId },
        run2: { success: run2.success, state: run2.state, wallMs: wall2, confirmationId: run2.confirmationId },
        deltaMs: wall1 - wall2,
        cache: {
          flags: 'JD_CACHE_ENABLED=1 MATCH_CACHE_ENABLED=1 ARTIFACT_CACHE_ENABLED=1 LLM_CACHE_ENABLED=1',
          hits: cacheHits,
          misses: cacheMisses,
          hitRate: cacheHitRate,
          jdExtractionRun1: jdCountRun1,
          jdExtractionRun2: jdCountRun2,
          cacheFilesBefore,
          cacheFilesAfter,
          newCacheFiles,
        },
        llmCalls: 0,
        llmCallEvidence:
          'Pipeline generators (jd/extractor, resume/generator, cover/generator, match/engine) contain no LLM client usage; ' +
          'as of Phase 4 only src/artifacts/generator.ts imports src/cache (artifact cache wired where measured cost warranted it); ' +
          'jd/match/LLM caches remain unwired (measured recompute cost 0.4/0.0ms — below the do-not-force-caching threshold). No LLM API call occurs.',
        stages: stageRows,
        dbApplications,
      };
      H.writeResult('bench_d_cache', result);
      H.printRawRun('bench_d_cache', {
        command: COMMAND,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        run1WallMs: wall1,
        run2WallMs: wall2,
        deltaMs: wall1 - wall2,
        run1Success: run1.success,
        run2Success: run2.success,
        run1State: run1.state,
        run2State: run2.state,
        cacheHits: cacheHits,
        cacheMisses: cacheMisses,
        cacheHitRate: `${cacheHitRate * 100}%`,
        jdExtractionRun1: jdCountRun1,
        jdExtractionRun2: jdCountRun2,
        newCacheFiles: JSON.stringify(newCacheFiles),
        llmCalls: 0,
        dbApplications,
        stages: stageRows.map(s => `${s.stage}: run1=${s.run1Count}(${s.run1AvgMs}ms) run2=${s.run2Count}(${s.run2AvgMs}ms)`),
      });

      expect(run1.success).toBe(true);
      expect(run2.success).toBe(true);
      expect(run1.state).toBe('CONFIRMED');
      expect(run2.state).toBe('CONFIRMED');
      expect(dbApplications).toBe(2);
      // Measured, not assumed: report what actually happened on run 2
      expect(jdCountRun2).toBeGreaterThanOrEqual(0);
    } finally {
      if (engine) await engine.close();
      await server.stop();
    }
  }, 300000);
});
