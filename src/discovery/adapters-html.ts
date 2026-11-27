/**
 * Phase 6B — HTML discovery adapters for sources whose PUBLIC listing pages
 * are server-rendered (measured: HTTP 200 + job links present).
 *
 * These adapters read only publicly served HTML with a plain HTTP GET.
 * They never solve challenges, never authenticate, never replay protected
 * APIs. If a page stops serving listings, the adapter returns [] and the
 * catalog's capability is downgraded — no mock fallback, ever.
 */

import type { DiscoveredJob, DiscoveryCriteria } from './types.ts';
import { BaseDiscoveryAdapter } from './adapters.ts';
import { matchesCriteria } from './adapters-api.ts';
import { logger } from '../core/logger.ts';
import { generateJobId } from '../core/ids.ts';

const UA = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchHtml(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) {
      logger.warn('Source HTML non-OK', { url, status: res.status });
      return null;
    }
    return await res.text();
  } catch (error) {
    logger.warn('Source HTML fetch failed', { url, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function slugToTitle(slug: string): string {
  return decodeURIComponent(slug).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Shine — search page exposes /jobs/{title-slug}/{company-slug}/{numericId}
// Measured: GET https://www.shine.com/job-search/devops-jobs -> 200 with
// server-rendered links; detail page 200 with full JD text.
// ---------------------------------------------------------------------------

export class ShineHtmlAdapter extends BaseDiscoveryAdapter {
  readonly source = 'shine';
  readonly name = 'Shine public search HTML';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const keywords = criteria.keywords?.length ? criteria.keywords : ['devops'];
    const jobs: DiscoveredJob[] = [];
    const seen = new Set<string>();

    for (const kw of keywords) {
      const url = `https://www.shine.com/job-search/${encodeURIComponent(kw.toLowerCase().replace(/\s+/g, '-'))}-jobs`;
      const html = await fetchHtml(url, 20000);
      if (!html) continue;

      // Server-rendered job cards: <a href="/jobs/<title>/<company>/<id>?position_in_results=N">
      const re = /<a[^>]+href="(\/jobs\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\d+)[^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const path = m[1];
        const titleSlug = m[2];
        const companySlug = m[3];
        const id = m[4];
        const anchorText = stripTags(m[5] || '');
        if (seen.has(id)) continue;

        const title = slugToTitle(titleSlug);
        const company = slugToTitle(companySlug);
        if (title.length < 4 || company.length < 2) continue;

        // Prefer richer anchor text (contains title) when present.
        const displayTitle = anchorText && anchorText.length >= title.length ? anchorText.split('\n')[0].trim() : title;
        const location = anchorText.match(/\b(Pune|Bengaluru|Bangalore|Hyderabad|Gurgaon|Gurugram|Noida|Delhi|Mumbai|Chennai|Kolkata|Jaipur|Ahmedabad|Kochi|Chandigarh|Coimbatore|India|Remote)\b/i)?.[1] || '';

        if (!matchesCriteria(criteria, { title: displayTitle, description: anchorText, location, remote: /remote/i.test(displayTitle) })) continue;

        seen.add(id);
        const jobUrl = `https://www.shine.com${path.split('?')[0]}`;
        jobs.push({
          jobId: generateJobId('shine', company, displayTitle, jobUrl),
          company,
          title: displayTitle,
          location: location || 'Not specified',
          remote: /remote/i.test(displayTitle) || /remote/i.test(location),
          url: jobUrl,
          source: 'shine',
          description: anchorText || displayTitle,
          rawData: { sourceJobId: `SH-${id}`, ats: 'shine' },
        });
        if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
      }
      if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
      // Be a polite public fetcher (6M): one request per keyword at catalog rate.
      await new Promise(r => setTimeout(r, 1500));
    }

    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// Apna — public jobs page exposes /job/{city}/{title-slug}-{numericId}
// Measured: GET https://apna.co/jobs -> 200 with links; detail 200 with JD.
// ---------------------------------------------------------------------------

export class ApnaHtmlAdapter extends BaseDiscoveryAdapter {
  readonly source = 'apna';
  readonly name = 'Apna public jobs HTML';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const url = 'https://apna.co/jobs';
    const html = await fetchHtml(url, 20000);
    if (!html) return [];
    const jobs: DiscoveredJob[] = [];
    const seen = new Set<string>();

    const re = /<a[^>]+href="(\/job\/([a-z0-9-]+)\/([a-z0-9-]+?)-(\d{6,}))"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const [, path, citySlug, titleSlug, id] = m;
      if (seen.has(id)) continue;
      const title = slugToTitle(titleSlug);
      const location = slugToTitle(citySlug);
      if (title.length < 4) continue;
      if (!matchesCriteria(criteria, { title, description: title, location, remote: false })) continue;
      seen.add(id);
      // Company is not in the URL; leave for JD retrieval to fill (6H).
      jobs.push({
        jobId: generateJobId('apna', citySlug, title, `AP-${id}`),
        company: 'Unknown (from listing)',
        title,
        location: location || 'Not specified',
        remote: false,
        url: `https://apna.co${path}`,
        source: 'apna',
        description: title,
        rawData: { sourceJobId: `AP-${id}`, ats: 'apna' },
      });
      if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
    }

    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}

// ---------------------------------------------------------------------------
// Freshersworld — category pages expose <city>-jobs/<numericId> style links
// plus h3 company names in the same card. Measured 200 with 50 detail links.
// ---------------------------------------------------------------------------

export class FreshersworldHtmlAdapter extends BaseDiscoveryAdapter {
  readonly source = 'freshersworld';
  readonly name = 'Freshersworld public category HTML';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const url = 'https://www.freshersworld.com/jobs/category/it-software-job-vacancies';
    const html = await fetchHtml(url, 20000);
    if (!html) return [];
    const jobs: DiscoveredJob[] = [];
    const seen = new Set<string>();

    // Job cards: <a href="https://www.freshersworld.com/<slug>/<numericId>"> with title text
    const re = /<a[^>]+href="(https?:\/\/www\.freshersworld\.com\/([a-z0-9-]+)\/(\d{6,}))"[^>]*>([\s\S]{10,300}?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const [, link, slug, id, inner] = m;
      if (/jobs-vacancies|training-institutes|jobs-in-/.test(slug)) continue;
      if (seen.has(id)) continue;
      const text = stripTags(inner);
      if (text.length < 10) continue;
      const location = text.match(/\b(Pune|Bengaluru|Bangalore|Hyderabad|Gurgaon|Noida|Delhi|Mumbai|Chennai|Kolkata|Jaipur|Ahmedabad|Kochi|Chandigarh|India|Remote)\b/i)?.[1] || '';
      if (!matchesCriteria(criteria, { title: text, description: text, location, remote: false })) continue;
      seen.add(id);
      jobs.push({
        jobId: generateJobId('freshersworld', slug, text.slice(0, 60), link),
        company: 'Unknown (from listing)',
        title: text.split('|')[0].trim().slice(0, 120),
        location: location || 'India',
        remote: false,
        url: link,
        source: 'freshersworld',
        description: text,
        rawData: { sourceJobId: `FW-${id}`, ats: 'freshersworld' },
      });
      if (criteria.maxResults && jobs.length >= criteria.maxResults) break;
    }

    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }
}
