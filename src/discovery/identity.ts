/**
 * Phase 6F — JobIdentityResolver.
 *
 * Turns cross-source occurrences of the SAME opportunity into ONE canonical
 * identity. Signals (in strength order):
 *   1. exact requisition ID (e.g. Greenhouse job id appearing in another URL)
 *   2. canonical application URL equality
 *   3. source job id equality (same source re-discovery)
 *   4. normalized company
 *   5. normalized title
 *   6. normalized location
 *   7. JD content hash
 *   8. JD similarity (token Jaccard)
 *   9. posting date proximity
 *  10. ATS metadata (same ats + same requisition)
 *
 * Every source occurrence is preserved as metadata on the canonical job.
 * Dedupe confidence >= MERGE_THRESHOLD => duplicate (merge);
 * between AMBIGUOUS_THRESHOLD and MERGE_THRESHOLD => flagged for review,
 * kept separate (conservative: never silently merge near-matches).
 */

import { createHash } from 'crypto';
import type { NormalizedJob, IdentityMatch, IdentityResolution, IdentitySignal } from './types.ts';
import type { JobId } from '../core/types.ts';

export const MERGE_THRESHOLD = 0.75;
/**
 * Score a candidate pair. Both jobs must already be normalized (6E).
 *
 * Threshold calibration: confidence = matchedWeight / totalWeight where the
 * authored weights sum to 1.30. A strong-but-unproven cross-source match
 * (same company + title + location + byte-identical JD + same posting day,
 * but no shared requisition id or canonical URL) scores ~0.44 — so AMBIGUOUS
 * is 0.40: near-matches get FLAGGED for review while still never merging.
 * Merges remain exclusive to hard evidence (shared requisition id -> 0.95,
 * equal canonical URL -> 0.92) or >= MERGE_THRESHOLD of matched weight.
 */
export const AMBIGUOUS_THRESHOLD = 0.40;

/** Signal weights (sum = 1.0 for the matched subset scale). */
const WEIGHTS: Record<IdentitySignal, number> = {
  requisition_id: 0.30,
  canonical_url: 0.25,
  source_job_id: 0.10,
  company: 0.10,
  title: 0.10,
  location: 0.04,
  jd_hash: 0.18,
  jd_similarity: 0.12,
  posted_date: 0.03,
  ats_metadata: 0.08,
};

