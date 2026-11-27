/**
 * Job discovery types and interfaces.
 *
 * Phase 6: source identity is derived from the central catalog
 * (catalog.ts) so a new legitimate source is added in exactly ONE place.
 */

import type { JobId } from '../core/types.ts';
import type { SourceCategory, DiscoveryMethod } from './catalog.ts';
import { ALL_SOURCE_IDS } from './catalog.ts';

const KNOWN_SOURCE_IDS = new Set(ALL_SOURCE_IDS);

/**
 * A source id is valid iff the catalog knows it. The union below is the
 * compile-time view of SOURCE_CATALOG (asserted by `satisfies` in catalog).
 */
export type JobSource = string;

export type EmploymentType =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'internship'
  | 'freelance';

export type Seniority =
  | 'intern'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'lead'
  | 'principal'
  | 'staff'
  | 'director'
  | 'vp'
  | 'c-level';

export interface DiscoveredJob {
  jobId: JobId;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: string;
  url: string;
  source: JobSource;
  postedAt?: Date;
  description: string;
  salary?: string;
  employmentType?: EmploymentType;
  seniority?: Seniority;
  rawData?: Record<string, unknown>;
}

export interface DiscoveryAdapter {
  readonly source: JobSource;
  readonly name: string;

  discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]>;
  verifyJob(job: DiscoveredJob): Promise<VerificationResult>;
}

export interface DiscoveryCriteria {
  keywords?: string[];
  locations?: string[];
  remote?: boolean;
  seniority?: string[];
  maxResults?: number;
  postedWithinDays?: number;
  /** 6C: role families to search (expands to title synonyms server-side). */
  roleFamilies?: string[];
  /** 6D: explicit remote targeting — never assumed from a "Remote" label. */
  remoteIndia?: boolean;
  allowedCountries?: string[];
}

export interface VerificationResult {
  verified: boolean;
  confidence: number;
  details?: string;
  fullDescription?: string;
}

export interface DiscoveryConfig {
  adapters: Record<string, AdapterConfig>;
  concurrency: number;
  rateLimitMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  onlyMock?: boolean; // If true, only enable MockDiscoveryAdapter (for testing)
  mockJobs?: DiscoveredJob[]; // Explicit job fixtures for the mock adapter (benchmarks)
  // Phase 6A — registry-driven selection (all optional; catalog supplies defaults)
  onlySources?: string[];
  excludeSources?: string[];
  enableSources?: string[];
  maxJobsPerSource?: number;
  sourceConcurrency?: number;
  /** Company/board slugs for ATS API sources (6B), e.g. { greenhouse: ['gitlab'] }. */
  atsBoards?: Record<string, string[]>;
}

export interface AdapterConfig {
  enabled: boolean;
  priority: number;
  rateLimit?: number;
  customHeaders?: Record<string, string>;
}

/** All known source ids, derived from the catalog at runtime. */
export { ALL_SOURCE_IDS as DISCOVERY_SOURCES } from './catalog.ts';

export function isValidSource(source: string): boolean {
  return KNOWN_SOURCE_IDS.has(source);
}

// ---------------------------------------------------------------------------
// 6E — Normalized job model. Every adapter output passes through
// normalize.ts to produce this shape. Internal vs external IDs are distinct:
//   internalJobId  JOB-...            (job-agent identity)
//   sourceJobId    NK-123 / LI-987 / GH-abc  (portal/ATS identity)
// ---------------------------------------------------------------------------

export interface NormalizedJob {
  internalJobId: JobId;
  source: JobSource;
  sourceJobId: string;
  sourceUrl: string;
  canonicalJobUrl: string;
  applicationUrl: string;
  company: string;
  companyUrl?: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: string;
  /** 6D: remote labels never imply India eligibility. */
  allowedCountries?: string[];
  timezone?: string;
  employmentType?: EmploymentType;
  seniority?: Seniority;
  salary?: string;
  postedAt?: Date;
  updatedAt?: Date;
  description: string;
  ats?: string;
  discoveredAt: Date;
  /** Source-specific fields kept OUT of the normalized shape. */
  sourceMeta: Record<string, unknown>;
  /** 6H: true only after full-JD retrieval + verification succeeded. */
  jdComplete: boolean;
}

// ---------------------------------------------------------------------------
// 6G — Application route classification.
// ---------------------------------------------------------------------------

export type ApplicationRoute =
  | 'DIRECT_EMPLOYER'
  | 'ATS'
  | 'JOB_PORTAL'
  | 'REDIRECT'
  | 'LOGIN_REQUIRED'
  | 'HUMAN_REQUIRED'
  | 'UNKNOWN';

export interface ResolvedRoute {
  route: ApplicationRoute;
  /** Which ATS sits behind the URL, when detectable. */
  ats?: string;
  /** Where the application should actually be submitted. */
  applicationUrl: string;
  /** Where the canonical JD lives (may differ from applicationUrl). */
  canonicalSource: string;
  /** The source that surfaced the job during discovery. */
  discoveredFrom: JobSource;
  confidence: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// 6F — Canonical identity for cross-source dedup.
// ---------------------------------------------------------------------------

export type IdentitySignal =
  | 'requisition_id'
  | 'canonical_url'
  | 'source_job_id'
  | 'company'
  | 'title'
  | 'location'
  | 'jd_hash'
  | 'jd_similarity'
  | 'posted_date'
  | 'ats_metadata';

export interface IdentityMatch {
  signal: IdentitySignal;
  matched: boolean;
  weight: number;
  detail?: string;
}

export interface IdentityResolution {
  /** Stable key for the canonical opportunity (dedupe identity). */
  canonicalKey: string;
  confidence: number;
  matched: IdentityMatch[];
  /** True when this occurrence should merge into an existing canonical job. */
  duplicate: boolean;
  canonicalInternalJobId?: JobId;
}

// ---------------------------------------------------------------------------
// 6M/6N — per-source controls and health.
// ---------------------------------------------------------------------------

export type SourceHealthState = 'healthy' | 'degraded' | 'down' | 'cooldown' | 'login-paused';

export interface SourceHealthMetrics {
  source: string;
  searchesAttempted: number;
  searchesCompleted: number;
  jobsDiscovered: number;
  jobsNormalized: number;
  duplicates: number;
  uniqueJobs: number;
  jdRetrievalSuccess: number;
  jdRetrievalAttempts: number;
  routeResolutionSuccess: number;
  routeResolutionAttempts: number;
  navigationSuccess: number;
  navigationAttempts: number;
  applicationSuccess: number;
  applicationAttempts: number;
  failures: number;
  loginInterruptions: number;
  captchaInterruptions: number;
  timeouts: number;
  requestsAttempted: number;
  requestsRejected: number;
  latenciesMs: number[];
  state: SourceHealthState;
  lastError?: string;
  lastErrorAt?: Date;
}

export interface RateLimitPolicy {
  /** Minimum ms between two requests to this source. */
  rateLimitMs: number;
  /** Max consecutive failures before marking the source degraded. */
  failureThreshold: number;
  /** Cooldown ms applied when degraded. */
  cooldownMs: number;
  /** Retry attempts for retryable (transient) failures only. */
  retryAttempts: number;
  retryDelayMs: number;
  /** Cap of source-level concurrency (6I). */
  concurrency: number;
}

export type { SourceCategory, DiscoveryMethod };
