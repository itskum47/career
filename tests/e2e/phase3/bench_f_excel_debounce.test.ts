/**
 * PHASE 3 - BENCHMARK F: EXCEL DEBOUNCE
 * Two real 5-job batches through the same pipeline:
 *   Phase 1 (direct): sync-per-update - every real DB write immediately followed by ExcelSync.sync()
 *   Phase 2 (debounced): every real DB write schedules DebouncedExcelSync.schedule()
 * Counts: DB updates vs ACTUAL Excel writes, debounce delay, workbook correctness on read-back.
 * Command:
 *   BROWSER_HEADLESS=false EXCEL_SYNC_DEBOUNCE_MS=2000 npx vitest run tests/e2e/phase3/bench_f_excel_debounce.test.ts --reporter=verbose
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FakeATSServer } from '../fake-ats.ts';
import * as H from './harness.ts';

process.env.DB_PATH = './data/bench-f.db';
process.env.EXCEL_SYNC_DEBOUNCE_MS = '2000';
process.env.JD_CACHE_ENABLED = '1';
process.env.MATCH_CACHE_ENABLED = '1';
process.env.ARTIFACT_CACHE_ENABLED = '1';
process.env.LLM_CACHE_ENABLED = '1';

const PORT = 32615;
const TAG = 'F';
const PHASE_JOBS = 5;
const COMMAND =
  'BROWSER_HEADLESS=false EXCEL_SYNC_DEBOUNCE_MS=2000 ' +
  'npx vitest run tests/e2e/phase3/bench_f_excel_debounce.test.ts --reporter=verbose';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Phase 3 Benchmark F: EXCEL DEBOUNCE (DB updates vs real workbook writes)', () => {
  it('measures direct sync-per-update vs DebouncedExcelSync and workbook correctness', async () => {
    const startedAt = new Date().toISOString();
    const specs = H.makeBenchJobs(PORT, PHASE_JOBS * 2, TAG);
    const phase1Specs = specs.slice(0, PHASE_JOBS);
    const phase2Specs = specs.slice(PHASE_JOBS);

    const server = new FakeATSServer(PORT);
    server.addJobs(H.toFakeAtsJobs(specs));
    await server.start();

    let engine: any = null;
    try {
      const dbBundle = await H.setupDb('./data/bench-f.db');
      const profile = await H.loadBenchProfile();
      await H.clearStageStats();

      const { ApplicationEngine } = await import(path.join(H.srcPath, 'application/engine.ts'));
      const profilePath = path.join(os.homedir(), '.job-agent', `bench-${TAG.toLowerCase()}-profile`);
      engine = new ApplicationEngine({ profilePath });
      await engine.initialize();

      const ctx = await H.createPipelineContext(dbBundle.db, dbBundle, profile, engine);

      // ---- Instrumentation: REAL Excel writes counted on the class both modes share ----
      const { ExcelSync } = await import(path.join(H.srcPath, 'sync/excel.ts'));
      const { DebouncedExcelSync } = await import(path.join(H.srcPath, 'sync/debounced-excel.ts'));
      const origSync = ExcelSync.prototype.sync;
      let excelWrites = 0;
      const excelWriteLog: Array<{ at: number; ms: number; applicationsSynced: number }> = [];
      ExcelSync.prototype.sync = async function (this: any, ...args: any[]) {
        excelWrites++;
        const t = Date.now();
        const r = await origSync.apply(this, args);
        excelWriteLog.push({ at: Date.now(), ms: Date.now() - t, applicationsSynced: r?.applicationsSynced ?? -1 });
        return r;
      };

      const excelPath = path.join(H.projectRoot, 'benchmarks', 'out', `bench-${TAG.toLowerCase()}.xlsx`);
      const directExcel = new ExcelSync(excelPath);
      const debouncedExcel = new DebouncedExcelSync(2000, excelPath);

      // ---- Instrumentation: DB updates (INSERT/UPDATE/DELETE) on the one client all repos share ----
      let phase = 0; // 0 = idle, 1 = direct, 2 = debounced
      let dbWrites1 = 0;
      let dbWrites2 = 0;
      let directSyncs = 0;
      let schedules = 0;
      let lastScheduleAt = 0;
      const origQuery = dbBundle.db.query.bind(dbBundle.db);
      (dbBundle.db as any).query = async (sql: string, params?: any[]) => {
        const res = await origQuery(sql, params);
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(String(sql))) {
          if (phase === 1) {
            dbWrites1++;
            directSyncs++;
            // Direct mode: sync the workbook immediately after EVERY DB update
            await directExcel.sync(
              ctx.appRepo, ctx.jobRepo, ctx.matchRepo, ctx.resumeRepo, ctx.coverRepo, {}
            );
          } else if (phase === 2) {
            dbWrites2++;
            schedules++;
            lastScheduleAt = Date.now();
            debouncedExcel.schedule(
              ctx.appRepo, ctx.jobRepo, ctx.matchRepo, ctx.resumeRepo, ctx.coverRepo, {}
            );
          }
        }
        return res;
      };

      // ---- PHASE 1: direct sync-per-update, 5 real jobs ----
      phase = 1;
      const p1Start = Date.now();
      const outcomes1: H.JobOutcome[] = [];
      for (const spec of phase1Specs) {
        const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
        outcomes1.push(o);
        console.log(`[BENCH ${TAG}] phase1 job=${o.jobId} wall=${o.wallMs}ms success=${o.success} state=${o.state}`);
      }
      const phase1Ms = Date.now() - p1Start;
      const phase1ExcelWrites = excelWrites;
      const phase1WriteLog = [...excelWriteLog];
      const phase1DirectSyncs = directSyncs;

      // ---- PHASE 2: debounced, 5 real jobs ----
      phase = 2;
      const writesBeforePhase2 = excelWrites;
      const p2Start = Date.now();
      const outcomes2: H.JobOutcome[] = [];
      for (const spec of phase2Specs) {
        const o = await H.runPipelineJob(ctx, spec, { autoSubmit: true });
        outcomes2.push(o);
        console.log(`[BENCH ${TAG}] phase2 job=${o.jobId} wall=${o.wallMs}ms success=${o.success} state=${o.state}`);
      }
      const phase2Ms = Date.now() - p2Start;

      // Wait for the trailing debounced write to fire and settle
      await sleep(3500);
      phase = 0;

      const phase2ExcelWrites = excelWrites - writesBeforePhase2;
      const phase2WriteLog = excelWriteLog.slice(phase1WriteLog.length);
      const finalWriteAt = phase2WriteLog.length ? phase2WriteLog[phase2WriteLog.length - 1].at : 0;
      const debounceDelayMs = finalWriteAt && lastScheduleAt ? finalWriteAt - lastScheduleAt : -1;

      // ---- Final workbook correctness (read back the actual file) ----
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(excelPath);
      const sheets = wb.worksheets.map(w => w.name);
      const appsWs = wb.getWorksheet('Applications');
      const applicationsRows = appsWs ? Math.max(0, appsWs.actualRowCount - 1) : -1;

      const dbApplications = Number((await dbBundle.db.query('SELECT COUNT(*) AS c FROM applications')).rows[0].c);

      const result = {
        command: COMMAND,
        startedAt,
        endedAt: new Date().toISOString(),
        debounceMsConfigured: 2000,
        phase1_direct: {
          jobs: outcomes1.length,
          outcomes: outcomes1,
          batchMs: phase1Ms,
          dbWrites: dbWrites1,
          excelWrites: phase1ExcelWrites,
          writeRatio: dbWrites1 > 0 ? Math.round((phase1ExcelWrites / dbWrites1) * 1000) / 1000 : -1,
          totalSyncMs: phase1WriteLog.reduce((s, w) => s + w.ms, 0),
          avgSyncMs: phase1WriteLog.length
            ? Math.round(phase1WriteLog.reduce((s, w) => s + w.ms, 0) / phase1WriteLog.length)
            : 0,
          applicationsSyncedPerWrite: [...new Set(phase1WriteLog.map(w => w.applicationsSynced))],
        },
        phase2_debounced: {
          jobs: outcomes2.length,
          outcomes: outcomes2,
          batchMs: phase2Ms,
          dbWrites: dbWrites2,
          schedules,
          excelWrites: phase2ExcelWrites,
          writeRatio: dbWrites2 > 0 ? Math.round((phase2ExcelWrites / dbWrites2) * 1000) / 1000 : -1,
          writesSaved: dbWrites2 - phase2ExcelWrites,
          debounceDelayMs,
          applicationsSyncedPerWrite: [...new Set(phase2WriteLog.map(w => w.applicationsSynced))],
        },
        workbook: {
          path: excelPath,
          exists: fs.existsSync(excelPath),
          sheets,
          applicationsRows,
          dbApplications,
        },
        stageStats: await H.getStageStats(),
      };
      H.writeResult('bench_f_excel_debounce', result);
      H.printRawRun('bench_f_excel_debounce', {
        command: COMMAND,
        startedAt,
        endedAt: result.endedAt,
        phase1: `jobs=5 success=${outcomes1.filter(o => o.success).length} batchMs=${phase1Ms} dbWrites=${dbWrites1} excelWrites=${phase1ExcelWrites} ratio=${result.phase1_direct.writeRatio} avgSyncMs=${result.phase1_direct.avgSyncMs} applicationsSynced=${JSON.stringify(result.phase1_direct.applicationsSyncedPerWrite)}`,
        phase2: `jobs=5 success=${outcomes2.filter(o => o.success).length} batchMs=${phase2Ms} dbWrites=${dbWrites2} schedules=${schedules} excelWrites=${phase2ExcelWrites} ratio=${result.phase2_debounced.writeRatio} writesSaved=${result.phase2_debounced.writesSaved} debounceDelayMs=${debounceDelayMs} applicationsSynced=${JSON.stringify(result.phase2_debounced.applicationsSyncedPerWrite)}`,
        workbookExists: fs.existsSync(excelPath),
        workbookSheets: sheets.join(','),
        workbookApplicationsRows: applicationsRows,
        dbApplications,
      });

      // Mechanics assertions (both modes)
      expect(outcomes1.every(o => o.success)).toBe(true);
      expect(outcomes2.every(o => o.success)).toBe(true);
      expect(dbWrites1).toBeGreaterThan(0);
      expect(dbWrites2).toBeGreaterThan(0);
      // Direct mode must be exactly 1:1 (sync per DB update)
      expect(phase1ExcelWrites).toBe(phase1DirectSyncs);
      // Debounced mode must COALESCE: fewer Excel writes than DB updates
      expect(phase2ExcelWrites).toBeLessThan(dbWrites2);
      expect(debounceDelayMs).toBeGreaterThanOrEqual(1500);
      expect(dbApplications).toBe(PHASE_JOBS * 2);
      // Final workbook correctness: all confirmed applications present in the workbook
      expect(sheets).toContain('Applications');
      expect(applicationsRows).toBe(dbApplications);
    } finally {
      if (engine) await engine.close();
      await server.stop();
    }
  }, 420000);
});
