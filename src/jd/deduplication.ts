/**
 * Job Deduplication - identifies duplicate job postings across sources.
 */

import type { DiscoveredJob as DiscoveryDiscoveredJob } from '../discovery/types.ts';
import type { DeduplicationResult } from './types.ts';
import { logger } from '../core/logger.ts';

type DiscoveredJob = DiscoveryDiscoveredJob & { jobId: string };

interface JobSignature {
  normalizedTitle: string;
  normalizedCompany: string;
  locationKey: string;
  urlDomain: string;
}

export class JobDeduplicator {
  private seenSignatures: Map<string, DiscoveredJob> = new Map();

  deduplicate(jobs: DiscoveredJob[]): { unique: DiscoveredJob[]; duplicates: Array<{ original: DiscoveredJob; duplicate: DiscoveredJob; result: DeduplicationResult }> } {
    const unique: DiscoveredJob[] = [];
    const duplicates: Array<{ original: DiscoveredJob; duplicate: DiscoveredJob; result: DeduplicationResult }> = [];

    for (const job of jobs) {
      const signature = this.createSignature(job);
      const existing = this.seenSignatures.get(signature);

      if (existing) {
        const result = this.compareJobs(existing, job);
        duplicates.push({ original: existing, duplicate: job, result });
        logger.debug('Duplicate job found', { 
          originalId: existing.jobId, 
          duplicateId: job.jobId,
          similarity: result.similarity,
        });
      } else {
        this.seenSignatures.set(signature, job);
        unique.push(job);
      }
    }

    logger.info('Deduplication completed', { 
      total: jobs.length, 
      unique: unique.length, 
      duplicates: duplicates.length 
    });

    return { unique, duplicates };
  }

  private createSignature(job: DiscoveredJob): string {
    return [
      this.normalizeTitle(job.title),
      this.normalizeCompany(job.company),
      this.normalizeLocation(job.location),
      this.extractDomain(job.url),
    ].join('|');
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\b(senior|junior|lead|principal|staff|sr|jr)\b/g, '')
      .replace(/\b(engineer|developer|architect|specialist|analyst|manager)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeCompany(company: string): string {
    return company
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\b(inc|corp|corporation|llc|ltd|limited|company|co)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeLocation(location: string): string {
    return location
      .toLowerCase()
      .replace(/[^\w\s,]/g, '')
      .replace(/\b(remote|hybrid|onsite|on-site)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(',')[0]; // Just use city/region
  }

  private extractDomain(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname.replace('www.', '');
    } catch {
      return url;
    }
  }

  private compareJobs(job1: DiscoveredJob, job2: DiscoveredJob): DeduplicationResult {
    let similarity = 0;
    const reasons: string[] = [];

    // Title similarity (40%)
    const titleSim = this.stringSimilarity(
      this.normalizeTitle(job1.title),
      this.normalizeTitle(job2.title)
    );
    similarity += titleSim * 0.4;
    if (titleSim > 0.8) reasons.push('Very similar titles');

    // Company similarity (30%)
    const companySim = this.stringSimilarity(
      this.normalizeCompany(job1.company),
      this.normalizeCompany(job2.company)
    );
    similarity += companySim * 0.3;
    if (companySim > 0.8) reasons.push('Same company');

    // Location similarity (20%)
    const locationSim = this.stringSimilarity(
      this.normalizeLocation(job1.location),
      this.normalizeLocation(job2.location)
    );
    similarity += locationSim * 0.2;
    if (locationSim > 0.8) reasons.push('Same location');

    // URL domain (10%)
    const domainSim = this.extractDomain(job1.url) === this.extractDomain(job2.url) ? 1 : 0;
    similarity += domainSim * 0.1;
    if (domainSim) reasons.push('Same domain');

    // Check for exact URL match
    if (job1.url === job2.url) {
      similarity = 1;
      reasons.push('Identical URLs');
    }

    const isDuplicate = similarity >= 0.75;

    return {
      isDuplicate,
      existingJobId: isDuplicate ? job1.jobId : undefined,
      similarity,
      reason: reasons.join('; ') || 'Below similarity threshold',
    };
  }

  private stringSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshteinDistance(s1: string, s2: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[s2.length][s1.length];
  }

  clear(): void {
    this.seenSignatures.clear();
  }
}
