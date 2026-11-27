/**
 * Phase 6U — Duplicate application protection (6X).
 *
 * DB-backed: proves that before EVERY real application the pre-flight guard
 * blocks a second submission for the same job AND for different portal
 * listings that resolve to the same canonical opportunity. Non-blocking
 * states (REJECTED) remain retryable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Must run before config is imported: point the test at its own database.
vi.hoisted(() => {
  process.env.DB_PATH = `${process.cwd()}/data/test-phase6-dupguard.db`;
});

import { createDatabaseClient } from '../../../src/database/client.ts';
import type { DatabaseClient } from '../../../src/database/client.ts';
import { JobRepository, ApplicationRepository, CandidateProfileRepository } from '../../../src/database/repositories.ts';
import {
  preflightDuplicateCheck,
  assertNoDuplicateApplication,
  DuplicateApplicationError,
} from '../../../src/application/duplicate-guard.ts';
import type { Application } from '../../../src/core/types.ts';

const DB_PATH = process.env.DB_PATH!;
const CANDIDATE = 'CAND-6U' as any;
const COMPANY = 'COMP-6U' as any;
const CANONICAL_K = 'sig:gitlab|devops|pune';
const APP_URL_E = 'https://boards.greenhouse.io/acme/jobs/777777';

let db: DatabaseClient;
let jobRepo: JobRepository;
let appRepo: ApplicationRepository;

function mkApp(id: string, jobId: string, state: string, status: string): Application {
  const now = new Date();
  return {
    applicationId: id as any,
    jobId: jobId as any,
    candidateId: CANDIDATE,
    companyId: COMPANY,
    state,
    status,
    createdAt: now,
    updatedAt: now,
  } as unknown as Application;
}

async function addJob(jobId: string, opts: { canonicalKey?: string; applicationUrl: string; sourceUrl?: string; source?: string }) {
  const sourceUrl = opts.sourceUrl ?? opts.applicationUrl; // jobs.url is UNIQUE
  await jobRepo.upsertNormalizedJob({
    internalJobId: jobId as any,
    source: opts.source ?? 'naukri',
    sourceJobId: `${(opts.source ?? 'naukri').toUpperCase()}-${jobId}`,
    sourceUrl,
    canonicalJobUrl: sourceUrl,
    applicationUrl: opts.applicationUrl,
    company: 'GitLab',
    title: 'DevOps Engineer',
    location: 'Pune, India',
    remote: false,
    description: 'x'.repeat(500),
    canonicalKey: opts.canonicalKey,
    jdComplete: true,
  }, COMPANY, { discoveredFrom: opts.source ?? 'naukri', applicationRoute: 'ATS' });
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${DB_PATH}${suffix}`); } catch { /* fresh run */ }
  }
  db = await createDatabaseClient();
  await db.runMigrations(path.resolve(__dirname, '../../../migrations'));
  jobRepo = new JobRepository(db);
  appRepo = new ApplicationRepository(db);

  await jobRepo.upsertCompany({ companyId: COMPANY, name: 'SixU Test Corp' });
  // applications.candidate_id has an FK to candidate_profiles.
  await new CandidateProfileRepository(db).upsert({
    candidateId: 'CAND-6U',
    personal: { name: 'SixU Candidate' },
    education: [], experience: [], projects: [], skills: [],
    certifications: [], achievements: [],
    preferences: {}, authorization: {}, compensation: {}, questionAnswers: {},
    version: 1,
  } as any);

  // JOB-DUP-A: has a SUBMITTED application, carries the canonical identity.
  await addJob('JOB-DUP-A', { canonicalKey: CANONICAL_K, applicationUrl: 'https://www.naukri.com/devops-pune-1' });
  // JOB-DUP-B: different portal listing of the SAME canonical job (no app yet).
  await addJob('JOB-DUP-B', { canonicalKey: CANONICAL_K, applicationUrl: 'https://www.linkedin.com/jobs/view/999', source: 'linkedin' });
  // JOB-DUP-C: application was REJECTED (legitimate retry allowed).
  await addJob('JOB-DUP-C', { applicationUrl: 'https://www.naukri.com/devops-pune-3' });
  // JOB-DUP-E: in-flight application sharing an application URL.
  await addJob('JOB-DUP-E', { canonicalKey: 'sig:acme|devops|pune', applicationUrl: APP_URL_E, source: 'greenhouse' });
  // JOB-DUP-F: another portal listing exposing the SAME application URL.
  await addJob('JOB-DUP-F', {
    canonicalKey: 'sig:acme|devops|remote',
    applicationUrl: APP_URL_E,
    sourceUrl: 'https://remoteok.com/l/889900',
    source: 'remoteok',
  });
  // JOB-DUP-G: brand new, nothing exists for it.
  await addJob('JOB-DUP-G', { applicationUrl: 'https://www.naukri.com/devops-pune-7' });

  await appRepo.create(mkApp('APP-6X-1', 'JOB-DUP-A', 'SUBMITTED', 'submitted'));
  await appRepo.create(mkApp('APP-6X-2', 'JOB-DUP-C', 'REJECTED', 'rejected'));
  await appRepo.create(mkApp('APP-6X-3', 'JOB-DUP-E', 'BROWSER_STARTED', 'in_progress'));
});

