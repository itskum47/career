/**
 * Phase 6U — Prioritization before application (6O).
 *
 * Quality over count: incomplete JDs, blocked companies, excluded locations,
 * and remote jobs without India eligibility evidence are ranked ineligible
 * (retained for tracking, never queued for submission).
 */
import { describe, it, expect } from 'vitest';
import { scoreJob, prioritize } from '../../../src/discovery/prioritize.ts';
import { normalize } from '../../../src/discovery/normalize.ts';
import { JobIdentityResolver } from '../../../src/discovery/identity.ts';
import type { PrioritizationContext } from '../../../src/discovery/prioritize.ts';
import type { DiscoveredJob } from '../../../src/core/types.ts';
import type { NormalizedJob } from '../../../src/discovery/types.ts';

const SKILLS = ['devops', 'kubernetes', 'aws', 'terraform', 'docker', 'ci/cd', 'linux', 'python'];

function norm(overrides: Partial<Omit<DiscoveredJob, 'jobId'>> & { jobId: string }): NormalizedJob {
  return normalize({
    company: 'GitLab',
    title: 'DevOps Engineer',
    location: 'Pune, India',
    remote: false,
    url: 'https://boards.greenhouse.io/gitlab/jobs/111111',
    source: 'greenhouse',
    description: `DevOps Engineer role covering ${SKILLS.join(', ')} and production operations. `
      + 'Own Kubernetes clusters, Terraform modules, CI/CD pipelines, monitoring and incident response. '
      + 'Requirements: 5 years experience, Linux administration, Docker, AWS cloud, Jenkins, '
      + 'strong communication and collaboration skills in an agile environment.',
    postedAt: new Date(),
    ...overrides,
  } as DiscoveredJob).normalized;
}

const BASE_CTX: PrioritizationContext = {
  candidateSkills: SKILLS,
  candidateExperienceYears: 6,
  preferredLocations: ['Pune', 'Bengaluru', 'Remote India'],
  freshnessHalfLifeDays: 14,
  matchScore: 85,
  jdComplete: true,
};

