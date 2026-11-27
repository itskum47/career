/**
 * Phase 6H — Complete JD retrieval gate.
 *
 * Pipeline enforced by retrieveCompleteJd():
 *   job discovered -> full JD fetched -> JD extraction -> JD verification
 *   -> (downstream) JD analysis -> matching -> artifacts -> application
 *
 * A listing is NOT application-ready until the complete JD is available:
 *   - search snippets, preview cards, title-only records => INCOMPLETE
 *   - fetch failure, short content, verification failure => INCOMPLETE
 *
 * When the complete JD cannot be retrieved reliably: DO NOT APPLY.
 * The job is classified (INCOMPLETE_SNIPPET / FETCH_FAILED / VERIFICATION_FAILED
 * / LOGIN_REQUIRED / CHALLENGE_DETECTED) and retained for tracking.
 */

import { JDExtractor } from '../jd/extractor.ts';
import { JDVerifier } from '../jd/verifier.ts';
import type { NormalizedJob } from './types.ts';
import { logger } from '../core/logger.ts';

export type JdIncompleteReason =
  | 'INCOMPLETE_SNIPPET'     // description too short to be a JD
  | 'FETCH_FAILED'           // full page could not be fetched
  | 'VERIFICATION_FAILED'    // fetched but JD verification failed
  | 'LOGIN_REQUIRED'         // full JD sits behind authentication
  | 'CHALLENGE_DETECTED';    // CAPTCHA/anti-bot challenge in the way

export interface JdRetrievalResult {
  ready: boolean;
  reason?: JdIncompleteReason;
  detail?: string;
  /** Complete JD text when ready. */
  fullText?: string;
  /** Extracted + verified job description (ready path only). */
  jobDescription?: unknown;
  confidence?: number;
  /** ms spent fetching (measured, 6T metrics). */
  fetchMs: number;
}

/** Minimum believable full-JD length (chars of visible text). */
export const MIN_FULL_JD_CHARS = 400;

const CHALLENGE_MARKERS = /captcha|recaptcha|hcaptcha|cf-challenge|verify you are human|unusual traffic|access denied|are you a robot/i;
const LOGIN_MARKERS = /sign in to (?:view|apply)|log in to (?:view|apply)|login required|members only/i;

export class JdRetrievalGate {
  private extractor = new JDExtractor();
  private verifier = new JDVerifier();

  /**
   * Retrieve + verify the complete JD for a normalized job.
   * `existingDescription` is whatever the listing already carried (may be a
   * snippet). Fetch uses plain public GET with a polite UA; no auth, no
   * challenge solving — challenges are reported, never bypassed (6L).
   */
  async retrieveCompleteJd(
    job: NormalizedJob,
    options: { fetchPage?: boolean; existingDescription?: string } = {}
  ): Promise<JdRetrievalResult> {
    const fetchPage = options.fetchPage ?? true;
    const snippet = (options.existingDescription ?? job.description ?? '').trim();

    // Step 1: do we already carry a complete JD (e.g. API sources with content)?
    if (snippet.length >= MIN_FULL_JD_CHARS && !CHALLENGE_MARKERS.test(snippet) && !LOGIN_MARKERS.test(snippet)) {
      const verified = await this.verifyText(job, snippet);
      if (verified.ready) return { ...verified, fetchMs: 0 };
    }

    if (!fetchPage) {
      return {
        ready: false, reason: 'INCOMPLETE_SNIPPET',
        detail: `description ${snippet.length} chars (< ${MIN_FULL_JD_CHARS}) and fetch disabled`,
        fetchMs: 0,
      };
    }

    // Step 2: fetch the full page (public GET only).
    const t0 = Date.now();
    let html: string | null = null;
    try {
      const res = await fetch(job.sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) html = await res.text();
      else {
        return {
          ready: false,
          reason: res.status === 401 || res.status === 403 ? 'LOGIN_REQUIRED' : 'FETCH_FAILED',
          detail: `HTTP ${res.status} fetching ${job.sourceUrl}`,
          fetchMs: Date.now() - t0,
        };
      }
    } catch (error) {
      return {
        ready: false, reason: 'FETCH_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        fetchMs: Date.now() - t0,
      };
    }
    const fetchMs = Date.now() - t0;

    if (!html) return { ready: false, reason: 'FETCH_FAILED', detail: 'empty response', fetchMs };

    // Step 3: challenge / login walls are reported, NEVER bypassed (6L).
    const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (CHALLENGE_MARKERS.test(visibleText.slice(0, 5000))) {
      logger.warn('JD retrieval hit a challenge — not bypassed', { source: job.source, url: job.sourceUrl });
      return { ready: false, reason: 'CHALLENGE_DETECTED', detail: 'anti-bot challenge on full JD page', fetchMs };
    }
    if (LOGIN_MARKERS.test(visibleText.slice(0, 5000))) {
      return { ready: false, reason: 'LOGIN_REQUIRED', detail: 'full JD behind login', fetchMs };
    }

    // Step 4: extraction + verification (existing Phase 2/3 machinery).
    if (visibleText.trim().length < MIN_FULL_JD_CHARS) {
      return { ready: false, reason: 'INCOMPLETE_SNIPPET', detail: `page text ${visibleText.trim().length} chars`, fetchMs };
    }
    return { ...await this.verifyText(job, html, fetchMs), fetchMs };
  }

  private async verifyText(job: NormalizedJob, htmlOrText: string, fetchMs = 0): Promise<Omit<JdRetrievalResult, 'fetchMs'> & { fetchMs?: number }> {
    try {
      const extraction = this.extractor.extract({ html: htmlOrText, url: job.sourceUrl });
      const verification = await this.verifier.verify(extraction.jobDescription);
      if (!verification.verified) {
        return {
          ready: false, reason: 'VERIFICATION_FAILED',
          detail: `confidence ${verification.confidence.toFixed(2)} < 0.60; issues: ${verification.issues.slice(0, 3).join('; ')}`,
          fetchMs,
        };
      }
      const fullText = extraction.jobDescription.fullText || htmlOrText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return {
        ready: true,
        fullText,
        jobDescription: extraction.jobDescription,
        confidence: verification.confidence,
        fetchMs,
      };
    } catch (error) {
      return {
        ready: false, reason: 'VERIFICATION_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        fetchMs,
      };
    }
  }
}

export const jdRetrievalGate = new JdRetrievalGate();
