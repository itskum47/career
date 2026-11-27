/**
 * Phase 6G — ApplicationRouteResolver.
 *
 * Classifies where an application should actually go:
 *   DIRECT_EMPLOYER | ATS | JOB_PORTAL | REDIRECT | LOGIN_REQUIRED |
 *   HUMAN_REQUIRED | UNKNOWN
 *
 * Preference: DIRECT_EMPLOYER / ATS over aggregator application pages when
 * the underlying target is legitimately discoverable from the listing.
 *
 * Persisted distinction (6R):
 *   discoveredFrom   = source that surfaced the listing
 *   canonicalSource  = where the canonical JD lives (company site / ATS / portal)
 *   applicationRoute = how the application is submitted
 */

import type { NormalizedJob, ApplicationRoute, ResolvedRoute } from './types.ts';

/** ATS detection from URL patterns + source metadata. */
const ATS_PATTERNS: Array<{ ats: string; pattern: RegExp }> = [
  { ats: 'greenhouse', pattern: /(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|boards-api\.greenhouse\.io)/i },
  { ats: 'lever', pattern: /(?:jobs\.lever\.co|api\.lever\.co|lever\.co\/v0)/i },
  { ats: 'ashby', pattern: /(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com|apply\.ashbyhq\.com)/i },
  { ats: 'workday', pattern: /(?:wd5\.myworkdayjobs\.com|myworkdayjobs\.com|wd3\.myworkdayjobs\.com)/i },
  { ats: 'smartrecruiters', pattern: /(?:jobs\.smartrecruiters\.com|smartrecruiters\.com)/i },
  { ats: 'workable', pattern: /(?:apply\.workable\.com|workable\.com\/jobs)/i },
  { ats: 'icims', pattern: /(?:icims\.com\/jobs|careers\.[a-z0-9-]+\.com\/jobs)/i },
  { ats: 'taleo', pattern: /(?:taleo\.net|careertalent\.oracle\.com)/i },
  { ats: 'jobvite', pattern: /(?:jobvite\.com\/jobs)/i },
  { ats: 'recruitee', pattern: /(?:recruitee\.com\/jobs|careers\.[a-z0-9.-]+\/offers)/i },
  { ats: 'breezy', pattern: /(?:breezy\.hr)/i },
  { ats: 'jazzhr', pattern: /(?:apply\.jobs\.ai|jazzhr\.com\/apply)/i },
  { ats: 'pinpoint', pattern: /(?:pinpointhq\.com)/i },
  { ats: 'teamtailor', pattern: /([a-z0-9-]+)\.teamtailor\.com/i },
  { ats: 'comeet', pattern: /([a-z0-9-]+)\.comeet\.co/i },
  { ats: 'bamboohr', pattern: /([a-z0-9-]+)\.bamboohr\.com\/jobs/i },
  { ats: 'rippling', pattern: /([a-z0-9-]+)\.rippling\.com\/jobs/i },
  { ats: 'personio', pattern: /([a-z0-9-]+)\.jobs\.personio\.(de|com|at)/i },
  { ats: 'dover', pattern: /([a-z0-9-]+)\.dover\.com/i },
  { ats: 'eightfold', pattern: /([a-z0-9-]+)\.eightfold\.ai\/careers/i },
  { ats: 'ukg', pattern: /([a-z0-9-]+)\.ultipro\.com/i },
  { ats: 'dayforce', pattern: /([a-z0-9-]+)\.dayforcehcm\.com/i },
  { ats: 'avature', pattern: /([a-z0-9-]+)\.avature\.net/i },
  { ats: 'greenhouse', pattern: /\/jobs\/\d{4,}(?:\?|$)/i }, // boards.greenhouse.io/<board>/jobs/<id>
];

/** Portal hosts whose listing pages are NOT application targets. */
const PORTAL_HOSTS = [
  'naukri.com', 'linkedin.com', 'indeed.com', 'glassdoor.com', 'foundit.in',
  'shine.com', 'timesjobs.com', 'cutshort.io', 'instahyre.com', 'hirist.tech',
  'wellfound.com', 'iimjobs.com', 'apna.co', 'freshersworld.com', 'monster.in',
  'foundit.com', 'dice.com', 'ziprecruiter.com', 'simplyhired.com',
];

/** Remote boards that link out to employer/ATS application pages. */
const REMOTE_BOARD_HOSTS = [
  'remoteok.com', 'remotive.com', 'weworkremotely.com', 'himalayas.app',
  'workingnomads.com', 'jobpresso.com', 'workatastartup.com',
];

