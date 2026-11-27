/**
 * Phase 6U — Per-source rate limits, retry classification, degradation (6M)
 * and health metrics (6N).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyFailure,
  SourceHealthTracker,
  emptyMetrics,
} from '../../../src/discovery/health.ts';
import type { RateLimitPolicy } from '../../../src/discovery/types.ts';

const POLICY: RateLimitPolicy = {
  rateLimitMs: 100,
  failureThreshold: 3,
  cooldownMs: 60_000,
  retryAttempts: 2,
  retryDelayMs: 50,
  concurrency: 1,
};

describe('6M — failure classification (retry only what is safe to retry)', () => {
  it('classifies HTTP statuses', () => {
    expect(classifyFailure({ status: 429 })).toBe('rate-limited');
    expect(classifyFailure({ status: 401 })).toBe('login');
    expect(classifyFailure({ status: 403 })).toBe('challenge');
    expect(classifyFailure({ status: 404 })).toBe('permanent');
    expect(classifyFailure({ status: 410 })).toBe('permanent');
    expect(classifyFailure({ status: 451 })).toBe('permanent');
    expect(classifyFailure({ status: 500 })).toBe('retryable');
    expect(classifyFailure({ status: 503 })).toBe('retryable');
    expect(classifyFailure({ status: 400 })).toBe('permanent');
  });

  it('classifies network errors as retryable and anti-bot text as challenge', () => {
    expect(classifyFailure({ error: 'ETIMEDOUT after 20s' })).toBe('retryable');
    expect(classifyFailure({ error: 'ECONNRESET' })).toBe('retryable');
    expect(classifyFailure({ error: 'fetch failed: network down' })).toBe('retryable');
    expect(classifyFailure({ error: 'Unexpected token captcha challenge' })).toBe('challenge');
    expect(classifyFailure({ error: 'Access Denied by WAF' })).toBe('challenge');
  });
});

describe('6M — rate limit, cooldown, degradation', () => {
  let tracker: SourceHealthTracker;

  beforeEach(() => {
    tracker = new SourceHealthTracker();
    tracker.register('src-a', POLICY);
  });

  it('enforces the per-source minimum interval between requests', async () => {
    const first = await tracker.acquire('src-a');
    expect(first.waitedMs).toBe(0);
    const second = await tracker.acquire('src-a');
    // ~100ms required; allow generous slack for scheduler jitter.
    expect(second.waitedMs).toBeGreaterThan(40);
    expect(tracker.get('src-a').requestsAttempted).toBe(2);
  });

  it('records searches, normalized jobs, and latency (6N metrics)', () => {
    tracker.recordSearchStarted('src-a');
    tracker.recordSearchCompleted('src-a', 5, 120);
    tracker.recordJobsNormalized('src-a', 5, 4, 1);

    const m = tracker.get('src-a');
    expect(m.searchesAttempted).toBe(1);
    expect(m.searchesCompleted).toBe(1);
    expect(m.jobsDiscovered).toBe(5);
    expect(m.jobsNormalized).toBe(5);
    expect(m.uniqueJobs).toBe(4);
    expect(m.duplicates).toBe(1);
    expect(m.latenciesMs).toEqual([120]);

    const s = tracker.summary().find(x => x.source === 'src-a')!;
    expect(s.avgLatencyMs).toBe(120);
    expect(s.failureRate).toBe(0);
    expect(s.state).toBe('healthy');
  });

  it('retryable failures: retries while under threshold, then DEGRADES', () => {
    const f1 = tracker.recordFailure('src-a', 'retryable', 'timeout');
    expect(f1.shouldRetry).toBe(true);
    expect(tracker.get('src-a').state).toBe('healthy');
    expect(tracker.get('src-a').timeouts).toBe(1);

    const f2 = tracker.recordFailure('src-a', 'retryable', 'timeout');
    expect(f2.shouldRetry).toBe(true);

    const f3 = tracker.recordFailure('src-a', 'retryable', 'timeout');
    expect(f3.shouldRetry).toBe(false);
    expect(tracker.get('src-a').state).toBe('degraded');
    expect(tracker.inCooldown('src-a')).toBe(true);
    expect(tracker.get('src-a').failures).toBe(3);
  });

  it('permanent failures are never retried and mark the source down', () => {
    const r = tracker.recordFailure('src-a', 'permanent', 'HTTP 404');
    expect(r.shouldRetry).toBe(false);
    expect(tracker.get('src-a').state).toBe('down');
    expect(tracker.inCooldown('src-a')).toBe(true);
  });

  it('challenge failures count as CAPTCHA interruptions and are never retried', () => {
    const r = tracker.recordFailure('src-a', 'challenge', 'recaptcha wall');
    expect(r.shouldRetry).toBe(false);
    expect(tracker.get('src-a').captchaInterruptions).toBe(1);
    expect(tracker.inCooldown('src-a')).toBe(true);
  });

  it('login failures count as login interruptions and are never retried', () => {
    const r = tracker.recordFailure('src-a', 'login', 'HTTP 401');
    expect(r.shouldRetry).toBe(false);
    expect(tracker.get('src-a').loginInterruptions).toBe(1);
  });

  it('rate limiting backs off and marks cooldown (retry later, not now)', () => {
    const r = tracker.recordFailure('src-a', 'rate-limited', 'HTTP 429');
    expect(r.shouldRetry).toBe(true);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(5000);
    expect(tracker.get('src-a').state).toBe('cooldown');
    expect(tracker.inCooldown('src-a')).toBe(true);
  });

  it('a successful search recovers a degraded source', () => {
    tracker.recordFailure('src-a', 'retryable', 'timeout');
    tracker.recordFailure('src-a', 'retryable', 'timeout');
    tracker.recordFailure('src-a', 'retryable', 'timeout');
    expect(tracker.get('src-a').state).toBe('degraded');

    tracker.recordSearchStarted('src-a');
    tracker.recordSearchCompleted('src-a', 3, 80);
    const m = tracker.get('src-a');
    expect(m.state).toBe('healthy');
    expect(tracker.inCooldown('src-a')).toBe(false);
  });

  it('summary reports JD/route/application rates for the orchestrator (6N)', () => {
    tracker.recordJdRetrieval('src-a', true);
    tracker.recordJdRetrieval('src-a', false);
    tracker.recordRouteResolution('src-a', true);
    tracker.recordApplication('src-a', true);
    tracker.recordApplication('src-a', false);

    const s = tracker.summary().find(x => x.source === 'src-a')!;
    expect(s.jdRetrievalRate).toBeCloseTo(0.5, 5);
    expect(s.routeResolutionRate).toBe(1);
    expect(s.applicationRate).toBeCloseTo(0.5, 5);
    expect(s.timeoutRate).toBe(0);
  });

  it('emptyMetrics starts clean and healthy', () => {
    const m = emptyMetrics('fresh');
    expect(m.state).toBe('healthy');
    expect(m.searchesAttempted).toBe(0);
    expect(m.failures).toBe(0);
    expect(m.latenciesMs).toEqual([]);
  });
});
