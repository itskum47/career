/**
 * Phase 6B — API-backed discovery adapters.
 *
 * These adapters call PUBLIC, documented JSON/RSS endpoints only:
 *   - Greenhouse Board API   boards-api.greenhouse.io
 *   - Lever Postings API     api.lever.co
 *   - Ashby Posting API      api.ashbyhq.com/posting-api
 *   - Remote OK API          remoteok.com/api
 *   - Remotive API           remotive.com/api
 *   - We Work Remotely RSS   weworkremotely.com/categories/.../rss
 *
 * No authentication, no scraping of protected pages, no anti-bot bypass.
 * Adapters return [] on failure — NEVER mock fallback (Phase 2 rule).
 */

import type { DiscoveredJob, DiscoveryCriteria, DiscoveryAdapter, VerificationResult } from './types.ts';
import { BaseDiscoveryAdapter } from './adapters.ts';
import { logger } from '../core/logger.ts';
import { generateJobId } from '../core/ids.ts';
import { createHash } from 'crypto';

const UA = { 'User-Agent': 'job-agent/1.0 (public job discovery; +https://github.com/)' };

/** Shared keyword/location filter used by API adapters. */
export function matchesCriteria(
  criteria: DiscoveryCriteria,
  fields: { title: string; description: string; location: string; remote?: boolean }
): boolean {
  if (criteria.keywords?.length) {
    const hay = `${fields.title} ${fields.description}`.toLowerCase();
    if (!criteria.keywords.some(k => hay.includes(k.toLowerCase()))) return false;
  }
  if (criteria.locations?.length) {
    const loc = fields.location.toLowerCase();
    // "Remote India" style entries are handled by the caller via remote flag;
    // here we do substring matching only against non-remote labels.
    const locTerms = criteria.locations.filter(l => !/^remote/i.test(l));
    if (locTerms.length && !locTerms.some(l => loc.includes(l.toLowerCase()))) {
      // Job may still match if it is remote and the criteria include a remote entry.
      const wantsRemote = criteria.locations.some(l => /^remote/i.test(l));
      if (!(wantsRemote && fields.remote)) return false;
    }
  }
  if (criteria.remote === true && fields.remote === false) return false;
  return true;
}