export function detectAts(url: string, job?: NormalizedJob): string | undefined {
  // A remote-board URL is never an ATS URL — boards link OUT to ATSes, and
  // generic patterns (e.g. /jobs/<digits>) would false-positive on them.
  if (isRemoteBoardHost(hostOf(url))) return undefined;
  const fromMeta = job?.ats ?? (job?.sourceMeta.ats as string | undefined);
  // Boards/portals are never ATSes, whatever the source metadata claims.
  const NOT_AN_ATS = new Set(['shine', 'apna', 'freshersworld', 'remoteok', 'remotive', 'weworkremotely']);
  if (fromMeta && !NOT_AN_ATS.has(fromMeta)) return fromMeta;
  for (const { ats, pattern } of ATS_PATTERNS) {
    if (pattern.test(url)) return ats;
  }
  return undefined;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function isPortalHost(host: string): boolean {
  return PORTAL_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

function isRemoteBoardHost(host: string): boolean {
  return REMOTE_BOARD_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

export interface RouteResolutionOptions {
  /**
   * Employer URL extracted from the listing (portal "view on company site",
   * ATS application link in description, etc). When present it upgrades
   * JOB_PORTAL -> DIRECT_EMPLOYER/ATS.
   */
  employerUrl?: string;
}

/**
 * Resolve the canonical application route for a normalized job.
 * Never invents URLs: everything derives from what the listing exposes.
 */
export function resolveRoute(job: NormalizedJob, options: RouteResolutionOptions = {}): ResolvedRoute {
  const discoveredFrom = job.source;
  const sourceHost = hostOf(job.sourceUrl);
  const appUrl = options.employerUrl || job.applicationUrl || job.sourceUrl;
  const appHost = hostOf(appUrl);
  const atsFromUrl = detectAts(appUrl, job);
  const atsFromEmployer = options.employerUrl ? detectAts(options.employerUrl, job) : undefined;
  const ats = atsFromEmployer ?? atsFromUrl;

  // 1. Login-required sources (6K) surface as LOGIN_REQUIRED when the ONLY
  //    application path is behind authentication and no public route exists.
  const loginRequiredDef = job.sourceMeta.loginRequired === true;

  // 2. ATS behind the application URL -> ATS route (preferred over portal).
  if (ats && !isPortalHost(appHost)) {
    return {
      route: 'ATS',
      ats,
      applicationUrl: appUrl,
      canonicalSource: appHost,
      discoveredFrom,
      confidence: 0.95,
      reason: `ATS '${ats}' detected on application host ${appHost}`,
    };
  }

  // 3. Employer career page (not a portal host, not a remote board).
  if (!isPortalHost(appHost) && !isRemoteBoardHost(appHost) && appHost) {
    return {
      route: 'DIRECT_EMPLOYER',
      ats,
      applicationUrl: appUrl,
      canonicalSource: appHost,
      discoveredFrom,
      confidence: 0.85,
      reason: `application host ${appHost} is an employer/ATS page, not an aggregator`,
    };
  }

  // 4. Employer URL embedded in a portal listing -> prefer it (6G example:
  //    Naukri -> employer URL -> Greenhouse).
  if (options.employerUrl) {
    const euHost = hostOf(options.employerUrl);
    const euAts = detectAts(options.employerUrl, job);
    return {
      route: euAts ? 'ATS' : 'DIRECT_EMPLOYER',
      ats: euAts,
      applicationUrl: options.employerUrl,
      canonicalSource: euHost,
      discoveredFrom,
      confidence: euAts ? 0.9 : 0.8,
      reason: `employer application URL found in listing (via ${discoveredFrom})`,
    };
  }

  // 4b. Remote board / aggregator page: the board's apply control bounces to
  //     the employer site. Classify as REDIRECT — the board is NOT an ATS and
  //     the flow does NOT stay on the board.
  if (isRemoteBoardHost(appHost)) {
    return {
      route: 'REDIRECT',
      ats: undefined, // resolved only after the board bounces to the employer
      applicationUrl: appUrl,
      canonicalSource: appHost,
      discoveredFrom,
      confidence: 0.7,
      reason: `application host ${appHost} is a remote job board — apply redirects to the employer`,
    };
  }

  // 5. Portal-hosted application (aggregator's own apply flow).
  if (isPortalHost(appHost)) {
    if (loginRequiredDef) {
      return {
        route: 'LOGIN_REQUIRED',
        ats,
        applicationUrl: appUrl,
        canonicalSource: sourceHost,
        discoveredFrom,
        confidence: 0.7,
        reason: `portal ${sourceHost} requires login for application`,
      };
    }
    return {
      route: 'JOB_PORTAL',
      ats,
      applicationUrl: appUrl,
      canonicalSource: sourceHost,
      discoveredFrom,
      confidence: 0.75,
      reason: `application stays on aggregator ${appHost}`,
    };
  }

  if (loginRequiredDef) {
    return {
      route: 'LOGIN_REQUIRED', ats, applicationUrl: appUrl, canonicalSource: sourceHost,
      discoveredFrom, confidence: 0.6, reason: 'login required and no public route found',
    };
  }

  return {
    route: 'UNKNOWN',
    ats,
    applicationUrl: appUrl,
    canonicalSource: sourceHost || 'unknown',
    discoveredFrom,
    confidence: 0.3,
    reason: 'could not classify application host',
  };
}

/** Rank routes by application preference (DIRECT/ATS first). */
export function routePreference(route: ApplicationRoute): number {
  switch (route) {
    case 'DIRECT_EMPLOYER': return 0;
    case 'ATS': return 1;
    case 'REDIRECT': return 2;
    case 'JOB_PORTAL': return 3;
    case 'LOGIN_REQUIRED': return 4;
    case 'HUMAN_REQUIRED': return 5;
    default: return 6;
  }
}

/**
 * Pick the best application URL among candidate routes found on a listing.
 * Returns the highest-preference candidate (ties -> first found).
 */
export function pickBestRoute(candidates: ResolvedRoute[]): ResolvedRoute | undefined {
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) => routePreference(a.route) - routePreference(b.route))[0];
}
