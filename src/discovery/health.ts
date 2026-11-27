/**
 * Phase 6M/6N — Per-source rate limiting, backoff, cooldown + health metrics.
 *
 * Rules:
 *   - per-source concurrency + min interval between requests
 *   - retry ONLY retryable failures (timeouts, 429, 5xx); never retry
 *     permanent failures (404/410/401/403-anti-bot)
 *   - repeated failures => MARK SOURCE DEGRADED, stop hammering it
 *   - health metrics are readable by the orchestrator (6N)
 */

import type { SourceHealthMetrics, SourceHealthState, RateLimitPolicy } from './types.ts';
import { logger } from '../core/logger.ts';

export type FailureKind = 'retryable' | 'permanent' | 'rate-limited' | 'challenge' | 'login';

/** Classify an HTTP status / error into a retry decision. */
export function classifyFailure(input: { status?: number; error?: string }): FailureKind {
  const { status, error } = input;
  if (status === 429) return 'rate-limited';
  if (status !== undefined) {
    if (status === 401) return 'login';
    if (status === 403) return 'challenge'; // anti-bot — never retried
    if (status === 404 || status === 410 || status === 451) return 'permanent';
    if (status >= 500) return 'retryable';
    if (status >= 400) return 'permanent';
    return 'retryable';
  }
  const msg = (error ?? '').toLowerCase();
  if (/timeout|etimedout|econnreset|econnrefused|eai_again|socket|network|fetch failed/.test(msg)) return 'retryable';
  if (/captcha|challenge|access denied|unusual traffic/.test(msg)) return 'challenge';
  return 'retryable';
}

export function emptyMetrics(source: string): SourceHealthMetrics {
  return {
    source,
    searchesAttempted: 0, searchesCompleted: 0,
    jobsDiscovered: 0, jobsNormalized: 0,
    duplicates: 0, uniqueJobs: 0,
    jdRetrievalSuccess: 0, jdRetrievalAttempts: 0,
    routeResolutionSuccess: 0, routeResolutionAttempts: 0,
    navigationSuccess: 0, navigationAttempts: 0,
    applicationSuccess: 0, applicationAttempts: 0,
    failures: 0, loginInterruptions: 0, captchaInterruptions: 0,
    timeouts: 0, requestsAttempted: 0, requestsRejected: 0,
    latenciesMs: [],
    state: 'healthy',
  };
}

export class SourceHealthTracker {
  private metrics = new Map<string, SourceHealthMetrics>();
  private policies = new Map<string, RateLimitPolicy>();
  private lastRequestAt = new Map<string, number>();
  private consecutiveFailures = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();

  register(source: string, policy: RateLimitPolicy): void {
    if (!this.metrics.has(source)) this.metrics.set(source, emptyMetrics(source));
    this.policies.set(source, policy);
  }

  get(source: string): SourceHealthMetrics {
    let m = this.metrics.get(source);
    if (!m) { m = emptyMetrics(source); this.metrics.set(source, m); }
    return m;
  }

  all(): SourceHealthMetrics[] {
    return [...this.metrics.values()];
  }

  /** True while the source is in failure cooldown (do NOT hammer it). */
  inCooldown(source: string): boolean {
    const until = this.cooldownUntil.get(source) ?? 0;
    return Date.now() < until;
  }

