/**
 * Phase 7 — Production rate limiting.
 *
 * A single choke point for "how much may we do, how fast" so no subsystem can
 * hammer a source or an employer:
 *
 *   - per-source and per-domain request budgets (sliding window, requests/minute)
 *   - application budgets (per hour, per day)
 *   - a concurrency cap across browser sessions
 *   - cooldown after a source signals throttling (429 / Retry-After)
 *
 * Design rules (production safety, not "get the benchmark green"):
 *   - When a limit is reached we PAUSE and tell the caller exactly how long to
 *     wait. We never busy-loop, never retry immediately, never raise the limit.
 *   - No anti-bot evasion lives here: budgets model a well-behaved client, they
 *     do not defeat throttles.
 *   - Pure and clock-injectable so the timing rules are unit-testable.
 */

export interface RateLimitConfig {
  /** Requests per minute allowed per key (source or domain). Default 20. */
  requestsPerMinute?: number;
  /** Discovery/application attempts per hour. Default 60. */
  actionsPerHour?: number;
  /** Applications per day. Default 100. */
  applicationsPerDay?: number;
  /** Maximum simultaneous browser sessions. Default 2. */
  maxConcurrency?: number;
  /** Cooldown applied when a source throttles us. Default 5 min. */
  cooldownMs?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds to wait before the same action may be attempted again. */
  retryAfterSeconds: number;
  reason?: string;
  limit?: string;
  remaining: number;
}

export class RateLimitExceeded extends Error {
  readonly decision: RateLimitDecision;
  constructor(decision: RateLimitDecision) {
    super(`Rate limit reached (${decision.limit}): ${decision.reason}. Retry after ${decision.retryAfterSeconds}s.`);
    this.name = 'RateLimitExceeded';
    this.decision = decision;
  }
}

interface WindowState {
  /** Timestamps (ms) inside the current window. */
  events: number[];
  /** Active cooldown until (ms), set when the source throttled us. */
  cooldownUntil?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export class RateLimiter {
  private readonly cfg: Required<RateLimitConfig>;
  private readonly now: () => number;
  /** key -> source/domain window. */
  private readonly windows = new Map<string, WindowState>();
  /** key -> action timestamps (applications). */
  private readonly actions = new Map<string, number[]>();
  private readonly appsByDay = new Map<string, number[]>();
  private inFlight = 0;

  constructor(config: RateLimitConfig = {}, clock: () => number = Date.now) {
    this.cfg = {
      requestsPerMinute: config.requestsPerMinute ?? 20,
      actionsPerHour: config.actionsPerHour ?? 60,
      applicationsPerDay: config.applicationsPerDay ?? 100,
      maxConcurrency: config.maxConcurrency ?? 2,
      cooldownMs: config.cooldownMs ?? 5 * MINUTE,
    };
    this.now = clock;
  }

  private window(key: string): WindowState {
    let w = this.windows.get(key);
    if (!w) {
      w = { events: [] };
      this.windows.set(key, w);
    }
    return w;
  }

  /** Check a request budget for `key` (a source name or a domain). */
  checkRequest(key: string): RateLimitDecision {
    const t = this.now();
    const w = this.window(key);

    if (w.cooldownUntil && w.cooldownUntil > t) {
      const waitMs = w.cooldownUntil - t;
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
        reason: `source is in cooldown after signalling throttling`,
        limit: 'cooldown',
        remaining: 0,
      };
    }

    w.events = w.events.filter(ts => t - ts < MINUTE);
    if (w.events.length >= this.cfg.requestsPerMinute) {
      const oldest = w.events[0];
      const waitMs = MINUTE - (t - oldest);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        reason: `request budget exhausted (${w.events.length}/${this.cfg.requestsPerMinute} per minute)`,
        limit: 'requests_per_minute',
        remaining: 0,
      };
    }

    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.cfg.requestsPerMinute - w.events.length,
    };
  }

  recordRequest(key: string): void {
    this.window(key).events.push(this.now());
  }

  /** Check (and optionally record) an application attempt budget. */
  checkApplication(source: string, domain: string, record = true): RateLimitDecision {
    const t = this.now();
    const hour = this.actions.get(source) ?? [];
    const day = this.appsByDay.get(source) ?? [];

    const cleanHour = hour.filter(ts => t - ts < HOUR);
    const cleanDay = day.filter(ts => t - ts < DAY);

    if (cleanHour.length >= this.cfg.actionsPerHour) {
      const waitMs = HOUR - (t - cleanHour[0]);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        reason: `hourly application budget exhausted (${cleanHour.length}/${this.cfg.actionsPerHour})`,
        limit: 'applications_per_hour',
        remaining: 0,
      };
    }
    if (cleanDay.length >= this.cfg.applicationsPerDay) {
      const waitMs = DAY - (t - cleanDay[0]);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        reason: `daily application budget exhausted (${cleanDay.length}/${this.cfg.applicationsPerDay})`,
        limit: 'applications_per_day',
        remaining: 0,
      };
    }

    const requestDecision = this.checkRequest(domain);
    if (!requestDecision.allowed) return requestDecision;

    if (record) {
      this.recordRequest(domain);
      this.actions.set(source, [...cleanHour, t]);
      this.appsByDay.set(source, [...cleanDay, t]);
    }
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.cfg.actionsPerHour - cleanHour.length,
    };
  }

  /** Reserve one of the concurrent browser-session slots. */
  acquireSlot(): boolean {
    if (this.inFlight >= this.cfg.maxConcurrency) return false;
    this.inFlight += 1;
    return true;
  }

  releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  /** A source signalled throttling (429 / Retry-After): cool down, don't hammer. */
  recordThrottle(source: string, retryAfterMs?: number): void {
    const w = this.window(source);
    w.cooldownUntil = this.now() + Math.max(retryAfterMs ?? 0, this.cfg.cooldownMs);
  }

  /** Throttle keys currently cooling down (for status output). */
  cooldowns(): Array<{ key: string; secondsRemaining: number }> {
    const t = this.now();
    return [...this.windows.entries()]
      .filter(([, w]) => (w.cooldownUntil ?? 0) > t)
      .map(([key, w]) => ({ key, secondsRemaining: Math.ceil((w.cooldownUntil! - t) / 1000) }));
  }

  /** Throwing gate for call sites that must stop rather than proceed. */
  assertApplicationAllowed(source: string, domain: string): void {
    const decision = this.checkApplication(source, domain, true);
    if (!decision.allowed) throw new RateLimitExceeded(decision);
  }

  /** Assert-and-consume: a successful check spends one request from the budget. */
  assertRequestAllowed(key: string): void {
    const decision = this.checkRequest(key);
    if (!decision.allowed) throw new RateLimitExceeded(decision);
    this.recordRequest(key);
  }

  /** Test/diagnostic reset. */
  reset(): void {
    this.windows.clear();
    this.actions.clear();
    this.appsByDay.clear();
    this.inFlight = 0;
  }
}

/** Domain (host) for a URL — the rate-limit key for employer/ATS traffic. */
export function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.split('/')[0] || 'unknown';
  }
}