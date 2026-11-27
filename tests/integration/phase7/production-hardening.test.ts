/**
 * Phase 7 — Production hardening: rate limiting, submission state machine,
 * failure taxonomy, artifact integrity, observability timeline, and the chat
 * control plane.
 *
 * Fixtures/fake data only — real applications are never disposable test cases.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const testDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(testDir, '../../../');

vi.hoisted(() => {
  process.env.DB_PATH = `${process.cwd()}/data/test-phase7-hardening.db`;
});

import { createDatabaseClient, type DatabaseClient } from '../../../src/database/client.ts';
import { SubmissionJournalRepository } from '../../../src/database/repositories.ts';
import { FileSubmissionJournal, CLICK_BEARING_PHASES } from '../../../src/application/submission-journal.ts';
import { RateLimiter, RateLimitExceeded, domainOf } from '../../../src/core/rate-limiter.ts';
import {
  canTransition, assertTransition, decideRetry, toLifecycleState, NO_AUTO_RETRY_STATES,
  CLICK_BEARING_STATES, type ApplicationLifecycleState,
} from '../../../src/application/state-machine.ts';
import { classifyFailure, explainFailure, FAILURE_CODES } from '../../../src/application/failure-taxonomy.ts';
import { verifyArtifacts, MasterProfileGuard, verifyUploadedAttachment } from '../../../src/application/artifact-integrity.ts';
import { buildTimeline, renderTimeline, sanitiseMessage } from '../../../src/observability/application-timeline.ts';
import { ChatAgent } from '../../../src/control/chat-agent.ts';

// ---------------------------------------------------------------------------
describe('7 — rate limiting (budgets, cooldown, concurrency)', () => {
  it('enforces a per-domain request budget and tells the caller how long to wait', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ requestsPerMinute: 3 }, () => now);
    expect(limiter.checkRequest('boards.example.com').allowed).toBe(true);
    limiter.recordRequest('boards.example.com');
    limiter.recordRequest('boards.example.com');
    limiter.recordRequest('boards.example.com');
    const denied = limiter.checkRequest('boards.example.com');
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe('requests_per_minute');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Window slides: a minute later the budget is back.
    now += 60_001;
    expect(limiter.checkRequest('boards.example.com').allowed).toBe(true);
  });

  it('cools a source down after it signals throttling, instead of hammering it', () => {
    let now = 2_000_000;
    const limiter = new RateLimiter({ cooldownMs: 60_000 }, () => now);
    limiter.recordThrottle('greenhouse', 30_000);
    const denied = limiter.checkRequest('greenhouse');
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe('cooldown');
    expect(limiter.cooldowns()[0].key).toBe('greenhouse');
    now += 61_000;
    expect(limiter.checkRequest('greenhouse').allowed).toBe(true);
  });

  it('enforces application budgets per hour and per day', () => {
    let now = 3_000_000;
    const limiter = new RateLimiter({ actionsPerHour: 2, applicationsPerDay: 3, requestsPerMinute: 100 }, () => now);
    expect(limiter.checkApplication('src', 'a.com').allowed).toBe(true);
    now += 1000;
    expect(limiter.checkApplication('src', 'a.com').allowed).toBe(true);
    now += 1000;
    const hourly = limiter.checkApplication('src', 'a.com');
    expect(hourly.allowed).toBe(false);
    expect(hourly.limit).toBe('applications_per_hour');
    now += 60 * 60_000 + 1;
    expect(limiter.checkApplication('src', 'a.com').allowed).toBe(true); // third of the day
    now += 1000;
    const daily = limiter.checkApplication('src', 'a.com');
    expect(daily.allowed).toBe(false);
    expect(daily.limit).toBe('applications_per_day');
  });

  it('caps concurrent browser sessions and throws (PAUSE, never hammer) when exhausted', () => {
    const limiter = new RateLimiter({ maxConcurrency: 2, requestsPerMinute: 100 });
    expect(limiter.acquireSlot()).toBe(true);
    expect(limiter.acquireSlot()).toBe(true);
    expect(limiter.acquireSlot()).toBe(false);
    limiter.releaseSlot();
    expect(limiter.acquireSlot()).toBe(true);
    const strict = new RateLimiter({ requestsPerMinute: 1 });
    strict.assertRequestAllowed('x'); // consumes the single budget slot
    expect(() => strict.assertRequestAllowed('x')).toThrow(RateLimitExceeded);
    expect(() => strict.assertRequestAllowed('x')).toThrow(/Rate limit reached/);
  });

  it('derives the rate-limit domain from a URL', () => {
    expect(domainOf('https://job-boards.greenhouse.io/x/y?z=1')).toBe('job-boards.greenhouse.io');
    expect(domainOf('not-a-url')).toBe('not-a-url');
  });
});

// ---------------------------------------------------------------------------
describe('7 — submission state machine safety rules', () => {
  it('allows the happy path and blocks illegal jumps', () => {
    expect(canTransition('DISCOVERED', 'QUALIFIED')).toBe(true);
    expect(canTransition('ARTIFACTS_READY', 'FORM_STARTED')).toBe(true);
    expect(canTransition('READY_TO_SUBMIT', 'SUBMISSION_STARTED')).toBe(true);
    expect(canTransition('SUBMISSION_ATTEMPTED', 'CONFIRMED')).toBe(true);
    // A click cannot be "unwound" back into a pre-submit state.
    expect(canTransition('SUBMITTED', 'FORM_STARTED')).toBe(false);
    expect(canTransition('CONFIRMED', 'SUBMISSION_STARTED')).toBe(false);
    expect(canTransition('SUBMISSION_STARTED', 'READY_TO_SUBMIT')).toBe(false);
    expect(assertTransition('CONFIRMED', 'FORM_STARTED').allowed).toBe(false);
  });

  it('never auto-retries unknown/uncertain/submitted/confirmed', () => {
    for (const state of NO_AUTO_RETRY_STATES) {
      const d = decideRetry({ state: state as ApplicationLifecycleState, journalClickBearing: false, provablyPreSubmit: true });
      expect(d.safeToAutoRetry).toBe(false);
      expect(d.requiresHuman).toBe(true);
    }
    expect(CLICK_BEARING_STATES).toContain('SUBMISSION_STARTED');
    expect(CLICK_BEARING_STATES).toContain('SUBMISSION_UNCERTAIN');
  });

  it('retries only provably pre-submit failures, and the journal always wins', () => {
    expect(decideRetry({ state: 'FAILED', journalClickBearing: false, provablyPreSubmit: true, failureCode: 'ATTACHMENT_FAILURE' }).safeToAutoRetry).toBe(true);
    expect(decideRetry({ state: 'FAILED', journalClickBearing: false }).safeToAutoRetry).toBe(false);
    // Journal knowledge overrides an apparently retryable state.
    expect(decideRetry({ state: 'FAILED', journalClickBearing: true, provablyPreSubmit: true }).safeToAutoRetry).toBe(false);
  });

  it('maps legacy engine states onto the lifecycle', () => {
    expect(toLifecycleState('PAUSED_FOR_USER')).toBe('WAITING_FOR_USER');
    expect(toLifecycleState('SUBMISSION_UNCERTAIN')).toBe('SUBMISSION_UNCERTAIN');
    expect(toLifecycleState('ERROR')).toBe('FAILED');
    expect(toLifecycleState('CONFIRMED')).toBe('CONFIRMED');
  });
});

// ---------------------------------------------------------------------------
describe('7 — failure taxonomy (first failing stage, never collapsed)', () => {
  it('classifies each failure mode to its own code', () => {
    const cases: Array<[Parameters<typeof classifyFailure>[0], string]> = [
      [{ stage: 'submit', error: 'CAPTCHA marker: <iframe title="reCAPTCHA">' }, 'CAPTCHA_REQUIRED'],
      [{ stage: 'form', error: 'login required to apply' }, 'LOGIN_REQUIRED'],
      [{ stage: 'form', error: 'enter the code we sent (one-time-code)' }, 'MFA_REQUIRED'],
      [{ stage: 'discovery', error: '429 Too Many Requests' }, 'RATE_LIMITED'],
      [{ stage: 'uploads', error: 'Attachment gate failed — Resume/CV is required.' }, 'ATTACHMENT_FAILURE'],
      [{ stage: 'validation', error: 'Form validation failed: Required field empty' }, 'VALIDATION_FAILURE'],
      [{ stage: 'questions', error: 'Paused for 18 user questions' }, 'QUESTION_ESCALATION'],
      [{ stage: 'confirmation', error: 'Submission uncertain - needs verification' }, 'CONFIRMATION_FAILURE'],
      [{ stage: 'submit', error: 'Submission failed: network error' }, 'SUBMISSION_TRANSPORT_FAILURE'],
      [{ stage: 'persistence', error: 'SqliteError: UNIQUE constraint failed' }, 'DB_FAILURE'],
      [{ stage: 'excel', error: 'Excel sync completed' }, 'EXCEL_FAILURE'],
    ];
    for (const [input, expected] of cases) {
      expect(classifyFailure(input).code).toBe(expected);
      expect(FAILURE_CODES).toContain(expected);
    }
  });

  it('marks challenge-class failures as pre-submit and transport failures as not', () => {
    expect(classifyFailure({ stage: 'submit', error: 'captcha required' }).preSubmit).toBe(true);
    expect(classifyFailure({ stage: 'submit', error: 'Submission failed: network error' }).preSubmit).toBe(false);
  });

  it('explains a failure as WHAT / WHY / ACTION', () => {
    const c = classifyFailure({ stage: 'uploads', error: 'resume not committed' });
    const text = explainFailure(c, { applicationId: 'APP-1', jobId: 'JOB-1' });
    expect(text).toContain('FAILED at UPLOADS');
    expect(text).toContain('ATTACHMENT_FAILURE');
    expect(text).toContain('ATTACHMENT_FAILURE');
  });
});

// ---------------------------------------------------------------------------
describe('7 — artifact integrity', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-artifacts-'));
    fs.writeFileSync(path.join(dir, 'Acme_Cloud_Platform_Engineer_2026-01-01.pdf'), '%PDF-1.4 resume for acme');
    fs.writeFileSync(path.join(dir, 'CoverLetter_Acme_Cloud_Platform_Engineer_2026-01-01.pdf'), '%PDF-1.4 cover for acme');
    fs.writeFileSync(path.join(dir, 'OtherCorp_Some_Engineer_2026-01-01.pdf'), '%PDF-1.4 other company');
  });

  const binding = () => ({
    jobId: 'JOB-1',
    company: 'Acme',
    title: 'Cloud Platform Engineer',
    resumePath: path.join(dir, 'Acme_Cloud_Platform_Engineer_2026-01-01.pdf'),
    coverLetterPath: path.join(dir, 'CoverLetter_Acme_Cloud_Platform_Engineer_2026-01-01.pdf'),
  });

  it('accepts artifacts that belong to this job', () => {
    const report = verifyArtifacts(binding());
    expect(report.ok).toBe(true);
    expect(report.resume?.jobBound).toBe(true);
    expect(report.resume?.sizeBytes).toBeGreaterThan(0);
    expect(report.resume?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an artifact from a different job/company', () => {
    const report = verifyArtifacts({ ...binding(), resumePath: path.join(dir, 'OtherCorp_Some_Engineer_2026-01-01.pdf') });
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/does not identify this job|different company/);
  });

  it('rejects a missing artifact', () => {
    const report = verifyArtifacts({ ...binding(), resumePath: path.join(dir, 'nope.pdf') });
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('does not exist');
  });

  it('detects master-profile mutation', () => {
    const profile = path.join(dir, 'profile.yaml');
    fs.writeFileSync(profile, 'name: Test\n');
    const guard = new MasterProfileGuard(profile);
    guard.snapshot();
    expect(guard.verifyUnchanged().unchanged).toBe(true);
    fs.appendFileSync(profile, 'tampered: true\n');
    expect(guard.verifyUnchanged().unchanged).toBe(false);
  });

  it('proves the uploaded file is the generated one', () => {
    const ok = verifyUploadedAttachment({ kind: 'resume', expectedPath: binding().resumePath, observedName: path.basename(binding().resumePath) });
    expect(ok.ok).toBe(true);
    const wrong = verifyUploadedAttachment({ kind: 'resume', expectedPath: binding().resumePath, observedName: 'someone_else.pdf' });
    expect(wrong.ok).toBe(false);
    const missing = verifyUploadedAttachment({ kind: 'resume', expectedPath: binding().resumePath });
    expect(missing.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('7 — observability timeline', () => {
  it('orders events + journal rows and finds the first failing stage', () => {
    const t = buildTimeline({
      applicationId: 'APP-9',
      company: 'Acme',
      role: 'Platform Engineer',
      events: [
        { type: 'state_transition', message: 'Browser session started', timestamp: '2026-01-01T10:00:00Z' },
        { type: 'form_field_filled', message: 'Filled 8 fields', timestamp: '2026-01-01T10:00:10Z' },
        { type: 'human_escalation', message: 'Paused for 3 user questions', timestamp: '2026-01-01T10:00:20Z' },
        { type: 'submission_failed', message: 'Submission failed: network error', timestamp: '2026-01-01T10:00:40Z' },
      ],
      journal: [{ entryId: 'j1', applicationId: 'APP-9', jobId: 'JOB-9', phase: 'started', createdAt: '2026-01-01T10:00:35Z' } as any],
    });
    expect(t.humanIntervention).toBe(true);
    expect(t.firstFailingStage).toBe('submit');
    expect(t.entries.map(e => e.at)).toEqual([...t.entries.map(e => e.at)].sort());
    expect(renderTimeline(t)).toContain('First failing stage: submit');
  });

  it('redacts tokens from operator-facing messages', () => {
    expect(sanitiseMessage('failed url https://x/y?access_token=SECRETVALUE123')).not.toContain('SECRETVALUE123');
    expect(sanitiseMessage('hash ' + 'a'.repeat(40))).toContain('[hash]');
  });
});

// ---------------------------------------------------------------------------
describe('7 — chat control plane (safety first)', () => {
  let db: DatabaseClient;
  let agent: ChatAgent;
  let journalRepo: SubmissionJournalRepository;
  const DB_PATH = process.env.DB_PATH!;
  const UNCERTAIN_JOB = 'JOB-chat-uncertain';

  beforeAll(async () => {
    try { fs.rmSync(DB_PATH); } catch { /* fresh */ }
    db = await createDatabaseClient();
    await db.runMigrations(path.join(projectRoot, 'migrations'));
    journalRepo = new SubmissionJournalRepository(db);

    await db.query(`INSERT OR IGNORE INTO companies (company_id, name) VALUES (?,?)`, ['COMP-ACME', 'Acme']);
    await db.query(
      `INSERT OR IGNORE INTO candidate_profiles
         (candidate_id, personal_info, education, experience, projects, skills, certifications, achievements, preferences, authorization, compensation, question_answers, version, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))`,
      ['CAND-1', '{}', '[]', '[]', '[]', '[]', '[]', '[]', '{}', '{}', '{}', '[]']
    );
    await db.query(
      `INSERT OR IGNORE INTO jobs (job_id, company_id, title, url, source, updated_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [UNCERTAIN_JOB, 'COMP-ACME', 'Platform Engineer', 'https://example.com/j/1', 'greenhouse']
    );
    await db.query(
      `INSERT OR REPLACE INTO applications (application_id, job_id, candidate_id, company_id, state, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      ['APP-chat-uncertain', UNCERTAIN_JOB, 'CAND-1', 'COMP-ACME', 'SUBMISSION_UNCERTAIN', 'in_progress']
    );
    await db.query(
      `INSERT OR IGNORE INTO jobs (job_id, company_id, title, url, source, updated_at) VALUES (?,?,?,?,?,datetime('now'))`,
      ['JOB-chat-failed', 'COMP-ACME', 'SRE', 'https://example.com/j/2', 'greenhouse']
    );
    await db.query(
      `INSERT OR REPLACE INTO applications (application_id, job_id, candidate_id, company_id, state, status, error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      ['APP-chat-failed', 'JOB-chat-failed', 'CAND-1', 'COMP-ACME', 'ERROR', 'error', 'Form validation failed: Required field empty']
    );
    await db.query(
      `INSERT OR REPLACE INTO application_events (event_id, application_id, type, from_state, to_state, message, timestamp)
       VALUES (?,?,?,?,?,?,datetime('now'))`,
      ['EV-1', 'APP-chat-uncertain', 'state_transition', 'SUBMITTED', 'SUBMISSION_UNCERTAIN', 'Submission uncertain - needs verification']
    );
    await journalRepo.append({ entryId: 'J-unc', applicationId: 'APP-chat-uncertain', jobId: UNCERTAIN_JOB, phase: 'uncertain' });

    agent = new ChatAgent({ db, journalRepo, fileJournal: new FileSubmissionJournal(fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-chat-'))) });
  }, 60000);

  afterAll(async () => {
    try { fs.rmSync(DB_PATH); } catch { /* cleaned */ }
  });

  it('refuses to retry an uncertain submission, whatever the phrasing', async () => {
    for (const phrase of ['retry APP-chat-uncertain', 'submit it again', 'resubmit APP-chat-uncertain']) {
      const r = await agent.handle(phrase);
      if (r.action === 'unknown_instruction') continue;
      expect(r.ok).toBe(false);
      expect(r.action).toBe('retry_refused');
      expect(r.message).toContain('Refused to retry');
      expect(r.message).toContain('journal');
    }
  });

  it('refuses unsafe control-plane instructions outright', async () => {
    for (const phrase of [
      'bypass the captcha and submit',
      'disable duplicate protection',
      'mark it as confirmed manually',
      'fabricate the confirmation id',
      'reset the journal',
      'delete the journal',
    ]) {
      const r = await agent.handle(phrase);
      expect(r.ok).toBe(false);
      expect(r.action).toBe('refused_unsafe');
    }
  });

  it('refuses an otherwise-safe retry while the real-submission lock is closed', async () => {
    // Hermetic: the locked path is tested against an approval scope that holds
    // no approval, so this test never depends on the repository's own state.
    const emptyScope = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-locked-'));
    const previous = process.env.PROFILE_APPROVAL_FILE;
    process.env.PROFILE_APPROVAL_FILE = path.join(emptyScope, 'approval.json');
    try {
      const r = await agent.handle('retry APP-chat-failed');
      expect(r.ok).toBe(false);
      expect(r.action).toBe('retry_refused');
      expect(r.message).toMatch(/real submissions are locked/i);
    } finally {
      if (previous === undefined) delete process.env.PROFILE_APPROVAL_FILE;
      else process.env.PROFILE_APPROVAL_FILE = previous;
    }
  });

  it('allows a retry that is provably pre-submit once the profile is approved', async () => {
    const { computeProfileVersion } = await import('../../../src/profile/profile-integrity.ts');
    const approvalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-lock-')), 'approval.json');
    const previous = process.env.PROFILE_APPROVAL_FILE;
    process.env.PROFILE_APPROVAL_FILE = approvalFile;
    fs.writeFileSync(
      approvalFile,
      JSON.stringify({ approved: true, profileVersion: computeProfileVersion(), approvedBy: 'test' }),
    );
    try {
      const r = await agent.handle('retry APP-chat-failed');
      expect(r.ok).toBe(true);
      expect(r.action).toBe('retry_allowed');
    } finally {
      if (previous === undefined) delete process.env.PROFILE_APPROVAL_FILE;
      else process.env.PROFILE_APPROVAL_FILE = previous;
    }
  });

  it('shows status with grouped buckets', async () => {
    const r = await agent.handle('status');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Applications:');
    expect(r.message).toMatch(/uncertain \d+/);
  });

  it('lists uncertain applications with their retry protection', async () => {
    const r = await agent.handle('uncertain');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('APP-chat-uncertain');
    expect(r.message).toContain('retry protected');
  });

  it('explains an application with a timeline and the first failing stage', async () => {
    const r = await agent.handle('explain APP-chat-uncertain');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Timeline');
    expect(r.message).toContain('First failing stage: confirmation');
  });

  it('reports failed applications with their cause', async () => {
    const r = await agent.handle('failed');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('APP-chat-failed');
  });

  it('refuses to approve an application the journal says may already be submitted', async () => {
    const r = await agent.handle('approve APP-chat-uncertain');
    expect(r.ok).toBe(false);
    expect(r.action).toBe('approve_refused');
  });

  it('supports pause/resume and help, and refuses unknown instructions', async () => {
    expect((await agent.handle('pause all')).action).toBe('pause_all');
    expect((await agent.handle('resume')).action).toBe('resume');
    expect((await agent.handle('help')).ok).toBe(true);
    const unknown = await agent.handle('make me a sandwich');
    expect(unknown.ok).toBe(false);
    expect(unknown.action).toBe('unknown_instruction');
  });

  it('surfaces pending escalations as waiting (never answers them itself)', async () => {
    const r = await agent.handle('waiting');
    expect(r.ok).toBe(true);
    expect(r.message.toLowerCase()).toMatch(/nothing is waiting|waiting for you/);
  });

  it('explains and blocks an application that has no DB row (crash case)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-crashcase-'));
    const fileJournal = new FileSubmissionJournal(dir);
    fileJournal.appendSync({ applicationId: 'APP-crashed', jobId: 'JOB-crashed', phase: 'started' });
    fileJournal.appendSync({ applicationId: 'APP-crashed', jobId: 'JOB-crashed', phase: 'uncertain' });
    const crashAgent = new ChatAgent({ db, journalRepo, fileJournal });
    const explained = await crashAgent.handle('explain APP-crashed');
    expect(explained.ok).toBe(true);
    expect(explained.message).toContain('no database row');
    expect(explained.message).toContain('Retry protection: ENABLED');
    const retried = await crashAgent.handle('retry JOB-crashed');
    expect(retried.ok).toBe(false);
    expect(retried.action).toBe('retry_refused');
    expect(retried.message).toContain('journal');
  });

  it('uses the file journal as protection even when the DB row is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-journalonly-'));
    const fileJournal = new FileSubmissionJournal(dir);
    fileJournal.appendSync({ applicationId: 'APP-gone', jobId: 'JOB-only-journal', phase: 'started' });
    const attempt = await fileJournal.hasClickBearingAttempt('JOB-only-journal', CLICK_BEARING_PHASES);
    expect(attempt?.phase).toBe('started');
  });
});