/** Decode common HTML entities (incl. escaped markup in RSS/HTML snippets). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function stripHtml(html: string): string {
  return decodeEntities(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.warn('Source API non-OK response', { url, status: res.status });
      return null;
    }
    return await res.json();
  } catch (error) {
    logger.warn('Source API fetch failed', { url, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------

export class GreenhouseApiAdapter extends BaseDiscoveryAdapter {
  readonly source = 'greenhouse';
  readonly name = 'Greenhouse Board API';

  constructor(private boards: string[] = []) { super(); }

  private resolveBoards(criteria: DiscoveryCriteria): string[] {
    if (this.boards.length) return this.boards;
    const cfgBoards = (criteria as { boards?: string[] }).boards;
    if (cfgBoards?.length) return cfgBoards;
    const env = process.env.GREENHOUSE_BOARD_TOKENS || '';
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const boards = this.resolveBoards(criteria);
    if (!boards.length) {
      logger.warn('Greenhouse: no board tokens configured', { hint: 'GREENHOUSE_BOARD_TOKENS or criteria.boards' });
      return [];
    }
    const jobs: DiscoveredJob[] = [];
    const timeoutMs = 15000;
    for (const board of boards) {
      const data = await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
        timeoutMs
      ) as { jobs?: any[] } | null;
      if (!data?.jobs) continue;
      for (const opening of data.jobs) {
        const title = opening.title || '';
        const location = opening.location?.name || '';
        const description = opening.content ? stripHtml(opening.content) : '';
        if (!matchesCriteria(criteria, { title, description, location, remote: /remote/i.test(location) })) continue;
        const url = opening.absolute_url || `https://boards.greenhouse.io/${board}/jobs/${opening.id}`;
        jobs.push({
          jobId: generateJobId('greenhouse', opening.company_name || board, title, `GH-${opening.id}`),
          company: opening.company_name || board,
          title,
          location: location || 'Not specified',
          remote: /remote/i.test(location) || /remote/i.test(title),
          remotePolicy: /remote/i.test(location) ? 'fully-remote' : undefined,
          url,
          source: 'greenhouse',
          postedAt: opening.updated_at ? new Date(opening.updated_at) : undefined,
          description: description || title,
          employmentType: opening.type || undefined,
          rawData: { sourceJobId: `GH-${opening.id}`, board, ats: 'greenhouse', firstPublished: opening.first_published },
        });
        if (criteria.maxResults && jobs.length >= criteria.maxResults) return jobs;
      }
    }
    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------

export class LeverPostingsAdapter extends BaseDiscoveryAdapter {
  readonly source = 'lever';
  readonly name = 'Lever Public Postings API';

  constructor(private boards: string[] = []) { super(); }

  private resolveBoards(criteria: DiscoveryCriteria): string[] {
    if (this.boards.length) return this.boards;
    const cfg = (criteria as { boards?: string[] }).boards;
    if (cfg?.length) return cfg;
    return (process.env.LEVER_POSTING_BOARDS || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const boards = this.resolveBoards(criteria);
    if (!boards.length) {
      logger.warn('Lever: no company boards configured', { hint: 'LEVER_POSTING_BOARDS' });
      return [];
    }
    const jobs: DiscoveredJob[] = [];
    for (const board of boards) {
      const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`, 15000);
      if (!Array.isArray(data)) continue; // 404 -> unknown board -> clean empty
      for (const posting of data as any[]) {
        const title = posting.text || '';
        const location = posting.categories?.location || '';
        const description = [posting.description, posting.descriptionPlain, ...(posting.lists || []).map((l: any) => l.text)]
          .filter(Boolean).join('\n ');
        if (!matchesCriteria(criteria, { title, description, location, remote: posting.workplaceType === 'remote' })) continue;
        jobs.push({
          jobId: generateJobId('lever', posting.company || board, title, `LV-${posting.id}`),
          company: posting.company || board,
          title,
          location: location || 'Not specified',
          remote: posting.workplaceType === 'remote' || /remote/i.test(location),
          remotePolicy: posting.workplaceType === 'remote' ? 'fully-remote' : undefined,
          url: posting.hostedUrl || posting.applyUrl,
          source: 'lever',
          postedAt: posting.createdAt ? new Date(posting.createdAt) : undefined,
          description: stripHtml(description) || title,
          salary: posting.salaryRange ? `${posting.salaryRange.min} - ${posting.salaryRange.max} ${posting.salaryRange.currency}` : undefined,
          employmentType: posting.type || undefined,
          rawData: { sourceJobId: `LV-${posting.id}`, board, ats: 'lever', applyUrl: posting.applyUrl },
        });
        if (criteria.maxResults && jobs.length >= criteria.maxResults) return jobs;
      }
    }
    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// Ashby
// ---------------------------------------------------------------------------

export class AshbyPostingAdapter extends BaseDiscoveryAdapter {
  readonly source = 'ashby';
  readonly name = 'Ashby Posting API';

  constructor(private boards: string[] = []) { super(); }

  private resolveBoards(criteria: DiscoveryCriteria): string[] {
    if (this.boards.length) return this.boards;
    const cfg = (criteria as { boards?: string[] }).boards;
    if (cfg?.length) return cfg;
    return (process.env.ASHBY_POSTING_BOARDS || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const boards = this.resolveBoards(criteria);
    if (!boards.length) {
      logger.warn('Ashby: no job boards configured', { hint: 'ASHBY_POSTING_BOARDS' });
      return [];
    }
    const jobs: DiscoveredJob[] = [];
    for (const board of boards) {
      const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`, 15000) as { jobs?: any[] } | null;
      if (!data?.jobs) continue;
      for (const job of data.jobs) {
        const title = job.title || '';
        const location = job.location || '';
        const description = job.descriptionPlain || job.descriptionHtml || '';
        const remote = job.isRemote || job.workplaceType === 'remote';
        if (!matchesCriteria(criteria, { title, description, location, remote })) continue;
        jobs.push({
          jobId: generateJobId('ashby', board, title, `AB-${job.id}`),
          company: board,
          title,
          location: location || 'Not specified',
          remote,
          remotePolicy: remote ? 'fully-remote' : undefined,
          url: job.jobUrl || job.applyUrl,
          source: 'ashby',
          postedAt: job.publishedAt ? new Date(job.publishedAt) : undefined,
          description: stripHtml(description) || title,
          employmentType: job.employmentType || undefined,
          salary: job.compensation?.compensationTierSummary || undefined,
          rawData: { sourceJobId: `AB-${job.id}`, board, ats: 'ashby', applyUrl: job.applyUrl },
        });
        if (criteria.maxResults && jobs.length >= criteria.maxResults) return jobs;
      }
    }
    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// Remote OK
// ---------------------------------------------------------------------------

export class RemoteOKAdapter extends BaseDiscoveryAdapter {
  readonly source = 'remoteok';
  readonly name = 'Remote OK API';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const data = await fetchJson('https://remoteok.com/api', 15000);
    if (!Array.isArray(data)) return [];
    const jobs: DiscoveredJob[] = [];
    for (const item of data as any[]) {
      if (!item || typeof item !== 'object' || !('position' in item)) continue; // first element is legal notice
      const title = item.position || '';
      const location = item.location || 'Remote';
      const description = stripHtml(item.description || '') || title;
      if (!matchesCriteria(criteria, { title, description, location, remote: true })) continue;
      const url = item.url || item.apply_url || `https://remoteok.com/jobs/${item.id}`;
      jobs.push({
        jobId: generateJobId('remoteok', item.company || 'unknown', title, `RO-${item.id}`),
        company: item.company || 'Unknown',
        title,
        location: location || 'Remote',
        remote: true,
        remotePolicy: 'fully-remote',
        url,
        source: 'remoteok',
        postedAt: item.date ? new Date(item.date) : undefined,
        description,
        salary: item.salary_min ? `${item.salary_min} - ${item.salary_max}` : undefined,
        employmentType: item.type || undefined,
        rawData: {
          sourceJobId: `RO-${item.id}`,
          // RemoteOK is a board, not an ATS — never label it as one (6G).
          ...(item.apply_url ? { applicationUrl: item.apply_url } : {}),
          tags: item.tags,
          legal: item.legal,
        },
      });
      if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
    }
    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// Remotive
// ---------------------------------------------------------------------------

export class RemotiveAdapter extends BaseDiscoveryAdapter {
  readonly source = 'remotive';
  readonly name = 'Remotive API';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const params = new URLSearchParams({ limit: String(criteria.maxResults ?? 50) });
    if (criteria.keywords?.length) params.set('search', criteria.keywords.join(' '));
    const data = await fetchJson(`https://remotive.com/api/remote-jobs?${params.toString()}`, 15000) as { jobs?: any[] } | null;
    if (!data?.jobs) return [];
    const jobs: DiscoveredJob[] = [];
    for (const item of data.jobs) {
      const title = item.title || '';
      const location = item.candidate_required_location || 'Remote';
      const description = stripHtml(item.description || '') || title;
      if (!matchesCriteria(criteria, { title, description, location, remote: true })) continue;
      jobs.push({
        jobId: generateJobId('remotive', item.company_name || 'unknown', title, `RM-${item.id}`),
        company: item.company_name || 'Unknown',
        title,
        location: location || 'Remote',
        remote: true,
        remotePolicy: 'fully-remote',
        url: item.url || `https://remotive.com/remote-jobs/${item.id}`,
        source: 'remotive',
        postedAt: item.publication_date ? new Date(item.publication_date) : undefined,
        description,
        salary: item.salary || undefined,
        rawData: { sourceJobId: `RM-${item.id}`, category: item.category, tags: item.tags },
      });
      if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
    }
    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// We Work Remotely (public RSS)
// ---------------------------------------------------------------------------

/** Trailing parens are a location ONLY when they look like one — "(Python)"
 *  and "(Node.js / Nest.js)" are skill discriminators, not locations. */
