/**
 * Phase 6U — Cross-source deduplication / canonical identity tests (6F).
 */
import { describe, it, expect } from 'vitest';
import {
  comparePair,
  canonicalKeyFor,
  canonicalInternalJobId,
  JobIdentityResolver,
  MERGE_THRESHOLD,
  AMBIGUOUS_THRESHOLD,
  jdHash,
} from '../../../src/discovery/identity.ts';
import { normalize } from '../../../src/discovery/normalize.ts';
import type { DiscoveredJob } from '../../../src/core/types.ts';
import type { NormalizedJob } from '../../../src/discovery/types.ts';

const LONG_JD = [
  'DevOps Engineer responsible for Kubernetes clusters, Terraform infrastructure,',
  'CI/CD pipelines, AWS cloud operations, observability and incident response.',
  'You will own build and release automation, container platforms, and production',
  'reliability across services. Requirements include Linux, Docker, Python or Go,',
  'monitoring with Prometheus and Grafana, and infrastructure as code experience.',
  'Nice to have: Helm, ArgoCD, GitOps workflows, cost optimization and security',
  'hardening of pipelines. This role partners with engineering teams to ship safely.',
].join(' ');

function mkJob(overrides: Partial<Omit<DiscoveredJob, 'jobId'>> & { jobId: string }): DiscoveredJob {
  return {
    company: 'GitLab',
    title: 'DevOps Engineer',
    location: 'Remote',
    remote: true,
    url: 'https://example.com/jobs/1',
    source: 'greenhouse',
    description: LONG_JD,
    postedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as DiscoveredJob;
}

function norm(overrides: Partial<Omit<DiscoveredJob, 'jobId'>> & { jobId: string }): NormalizedJob {
  return normalize(mkJob(overrides)).normalized;
}

describe('6F — pair scoring across the 10 identity signals', () => {
  it('scores exactly 10 signals', () => {
    const a = norm({ jobId: 'JOB-A', url: 'https://boards.greenhouse.io/gitlab/jobs/111111' });
    const b = norm({ jobId: 'JOB-B', source: 'lever', url: 'https://jobs.lever.co/gitlab/aaa-bbb' });
    const r = comparePair(a, b);
    expect(r.matched.length).toBe(10);
    expect(r.canonicalKey.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('merges two sources carrying the same requisition id (>= MERGE_THRESHOLD)', () => {
    const a = norm({
      jobId: 'JOB-A', url: 'https://boards.greenhouse.io/gitlab/jobs/111111',
      rawData: { sourceJobId: 'REQ-8871', ats: 'greenhouse' },
    });
    const b = norm({
      jobId: 'JOB-B', source: 'lever', url: 'https://jobs.lever.co/gitlab/aaa-bbb',
      rawData: { sourceJobId: 'REQ-8871' },
    });
    const r = comparePair(a, b);
    expect(r.matched.find(m => m.signal === 'requisition_id')?.matched).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    expect(r.shouldMerge).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it('merges identical listings on the same source (same source job id)', () => {
    const a = norm({
      jobId: 'JOB-A', source: 'naukri', url: 'https://www.naukri.com/job-1',
      company: 'Acme Systems', rawData: { sourceJobId: 'NK-998877' },
    });
    const b = norm({
      jobId: 'JOB-B', source: 'naukri', url: 'https://www.naukri.com/job-1?ref=x',
      company: 'Acme Systems', rawData: { sourceJobId: 'NK-998877' },
    });
    // canonical URLs equal after tracking-param strip + shared source id.
    expect(a.canonicalJobUrl.split('?')[0]).toBe(b.canonicalJobUrl.split('?')[0]);
    const r = comparePair(a, b);
    expect(r.shouldMerge).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
  });

  it('NEVER merges different companies, even with identical title/JD/requisition', () => {
    const a = norm({
      jobId: 'JOB-A', company: 'GitLab', url: 'https://boards.greenhouse.io/gitlab/jobs/111111',
      rawData: { sourceJobId: 'REQ-8871' },
    });
    const b = norm({
      jobId: 'JOB-B', company: 'Acme Corp', url: 'https://boards.greenhouse.io/acme/jobs/222222',
      rawData: { sourceJobId: 'REQ-8871' },
    });
    const r = comparePair(a, b);
    expect(r.shouldMerge).toBe(false);
    expect(r.confidence).toBeLessThan(MERGE_THRESHOLD);
    expect(r.matched.find(m => m.signal === 'company')?.matched).toBe(false);
  });

  it('keeps near-matches separate when evidence is only ambiguous (conservative)', () => {
    const a = norm({ jobId: 'JOB-A', url: 'https://boards.greenhouse.io/gitlab/jobs/111111' });
    const b = norm({
      jobId: 'JOB-B', source: 'lever', url: 'https://jobs.lever.co/gitlab/xyz-uvw',
      rawData: { sourceJobId: 'LEVER-777' },
    });
    // Same company/title/location + identical JD + same day, but no shared
    // requisition id and different URLs => ambiguous, NOT silently merged.
    const r = comparePair(a, b);
    expect(r.shouldMerge).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.confidence).toBeLessThan(MERGE_THRESHOLD);
    expect(r.confidence).toBeGreaterThanOrEqual(AMBIGUOUS_THRESHOLD);
  });

  it('canonical keys: ATS+requisition first, signature fallback otherwise', () => {
    const atsJob = norm({
      jobId: 'JOB-K1', url: 'https://boards.greenhouse.io/gitlab/jobs/111111',
      rawData: { sourceJobId: 'REQ-8871', ats: 'greenhouse' },
    });
    expect(canonicalKeyFor(atsJob)).toBe('ats:greenhouse:REQ-8871');

    const plain = norm({ jobId: 'JOB-K2', source: 'shine', url: 'https://www.shine.com/careers/x' });
    expect(canonicalKeyFor(plain).startsWith('sig:')).toBe(true);
  });

  it('jdHash is stable across formatting differences', () => {
    expect(jdHash('Hello,  World!!')).toBe(jdHash('hello world'));
  });
});

describe('6F — JobIdentityResolver produces ONE canonical opportunity', () => {
  const resolver = new JobIdentityResolver();

  it('collapses cross-source duplicates and preserves every occurrence', () => {
    const gh = norm({
      jobId: 'JOB-GH', url: 'https://boards.greenhouse.io/gitlab/jobs/111111',
      rawData: { sourceJobId: 'REQ-8871', ats: 'greenhouse' },
    });
    const lever = norm({
      jobId: 'JOB-LV', source: 'lever', url: 'https://jobs.lever.co/gitlab/aaa-bbb',
      rawData: { sourceJobId: 'REQ-8871' },
    });
    const other = norm({
      jobId: 'JOB-OT', company: 'Acme Corp', title: 'Site Reliability Engineer',
      location: 'Pune, India', remote: false, url: 'https://boards.greenhouse.io/acme/jobs/222222',
      rawData: { sourceJobId: 'REQ-4444' },
    });

    const out = resolver.resolve([gh, lever, other]);

    expect(out.canonical.length).toBe(2);
    expect(out.duplicates.length).toBe(1);
    expect(out.ambiguousPairs.length).toBe(0);

    const gitlabCanonical = out.canonical.find(c => c.primary.company === 'GitLab')!;
    expect(gitlabCanonical.occurrences.length).toBe(2);
    expect(gitlabCanonical.sources.sort()).toEqual(['greenhouse', 'lever']);
    expect(gitlabCanonical.dedupeConfidence).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    // The duplicate occurrence is recorded with its origin — nothing is lost.
    expect(out.duplicates[0].occurrence.source).toBe('lever');
    expect(out.duplicates[0].into.primary.internalJobId).toBe('JOB-GH');
  });

  it('canonical internal id is the primary occurrence id', () => {
    const gh = norm({
      jobId: 'JOB-GH', url: 'https://boards.greenhouse.io/gitlab/jobs/111111',
      rawData: { sourceJobId: 'REQ-8871', ats: 'greenhouse' },
    });
    const out = resolver.resolve([gh]);
    expect(canonicalInternalJobId(out.canonical[0])).toBe('JOB-GH');
  });

  it('does not merge jobs from different companies in a batch', () => {
    const a = norm({ jobId: 'JOB-X1', url: 'https://boards.greenhouse.io/gitlab/jobs/111111' });
    const b = norm({ jobId: 'JOB-X2', company: 'Acme Corp', url: 'https://boards.greenhouse.io/acme/jobs/222222' });
    const out = resolver.resolve([a, b]);
    expect(out.canonical.length).toBe(2);
    expect(out.duplicates.length).toBe(0);
  });

  it('is deterministic: same input, same canonical output', () => {
    const jobs = [
      norm({ jobId: 'JOB-D1', url: 'https://boards.greenhouse.io/gitlab/jobs/111111', rawData: { sourceJobId: 'REQ-8871', ats: 'greenhouse' } }),
      norm({ jobId: 'JOB-D2', source: 'lever', url: 'https://jobs.lever.co/gitlab/aaa-bbb', rawData: { sourceJobId: 'REQ-8871' } }),
    ];
    const r1 = resolver.resolve(jobs);
    const r2 = resolver.resolve(jobs);
    expect(r1.canonical.map(c => c.canonicalKey)).toEqual(r2.canonical.map(c => c.canonicalKey));
    expect(r1.duplicates.length).toBe(r2.duplicates.length);
  });
});