export function normalizeCompany(name: string): string {
  return name.toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|private|pvt|corp|corporation|co|gmbh|srl|technologies|tech|solutions|systems|labs|group)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/\b(sr|sr\.|jr|jr\.|senior|junior|lead|principal|staff|ii|iii|iv)\b/g, '')
    .replace(/\b(full time|full-time|ft)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLocation(loc: string): string {
  return loc.toLowerCase()
    .replace(/\bbangalore\b/g, 'bengaluru')
    .replace(/\bgurugram\b/g, 'gurgaon')
    .replace(/\bbombay\b/g, 'mumbai')
    .replace(/\bcalcutta\b/g, 'kolkata')
    .replace(/\bmadras\b/g, 'chennai')
    .replace(/\bcochin\b/g, 'kochi')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function jdHash(description: string): string {
  const normalized = description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Requisition ids visible on a job (ATS metadata, path segments). */
export function requisitionIds(job: NormalizedJob): string[] {
  const ids = new Set<string>();
  // The normalized sourceJobId is the primary carrier of a requisition id
  // (6E: adapters pass rawData.sourceJobId through normalize verbatim).
  // normalize() strips sourceJobId from sourceMeta, so read BOTH here —
  // otherwise this signal (weight 0.30) could never fire (6F).
  const carriers = [job.sourceJobId, job.sourceMeta.sourceJobId];
  for (const rawId of carriers) {
    if (typeof rawId === 'string' && rawId.length > 0 && !rawId.endsWith('-unknown') && !rawId.endsWith(':unknown')) {
      ids.add(rawId);
    }
  }
  try {
    const u = new URL(job.sourceUrl);
    for (const key of ['jobId', 'jk', 'id', 'requisition', 'req', 'gh_jid', 'posting']) {
      const v = u.searchParams.get(key);
      if (v && /\d/.test(v)) ids.add(v);
    }
    // Numeric path segment (Shine/Apna/FW style /jobs/x/y/19715097)
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (last && /^\d{5,}$/.test(last)) ids.add(last);
  } catch { /* ignore */ }
  return [...ids];
}

function daysApart(a?: Date, b?: Date): number | null {
  if (!a || !b) return null;
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

export interface IdentityPairResult extends IdentityResolution {
  /** True when the pair should be merged into one canonical opportunity. */
  shouldMerge: boolean;
  /** True when evidence exists but is below merge threshold (keep separate). */
  ambiguous: boolean;
}

/**
 * Score a candidate pair. Both jobs must already be normalized (6E).
 */
export function comparePair(a: NormalizedJob, b: NormalizedJob): IdentityPairResult {
  const matched: IdentityMatch[] = [];

  const aReq = new Set(requisitionIds(a));
  const bReq = new Set(requisitionIds(b));
  const reqShared = [...aReq].filter(x => bReq.has(x));
  matched.push({
    signal: 'requisition_id',
    matched: reqShared.length > 0,
    weight: WEIGHTS.requisition_id,
    detail: reqShared.length ? `shared: ${reqShared.join(',')}` : 'no shared requisition id',
  });

  const urlEqual = a.canonicalJobUrl === b.canonicalJobUrl;
  matched.push({ signal: 'canonical_url', matched: urlEqual, weight: WEIGHTS.canonical_url, detail: urlEqual ? 'canonical URLs equal' : 'differ' });

  const sameSource = a.source === b.source;
  const sidEqual = sameSource && a.sourceJobId === b.sourceJobId && !a.sourceJobId.endsWith('-unknown');
  matched.push({ signal: 'source_job_id', matched: sidEqual, weight: WEIGHTS.source_job_id, detail: sidEqual ? a.sourceJobId : (sameSource ? 'same source, different ids' : 'different sources') });

  const companyEqual = normalizeCompany(a.company) === normalizeCompany(b.company) && normalizeCompany(a.company).length > 1;
  matched.push({ signal: 'company', matched: companyEqual, weight: WEIGHTS.company, detail: companyEqual ? normalizeCompany(a.company) : `${a.company} != ${b.company}` });

  const aTitle = normalizeTitle(a.title);
  const bTitle = normalizeTitle(b.title);
  const titleEqual = aTitle === bTitle && aTitle.length > 3;
  const titleSim = jaccard(tokenSet(a.title), tokenSet(b.title));
  matched.push({ signal: 'title', matched: titleEqual, weight: WEIGHTS.title, detail: titleEqual ? aTitle : `sim=${titleSim.toFixed(2)}` });

  const locEqual = normalizeLocation(a.location) === normalizeLocation(b.location) && normalizeLocation(a.location).length > 2;
  matched.push({ signal: 'location', matched: locEqual, weight: WEIGHTS.location, detail: locEqual ? normalizeLocation(a.location) : `${a.location} != ${b.location}` });

  const aHash = jdHash(a.description);
  const bHash = jdHash(b.description);
  const hashEqual = a.description.length > 200 && aHash === bHash;
  matched.push({ signal: 'jd_hash', matched: hashEqual, weight: WEIGHTS.jd_hash, detail: hashEqual ? aHash.slice(0, 12) : 'differ' });

  const sim = jaccard(tokenSet(a.description), tokenSet(b.description));
  const simStrong = sim >= 0.6;
  matched.push({ signal: 'jd_similarity', matched: simStrong, weight: WEIGHTS.jd_similarity, detail: `jaccard=${sim.toFixed(3)}` });

  const days = daysApart(a.postedAt, b.postedAt);
  const dateClose = days !== null && days <= 7;
  matched.push({ signal: 'posted_date', matched: dateClose, weight: WEIGHTS.posted_date, detail: days === null ? 'unknown' : `${days.toFixed(1)}d apart` });

  const atsA = a.ats ?? (a.sourceMeta.ats as string | undefined);
  const atsB = b.ats ?? (b.sourceMeta.ats as string | undefined);
  const atsEqual = !!atsA && atsA === atsB && reqShared.length > 0;
  matched.push({ signal: 'ats_metadata', matched: atsEqual, weight: WEIGHTS.ats_metadata, detail: atsEqual ? String(atsA) : 'differ/absent' });

  // Confidence = fraction of total weight that matched.
  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const matchedWeight = matched.filter(m => m.matched).reduce((s, m) => s + m.weight, 0);
  let confidence = matchedWeight / totalWeight;

  // Hard rules (override weak weighted evidence):
  //  - identical canonical URL of the SAME source+id => always merge
  //  - different companies => NEVER merge even if titles collide
  if (!companyEqual) confidence = Math.min(confidence, AMBIGUOUS_THRESHOLD - 0.01);
  if (reqShared.length > 0 && companyEqual) confidence = Math.max(confidence, 0.95);
  if (urlEqual && companyEqual) confidence = Math.max(confidence, 0.92);

  const shouldMerge = confidence >= MERGE_THRESHOLD;
  const ambiguous = !shouldMerge && confidence >= AMBIGUOUS_THRESHOLD;

  return {
    canonicalKey: canonicalKeyFor(a),
    confidence,
    matched,
    duplicate: shouldMerge,
    shouldMerge,
    ambiguous,
  };
}

/** Stable identity key for a job (used to bucket before pairwise compare). */
export function canonicalKeyFor(job: NormalizedJob): string {
  const req = requisitionIds(job)[0];
  if (req && job.ats) return `ats:${job.ats}:${req}`;
  if (job.ats) {
    const m = job.canonicalJobUrl.match(/\/(\d{5,})(?:\?|$)/);
    if (m) return `ats:${job.ats}:${m[1]}`;
  }
  const company = normalizeCompany(job.company);
  const title = normalizeTitle(job.title);
  const loc = normalizeLocation(job.location);
  return `sig:${company}|${title}|${loc}`;
}

export interface CanonicalJob {
  canonicalKey: string;
  /** The representative occurrence (highest JD quality). */
  primary: NormalizedJob;
  /** Every source occurrence, preserved as metadata (6F). */
  occurrences: NormalizedJob[];
  /** Best dedupe confidence achieved against the primary. */
  dedupeConfidence: number;
  /** Sources this canonical job appeared on. */
  sources: string[];
}

/**
 * Resolve a batch of normalized jobs into canonical opportunities.
 * Deterministic: processes in input order; O(n^2) pairwise within buckets,
 * with a company-partition prefilter to bound cost.
 */
export class JobIdentityResolver {
  resolve(jobs: NormalizedJob[]): {
    canonical: CanonicalJob[];
    duplicates: Array<{ occurrence: NormalizedJob; into: CanonicalJob; confidence: number; ambiguous: boolean }>;
    ambiguousPairs: Array<{ a: NormalizedJob; b: NormalizedJob; confidence: number }>;
  } {
    const canonical: CanonicalJob[] = [];
    const duplicates: Array<{ occurrence: NormalizedJob; into: CanonicalJob; confidence: number; ambiguous: boolean }> = [];
    const ambiguousPairs: Array<{ a: NormalizedJob; b: NormalizedJob; confidence: number }> = [];

    // Prefilter by normalized company to avoid O(n^2) across unrelated firms.
    const byCompany = new Map<string, CanonicalJob[]>();
    const noCompany: CanonicalJob[] = [];

    for (const job of jobs) {
      const company = normalizeCompany(job.company);
      let candidates: CanonicalJob[] = company.length > 1 ? (byCompany.get(company) ?? []) : noCompany;

      let best: { job: CanonicalJob; result: IdentityPairResult } | null = null;
      for (const c of candidates) {
        const result = comparePair(c.primary, job);
        if (!best || result.confidence > best.result.confidence) best = { job: c, result };
      }

      if (best && best.result.shouldMerge) {
        best.job.occurrences.push(job);
        best.job.dedupeConfidence = Math.max(best.job.dedupeConfidence, best.result.confidence);
        if (!best.job.sources.includes(job.source)) best.job.sources.push(job.source);
        duplicates.push({ occurrence: job, into: best.job, confidence: best.result.confidence, ambiguous: false });
        continue;
      }

      if (best && best.result.ambiguous) {
        ambiguousPairs.push({ a: best.job.primary, b: job, confidence: best.result.confidence });
        // Conservative: keep separate (do NOT silently merge near-matches).
      }

      const entry: CanonicalJob = {
        canonicalKey: canonicalKeyFor(job),
        primary: job,
        occurrences: [job],
        dedupeConfidence: 1,
        sources: [job.source],
      };
      if (company.length > 1) {
        const list = byCompany.get(company) ?? [];
        list.push(entry);
        byCompany.set(company, list);
      } else {
        noCompany.push(entry);
      }
      canonical.push(entry);
    }

    return { canonical, duplicates, ambiguousPairs };
  }
}

/** The internal JobId the canonical job will use downstream. */
export function canonicalInternalJobId(c: CanonicalJob): JobId {
  return c.primary.internalJobId;
}