const WWR_LOCATION_WORDS = /^(remote|anywhere|worldwide|global|hybrid|india|united states|usa|us|uk|eu|europe|emea|apac|latam|americas?|north america|south america|asia|australia)$/i;
const WWR_LOCATION_CODES = /^[A-Z]{2}(?:\s*,\s*[A-Z]{2})*$/;

/** Parse "Company: Role (Location?)" — measured 25/25 colon-format titles on
 *  2026-10-07. Split on the FIRST colon so dashes inside role titles never
 *  leak into the company name. Pure function (unit-testable, 6U). */
export function parseWwrTitle(rawTitle: string): { company: string; title: string; locSuffix?: string } {
  const colonIdx = rawTitle.indexOf(': ');
  const dashIdx = rawTitle.indexOf(' - ');
  let company: string, jobTitle: string;
  if (colonIdx > 0) { company = rawTitle.slice(0, colonIdx); jobTitle = rawTitle.slice(colonIdx + 2); }
  else if (dashIdx > 0) { company = rawTitle.slice(0, dashIdx); jobTitle = rawTitle.slice(dashIdx + 3); }
  else { company = 'Unknown'; jobTitle = rawTitle; }
  const suffix = jobTitle.match(/\s*\(([^)]{1,40})\)\s*$/)?.[1]?.trim();
  const locSuffix = suffix && (WWR_LOCATION_WORDS.test(suffix) || WWR_LOCATION_CODES.test(suffix)) ? suffix : undefined;
  if (locSuffix) jobTitle = jobTitle.replace(/\s*\([^)]{1,40}\)\s*$/, '').trimEnd();
  return { company: company.trim(), title: jobTitle.trim(), locSuffix };
}

