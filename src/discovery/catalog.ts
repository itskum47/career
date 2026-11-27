/**
 * Phase 6A/6B — Central job source catalog.
 *
 * Single source of truth for every job source the system knows about.
 * The registry (registry.ts) reads this catalog and applies configuration
 * on top of it. Nothing here is hardcoded inside adapter constructors.
 *
 * Capability reporting rules:
 *  - `discovery` reflects what has been ACTUALLY EXECUTED against the real
 *    public surface from this machine, not what we hope works:
 *      'api'   -> a public documented JSON API was called and returned jobs
 *      'html'  -> public HTML listings were fetched and parsed
 *      'browser' -> requires a real browser session (JS-rendered / login)
 *      'none'  -> cannot be safely supported yet (blocked/anti-bot/no route)
 *  - `application` is whether the optimized ApplicationEngine can submit
 *    through this source's route without bypassing auth/CAPTCHA/MFA.
 *  - `probeEvidence` records the last measured result so the report can
 *    distinguish VERIFIED from NOT VERIFIED sources.
 *
 * NO FAKE IMPLEMENTATIONS: a source with discovery:'none' has NO adapter —
 * it is registered as deferred with an explicit reason.
 */

export type SourceCategory =
  | 'job-portal'      // aggregator portals (Naukri, LinkedIn, Indeed...)
  | 'remote-board'    // remote-specific boards (WWR, Remotive...)
  | 'ats'             // applicant tracking systems (Greenhouse, Lever...)
  | 'direct-employer' // company career pages
  | 'search-engine'   // indexed job pages
  | 'internal';       // mock / manual (test & fixture sources)

export type DiscoveryMethod = 'api' | 'rss' | 'html' | 'browser' | 'none';

export type SourceSupport = 'supported' | 'partial' | 'deferred' | 'blocked';

export interface SourceProbeEvidence {
  /** e.g. 'GET https://boards-api.greenhouse.io/... -> 200, 210 jobs' */
  measured: string;
  /** ISO date of last probe */
  at: string;
  /** true when the probe returned parseable real jobs */
  realJobsObserved: boolean;
}

export interface SourceDefinition {
  id: string;
  displayName: string;
  category: SourceCategory;
  /** For direct-employer sources routed through a known ATS. */
  atsHint?: string;
  /** Base URL used for discovery / canonicalization. */
  baseUrl?: string;
  /** Overall support classification for the Phase 6 report. */
  support: SourceSupport;
  /** Why a source is partial/deferred/blocked (honest, required when not supported). */
  reason?: string;

  capabilities: {
    discovery: DiscoveryMethod;
    /** Complete job description can be retrieved (6H gate). */
    completeJd: boolean;
    /** Application submission is supported by the engine (6P/6Q). */
    application: boolean;
    /** Source needs a login session (6K — pause for user, never bypass). */
    loginRequired: boolean;
    /** Public listing pages are paginated. */
    pagination: boolean;
    /** Discovery (search) is enabled by default when the source is enabled. */
    discoveryEnabledByDefault: boolean;
    /** Application is possible by default when enabled. */
    applicationSupportedByDefault: boolean;
  };

  /** Per-source defaults the registry applies unless config overrides them. */
  defaults: {
    enabled: boolean;
    priority: number;        // lower = earlier in the queue
    concurrency: number;     // source worker concurrency (6I/6M)
    rateLimitMs: number;     // min interval between requests (6M)
    timeoutMs: number;       // per-search timeout
    maxJobsPerSource: number; // pagination cap (6J)
  };

  probeEvidence?: SourceProbeEvidence;
}

// ---------------------------------------------------------------------------
// Role families (6C) — normalization + synonyms. Discovery is NOT restricted
// to exact title matches: adapters match by role-family membership.
// ---------------------------------------------------------------------------

export interface RoleFamily {
  family: string;
  /** Titles considered members of this family (normalized lowercase). */
  synonyms: string[];
}

