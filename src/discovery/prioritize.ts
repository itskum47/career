/**
 * Phase 6O — Job prioritization.
 *
 * Ranks canonical opportunities BEFORE any application is attempted.
 * Optimizes for application quality, NOT application count.
 *
 * Signals: role relevance, skill match, experience match, seniority,
 * location, remote eligibility, freshness, company preference, source
 * confidence, JD quality, application-route confidence, dedupe confidence.
 * (Skill/experience match inputs come from the existing MatchAnalysis when
 * available; ranking still works pre-match using title/role evidence.)
 */

import type { NormalizedJob, ResolvedRoute } from './types.ts';
import type { CanonicalJob } from './identity.ts';
import { normalizeTitle, tokenSet, jaccard } from './identity.ts';
import { ROLE_FAMILIES } from './catalog.ts';

export interface PrioritizationContext {
  /** Role families from the search profile (6C). */
  roleFamilies?: string[];
  /** Skills the candidate holds (from master profile), lowercase. */
  candidateSkills?: string[];
  /** Years of experience the candidate has. */
  candidateExperienceYears?: number;
  /** Preferred/allowed locations (6D labels). */
  preferredLocations?: string[];
  /** Locations the candidate will not consider. */
  excludeLocations?: string[];
  /** Companies of special interest (lowercase). */
  preferredCompanies?: string[];
  /** Explicitly unwanted companies. */
  blockedCompanies?: string[];
  /** Days beyond which freshness score decays to 0. */
  freshnessHalfLifeDays?: number;
  /** Existing MatchAnalysis overall score (0-100) when already matched. */
  matchScore?: number;
  /** JD completeness (6H) — required for a job to be ranked as ready. */
  jdComplete?: boolean;
}

export interface PriorityBreakdown {
  roleRelevance: number;   // 0..1
  skillMatch: number;      // 0..1
  experienceMatch: number; // 0..1
  seniority: number;       // 0..1
  location: number;        // 0..1
  remoteEligibility: number; // 0..1
  freshness: number;       // 0..1
  companyPreference: number; // 0..1
  sourceConfidence: number;  // 0..1
  jdQuality: number;       // 0..1
  routeConfidence: number; // 0..1
  dedupeConfidence: number; // 0..1
}

export interface PriorityScore {
  /** Weighted total 0..1. */
  total: number;
  breakdown: PriorityBreakdown;
  /** Hard gate: false => must NOT be applied to (rank is informational). */
  eligible: boolean;
  ineligibleReasons: string[];
}

const WEIGHTS: Record<keyof PriorityBreakdown, number> = {
  roleRelevance: 0.20,
  skillMatch: 0.16,
  experienceMatch: 0.10,
  seniority: 0.07,
  location: 0.08,
  remoteEligibility: 0.06,
  freshness: 0.07,
  companyPreference: 0.05,
  sourceConfidence: 0.05,
  jdQuality: 0.07,
  routeConfidence: 0.06,
  dedupeConfidence: 0.03,
};