describe('6O — ranking signals and hard eligibility gates', () => {
  it('a strong, complete, eligible job scores positively and passes all gates', () => {
    const score = scoreJob(norm({ jobId: 'JOB-P1' }), BASE_CTX);
    expect(score.eligible).toBe(true);
    expect(score.ineligibleReasons).toEqual([]);
    expect(score.total).toBeGreaterThan(0.4);
    expect(score.total).toBeLessThanOrEqual(1);
    // Individual signals are all normalized 0..1.
    for (const [k, v] of Object.entries(score.breakdown)) {
      expect(v, k).toBeGreaterThanOrEqual(0);
      expect(v, k).toBeLessThanOrEqual(1);
    }
    // Title match dominates role relevance.
    expect(score.breakdown.roleRelevance).toBe(1);
    expect(score.breakdown.location).toBe(1);
  });

  it('incomplete JD is INELIGIBLE (6H gate: never tailor from snippets)', () => {
    const score = scoreJob(norm({ jobId: 'JOB-P2' }), { ...BASE_CTX, jdComplete: false });
    expect(score.eligible).toBe(false);
    expect(score.ineligibleReasons.some(r => r.includes('JD not complete'))).toBe(true);
  });

  it('blocked companies are INELIGIBLE', () => {
    const score = scoreJob(norm({ jobId: 'JOB-P3' }), { ...BASE_CTX, blockedCompanies: ['gitlab'] });
    expect(score.eligible).toBe(false);
    expect(score.ineligibleReasons).toContain('company blocked');
    expect(score.breakdown.companyPreference).toBe(0);
  });

  it('excluded locations are INELIGIBLE', () => {
    const score = scoreJob(
      norm({ jobId: 'JOB-P4', location: 'New York, NY', remote: false }),
      { ...BASE_CTX, excludeLocations: ['New York'] },
    );
    expect(score.eligible).toBe(false);
    expect(score.ineligibleReasons).toContain('location excluded');
    expect(score.breakdown.location).toBe(0);
  });

  it('remote explicitly restricted to non-India is INELIGIBLE (never assume)', () => {
    const score = scoreJob(
      norm({
        jobId: 'JOB-P5', location: 'Remote', remote: true,
        rawData: { allowedCountries: ['Germany'] },
      }),
      BASE_CTX,
    );
    expect(score.eligible).toBe(false);
    expect(score.ineligibleReasons).toContain('remote without India eligibility evidence');
    expect(score.breakdown.remoteEligibility).toBe(0.4);
  });

  it('remote with India evidence passes the remote gate', () => {
    const score = scoreJob(
      norm({
        jobId: 'JOB-P6', location: 'Remote - India', remote: true,
        rawData: { allowedCountries: ['India'] },
      }),
      BASE_CTX,
    );
    expect(score.ineligibleReasons).not.toContain('remote without India eligibility evidence');
    expect(score.breakdown.remoteEligibility).toBe(1);
  });

  it('a low match score gates the job out', () => {
    const score = scoreJob(norm({ jobId: 'JOB-P7' }), { ...BASE_CTX, matchScore: 42 });
    expect(score.eligible).toBe(false);
    expect(score.ineligibleReasons.some(r => r.includes('match score 42'))).toBe(true);
  });

  it('irrelevant roles gate out via role relevance', () => {
    const score = scoreJob(
      norm({ jobId: 'JOB-P8', title: 'Sales Development Representative', description: 'Cold calling and pipeline generation for enterprise accounts. ' + 'Prospecting, CRM hygiene, quota attainment and account research. '.repeat(6) }),
      BASE_CTX,
    );
    expect(score.eligible).toBe(false);
    expect(score.ineligibleReasons).toContain('role not relevant');
  });

  it('freshness decays: a month-old posting scores below today’s', () => {
    const fresh = scoreJob(norm({ jobId: 'JOB-P9', postedAt: new Date() }), BASE_CTX);
    const stale = scoreJob(norm({ jobId: 'JOB-P10', postedAt: new Date(Date.now() - 45 * 86_400_000) }), BASE_CTX);
    expect(fresh.breakdown.freshness).toBeGreaterThan(stale.breakdown.freshness);
  });
});

describe('6O — prioritize() ordering (eligible first, quality over count)', () => {
  const resolver = new JobIdentityResolver();

  it('sorts eligible jobs before ineligible ones', () => {
    const good = norm({ jobId: 'JOB-Q1', company: 'GitLab' });
    const blocked = norm({ jobId: 'JOB-Q2', company: 'Acme Corp', url: 'https://boards.greenhouse.io/acme/jobs/222222' });
    const canonical = resolver.resolve([good, blocked]).canonical;

    const ranked = prioritize(canonical, {
      ...BASE_CTX,
      blockedCompanies: ['acme'],
    });

    expect(ranked.length).toBe(2);
    expect(ranked[0].score.eligible).toBe(true);
    expect(ranked[1].score.eligible).toBe(false);
    // Ineligible jobs are RETAINED for tracking (never silently dropped).
    expect(ranked[1].job.internalJobId).toBe('JOB-Q2');
    expect(ranked[0].score.total).toBeGreaterThanOrEqual(ranked[1].score.total);
  });

  it('ranks by score among eligible jobs', () => {
    const roleMatch = norm({ jobId: 'JOB-Q3', title: 'DevOps Engineer' });
    const weakMatch = norm({
      jobId: 'JOB-Q4',
      title: 'Backend Engineer (some ops)',
      company: 'Zeta Corp',
      url: 'https://boards.greenhouse.io/zeta/jobs/333333',
      description: 'Spring boot microservices, REST APIs, postgres, kafka streaming and unit testing. '.repeat(6),
    });
    const canonical = resolver.resolve([roleMatch, weakMatch]).canonical;
    const ranked = prioritize(canonical, BASE_CTX);
    expect(ranked[0].job.internalJobId).toBe('JOB-Q3');
  });
});