  /** Wait (ms) required by this source's rate limit; updates the timestamp on acquire. */
  async acquire(source: string): Promise<{ waitedMs: number; skipped: boolean }> {
    const policy = this.policies.get(source);
    const rate = policy?.rateLimitMs ?? 0;
    const last = this.lastRequestAt.get(source) ?? 0;
    const wait = Math.max(0, last + rate - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequestAt.set(source, Date.now());
    const m = this.get(source);
    m.requestsAttempted++;
    return { waitedMs: wait, skipped: false };
  }

  recordSearchStarted(source: string): void {
    this.get(source).searchesAttempted++;
  }

  recordSearchCompleted(source: string, jobs: number, wallMs: number): void {
    const m = this.get(source);
    m.searchesCompleted++;
    m.jobsDiscovered += jobs;
    m.latenciesMs.push(wallMs);
    if (m.latenciesMs.length > 200) m.latenciesMs.shift();
    // A completed search proves the source is responding again — clear the
    // failure streak AND any cooldown so a recovered source is never silently
    // skipped for the rest of a stale failure cooldown (6M/6N consistency).
    this.consecutiveFailures.set(source, 0);
    this.cooldownUntil.delete(source);
    m.state = 'healthy';
  }

  recordJobsNormalized(source: string, normalized: number, unique: number, duplicates: number): void {
    const m = this.get(source);
    m.jobsNormalized += normalized;
    m.uniqueJobs += unique;
    m.duplicates += duplicates;
  }

  recordJdRetrieval(source: string, success: boolean): void {
    const m = this.get(source);
    m.jdRetrievalAttempts++;
    if (success) m.jdRetrievalSuccess++;
  }

  recordRouteResolution(source: string, success: boolean): void {
    const m = this.get(source);
    m.routeResolutionAttempts++;
    if (success) m.routeResolutionSuccess++;
  }

  recordLoginInterruption(source: string): void {
    const m = this.get(source);
    m.loginInterruptions++;
    m.state = 'login-paused';
  }

  recordCaptchaInterruption(source: string): void {
    const m = this.get(source);
    m.captchaInterruptions++;
    m.state = 'login-paused';
  }

  /**
   * Record a failure. Permanent/challenge failures degrade instantly;
   * retryable ones degrade after `failureThreshold` consecutive hits.
   * Returns the decision so the caller knows whether to retry.
   */
  recordFailure(source: string, kind: FailureKind, error?: string): { shouldRetry: boolean; retryAfterMs: number } {
    const m = this.get(source);
    const policy = this.policies.get(source) ?? {
      rateLimitMs: 1000, failureThreshold: 3, cooldownMs: 60_000,
      retryAttempts: 2, retryDelayMs: 1000, concurrency: 1,
    };

    if (kind === 'challenge') m.captchaInterruptions++;
    if (kind === 'login') m.loginInterruptions++;
    if (error?.includes('timeout')) m.timeouts++;
    m.failures++;
    m.requestsRejected++;
    m.lastError = error ?? kind;
    m.lastErrorAt = new Date();

    const before = this.consecutiveFailures.get(source) ?? 0;
    const after = before + 1;
    this.consecutiveFailures.set(source, after);

    if (kind === 'permanent' || kind === 'challenge') {
      m.state = kind === 'challenge' ? 'login-paused' : 'down';
      this.cooldownUntil.set(source, Date.now() + policy.cooldownMs);
      logger.warn('Source marked degraded (permanent failure)', { source, kind, error });
      return { shouldRetry: false, retryAfterMs: policy.cooldownMs };
    }

    if (kind === 'login') {
      // 6K: a login wall pauses for the USER — it is never retried
      // automatically and never bypassed. The affected session waits for
      // manual sign-in; retrying would only hammer the auth flow.
      m.state = 'login-paused';
      this.cooldownUntil.set(source, Date.now() + policy.cooldownMs);
      logger.warn('Source paused for user login (6K) — not retried automatically', { source, error });
      return { shouldRetry: false, retryAfterMs: policy.cooldownMs };
    }

    if (kind === 'rate-limited') {
      const retryAfterMs = Math.max(policy.rateLimitMs * 5, 5000);
      m.state = 'cooldown';
      this.cooldownUntil.set(source, Date.now() + retryAfterMs);
      return { shouldRetry: true, retryAfterMs };
    }

    // retryable
    if (after >= policy.failureThreshold) {
      m.state = 'degraded';
      this.cooldownUntil.set(source, Date.now() + policy.cooldownMs);
      logger.warn('Source marked degraded after consecutive failures', { source, failures: after });
      return { shouldRetry: after <= policy.retryAttempts, retryAfterMs: policy.cooldownMs };
    }
    return { shouldRetry: after <= policy.retryAttempts, retryAfterMs: policy.retryDelayMs };
  }

  recordApplication(source: string, success: boolean): void {
    const m = this.get(source);
    m.applicationAttempts++;
    if (success) m.applicationSuccess++;
  }

  recordNavigation(source: string, success: boolean): void {
    const m = this.get(source);
    m.navigationAttempts++;
    if (success) m.navigationSuccess++;
  }

  /** Orchestrator-facing health summary (6N). */
  summary(): Array<{
    source: string;
    state: SourceHealthState;
    searchesAttempted: number;
    searchesCompleted: number;
    jobsDiscovered: number;
    uniqueJobs: number;
    duplicates: number;
    failureRate: number;
    timeoutRate: number;
    avgLatencyMs: number;
    loginInterruptions: number;
    captchaInterruptions: number;
    jdRetrievalRate: number;
    routeResolutionRate: number;
    applicationRate: number;
    lastError?: string;
  }> {
    return this.all().map(m => ({
      source: m.source,
      state: m.state,
      searchesAttempted: m.searchesAttempted,
      searchesCompleted: m.searchesCompleted,
      jobsDiscovered: m.jobsDiscovered,
      uniqueJobs: m.uniqueJobs,
      duplicates: m.duplicates,
      failureRate: m.searchesAttempted ? m.failures / m.searchesAttempted : 0,
      timeoutRate: m.requestsAttempted ? m.timeouts / m.requestsAttempted : 0,
      avgLatencyMs: m.latenciesMs.length ? m.latenciesMs.reduce((a, b) => a + b, 0) / m.latenciesMs.length : 0,
      loginInterruptions: m.loginInterruptions,
      captchaInterruptions: m.captchaInterruptions,
      jdRetrievalRate: m.jdRetrievalAttempts ? m.jdRetrievalSuccess / m.jdRetrievalAttempts : 0,
      routeResolutionRate: m.routeResolutionAttempts ? m.routeResolutionSuccess / m.routeResolutionAttempts : 0,
      applicationRate: m.applicationAttempts ? m.applicationSuccess / m.applicationAttempts : 0,
      lastError: m.lastError,
    }));
  }

  reset(): void {
    this.metrics.clear();
    this.consecutiveFailures.clear();
    this.cooldownUntil.clear();
    this.lastRequestAt.clear();
  }
}

export const sourceHealth = new SourceHealthTracker();
