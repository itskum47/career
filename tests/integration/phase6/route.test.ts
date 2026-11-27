/**
 * Phase 6U — Application route resolution tests (6G).
 */
import { describe, it, expect } from 'vitest';
import {
  detectAts,
  resolveRoute,
  routePreference,
  pickBestRoute,
} from '../../../src/discovery/route.ts';
import { normalize } from '../../../src/discovery/normalize.ts';
import type { DiscoveredJob } from '../../../src/core/types.ts';
import type { NormalizedJob, ResolvedRoute } from '../../../src/discovery/types.ts';

function norm(overrides: Partial<Omit<DiscoveredJob, 'jobId'>> & { jobId: string }): NormalizedJob {
  return normalize({
    company: 'GitLab',
    title: 'DevOps Engineer',
    location: 'Remote',
    remote: true,
    url: 'https://example.com/jobs/1',
    source: 'greenhouse',
    description: 'x'.repeat(500),
    ...overrides,
  } as DiscoveredJob).normalized;
}

describe('6G — ATS detection (24 ATS patterns)', () => {
  it('detects the major ATS families by URL', () => {
    expect(detectAts('https://boards.greenhouse.io/gitlab/jobs/12345678')).toBe('greenhouse');
    expect(detectAts('https://jobs.lever.co/spotify/abc-def')).toBe('lever');
    expect(detectAts('https://jobs.ashbyhq.com/dust/xyz')).toBe('ashby');
    expect(detectAts('https://wd5.myworkdayjobs.com/External/job/Bengaluru/x')).toBe('workday');
    expect(detectAts('https://jobs.smartrecruiters.com/Company/123')).toBe('smartrecruiters');
    expect(detectAts('https://apply.workable.com/company/job/abc')).toBe('workable');
    expect(detectAts('https://company.bamboohr.com/jobs/123')).toBe('bamboohr');
    expect(detectAts('https://board.teamtailor.com/jobs/1')).toBe('teamtailor');
  });

  it('returns undefined for plain employer career pages', () => {
    expect(detectAts('https://careers.examplecorp.com/open-roles/senior-devops')).toBeUndefined();
    expect(detectAts('https://examplecorp.com/join-us')).toBeUndefined();
  });

  it('prefers explicit ATS metadata from the job when present', () => {
    const job = norm({ jobId: 'JOB-ATS', rawData: { ats: 'icims' } });
    expect(detectAts('https://careers.examplecorp.com/apply', job)).toBe('icims');
  });
});

describe('6G — route classification', () => {
  it('ATS application URL -> ATS route (preferred over aggregator)', () => {
    const job = norm({
      jobId: 'JOB-R1', source: 'greenhouse',
      url: 'https://boards.greenhouse.io/gitlab/jobs/12345678',
    });
    const r = resolveRoute(job);
    expect(r.route).toBe('ATS');
    expect(r.ats).toBe('greenhouse');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.discoveredFrom).toBe('greenhouse');
    expect(r.applicationUrl).toContain('greenhouse.io');
  });

  it('employer career page -> DIRECT_EMPLOYER', () => {
    const job = norm({
      jobId: 'JOB-R2', source: 'company-career',
      url: 'https://careers.examplecorp.com/open-roles/senior-devops',
    });
    const r = resolveRoute(job);
    expect(r.route).toBe('DIRECT_EMPLOYER');
    expect(r.canonicalSource).toBe('careers.examplecorp.com');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('aggregator-hosted apply stays JOB_PORTAL', () => {
    const job = norm({
      jobId: 'JOB-R3', source: 'naukri',
      url: 'https://www.naukri.com/devops-jobs-in-pune',
    });
    const r = resolveRoute(job);
    expect(r.route).toBe('JOB_PORTAL');
    expect(r.discoveredFrom).toBe('naukri');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('portal listing with login-only flow -> LOGIN_REQUIRED (6K)', () => {
    const job = norm({
      jobId: 'JOB-R4', source: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/devops-engineer-123',
      rawData: { loginRequired: true },
    });
    const r = resolveRoute(job);
    expect(r.route).toBe('LOGIN_REQUIRED');
    expect(r.reason).toMatch(/login/i);
  });

  it('portal listing exposing an employer/ATS link upgrades to ATS', () => {
    const portalJob = norm({
      jobId: 'JOB-R5', source: 'shine',
      url: 'https://www.shine.com/careers/devops-engineer-19715097/',
    });
    const r = resolveRoute(portalJob, { employerUrl: 'https://boards.greenhouse.io/acme/jobs/998888' });
    expect(r.route).toBe('ATS');
    expect(r.ats).toBe('greenhouse');
    expect(r.applicationUrl).toContain('greenhouse.io');
  });

  it('remote board without an employer link -> REDIRECT (apply bounces off the board, never mislabeled as ATS/portal)', () => {
    const job = norm({
      jobId: 'JOB-R6', source: 'remoteok',
      url: 'https://remoteok.com/l/445566',
    });
    const r = resolveRoute(job);
    expect(r.route).toBe('REDIRECT');
    expect(r.ats).toBeUndefined(); // resolved only after the redirect lands
    expect(r.confidence).toBeLessThan(0.85);
  });

  it('remote board with a Lever application URL -> ATS', () => {
    const job = norm({
      jobId: 'JOB-R7', source: 'remoteok',
      url: 'https://remoteok.com/l/445566',
    });
    const r = resolveRoute(job, { employerUrl: 'https://jobs.lever.co/spotify/xyz-123' });
    expect(r.route).toBe('ATS');
    expect(r.ats).toBe('lever');
  });
});

describe('6G — route preference ordering', () => {
  it('DIRECT_EMPLOYER and ATS outrank JOB_PORTAL', () => {
    expect(routePreference('DIRECT_EMPLOYER')).toBeLessThan(routePreference('ATS'));
    expect(routePreference('ATS')).toBeLessThan(routePreference('JOB_PORTAL'));
    expect(routePreference('JOB_PORTAL')).toBeLessThan(routePreference('LOGIN_REQUIRED'));
    expect(routePreference('LOGIN_REQUIRED')).toBeLessThan(routePreference('UNKNOWN'));
  });

  it('pickBestRoute selects the most direct route among candidates', () => {
    const base = {
      applicationUrl: 'https://x.test/a',
      canonicalSource: 'x.test',
      discoveredFrom: 'naukri',
      confidence: 0.7,
      reason: 'test',
    };
    const candidates: ResolvedRoute[] = [
      { ...base, route: 'JOB_PORTAL' },
      { ...base, route: 'ATS', ats: 'lever' },
      { ...base, route: 'DIRECT_EMPLOYER', applicationUrl: 'https://careers.x.test/jobs/1' },
    ];
    expect(pickBestRoute(candidates)?.route).toBe('DIRECT_EMPLOYER');
    expect(pickBestRoute([])).toBeUndefined();
  });
});
