/**
 * Phase 6U — Source normalization tests (6E) + remote eligibility (6D).
 */
import { describe, it, expect } from 'vitest';
import {
  normalize,
  normalizeAll,
  canonicalizeUrl,
  applicationUrlFor,
  extractSourceJobId,
} from '../../../src/discovery/normalize.ts';
import type { DiscoveredJob } from '../../../src/core/types.ts';

function mkJob(overrides: Partial<Omit<DiscoveredJob, 'jobId'>> & { jobId: string }): DiscoveredJob {
  return {
    company: 'GitLab',
    title: 'DevOps Engineer',
    location: 'Pune, India',
    remote: false,
    url: 'https://example.com/jobs/1',
    source: 'greenhouse',
    description: 'x'.repeat(500),
    ...overrides,
  } as DiscoveredJob;
}

describe('6E — normalization to the central model', () => {
  it('keeps internal (JOB-...) and portal (SOURCE-...) ids distinct', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0001',
      url: 'https://boards.greenhouse.io/gitlab/jobs/12345678',
    }));
    expect(normalized.internalJobId).toBe('JOB-0001');
    expect(normalized.sourceJobId).toBe('GREENHOUSE-12345678');
    expect(normalized.internalJobId).not.toBe(normalized.sourceJobId);
    expect(normalized.source).toBe('greenhouse');
  });

  it('prefers the adapter-supplied source job id (portal identity, e.g. NK-12345)', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0002',
      source: 'naukri',
      url: 'https://www.naukri.com/devops-jobs',
      rawData: { sourceJobId: 'NK-12345' },
    }));
    expect(normalized.sourceJobId).toBe('NK-12345');
    expect(normalized.internalJobId).toBe('JOB-0002');
  });

  it('extractSourceJobId falls back to source-unknown (never a bare number)', () => {
    const id = extractSourceJobId(mkJob({
      jobId: 'JOB-0003',
      source: 'naukri',
      url: 'https://www.naukri.com/devops-jobs',
    }));
    expect(id).toBe('NAUKRI-unknown');
  });

  it('canonical URL strips tracking params, fragment, and lowercases host', () => {
    expect(canonicalizeUrl('https://WWW.Example.COM/Jobs/12?utm_source=x&ref=y&keep=1#frag'))
      .toBe('https://www.example.com/Jobs/12?keep=1');
  });

  it('application URL drops list/search params but keeps the job identity', () => {
    expect(applicationUrlFor('https://www.naukri.com/jobs-in-india?q=devops&page=2'))
      .toBe('https://www.naukri.com/jobs-in-india');
  });

  it('collects warnings for unknown source / invalid url / missing fields', () => {
    const { warnings } = normalize(mkJob({
      jobId: 'JOB-0004',
      source: 'bogus-portal',
      url: 'not-a-url',
      title: '',
      company: '',
    }));
    expect(warnings.some(w => w.includes('unknown source id'))).toBe(true);
    expect(warnings.some(w => w.includes('source not in catalog'))).toBe(true);
    expect(warnings.some(w => w.includes('invalid url'))).toBe(true);
    expect(warnings.some(w => w.includes('missing title'))).toBe(true);
    expect(warnings.some(w => w.includes('missing company'))).toBe(true);
  });

  it('flags snippet descriptions: full JD retrieval required before apply (6H)', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0005',
      description: 'We are hiring a DevOps engineer.',
    }));
    expect(normalized.jdComplete).toBe(false);
    expect(warnings.some(w => w.includes('full JD retrieval required'))).toBe(true);
  });

  it('quarantines source-specific fields in sourceMeta (never leaks into model)', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0006',
      rawData: { sourceJobId: 'GH-abc123', allowedCountries: ['Germany'], gh_board: 'gitlab', ats: 'greenhouse' },
    }));
    expect(normalized.allowedCountries).toEqual(['Germany']); // raw value wins
    expect(normalized.ats).toBe('greenhouse');
    expect('sourceJobId' in normalized.sourceMeta).toBe(false);
    expect('allowedCountries' in normalized.sourceMeta).toBe(false);
    expect((normalized.sourceMeta as any).gh_board).toBe('gitlab');
  });

  it('normalizeAll never throws and reports per-job warnings', () => {
    const out = normalizeAll([
      mkJob({ jobId: 'JOB-0007' }),
      mkJob({ jobId: 'JOB-0008', source: 'nope-source' }),
    ]);
    expect(out.normalized.length).toBe(2);
    expect(out.results.length).toBe(2);
    const warnings = out.results.flatMap(r => r.warnings);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('6D — remote eligibility is explicit, never assumed (India)', () => {
  it('remote without country evidence gets a warning and NO India assumption', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0010',
      location: 'Anywhere',
      remote: true,
      url: 'https://remoteok.com/l/11111',
      source: 'remoteok',
    }));
    expect(normalized.remote).toBe(true);
    expect(normalized.allowedCountries).toBeUndefined();
    expect(warnings.some(w => w.includes('India eligibility NOT assumed'))).toBe(true);
  });

  it('remote explicitly scoped to India sets allowedCountries=[India]', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0011',
      location: 'Remote - India',
      remote: true,
      url: 'https://remoteok.com/l/22222',
      source: 'remoteok',
    }));
    expect(normalized.allowedCountries).toEqual(['India']);
    expect(warnings.some(w => w.includes('India eligibility NOT assumed'))).toBe(false);
  });

  it('remote scoped to another country keeps that country (not India)', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0012',
      location: 'Remote - United States',
      remote: true,
      url: 'https://remoteok.com/l/33333',
      source: 'remoteok',
      rawData: { allowedCountries: ['United States'] },
    }));
    expect(normalized.allowedCountries).toEqual(['United States']);
    expect(normalized.allowedCountries).not.toContain('India');
  });

  it('location enumerating non-India countries is explicit evidence AGAINST India (6D gate)', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0015',
      location: 'Remote, Canada; Remote, United Kingdom; Remote, United States',
      remote: true,
      url: 'https://job-boards.greenhouse.io/gitlab/jobs/111',
      source: 'greenhouse',
    }));
    expect(normalized.allowedCountries).toEqual(['United States', 'United Kingdom', 'Canada']);
    expect(normalized.allowedCountries).not.toContain('India');
    expect(warnings.some(w => w.includes('enumerates countries without India'))).toBe(true);
  });

  it('location with an India entry among other countries stays India-eligible', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0016',
      location: 'Bangalore, India; Remote, Australia; Remote, Canada',
      remote: true,
      url: 'https://job-boards.greenhouse.io/gitlab/jobs/222',
      source: 'greenhouse',
    }));
    expect(normalized.allowedCountries).toEqual(['India']);
  });

  it('neutral remote wording with no country claim stays undefined (never assumed)', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0017',
      location: 'Remote',
      remote: true,
      url: 'https://weworkremotely.com/remote-jobs/333',
      source: 'weworkremotely',
    }));
    expect(normalized.allowedCountries).toBeUndefined();
    expect(warnings.some(w => w.includes('India eligibility NOT assumed'))).toBe(true);
  });

  it('a US HQ city in a remote location is explicit non-India evidence (6D)', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0019',
      location: 'New York, NY (HQ)',
      remote: true,
      url: 'https://jobs.ashbyhq.com/ramp/abc123',
      source: 'ashby',
    }));
    expect(normalized.allowedCountries).toEqual(['United States']);
    expect(warnings.some(w => w.includes('enumerates countries without India'))).toBe(true);
  });

  it('an India-only city the legacy word list missed stays India-eligible', () => {
    const { normalized, warnings } = normalize(mkJob({
      jobId: 'JOB-0020',
      location: 'Coimbatore',
      remote: true,
      url: 'https://example.com/j/20',
      source: 'greenhouse',
    }));
    expect(normalized.allowedCountries).toEqual(['India']);
    expect(warnings.some(w => w.includes('enumerates countries without India'))).toBe(false);
  });

  it('application target discovered by the adapter wins over the listing URL (6G)', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0018',
      location: 'Remote',
      remote: true,
      url: 'https://weworkremotely.com/remote-jobs/444',
      source: 'weworkremotely',
      rawData: { applicationUrl: 'https://boards.greenhouse.io/acme/jobs/998877' },
    }));
    expect(normalized.applicationUrl).toContain('greenhouse.io');
    expect(normalized.sourceUrl).toBe('https://weworkremotely.com/remote-jobs/444');
    expect(normalized.canonicalJobUrl).toContain('weworkremotely.com');
  });

  it('derives remote + policy from location words when not stated', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0013', location: 'Work from home, India', remote: undefined,
      url: 'https://example.com/j/13',
    }));
    expect(normalized.remote).toBe(true);
    expect(normalized.remotePolicy).toBe('fully-remote');
    expect(normalized.allowedCountries).toEqual(['India']);
  });

  it('hybrid wording maps to hybrid policy', () => {
    const { normalized } = normalize(mkJob({
      jobId: 'JOB-0014', location: 'Hybrid, Pune', remote: false,
      url: 'https://example.com/j/14',
    }));
    expect(normalized.remotePolicy).toBe('hybrid');
    expect(normalized.remote).toBe(false);
  });
});
