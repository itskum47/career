/**
 * Phase 6E — Source-agnostic normalization.
 *
 * Every adapter's raw output passes through normalize() to become a
 * NormalizedJob. Source-specific fields stay in sourceMeta — they never
 * leak into the normalized shape.
 *
 * ID discipline (6E example):
 *   internalJobId  = JOB-...          job-agent identity (JobId)
 *   sourceJobId    = NK-123/LI-987/GH-abc   portal identity (from sourceMeta)
 * These are DIFFERENT identifiers and are never conflated.
 */

import type { DiscoveredJob, NormalizedJob } from './types.ts';
import { getSourceDefinition } from './catalog.ts';
import { isValidSource } from './types.ts';
import type { JobId } from '../core/types.ts';
import { logger } from '../core/logger.ts';

const REMOTE_WORDS = /\bremote\b|\bwork from home\b|\bwfh\b/i;
const INDIA_WORDS = /\bindia\b|\bbengaluru\b|\bbangalore\b|\bpune\b|\bhyderabad\b|\bmumbai\b|\bchennai\b|\bdelhi\b|\bgurgaon\b|\bnoida\b|\bkolkata\b|\bjaipur\b|\bahmedabad\b|\bkochi\b|\bchandigarh\b/i;

/**
 * Known countries/regions (6D). Used ONLY to interpret explicit location
 * enumerations: when a remote job's location lists countries and India is not
 * among them, India eligibility is explicitly NOT claimed (never assumed).
 * A location with no recognizable country stays NEUTRAL (undefined).
 */
const COUNTRY_PATTERNS: Array<[RegExp, string]> = [
  [/\bunited states\b|\busa\b|\bu\.s\.?\b|\bus\b/i, 'United States'],
  [/\bunited kingdom\b|\buk\b|\bgreat britain\b|\bengland\b/i, 'United Kingdom'],
  [/\bcanada\b/i, 'Canada'],
  [/\baustralia\b/i, 'Australia'],
  [/\bnew zealand\b/i, 'New Zealand'],
  [/\bgermany\b/i, 'Germany'],
  [/\bfrance\b/i, 'France'],
  [/\bnetherlands\b/i, 'Netherlands'],
  [/\bireland\b/i, 'Ireland'],
  [/\bspain\b/i, 'Spain'],
  [/\bportugal\b/i, 'Portugal'],
  [/\bitaly\b/i, 'Italy'],
  [/\bsweden\b/i, 'Sweden'],
  [/\bnorway\b/i, 'Norway'],
  [/\bdenmark\b/i, 'Denmark'],
  [/\bfinland\b/i, 'Finland'],
  [/\bswitzerland\b/i, 'Switzerland'],
  [/\baustria\b/i, 'Austria'],
  [/\bbelgium\b/i, 'Belgium'],
  [/\bpoland\b/i, 'Poland'],
  [/\bromania\b/i, 'Romania'],
  [/\bczech (republic|ia)\b/i, 'Czech Republic'],
  [/\bgreece\b/i, 'Greece'],
  [/\bhungary\b/i, 'Hungary'],
  [/\bukraine\b/i, 'Ukraine'],
  [/\bserbia\b/i, 'Serbia'],
  [/\bcroatia\b/i, 'Croatia'],
  [/\bbulgaria\b/i, 'Bulgaria'],
  [/\bestonia\b/i, 'Estonia'],
  [/\blithuania\b/i, 'Lithuania'],
  [/\blatvia\b/i, 'Latvia'],
  [/\bbrazil\b/i, 'Brazil'],
  [/\bmexico\b/i, 'Mexico'],
  [/\bargentina\b/i, 'Argentina'],
  [/\bchile\b/i, 'Chile'],
  [/\bsingapore\b/i, 'Singapore'],
  [/\bjapan\b/i, 'Japan'],
  [/\bsouth korea\b/i, 'South Korea'],
  [/\bsouth africa\b/i, 'South Africa'],
  [/\bnigeria\b/i, 'Nigeria'],
  [/\bkenya\b/i, 'Kenya'],
  [/\bisrael\b/i, 'Israel'],
  [/\buae\b|\babu dhabi\b/i, 'UAE'],
  [/\bsaudi arabia\b/i, 'Saudi Arabia'],
  [/\bqatar\b/i, 'Qatar'],
  [/\bphilippines\b/i, 'Philippines'],
  [/\bindonesia\b/i, 'Indonesia'],
  [/\bmalaysia\b/i, 'Malaysia'],
  [/\bthailand\b/i, 'Thailand'],
  [/\bvietnam\b/i, 'Vietnam'],
  [/\bpakistan\b/i, 'Pakistan'],
  [/\bbangladesh\b/i, 'Bangladesh'],
  [/\bsri lanka\b/i, 'Sri Lanka'],
  [/\bnepal\b/i, 'Nepal'],
  [/\bturkey\b/i, 'Turkey'],
  // Regions (non-India) — enumeration evidence only, never an India claim.
  [/\beurope\b/i, 'Europe'],
  [/\bapac\b/i, 'APAC'],
  [/\blatam\b/i, 'LATAM'],
  [/\bnorth(ern)? america\b/i, 'North America'],
  [/\bsouth america\b/i, 'South America'],
  [/\bemea\b/i, 'EMEA'],
];

