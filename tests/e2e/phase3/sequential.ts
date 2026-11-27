/**
 * Shared runner for Benchmark A (baseline) and Benchmark B (optimized sequential).
 * 5 jobs, sequential, one shared ApplicationEngine (production shape: services.appEngine singleton).
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

export interface SequentialBenchmarkOutcome {
  name: string;
  command: string;
  cacheFlags: Record<string, string>;
  startedAt: string;
  endedAt: string;
  jobCount: number;
  discoveryMs: number;
  engineInitMs: number;
  batchMs: number;
  excelMs: number;
  excelApplicationsSynced: number;
  excelPath: string;
  excelExists: boolean;
  dbApplications: number;
  outcomes: H.JobOutcome[];
  summary: H.TimingSummary;
  stageStats: H.StageStat[];
}

export async function runSequentialBenchmark(opts: {
  name: string;
  command: string;
  tag: string;
  port: number;
  dbPath: string;
  jobCount: number;
  cacheFlags: Record<string, string>;
}): Promise<SequentialBenchmarkOutcome> {
  const startedAt = new Date().toISOString();
  const specs = H.makeBenchJobs(opts.port, opts.jobCount, opts.tag);

  const server = new FakeATSServer(opts.port);
  server.addJobs(H.toFakeAtsJobs(specs));
  await server.start();

  let engine: any = null;
  try {
    const dbBundle = await H.setupDb(opts.dbPath);
    const profile = await H.loadBenchProfile();
    await H.clearStageStats();

    // Independent persistent browser profile for this benchmark
    const profilePath = path.join(os.homedir(), '.job-agent', `bench-${opts.tag.toLowerCase()}-profile`);
    const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
    engine = new ApplicationEngine({ profilePath });
    const tInit = Date.now();
    await engine.initialize();
    const engineInitMs = Date.now() - tInit;

    const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);

    // Real discovery (MockDiscoveryAdapter only - no external HTTP)
    const disc = await H.discoverJobs(specs);
    const discoveryMs = disc.wallMs;

    // Sequential batch through the real pipeline
    const outcomes: H.JobOutcome[] = [];
    const batchStart = Date.now();
    for (const spec of specs) {
      const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
      outcomes.push(o);
      console.log(
        `[BENCH ${opts.tag}] job=${o.jobId} wall=${o.wallMs}ms success=${o.success} ` +
        `state=${o.state} conf=${o.confirmationId || '-'} score=${o.recommendation}`
      );
    }
    const batchMs = Date.now() - batchStart;

    // Real Excel sync (DB -> workbook)
    const { ExcelSync } = await import(path.join(H.srcPath, 'sync/excel.ts'));
    const excelPath = path.join(H.projectRoot, 'benchmarks', 'out', `bench-${opts.tag.toLowerCase()}.xlsx`);
    const excel = new ExcelSync(excelPath);
    const tX = Date.now();
    const excelRes = await excel.sync(
      dbBundle.appRepo, dbBundle.jobRepo, dbBundle.matchRepo, dbBundle.resumeRepo, dbBundle.coverRepo, {}
    );
    const excelMs = Date.now() - tX;

    const appCountRes = await dbBundle.db.query('SELECT COUNT(*) AS c FROM applications');
    const dbApplications = Number(appCountRes.rows[0].c);

    const stageStats = await H.getStageStats();
    const summary = H.summarize(outcomes.map(o => o.wallMs), batchMs);

    const result: SequentialBenchmarkOutcome = {
      name: opts.name,
      command: opts.command,
      cacheFlags: opts.cacheFlags,
      startedAt,
      endedAt: new Date().toISOString(),
      jobCount: opts.jobCount,
      discoveryMs,
      engineInitMs,
      batchMs,
      excelMs,
      excelApplicationsSynced: excelRes.applicationsSynced,
      excelPath: excelRes.filePath,
      excelExists: fs.existsSync(excelRes.filePath),
      dbApplications,
      outcomes,
      summary,
      stageStats,
    };
    H.writeResult(opts.name, result);
    H.printRawRun(opts.name, {
      command: opts.command,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      jobs: opts.jobCount,
      success: outcomes.filter(o => o.success).length,
      failed: outcomes.filter(o => !o.success).length,
      discoveryMs,
      engineInitMs,
      batchMs,
      avgMs: summary.avgMs,
      medianMs: summary.medianMs,
      p95Ms: summary.p95Ms,
      minMs: summary.minMs,
      maxMs: summary.maxMs,
      jobsPerHour: summary.jobsPerHour,
      excelMs,
      excelApplicationsSynced: excelRes.applicationsSynced,
      dbApplications,
      stages: stageStats.map(s => `${s.stage}=${s.count}(${Math.round(s.average)}ms)`),
    });
    return result;
  } finally {
    if (engine) await engine.close();
    await server.stop();
  }
}
