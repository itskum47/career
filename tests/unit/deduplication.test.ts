/**
 * Unit tests for job deduplication.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JobDeduplicator } from '@job-agent/jd/deduplication.js';
import type { DiscoveredJob } from '@job-agent/discovery/types.js';

function createJob(overrides: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    jobId: 'JOB-test' as any,
    company: 'Test Company',
    title: 'DevOps Engineer',
    location: 'San Francisco, CA',
    remote: true,
    url: 'https://example.com/job/1',
    source: 'linkedin' as any,
    description: 'Test job description',
    ...overrides,
  };
}

describe('JobDeduplicator', () => {
  let deduplicator: JobDeduplicator;

  beforeEach(() => {
    deduplicator = new JobDeduplicator();
  });

  it('should identify exact duplicates', () => {
    const jobs = [
      createJob({ url: 'https://example.com/job/1' }),
      createJob({ url: 'https://example.com/job/1' }),
    ];

    const result = deduplicator.deduplicate(jobs);

    expect(result.unique.length).toBe(1);
    expect(result.duplicates.length).toBe(1);
    expect(result.duplicates[0].result.isDuplicate).toBe(true);
    expect(result.duplicates[0].result.similarity).toBe(1);
  });

  it('should identify near-duplicates by title and company', () => {
    const jobs = [
      createJob({ title: 'Senior DevOps Engineer', url: 'https://company.com/job/1' }),
      createJob({ title: 'DevOps Engineer', url: 'https://company.com/job/2' }),
    ];

    const result = deduplicator.deduplicate(jobs);

    expect(result.unique.length).toBe(1);
    expect(result.duplicates.length).toBe(1);
  });

  it('should not flag different companies as duplicates', () => {
    const jobs = [
      createJob({ company: 'Company A', url: 'https://a.com/job/1', title: 'DevOps Engineer' }),
      createJob({ company: 'Company B', url: 'https://b.com/job/1', title: 'DevOps Engineer' }),
    ];

    const result = deduplicator.deduplicate(jobs);

    expect(result.unique.length).toBe(2);
    expect(result.duplicates.length).toBe(0);
  });

  it('should not flag different titles as duplicates', () => {
    const jobs = [
      createJob({ title: 'DevOps Engineer', url: 'https://a.com/job/1' }),
      createJob({ title: 'Software Engineer', url: 'https://a.com/job/2' }),
    ];

    const result = deduplicator.deduplicate(jobs);

    expect(result.unique.length).toBe(2);
    expect(result.duplicates.length).toBe(0);
  });

  it('should handle empty job list', () => {
    const result = deduplicator.deduplicate([]);

    expect(result.unique.length).toBe(0);
    expect(result.duplicates.length).toBe(0);
  });

  it('should clear internal state', () => {
    const jobs = [
      createJob({ url: 'https://example.com/job/1' }),
    ];

    deduplicator.deduplicate(jobs);
    expect(deduplicator['seenSignatures'].size).toBe(1);

    deduplicator.clear();
    expect(deduplicator['seenSignatures'].size).toBe(0);
  });

  it('should calculate similarity correctly', () => {
    const jobs = [
      createJob({
        title: 'Senior DevOps Engineer',
        company: 'Acme Corp',
        location: 'New York, NY',
        url: 'https://acme.com/jobs/1',
      }),
      createJob({
        title: 'Sr. DevOps Engineer',
        company: 'Acme Corp',
        location: 'New York, NY',
        url: 'https://acme.com/jobs/2',
      }),
    ];

    const result = deduplicator.deduplicate(jobs);
    // Should be similar but not exact duplicate due to slightly different title
    expect(result.duplicates.length).toBe(1);
    expect(result.duplicates[0].result.similarity).toBeGreaterThan(0.5);
  });

  it('should handle jobs with different URLs on same domain', () => {
    const jobs = [
      createJob({ url: 'https://company.com/job/123' }),
      createJob({ url: 'https://company.com/job/456' }),
    ];

    const result = deduplicator.deduplicate(jobs);

    // Same company and title should be flagged as near-duplicates
    expect(result.duplicates.length).toBe(1);
  });
});