/**
 * Major tech-hub cities mapped to their country (6D). A remote job whose
 * location says "New York, NY (HQ)" carries explicit non-India evidence —
 * the same way a country list does. City evidence is only consulted when the
 * location does NOT already name India.
 */
const CITY_COUNTRY: Array<[RegExp, string]> = [
  [/\bnew york\b|\bsan francisco\b|\bseattle\b|\baustin\b|\bboston\b|\blos angeles\b|\bchicago\b|\bdenver\b|\bdallas\b|\batlanta\b|\bmiami\b|\bportland\b|\bwashington,?\s*dc\b|\bsilicon valley\b/i, 'United States'],
  [/\blondon\b|\bmanchester\b|\bedinburgh\b|\bbristol\b/i, 'United Kingdom'],
  [/\btoronto\b|\bvancouver\b|\bmontreal\b|\bwaterloo\b/i, 'Canada'],
  [/\bsydney\b|\bmelbourne\b|\bbrisbane\b/i, 'Australia'],
  [/\bberlin\b|\bmunich\b|\bfrankfurt\b|\bhamburg\b/i, 'Germany'],
  [/\bparis\b/i, 'France'],
  [/\bamsterdam\b|\brotterdam\b/i, 'Netherlands'],
  [/\bdublin\b/i, 'Ireland'],
  [/\bmadrid\b|\bbarcelona\b/i, 'Spain'],
  [/\bstockholm\b|\bgothenburg\b/i, 'Sweden'],
  [/\bzurich\b|\bbern\b/i, 'Switzerland'],
  [/\bbangalore\b|\bpune\b|\bmumbai\b|\bchennai\b|\bdelhi\b|\bhyderabad\b|\bgurgaon\b|\bnoida\b|\bkolkata\b|\bjaipur\b|\bahmedabad\b|\bkochi\b|\bchandigarh\b|\bcoimbatore\b/i, 'India'],
  [/\bbangkok\b/i, 'Thailand'],
  [/\bshanghai\b|\bbeijing\b|\bshenzhen\b/i, 'China'],
  [/\btokyo\b/i, 'Japan'],
  [/\bseoul\b/i, 'South Korea'],
  [/\bsao paulo\b|\brio de janeiro\b/i, 'Brazil'],
  [/\bsingapore\b/i, 'Singapore'],
];

function enumeratedCountries(location: string): string[] | undefined {
  const found: string[] = [];
  for (const [re, name] of COUNTRY_PATTERNS) {
    if (re.test(location) && !found.includes(name)) found.push(name);
  }
  for (const [re, name] of CITY_COUNTRY) {
    if (re.test(location) && !found.includes(name)) found.push(name);
  }
  return found.length ? found : undefined;
}

/** Canonical URL: strip tracking params/fragments, lowercase host. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    const drop = ['ref', 'ref_?', 'src', 'source', 'trk', 'trackingId', 'position_in_results', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'from', 'fromage', 'interest', 'fbclid'];
    for (const k of drop) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    // Sort params for stability.
    const entries = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of entries) u.searchParams.append(k, v);
    return u.toString().replace(/\/$/, u.pathname === '/' ? '/' : '');
  } catch {
    return raw;
  }
}

/** Application URL: same page, minus list/search params. */
export function applicationUrlFor(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of ['q', 'l', 'keywords', 'location', 'search', 'page', 'position_in_results']) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return raw;
  }
}

/** Extract the portal-level sourceJobId from adapter metadata. */
export function extractSourceJobId(job: DiscoveredJob): string {
  const raw = job.rawData?.sourceJobId;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  // Fall back to a stable external id derived from the URL path/query.
  try {
    const u = new URL(job.url);
    const idFromQuery = u.searchParams.get('jobId') || u.searchParams.get('jk') || u.searchParams.get('id');
    if (idFromQuery) return `${job.source.toUpperCase()}-${idFromQuery}`;
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /\d/.test(last)) return `${job.source.toUpperCase()}-${last}`;
  } catch { /* fall through */ }
  return `${job.source.toUpperCase()}-unknown`;
}