/** Extract Headquarters text + employer application link from a decoded WWR
 *  description. Pure function (unit-testable, 6U). */
export function parseWwrDescription(decodedDesc: string): { hq?: string; employerUrl?: string } {
  const urlAnchor = decodedDesc.match(/URL:(?:<\/?[^>]*>)?\s*<a[^>]*href=(["'])([^"']+)\1/i)?.[2];
  const urlPlain = decodedDesc.match(/URL:(?:<\/?[^>]*>)?\s*(https?:\/\/[^\s<"']+)/i)?.[1];
  const employerUrl = (urlAnchor || urlPlain) || undefined;
  const hq = decodedDesc.match(/Headquarters:(?:<\/?[^>]*>)?\s*([^\s<][^<\n]{0,59})/i)?.[1]?.trim() || undefined;
  return { hq, employerUrl };
}

export class WWRssAdapter extends BaseDiscoveryAdapter {
  readonly source = 'weworkremotely';
  readonly name = 'We Work Remotely RSS';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    // Public RSS feed (measured 200 / 25 items). Category slugs vary; search feed covers all.
    const url = 'https://weworkremotely.com/categories/remote-programming-jobs.rss';
    try {
      const res = await fetch(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml', ...UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { logger.warn('WWR RSS non-OK', { status: res.status }); return []; }
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
      const jobs: DiscoveredJob[] = [];
      for (const item of items) {
        const rawTitle = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/))?.[1] || '';
        const title = decodeEntities(rawTitle).trim();
        const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
        const rawDesc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
        const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
        if (!title || !link) continue;
        const desc = stripHtml(rawDesc);

        const { company, title: jobTitle, locSuffix } = parseWwrTitle(title);

        // Description carries escaped markup: decode first, then extract the
        // "Headquarters:" value and the employer application link ("URL:").
        const { hq, employerUrl } = parseWwrDescription(decodeEntities(rawDesc));

        // Prefer the explicit title suffix; fall back to a Headquarters value
        // only when it actually mentions remote work (an HQ city is not a job
        // location claim). Otherwise "Remote" stays neutral — India
        // eligibility is NEVER assumed from it (6D).
        const location = (/anywhere/i.test(locSuffix || '') ? 'Remote'
          : locSuffix) || (hq && /remote|anywhere/i.test(hq) ? hq : undefined) || 'Remote';

        if (!matchesCriteria(criteria, { title: jobTitle, description: desc, location, remote: true })) continue;
        // Unique per listing link — a truncated base64 prefix collided
        // across every job on the same domain (false-merge risk in 6F).
        const wwrSourceJobId = `WWR-${createHash('sha256').update(link).digest('hex').slice(0, 16)}`;
        jobs.push({
          jobId: generateJobId('weworkremotely', company || 'unknown', jobTitle, wwrSourceJobId),
          company: (company || 'Unknown').trim(),
          title: jobTitle.trim(),
          location,
          remote: true,
          remotePolicy: 'fully-remote',
          url: link,
          source: 'weworkremotely',
          postedAt: pubDate ? new Date(pubDate) : undefined,
          description: desc || jobTitle,
          rawData: {
            sourceJobId: wwrSourceJobId,
            ...(employerUrl ? { applicationUrl: employerUrl } : {}),
          },
        });
        if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
      }
      this.logDiscovery(jobs.length, criteria);
      return jobs;
    } catch (error) {
      logger.warn('WWR RSS failed', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }
}