/** Seniority proximity to the candidate's target band. */
function seniorityScore(job: NormalizedJob, ctx: PrioritizationContext): number {
  const s = job.seniority;
  if (!s) return 0.5;
  const exp = ctx.candidateExperienceYears ?? 6;
  // Target band by experience: <3 junior/mid, 3-8 mid/senior, >8 senior/lead.
  const target: string[] = exp < 3 ? ['intern', 'junior', 'mid']
    : exp <= 8 ? ['mid', 'senior']
    : ['senior', 'lead', 'principal', 'staff'];
  if (target.includes(s)) return 1;
  const ladder = ['intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'staff', 'director', 'vp', 'c-level'];
  const ji = ladder.indexOf(s);
  const ti = ladder.indexOf(target[target.length - 1]);
  if (ji < 0 || ti < 0) return 0.5;
  const dist = Math.abs(ji - ti);
  return Math.max(0, 1 - dist * 0.25);
}

function roleRelevance(job: NormalizedJob, ctx: PrioritizationContext): number {
  const families = ctx.roleFamilies?.length ? ctx.roleFamilies : ROLE_FAMILIES.map(f => f.family);
  const title = normalizeTitle(job.title);
  const titleTokens = tokenSet(title);
  let best = 0;
  for (const famName of families) {
    const fam = ROLE_FAMILIES.find(f => f.family === famName);
    const synonyms = fam ? fam.synonyms : [famName.toLowerCase()];
    for (const syn of synonyms) {
      const synNorm = normalizeTitle(syn);
      if (!synNorm) continue;
      // Exact/substring containment is strong evidence.
      if (title === synNorm || title.includes(synNorm) || synNorm.includes(title)) {
        best = Math.max(best, 1);
        continue;
      }
      const sim = jaccard(titleTokens, tokenSet(syn));
      best = Math.max(best, sim);
    }
  }
  return Math.min(1, best);
}

function skillMatch(job: NormalizedJob, ctx: PrioritizationContext): number {
  if (!ctx.candidateSkills?.length) return 0.5; // neutral when unknown
  const hay = `${job.title} ${job.description}`.toLowerCase();
  let hits = 0;
  for (const skill of ctx.candidateSkills) {
    if (hay.includes(skill.toLowerCase())) hits++;
  }
  return Math.min(1, hits / Math.max(6, ctx.candidateSkills.length * 0.5));
}

function experienceMatch(job: NormalizedJob, ctx: PrioritizationContext): number {
  const exp = ctx.candidateExperienceYears;
  if (exp === undefined) return 0.5;
  const text = `${job.description} ${job.title}`.toLowerCase();
  const matches = [...text.matchAll(/(\d+)\s*\+?\s*(?:-\s*(\d+)\s*)?years?/g)];
  if (!matches.length) return 0.6; // unknown requirement, mild optimism
  for (const m of matches) {
    const min = parseInt(m[1], 10);
    const max = m[2] ? parseInt(m[2], 10) : min + 4;
    if (exp >= min && exp <= max + 2) return 1;
    if (exp >= min - 1 && exp < min) return 0.7;
    if (exp > max + 2) return 0.6; // overqualified is still eligible
  }
  return 0.5;
}

function locationScore(job: NormalizedJob, ctx: PrioritizationContext): number {
  const loc = job.location.toLowerCase();
  if (ctx.excludeLocations?.some(e => loc.includes(e.toLowerCase()))) return 0;
  const prefs = ctx.preferredLocations ?? [];
  if (!prefs.length) return 0.7;
  if (prefs.some(p => loc.includes(p.toLowerCase()))) return 1;
  if (job.remote) return 0.8; // remote covers preference when policy allows
  return 0.3;
}

function remoteEligibility(job: NormalizedJob): number {
  if (!job.remote) return 0.5; // onsite is neutral, not a penalty by itself
  // Explicit country list containing India => full score;
  // remote WITHOUT a country list => NOT assumed eligible (6D).
  if (job.allowedCountries?.length) {
    return job.allowedCountries.some(c => c.toLowerCase() === 'india') ? 1 : 0.4;
  }
  return 0.5;
}

function freshness(job: NormalizedJob, ctx: PrioritizationContext): number {
  if (!job.postedAt) return 0.5;
  const ageDays = (Date.now() - job.postedAt.getTime()) / 86_400_000;
  if (ageDays < 0) return 1;
  const halfLife = ctx.freshnessHalfLifeDays ?? 14;
  return Math.max(0, Math.pow(0.5, ageDays / halfLife));
}

function companyPreference(job: NormalizedJob, ctx: PrioritizationContext): number {
  const c = job.company.toLowerCase();
  if (ctx.blockedCompanies?.some(b => c.includes(b.toLowerCase()))) return 0;
  if (ctx.preferredCompanies?.some(p => c.includes(p.toLowerCase()))) return 1;
  return 0.6;
}

function sourceConfidence(job: NormalizedJob): number {
  // Derived from how the job reached us: API sources with verified probe
  // evidence are highest; browser/HTML next; unknown lowest.
  const method = job.sourceMeta.__discoveryMethod as string | undefined;
  if (method === 'api') return 0.95;
  if (method === 'html') return 0.8;
  if (method === 'browser') return 0.65;
  return 0.6;
}

function jdQuality(job: NormalizedJob, ctx: PrioritizationContext): number {
  const len = (job.description || '').length;
  const hasSkills = /(?:kubernetes|aws|terraform|docker|ci\/?cd|jenkins|python|linux|monitoring)/i.test(job.description);
  let score = Math.min(1, len / 2000);
  if (hasSkills) score = Math.min(1, score + 0.3);
  if (ctx.jdComplete) score = Math.max(score, 0.8);
  return score;
}

export function scoreJob(
  job: NormalizedJob,
  ctx: PrioritizationContext,
  extras: { route?: ResolvedRoute; dedupeConfidence?: number } = {}
): PriorityScore {
  const breakdown: PriorityBreakdown = {
    roleRelevance: roleRelevance(job, ctx),
    skillMatch: skillMatch(job, ctx),
    experienceMatch: experienceMatch(job, ctx),
    seniority: seniorityScore(job, ctx),
    location: locationScore(job, ctx),
    remoteEligibility: remoteEligibility(job),
    freshness: freshness(job, ctx),
    companyPreference: companyPreference(job, ctx),
    sourceConfidence: sourceConfidence(job),
    jdQuality: jdQuality(job, ctx),
    routeConfidence: extras.route
      ? (extras.route.route === 'UNKNOWN' || extras.route.route === 'LOGIN_REQUIRED' ? 0.3 : extras.route.confidence)
      : 0.5,
    dedupeConfidence: extras.dedupeConfidence ?? 1,
  };

  const total = (Object.entries(breakdown) as Array<[keyof PriorityBreakdown, number]>)
    .reduce((sum, [k, v]) => sum + v * WEIGHTS[k], 0);

  // ---- Hard eligibility gates (6O: quality over count; 6H: complete JD) ----
  const ineligibleReasons: string[] = [];
  if (!ctx.jdComplete) ineligibleReasons.push('JD not complete (6H gate)');
  if (breakdown.location === 0) ineligibleReasons.push('location excluded');
  if (breakdown.companyPreference === 0) ineligibleReasons.push('company blocked');
  if (breakdown.roleRelevance < 0.15) ineligibleReasons.push('role not relevant');
  if (breakdown.remoteEligibility === 0.4 && !job.allowedCountries?.some(c => c.toLowerCase() === 'india')) {
    ineligibleReasons.push('remote without India eligibility evidence');
  }
  if (ctx.matchScore !== undefined && ctx.matchScore < 60) {
    ineligibleReasons.push(`match score ${ctx.matchScore} < 60 threshold`);
  }

  return { total, breakdown, eligible: ineligibleReasons.length === 0, ineligibleReasons };
}

export interface RankedJob {
  canonical: CanonicalJob;
  job: NormalizedJob;
  score: PriorityScore;
}

/**
 * Rank canonical jobs best-first. Ineligible jobs are still returned
 * (retained for tracking, 6H) but sorted after eligible ones.
 */
export function prioritize(
  canonicalJobs: CanonicalJob[],
  ctx: PrioritizationContext,
  routeByKey?: Map<string, ResolvedRoute>
): RankedJob[] {
  const ranked: RankedJob[] = canonicalJobs.map(c => {
    const score = scoreJob(c.primary, ctx, {
      route: routeByKey?.get(c.canonicalKey),
      dedupeConfidence: c.dedupeConfidence,
    });
    return { canonical: c, job: c.primary, score };
  });

  ranked.sort((a, b) => {
    if (a.score.eligible !== b.score.eligible) return a.score.eligible ? -1 : 1;
    return b.score.total - a.score.total;
  });
  return ranked;
}