export interface NormalizeResult {
  normalized: NormalizedJob;
  warnings: string[];
}

export function normalize(job: DiscoveredJob, now: Date = new Date()): NormalizeResult {
  const warnings: string[] = [];

  if (!isValidSource(job.source)) {
    warnings.push(`unknown source id: ${job.source}`);
  }
  const def = getSourceDefinition(job.source);
  if (!def) warnings.push(`source not in catalog: ${job.source}`);

  if (!job.url?.startsWith('http')) {
    warnings.push(`invalid url for ${job.jobId}`);
  }
  if (!job.title?.trim()) warnings.push(`missing title for ${job.jobId}`);
  if (!job.company?.trim()) warnings.push(`missing company for ${job.jobId}`);

  // 6D: remote is explicit and NEVER implies India eligibility.
  const location = (job.location || '').trim() || 'Not specified';
  const remote = job.remote ?? REMOTE_WORDS.test(location);
  let remotePolicy = job.remotePolicy;
  if (!remotePolicy) {
    remotePolicy = remote ? 'fully-remote' : /hybrid/i.test(location) ? 'hybrid' : /on-site|onsite/i.test(location) ? 'on-site' : 'unspecified';
  }
  const rawAC = job.rawData?.allowedCountries as string[] | undefined;
  let allowedCountries = rawAC;
  if (!allowedCountries && remote) {
    if (INDIA_WORDS.test(location)) {
      allowedCountries = ['India'];
    } else {
      // Explicit enumeration WITHOUT India (e.g. "Remote, Canada; Remote, US"
      // or "New York, NY (HQ)") is evidence AGAINST India eligibility —
      // gated, retained for tracking. India named anywhere keeps it eligible.
      const explicit = enumeratedCountries(location);
      if (explicit) {
        allowedCountries = explicit;
        if (!explicit.includes('India')) {
          warnings.push(`remote location enumerates countries without India (${explicit.join(', ')}) — India eligibility NOT assumed (${job.jobId})`);
        }
      }
    }
  }
  if (remote && !allowedCountries) {
    warnings.push(`remote job without allowedCountries — India eligibility NOT assumed (${job.jobId})`);
  }

  const sourceJobId = extractSourceJobId(job);
  const canonicalJobUrl = canonicalizeUrl(job.url);

  // Source-specific fields stay quarantined in sourceMeta (6E).
  const { sourceJobId: _ignored, allowedCountries: _ac, ...restRaw } = (job.rawData ?? {}) as Record<string, unknown>;

  // Prefer an explicit application target discovered by the adapter (6G:
  // employer/ATS link extracted from the listing) over the listing URL.
  const rawApp = job.rawData?.applicationUrl ?? job.rawData?.applyUrl;
  const applicationTarget = typeof rawApp === 'string' && rawApp.startsWith('http') ? rawApp : job.url;

  const normalized: NormalizedJob = {
    internalJobId: job.jobId as JobId,
    source: job.source,
    sourceJobId,
    sourceUrl: job.url,
    canonicalJobUrl,
    applicationUrl: applicationUrlFor(applicationTarget),
    company: job.company?.trim() || 'Unknown',
    title: job.title?.trim() || 'Unknown',
    location,
    remote,
    remotePolicy,
    allowedCountries,
    employmentType: job.employmentType,
    seniority: job.seniority,
    salary: job.salary,
    postedAt: job.postedAt,
    description: job.description || '',
    ats: typeof restRaw.ats === 'string' ? (restRaw.ats as string) : def?.atsHint,
    discoveredAt: now,
    sourceMeta: restRaw,
    // 6H gate: false until full-JD retrieval + verification succeeds.
    jdComplete: false,
  };

  if (normalized.description.length < 100) {
    warnings.push(`description is a snippet (${normalized.description.length} chars) — full JD retrieval required before apply`);
  }

  return { normalized, warnings };
}

/** Batch normalization with per-job warning logs (never throws). */
export function normalizeAll(jobs: DiscoveredJob[], now: Date = new Date()): {
  results: NormalizeResult[];
  normalized: NormalizedJob[];
} {
  const results: NormalizeResult[] = [];
  for (const job of jobs) {
    try {
      results.push(normalize(job, now));
    } catch (error) {
      logger.error('Normalization failed', { jobId: job.jobId, error: String(error) });
    }
  }
  return { results, normalized: results.map(r => r.normalized) };
}
