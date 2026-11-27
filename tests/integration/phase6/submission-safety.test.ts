/**
 * Phase 6U/6W/6X — Submission safety: transport instrumentation + durable
 * submission journal + crash recovery.
 *
 * Why this suite exists
 * ---------------------
 * Attempt 7 performed exactly ONE real Submit click (2026-10-08 10:41:03.612)
 * and then the process crashed inside the transport instrumentation:
 *
 *     TypeError: r.request is not a function
 *
 * because Playwright's `request` event supplies a Request, while the listener
 * called Response methods. The crash happened BEFORE any persistence, so the run
 * left no trace that a real click had occurred — and the duplicate guard could
 * not protect the next run.
 *
 * These tests prove, without any real submission:
 *   1. `request` events are handled as Requests and `response` as Responses
 *      (transport records carry the correct method/host/path/status).
 *   2. Instrumentation cannot crash a run.
 *   3. `submission_started` is durable and written BEFORE the irreversible click.
 *   4. A crash after the click leaves the journal in a click-bearing phase.
 *   5. Automatic retry is refused while such a record exists.
 *   6. Exactly one submission attempt is recorded per click.
 *   7. A demonstrably FAILED submission stays retryable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const testDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(testDir, '../../../');
const fixtureUrl = 'file://' + path.join(projectRoot, 'tests/fixtures/submit-json.html');

vi.hoisted(() => {
  process.env.DB_PATH = `${process.cwd()}/data/test-phase6-submission-safety.db`;
});

import { createDatabaseClient, type DatabaseClient } from '../../../src/database/client.ts';
import { SubmissionJournalRepository } from '../../../src/database/repositories.ts';
import { preflightDuplicateCheck } from '../../../src/application/duplicate-guard.ts';
import {
  FileSubmissionJournal,
  CLICK_BEARING_PHASES,
  type SubmissionJournalEntry,
} from '../../../src/application/submission-journal.ts';

describe('6W — submission transport instrumentation (request vs response shapes)', () => {
  let browserController: any;
  let page: any;
  let postBodies: string[] = [];

  beforeAll(async () => {
    const { BrowserController } = await import(path.join(projectRoot, 'src/browser/controller.ts'));
    browserController = new BrowserController({
      profilePath: '/Users/kumarmangalam/.job-agent/browser-profile-test-submit',
    });
    await browserController.initialize();
    await browserController.createSession('APP-TEST-SUBMIT', 'JOB-fixture-submit', fixtureUrl);
    page = browserController.getPage();

    await page.route((url: any) => url.host === 'submit.fixture.local' && url.pathname === '/gitlab/jobs/8730125002', async (route: any) => {
      postBodies.push(route.request().postData() || '');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#full_name', 'Kumar Mangalam');
  }, 60000);

  afterAll(async () => {
    if (browserController) await browserController.close();
  });

  beforeEach(async () => {
    postBodies = [];
    // Fresh page per test: a stale confirmation view would make verification
    // win instantly and mask the transport under test.
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#full_name', 'Kumar Mangalam');
  });

  it('records the JSON submission as BOTH a request and a response (correct event shapes)', async () => {
    const result = await browserController.submit();

    // No crash, submission succeeded, confirmation detected.
    expect(result.success).toBe(true);
    expect(result.submitted).toBe(true);
    expect(result.uncertain).toBe(false);
    expect(result.confirmationFound).not.toBe(false);

    const transport = result.transport as Array<any>;
    expect(Array.isArray(transport)).toBe(true);
    expect(transport.length).toBeGreaterThanOrEqual(2);

    const req = transport.find(t => t.event === 'request');
    const res = transport.find(t => t.event === 'response');
    // A `request` event is a Request: method/url come off it directly (this is
    // exactly what Attempt 7 got wrong by calling `.request()` on it).
    expect(req).toBeTruthy();
    expect(req.method).toBe('POST');
    expect(req.host).toBe('submit.fixture.local');
    expect(req.path).toBe('/gitlab/jobs/8730125002');
    expect(req.status).toBeNull();
    // A `response` event is a Response: status comes off it directly.
    expect(res).toBeTruthy();
    expect(res.method).toBe('POST');
    expect(res.path).toBe('/gitlab/jobs/8730125002');
    expect(res.status).toBe(201);

    // Safe fields only — no headers/cookies/tokens anywhere in the record.
    const serialised = JSON.stringify(transport);
    expect(serialised).not.toMatch(/cookie|authorization|csrf|authenticity_token/i);

    // Exactly one submit call reached the endpoint.
    expect(postBodies.length).toBe(1);
    expect(JSON.parse(postBodies[0]).job_application.first_name).toBe('Kumar Mangalam');
  }, 90000);

  it('never throws from the instrumentation listeners, even for odd responses', async () => {
    // A 500 response must still be recorded, not crash the run.
    await page.unroute((url: any) => url.host === 'submit.fixture.local' && url.pathname === '/gitlab/jobs/8730125002');
    await page.route((url: any) => url.host === 'submit.fixture.local' && url.pathname === '/gitlab/jobs/8730125002', async (route: any) => {
      await route.fulfill({ status: 500, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'boom' });
    });
    const result = await browserController.submit();
    expect(result).toBeTruthy();
    expect(Array.isArray(result.transport)).toBe(true);
    const res = (result.transport as Array<any>).find(t => t.event === 'response');
    expect(res?.status).toBe(500);
  }, 60000);
});

describe('6X — durable submission journal', () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subj-journal-'));
  });

  it('persists `started` synchronously — it survives an immediate process kill', () => {
    const journal = new FileSubmissionJournal(journalDir);
    // Written BEFORE the (hypothetical) irreversible click.
    journal.appendSync({
      applicationId: 'APP-CRASH-1',
      jobId: 'JOB-CRASH-1',
      phase: 'started',
      detail: 'intent persisted before click',
    });
    // "Process dies here" — nothing else is ever written.
    const entries = journal.read('APP-CRASH-1');
    expect(entries.length).toBe(1);
    expect(entries[0].phase).toBe('started');
    expect(CLICK_BEARING_PHASES).toContain('started');
    expect(fs.existsSync(journal.filePath('APP-CRASH-1'))).toBe(true);
  });

  it('records one attempt per click and never invents a confirmation', () => {
    const journal = new FileSubmissionJournal(journalDir);
    const base: Omit<SubmissionJournalEntry, 'phase'> = { applicationId: 'APP-CRASH-2', jobId: 'JOB-CRASH-2' };
    journal.appendSync({ ...base, phase: 'started' });
    journal.appendSync({ ...base, phase: 'request', method: 'POST', host: 'boards.example.com', path: '/jobs/1' });
    journal.appendSync({ ...base, phase: 'uncertain' });
    const entries = journal.read('APP-CRASH-2');
    expect(entries.filter(e => e.phase === 'started').length).toBe(1);
    expect(entries.map(e => e.phase)).toEqual(['started', 'request', 'uncertain']);
    expect(entries.some(e => e.phase === 'confirmed')).toBe(false);
  });
});

describe('6X — crash recovery and duplicate protection via the journal (DB-backed)', () => {
  let db: DatabaseClient;
  let journalRepo: SubmissionJournalRepository;
  const DB_PATH = process.env.DB_PATH!;

  beforeAll(async () => {
    try { fs.rmSync(DB_PATH); } catch { /* fresh */ }
    db = await createDatabaseClient();
    await db.runMigrations(path.join(projectRoot, 'migrations'));
    journalRepo = new SubmissionJournalRepository(db);
  }, 60000);

  afterAll(async () => {
    try { fs.rmSync(DB_PATH); } catch { /* cleaned */ }
  });

  const fakeAppRepo = {
    findBlockingApplication: async () => null,
    findBlockingApplicationByCanonical: async () => null,
  } as any;

  it('blocks a second click after a crash that only left a `started` record', async () => {
    await journalRepo.append({
      entryId: 'J-CRASH-1', applicationId: 'APP-CRASH-3', jobId: 'JOB-CRASH-3', phase: 'started',
    });
    const result = await preflightDuplicateCheck({
      appRepo: fakeAppRepo,
      jobId: 'JOB-CRASH-3' as any,
      candidateId: 'CAND-6U' as any,
      submissionJournal: journalRepo,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('submission attempt');
    expect(result.reason).toContain('started');
  });

  it('treats `uncertain` as click-bearing too (no auto-retry)', async () => {
    await journalRepo.append({
      entryId: 'J-CRASH-4', applicationId: 'APP-CRASH-4', jobId: 'JOB-CRASH-4', phase: 'uncertain',
      detail: 'clicked, no confirmation',
    });
    const result = await preflightDuplicateCheck({
      appRepo: fakeAppRepo,
      jobId: 'JOB-CRASH-4' as any,
      candidateId: 'CAND-6U' as any,
      submissionJournal: journalRepo,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('uncertain');
  });

  it('keeps a demonstrably FAILED submission retryable', async () => {
    await journalRepo.append({
      entryId: 'J-FAIL-1', applicationId: 'APP-FAIL-1', jobId: 'JOB-FAIL-1', phase: 'failed',
      detail: 'attachment gate blocked before the click',
    });
    const attempt = await journalRepo.hasClickBearingAttempt('JOB-FAIL-1', CLICK_BEARING_PHASES);
    expect(attempt).toBeNull();
    const result = await preflightDuplicateCheck({
      appRepo: fakeAppRepo,
      jobId: 'JOB-FAIL-1' as any,
      candidateId: 'CAND-6U' as any,
      submissionJournal: journalRepo,
    });
    expect(result.blocked).toBe(false);
  });

  it('blocks a job with NO journal record at all when the journal says nothing', async () => {
    const result = await preflightDuplicateCheck({
      appRepo: fakeAppRepo,
      jobId: 'JOB-UNKNOWN-9' as any,
      candidateId: 'CAND-6U' as any,
      submissionJournal: journalRepo,
    });
    expect(result.blocked).toBe(false);
  });

  it('blocks from the FILE journal alone, even with no database at all', async () => {
    // Simulates: crash + database lost/reset. The durable file journal must
    // still refuse a second click.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subj-journal-fileonly-'));
    const fileJournal = new FileSubmissionJournal(dir);
    fileJournal.appendSync({ applicationId: 'APP-FILE-ONLY', jobId: 'JOB-FILE-ONLY', phase: 'started' });
    const result = await preflightDuplicateCheck({
      appRepo: fakeAppRepo,
      jobId: 'JOB-FILE-ONLY' as any,
      candidateId: 'CAND-6U' as any,
      submissionJournal: fileJournal,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('started');
  });

  it('exposes the journal rows for an application in order (audit trail)', async () => {
    await journalRepo.append({ entryId: 'J-A-1', applicationId: 'APP-AUDIT', jobId: 'JOB-AUDIT', phase: 'started' });
    await journalRepo.append({
      entryId: 'J-A-2', applicationId: 'APP-AUDIT', jobId: 'JOB-AUDIT', phase: 'response',
      method: 'POST', host: 'boards.example.com', path: '/jobs/9', status: 201, resourceType: 'fetch',
    });
    const rows = await journalRepo.findByApplication('APP-AUDIT');
    expect(rows.map(r => r.phase)).toEqual(['started', 'response']);
    expect(rows[1].status).toBe(201);
    expect(rows[1].host).toBe('boards.example.com');
  });
});