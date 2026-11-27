/**
 * Deterministic ID generation for jobs, applications, etc.
 */

import { randomUUID, createHash } from 'crypto';
import type { JobId, ApplicationId, CandidateId, CompanyId, SessionId } from './types.ts';

let sequence = 0;

/**
 * Generate the internal job id (6E: JOB-...).
 *
 * When `stableKey` is provided (listing URL / source job id), the id is
 * DETERMINISTIC — rediscovering the same listing maps to the same internal id,
 * so re-persists upsert instead of colliding on the jobs.url UNIQUE index.
 * Without it (legacy callers, fixtures) the historical timestamped form is kept.
 */
export function generateJobId(source: string, company: string, title: string, stableKey?: string): JobId {
  const normalized = `${source}:${company}:${title}`.toLowerCase().replace(/[^a-z0-9:]+/g, '-');
  if (stableKey) {
    const suffix = createHash('sha256').update(stableKey).digest('hex').slice(0, 10);
    return `JOB-${normalized}-${suffix}` as JobId;
  }
  return `JOB-${normalized}-${Date.now().toString(36)}-${(sequence++).toString(36)}` as JobId;
}

export function generateApplicationId(jobId: JobId): ApplicationId {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const num = String(++sequence).padStart(6, '0');
  return `APP-${date}-${num}` as ApplicationId;
}

export function generateCandidateId(): CandidateId {
  return `CAND-${randomUUID().slice(0, 8)}` as CandidateId;
}

export function generateCompanyId(name: string): CompanyId {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `COMP-${normalized}-${randomUUID().slice(0, 6)}` as CompanyId;
}

export function generateSessionId(): SessionId {
  return `SESS-${randomUUID()}` as SessionId;
}

export function generateEventId(): string {
  return `EVT-${randomUUID()}`;
}

export function generateReportId(): string {
  return `RPT-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}