export const ROLE_FAMILIES: RoleFamily[] = [
  { family: 'DevOps Engineer', synonyms: ['devops engineer', 'devops', 'devops developer', 'devops consultant'] },
  { family: 'AWS DevOps Engineer', synonyms: ['aws devops engineer', 'aws devops', 'devops aws engineer'] },
  { family: 'Cloud Engineer', synonyms: ['cloud engineer', 'cloud engineering', 'cloud associate'] },
  { family: 'AWS Cloud Engineer', synonyms: ['aws cloud engineer', 'aws engineer', 'aws solutions engineer'] },
  { family: 'Cloud DevOps Engineer', synonyms: ['cloud devops engineer', 'cloud devops'] },
  { family: 'Site Reliability Engineer', synonyms: ['site reliability engineer', 'sre', 'sre engineer', 'site reliability', 'sr. site reliability engineer'] },
  { family: 'DevOps/SRE', synonyms: ['devops/sre', 'devops sre', 'sre/devops'] },
  { family: 'Platform Engineer', synonyms: ['platform engineer', 'platform engineering', 'internal platform engineer'] },
  { family: 'Cloud Platform Engineer', synonyms: ['cloud platform engineer', 'cloud platform'] },
  { family: 'Infrastructure Engineer', synonyms: ['infrastructure engineer', 'infrastructure', 'it infrastructure engineer'] },
  { family: 'Cloud Infrastructure Engineer', synonyms: ['cloud infrastructure engineer', 'cloud infrastructure'] },
  { family: 'Production Engineer', synonyms: ['production engineer', 'production systems engineer'] },
  { family: 'Kubernetes Engineer', synonyms: ['kubernetes engineer', 'kubernetes administrator', 'k8s engineer', 'container platform engineer'] },
  { family: 'CI/CD Engineer', synonyms: ['ci/cd engineer', 'cicd engineer', 'ci cd engineer', 'build engineer'] },
  { family: 'Release Engineer', synonyms: ['release engineer', 'release manager'] },
  { family: 'Build/Release Engineer', synonyms: ['build/release engineer', 'build and release engineer'] },
  { family: 'DevSecOps Engineer', synonyms: ['devsecops engineer', 'dev secops', 'security devops engineer'] },
  { family: 'Infrastructure Automation Engineer', synonyms: ['infrastructure automation engineer', 'automation engineer', 'it automation engineer'] },
  { family: 'Reliability Engineer', synonyms: ['reliability engineer', 'reliability'] },
];

/** Locations (6D). Remote eligibility is explicit — never assumed. */
export interface SearchLocation {
  label: string;
  /** True when this entry means "remote roles targeting India". */
  remote?: boolean;
  synonyms: string[];
}

export const SEARCH_LOCATIONS: SearchLocation[] = [
  { label: 'Remote India', remote: true, synonyms: ['remote', 'remote india', 'india (remote)'] },
  { label: 'Pune', synonyms: ['pune', 'mh'] },
  { label: 'Bengaluru', synonyms: ['bengaluru', 'bangalore', 'bengaluru / bangalore'] },
  { label: 'Hyderabad', synonyms: ['hyderabad', 'secunderabad', 'hyd'] },
  { label: 'Delhi NCR', synonyms: ['delhi', 'delhi ncr', 'new delhi', 'ncr'] },
  { label: 'Gurgaon', synonyms: ['gurgaon', 'gurugram'] },
  { label: 'Noida', synonyms: ['noida', 'greater noida'] },
  { label: 'Mumbai', synonyms: ['mumbai', 'bombay', 'thane'] },
  { label: 'Chennai', synonyms: ['chennai', 'madras'] },
  { label: 'Kolkata', synonyms: ['kolkata', 'calcutta'] },
  { label: 'Jaipur', synonyms: ['jaipur'] },
  { label: 'Ahmedabad', synonyms: ['ahmedabad'] },
  { label: 'Kochi', synonyms: ['kochi', 'cochin'] },
  { label: 'Chandigarh', synonyms: ['chandigarh', 'mohali', 'panchkula'] },
  { label: 'Coimbatore', synonyms: ['coimbatore'] },
  { label: 'Pune (Hinjewadi)', synonyms: ['hinjewadi'] },
  { label: 'India', synonyms: ['india', 'indian'] },
];

// ---------------------------------------------------------------------------
// The catalog itself.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_JOBS = 50;

/** Probe dates are real (last full source probe run). */
const PROBE_AT = '2026-10-07';

