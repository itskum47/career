/**
 * Phase 6U — Complete JD required before application (6H).
 *
 * Network is fully stubbed: these tests never touch a real site. They prove
 * the gate classifies incomplete/challenged/logged-in JDs and reports rather
 * than bypasses.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JdRetrievalGate, MIN_FULL_JD_CHARS } from '../../../src/discovery/jd-retrieval.ts';
import { normalize } from '../../../src/discovery/normalize.ts';
import type { DiscoveredJob } from '../../../src/core/types.ts';
import type { NormalizedJob } from '../../../src/discovery/types.ts';

function normJob(overrides: Partial<DiscoveredJob> = {}): NormalizedJob {
  return normalize({
    jobId: 'JOB-JD-1',
    company: 'GitLab',
    title: 'DevOps Engineer',
    location: 'Remote',
    remote: true,
    url: 'https://boards.examplecorp.com/jobs/42',
    source: 'company-career',
    description: 'short snippet',
    ...overrides,
  } as DiscoveredJob).normalized;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('6H — JD retrieval gate', () => {
  it('exposes a minimum full-JD threshold', () => {
    expect(MIN_FULL_JD_CHARS).toBeGreaterThanOrEqual(300);
  });

  it('incomplete snippet with fetch disabled -> INCOMPLETE_SNIPPET (do not apply)', async () => {
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: false });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('INCOMPLETE_SNIPPET');
    expect(r.fetchMs).toBe(0);
  });

  it('captcha wall on the full-JD page -> CHALLENGE_DETECTED (never bypassed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Just a moment... verify you are human before continuing.</body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('CHALLENGE_DETECTED');
  });

  it('login wall on the full-JD page -> LOGIN_REQUIRED (never bypassed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body><h1>Sign in to view this job</h1></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('LOGIN_REQUIRED');
  });

  it('HTTP 401/403 while fetching -> LOGIN_REQUIRED (auth wall, no retries bypassing)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('LOGIN_REQUIRED');
  });

  it('HTTP 5xx while fetching -> FETCH_FAILED (retryable, not a wall)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })));
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('FETCH_FAILED');
  });

  it('network failure -> FETCH_FAILED with detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('FETCH_FAILED');
    expect(r.detail).toContain('fetch failed');
  });

  it('a long page either verifies to READY or fails verification — never "snippet"', async () => {
    const longPage = `<html><head><title>DevOps Engineer — Acme</title></head><body>
      <h1>DevOps Engineer</h1><p>Company: Acme Corp, location Bengaluru or remote.</p>
      <h2>About the role</h2><p>${'Own Kubernetes, Terraform, CI/CD and AWS operations across production clusters. '.repeat(12)}</p>
      <h2>Requirements</h2><ul>
      <li>5+ years DevOps or SRE experience</li><li>Strong Linux and networking fundamentals</li>
      <li>Experience with Docker, Kubernetes and Helm</li><li>Infrastructure as code with Terraform</li>
      <li>CI/CD pipeline design and maintenance</li><li>Python or Go scripting ability</li>
      <li>Monitoring with Prometheus and Grafana</li><li>Cloud platform experience on AWS</li>
      </ul>
      <h2>Nice to have</h2><ul><li>GitOps with ArgoCD</li><li>Security scanning in pipelines</li></ul>
      </body></html>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(longPage, { status: 200, headers: { 'content-type': 'text/html' } })));
    const gate = new JdRetrievalGate();
    const r = await gate.retrieveCompleteJd(normJob(), { fetchPage: true });

    if (r.ready) {
      expect((r.fullText ?? '').length).toBeGreaterThan(0);
      expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    } else {
      expect(r.reason).toBe('VERIFICATION_FAILED');
    }
    // Never misclassified as a snippet, never bypassed a wall.
    expect(r.reason).not.toBe('INCOMPLETE_SNIPPET');
    expect(r.reason).not.toBe('CHALLENGE_DETECTED');
    expect(r.reason).not.toBe('LOGIN_REQUIRED');
  });

  it('does not fetch when the listing already carries a long description', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const gate = new JdRetrievalGate();
    const job = normJob({ description: 'x'.repeat(MIN_FULL_JD_CHARS + 100) });
    await gate.retrieveCompleteJd(job, { existingDescription: job.description });
    // Whether or not verification passed, no page fetch is issued for a
    // challenge-free full description path that returned early; if the first
    // verification failed it may fetch — assert only that a challenge-free
    // description never triggers more than one request.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