afterAll(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${DB_PATH}${suffix}`); } catch { /* already gone */ }
  }
});

describe('6X — pre-flight duplicate application guard', () => {
  it('allows a job with no prior application', async () => {
    const r = await preflightDuplicateCheck({
      appRepo, jobId: 'JOB-DUP-G' as any, candidateId: CANDIDATE,
    });
    expect(r.blocked).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('blocks a second application for a SUBMITTED job (job_id axis)', async () => {
    const r = await preflightDuplicateCheck({
      appRepo, jobId: 'JOB-DUP-A' as any, candidateId: CANDIDATE,
    });
    expect(r.blocked).toBe(true);
    expect(r.matchedOn).toBe('job_id');
    expect(r.existing?.applicationId).toBe('APP-6X-1');
    expect(r.reason).toContain('SUBMITTED');
  });

  it('blocks a second application across portal listings of the same canonical job', async () => {
    const r = await preflightDuplicateCheck({
      appRepo,
      jobId: 'JOB-DUP-B' as any,     // different job id, no application of its own
      candidateId: CANDIDATE,
      canonicalKey: CANONICAL_K,      // same canonical identity as JOB-DUP-A
    });
    expect(r.blocked).toBe(true);
    expect(r.matchedOn).toBe('canonical_key');
    expect(r.existing?.applicationId).toBe('APP-6X-1');
  });

  it('blocks when two listings share the same application URL', async () => {
    const r = await preflightDuplicateCheck({
      appRepo,
      jobId: 'JOB-DUP-F' as any,
      candidateId: CANDIDATE,
      applicationUrl: APP_URL_E,
    });
    expect(r.blocked).toBe(true);
    expect(r.matchedOn).toBe('application_url');
    expect(r.existing?.applicationId).toBe('APP-6X-3');
  });

  it('blocks while an application is still IN FLIGHT (no parallel submissions)', async () => {
    const r = await preflightDuplicateCheck({
      appRepo, jobId: 'JOB-DUP-E' as any, candidateId: CANDIDATE,
    });
    expect(r.blocked).toBe(true);
    expect(r.existing?.state).toBe('BROWSER_STARTED');
  });

  it('does NOT block a legitimate retry after REJECTION', async () => {
    const r = await preflightDuplicateCheck({
      appRepo, jobId: 'JOB-DUP-C' as any, candidateId: CANDIDATE,
    });
    expect(r.blocked).toBe(false);
  });

  it('is candidate-scoped: another candidate is unaffected', async () => {
    const r = await preflightDuplicateCheck({
      appRepo, jobId: 'JOB-DUP-A' as any, candidateId: 'CAND-OTHER' as any,
    });
    expect(r.blocked).toBe(false);
  });

  it('assertNoDuplicateApplication throws DuplicateApplicationError with context', async () => {
    await expect(assertNoDuplicateApplication({
      appRepo, jobId: 'JOB-DUP-A' as any, candidateId: CANDIDATE,
    })).rejects.toThrow(DuplicateApplicationError);

    // And stays silent for clean jobs.
    await expect(assertNoDuplicateApplication({
      appRepo, jobId: 'JOB-DUP-G' as any, candidateId: CANDIDATE,
    })).resolves.toBeUndefined();
  });

  it('blocks to stay safe when the check itself errors (never applies blind)', async () => {
    const broken = {
      findBlockingApplication: async () => { throw new Error('db gone'); },
      findBlockingApplicationByCanonical: async () => { throw new Error('db gone'); },
    } as unknown as ApplicationRepository;
    const r = await preflightDuplicateCheck({
      appRepo: broken, jobId: 'JOB-DUP-G' as any, candidateId: CANDIDATE,
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('duplicate check error');
  });
});