export const SOURCE_CATALOG: SourceDefinition[] = [
  // -----------------------------------------------------------------------
  // PRIMARY INDIA JOB PORTALS (6B)
  // -----------------------------------------------------------------------
  {
    id: 'naukri', displayName: 'Naukri', category: 'job-portal',
    baseUrl: 'https://www.naukri.com',
    support: 'deferred', reason: 'Public search page returns HTTP 200 but renders job cards client-side without a browser session; safe browser-based extraction not yet implemented (anti-bot not bypassed).',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 10, concurrency: 1, rateLimitMs: 3000, timeoutMs: 20000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /devops-jobs -> 200, 35,820 bytes, 0 server-rendered job cards', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'foundit', displayName: 'Foundit (Monster India)', category: 'job-portal',
    baseUrl: 'https://www.foundit.in',
    support: 'blocked', reason: 'HTTP 403 with 392-byte body (bot protection). Access controls are never bypassed.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 11, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /search/devops-jobs -> 403', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'linkedin', displayName: 'LinkedIn Jobs', category: 'job-portal',
    baseUrl: 'https://www.linkedin.com',
    support: 'partial',
    reason: 'Search page is served (200, real job titles) but listings are JS-rendered and a CAPTCHA/login wall appears without a session. Extraction runs in a real headless browser reading the public page only; login sessions are requested from the user (6K), never bypassed.',
    capabilities: { discovery: 'browser', completeJd: true, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: true, applicationSupportedByDefault: false },
    defaults: { enabled: true, priority: 20, concurrency: 1, rateLimitMs: 4000, timeoutMs: 25000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs/search?keywords=devops -> 200, 285,949 bytes, title "11,000+ Devops jobs", 0 server-rendered /jobs/view/ links (JS), captcha marker present', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'indeed', displayName: 'Indeed', category: 'job-portal',
    baseUrl: 'https://www.indeed.com',
    support: 'blocked', reason: 'HTTP 403 on public search. Anti-bot protection is never bypassed.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 21, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs?q=devops -> 403', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'glassdoor', displayName: 'Glassdoor', category: 'job-portal',
    baseUrl: 'https://www.glassdoor.com',
    support: 'blocked', reason: 'HTTP 403 on public job search. Never bypassed.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 22, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /Job/jobs.htm?sc.keyword=devops -> 403', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'timesjobs', displayName: 'TimesJobs', category: 'job-portal',
    baseUrl: 'https://www.timesjobs.com',
    support: 'deferred', reason: 'Host unreachable from this network during probe (fetch failed). Deferred until a successful public fetch is measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 23, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /candidate/job-search.html?...txtKeywords=devops -> fetch failed (ECONNREFUSED/timeout)', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'shine', displayName: 'Shine', category: 'job-portal',
    baseUrl: 'https://www.shine.com',
    support: 'partial',
    reason: 'Server-rendered job listings are publicly fetchable (measured). Full JD retrieval path implemented; application route is employer-redirect based.',
    capabilities: { discovery: 'html', completeJd: true, application: true, loginRequired: false, pagination: true, discoveryEnabledByDefault: true, applicationSupportedByDefault: false },
    defaults: { enabled: true, priority: 30, concurrency: 1, rateLimitMs: 3000, timeoutMs: 25000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /job-search/devops-jobs -> 200, 438,777 bytes, server-rendered job cards, title "6,105+ DevOps Jobs"', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'cutshort', displayName: 'Cutshort', category: 'job-portal',
    baseUrl: 'https://cutshort.io',
    support: 'deferred', reason: 'Public page served but CAPTCHA marker present and listings are JS-rendered; no safe extraction route yet.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 31, concurrency: 1, rateLimitMs: 3000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs/devops -> 200, captcha marker true, job-card markers false', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'instahyre', displayName: 'Instahyre', category: 'job-portal',
    baseUrl: 'https://www.instahyre.com',
    support: 'deferred', reason: 'Login-required platform; public discovery surface not measured as working. Will use the 6K login-pause flow when enabled.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 32, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'hirist', displayName: 'Hirist', category: 'job-portal',
    baseUrl: 'https://www.hirist.tech',
    support: 'deferred', reason: 'HTTP 200 but CAPTCHA marker present and listings require JS; safe extraction not implemented.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 33, concurrency: 1, rateLimitMs: 3000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /search/devops -> 200, captcha marker true', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'wellfound', displayName: 'Wellfound (AngelList)', category: 'job-portal',
    baseUrl: 'https://wellfound.com',
    support: 'deferred', reason: 'Login-required startup board; public discovery surface not yet measured as working.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 34, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'iimjobs', displayName: 'iimjobs', category: 'job-portal',
    baseUrl: 'https://www.iimjobs.com',
    support: 'deferred', reason: 'Public search URL returned HTTP 404 during probe; route not confirmed.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: true, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 35, concurrency: 1, rateLimitMs: 4000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs/devops -> 404', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'apna', displayName: 'Apna', category: 'job-portal',
    baseUrl: 'https://apna.co',
    support: 'partial',
    reason: 'Public jobs page is server-rendered (measured 200, job cards present). Search-page extraction implemented for the discovery benchmark; application is employer-redirect based.',
    capabilities: { discovery: 'html', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: true, applicationSupportedByDefault: false },
    defaults: { enabled: true, priority: 36, concurrency: 1, rateLimitMs: 3000, timeoutMs: 20000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs -> 200, 984,170 bytes, job-card markers present, title "80,821 Job Vacancies in India 2026"', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'freshersworld', displayName: 'Freshersworld', category: 'job-portal',
    baseUrl: 'https://www.freshersworld.com',
    support: 'partial',
    reason: 'Public page fetched with job cards present (measured). CAPTCHA marker seen on part of the page — discovery reads public listings only, never touches the challenge.',
    capabilities: { discovery: 'html', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: true, applicationSupportedByDefault: false },
    defaults: { enabled: true, priority: 37, concurrency: 1, rateLimitMs: 3000, timeoutMs: 20000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs -> 200, 883,170 bytes, job-card markers present', at: PROBE_AT, realJobsObserved: true },
  },

  // -----------------------------------------------------------------------
  // REMOTE BOARDS (6B)
  // -----------------------------------------------------------------------
  {
    id: 'weworkremotely', displayName: 'We Work Remotely', category: 'remote-board',
    baseUrl: 'https://weworkremotely.com',
    support: 'supported',
    reason: 'Public category RSS measured working (200 / 25 items). The generic search RSS returns 403 and is never bypassed; discovery uses /categories/remote-programming-jobs.rss only.',
    capabilities: { discovery: 'rss', completeJd: false, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 40, concurrency: 1, rateLimitMs: 3000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /categories/remote-programming-jobs.rss -> 200, 178884 bytes, 25 <item> entries (search.rss -> 403)', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'remoteok', displayName: 'Remote OK', category: 'remote-board',
    baseUrl: 'https://remoteok.com',
    support: 'supported',
    reason: 'Public JSON API measured working.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: true, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 41, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://remoteok.com/api -> 200, 573,869 bytes JSON', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'remotive', displayName: 'Remotive', category: 'remote-board',
    baseUrl: 'https://remotive.com',
    support: 'supported',
    reason: 'Public JSON API measured working (HTML site blocks direct fetch, API does not).',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: true, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 42, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://remotive.com/api/remote-jobs?limit=5 -> 200, 18 jobs', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'himalayas', displayName: 'Himalayas', category: 'remote-board',
    baseUrl: 'https://himalayas.app',
    support: 'blocked', reason: 'HTTP 403 during probe. Never bypassed.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 43, concurrency: 1, rateLimitMs: 3000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs/devops -> 403', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'workingnomads', displayName: 'Working Nomads', category: 'remote-board',
    baseUrl: 'https://www.workingnomads.com',
    support: 'deferred',
    reason: 'Public pages return 200 but contain no server-rendered job links (client-side rendering), and the JSON endpoints return 403. No safe extraction route yet.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 44, concurrency: 1, rateLimitMs: 3000, timeoutMs: 20000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /jobs -> 200, 86,546 bytes, 0 /jobs/ links in HTML; GET /api/jobs -> 403', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'jobspresso', displayName: 'Jobspresso', category: 'remote-board',
    baseUrl: 'https://jobpresso.com',
    support: 'deferred', reason: 'Host unreachable from this network during probe (fetch failed).',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 45, concurrency: 1, rateLimitMs: 3000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /?s=devops -> fetch failed', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'yc-jobs', displayName: 'YC Work at a Startup', category: 'remote-board',
    baseUrl: 'https://www.workatastartup.com',
    support: 'deferred', reason: 'Public board exists but no documented public JSON API measured; HTML extraction not yet implemented.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 46, concurrency: 1, rateLimitMs: 3000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },

  // -----------------------------------------------------------------------
  // ATS PLATFORMS (6B) — public APIs where measured.
  // -----------------------------------------------------------------------
  {
    id: 'greenhouse', displayName: 'Greenhouse (Board API)', category: 'ats',
    baseUrl: 'https://boards-api.greenhouse.io',
    support: 'supported',
    reason: 'Official public Board API measured working (210 real jobs on gitlab board). Requires configured board tokens (GREENHOUSE_BOARD_TOKENS) or discovered company tokens.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 50, concurrency: 2, rateLimitMs: 1000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=false -> 200, 210 jobs', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'lever', displayName: 'Lever (Public Postings API)', category: 'ats',
    baseUrl: 'https://api.lever.co',
    support: 'supported',
    reason: 'Official public postings API measured working on boards that exist (spotify -> 200); unknown boards return a clean 404 (treated as no-jobs, not an error).',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 51, concurrency: 2, rateLimitMs: 1000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://api.lever.co/v0/postings/spotify?mode=json -> 200 with postings', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'ashby', displayName: 'Ashby (Posting API)', category: 'ats',
    baseUrl: 'https://api.ashbyhq.com',
    support: 'supported',
    reason: 'Official public posting-api measured working (dust board -> 23 jobs); unknown boards return 404/Not Found (cleanly handled).',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 52, concurrency: 2, rateLimitMs: 1000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://api.ashbyhq.com/posting-api/job-board/dust -> 200, 23 jobs', at: PROBE_AT, realJobsObserved: true },
  },
  {
    id: 'workable', displayName: 'Workable (Widget API)', category: 'ats',
    baseUrl: 'https://apply.workable.com',
    support: 'partial',
    reason: 'Account widget endpoint returns 200 JSON, but the jobs listing endpoints measured 404/400 (shortcode required) — job listing route not yet confirmed, so discovery stays disabled until measured.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 53, concurrency: 1, rateLimitMs: 1500, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET /api/v1/widget/accounts/automattic -> 200 (account only); /jobs endpoints -> 404 / 400 shortcode required', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'smartrecruiters', displayName: 'SmartRecruiters (Public API)', category: 'ats',
    baseUrl: 'https://api.smartrecruiters.com',
    support: 'partial',
    reason: 'Public company postings endpoint returns 200; SAP board measured 0 postings (company may use its own careers site). Works for boards that publish there.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: true },
    defaults: { enabled: false, priority: 54, concurrency: 1, rateLimitMs: 1500, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://api.smartrecruiters.com/v1/companies/SAP/postings?limit=5 -> 200, 0 postings', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'workday', displayName: 'Workday (CXS Public API)', category: 'ats',
    baseUrl: 'https://www.myworkdayjobs.com',
    support: 'deferred',
    reason: 'Workday exposes a public CXS JSON endpoint per tenant but no tenant was measured from this machine yet; deferred until a probe succeeds.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 55, concurrency: 1, rateLimitMs: 2000, timeoutMs: 20000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'icims', displayName: 'iCIMS', category: 'ats', baseUrl: 'https://www.icims.com',
    support: 'deferred', reason: 'Career-site HTML only; no public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 56, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'taleo', displayName: 'Taleo (Oracle)', category: 'ats', baseUrl: 'https://www.taleo.net',
    support: 'deferred', reason: 'Legacy career-section HTML/RSS; no public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 57, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'oracle-recruiting', displayName: 'Oracle Recruiting Cloud', category: 'ats', baseUrl: 'https://www.oracle.com/careers/',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 58, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'successfactors', displayName: 'SAP SuccessFactors', category: 'ats', baseUrl: 'https://www.sap.com/careers.html',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 59, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'bamboohr', displayName: 'BambooHR Job Boards', category: 'ats', baseUrl: 'https://www.bamboohr.com',
    support: 'deferred', reason: 'Public board JSON endpoint exists per tenant but no tenant measured from this machine yet.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 60, concurrency: 1, rateLimitMs: 1500, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'jobvite', displayName: 'Jobvite', category: 'ats', baseUrl: 'https://www.jobvite.com',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 61, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'recruitee', displayName: 'Recruitee', category: 'ats', baseUrl: 'https://recruitee.com',
    support: 'deferred', reason: 'API probe for a sample tenant returned 404; tenant slug required.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 62, concurrency: 1, rateLimitMs: 1500, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://api.recruitee.com/v1/offers/zapier -> 404', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'breezy', displayName: 'Breezy HR', category: 'ats', baseUrl: 'https://breezy.hr',
    support: 'deferred', reason: 'v1 API probe returned HTML instead of JSON for a sample tenant; correct tenant endpoint not confirmed.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 63, concurrency: 1, rateLimitMs: 1500, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://api.breezy.hr/v1/company/zapier/jobs -> HTML (not JSON)', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'jazzhr', displayName: 'JazzHR', category: 'ats', baseUrl: 'https://www.jazzhr.com',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 64, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'pinpoint', displayName: 'Pinpoint', category: 'ats', baseUrl: 'https://www.pinpointhq.com',
    support: 'deferred', reason: 'Public careers HTML; no JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 65, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'teamtailor', displayName: 'Teamtailor', category: 'ats', baseUrl: 'https://teamtailor.com',
    support: 'deferred', reason: 'Public careers HTML; no JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 66, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'rippling', displayName: 'Rippling', category: 'ats', baseUrl: 'https://www.rippling.com/careers',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 67, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'personio', displayName: 'Personio', category: 'ats', baseUrl: 'https://www.personio.com',
    support: 'deferred', reason: 'Public XML job feed endpoint exists (jobs.personio.de/xml) but the probe connection failed from this network; retry needed before enabling.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 68, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
    probeEvidence: { measured: 'GET https://jobs.personio.de/xml -> fetch failed (network)', at: PROBE_AT, realJobsObserved: false },
  },
  {
    id: 'comeet', displayName: 'Comeet', category: 'ats', baseUrl: 'https://comeet.com',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 69, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'dover', displayName: 'Dover', category: 'ats', baseUrl: 'https://www.dover.com',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 70, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'avature', displayName: 'Avature', category: 'ats', baseUrl: 'https://www.avature.net',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 71, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'eightfold', displayName: 'Eightfold AI', category: 'ats', baseUrl: 'https://eightfold.ai',
    support: 'deferred', reason: 'Career sites are JS-rendered; no public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 72, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'ukg', displayName: 'UKG (UltiPro)', category: 'ats', baseUrl: 'https://www.ukg.com',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 73, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'dayforce', displayName: 'Dayforce (Ceridian)', category: 'ats', baseUrl: 'https://www.dayforce.com',
    support: 'deferred', reason: 'No public JSON API measured.',
    capabilities: { discovery: 'none', completeJd: false, application: false, loginRequired: false, pagination: true, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 74, concurrency: 1, rateLimitMs: 2000, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },

  // -----------------------------------------------------------------------
  // DIRECT EMPLOYER CAREERS (6B/6J) — career pages routed by known ATS or
  // fetched as public HTML when configured via DIRECT_CAREER_SOURCES.
  // -----------------------------------------------------------------------
  {
    id: 'company-career', displayName: 'Direct Company Careers', category: 'direct-employer',
    support: 'partial',
    reason: 'Config-driven: configured career page URLs (DIRECT_CAREER_SOURCES) are fetched as public HTML. Detection of the underlying ATS sets the application route (6G).',
    capabilities: { discovery: 'html', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: true, applicationSupportedByDefault: true },
    defaults: { enabled: true, priority: 80, concurrency: 2, rateLimitMs: 2000, timeoutMs: 20000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },

  // -----------------------------------------------------------------------
  // INTERNAL / TEST SOURCES (never enabled implicitly outside tests).
  // -----------------------------------------------------------------------
  {
    id: 'mock', displayName: 'Mock (test fixtures)', category: 'internal',
    support: 'supported', reason: 'Deterministic fixtures for tests/benchmarks. Only enabled via onlyMock or explicit config — the Phase 2 bug (mock enabled alongside real adapters) cannot return.',
    capabilities: { discovery: 'api', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 98, concurrency: 1, rateLimitMs: 0, timeoutMs: 5000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
  {
    id: 'manual', displayName: 'Manual (user-provided URL)', category: 'internal',
    support: 'supported', reason: 'A URL explicitly provided by the user is ingested as a job.',
    capabilities: { discovery: 'html', completeJd: true, application: true, loginRequired: false, pagination: false, discoveryEnabledByDefault: false, applicationSupportedByDefault: false },
    defaults: { enabled: false, priority: 99, concurrency: 1, rateLimitMs: 0, timeoutMs: 15000, maxJobsPerSource: DEFAULT_MAX_JOBS },
  },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const byId = new Map(SOURCE_CATALOG.map(s => [s.id, s]));

export function getSourceDefinition(id: string): SourceDefinition | undefined {
  return byId.get(id);
}

/** Every source id known to the system (type-guard for JobSource). */
export const ALL_SOURCE_IDS: string[] = SOURCE_CATALOG.map(s => s.id);

export function isKnownSourceId(id: string): boolean {
  return byId.has(id);
}

/** Sources whose discovery is genuinely executable today (6T inputs). */
export function discoverableSources(): SourceDefinition[] {
  return SOURCE_CATALOG.filter(s => s.capabilities.discovery !== 'none');
}
