/**
 * Phase 6I — Discovery orchestrator.
 *
 * One central pipeline owns the input side:
 *
 *   DISCOVERY (parallel source workers, per-source rate limits)
 *     -> NORMALIZATION (6E)
 *     -> CROSS-SOURCE DEDUPE (6F JobIdentityResolver)
 *     -> COMPLETE JD RETRIEVAL + VERIFICATION (6H gate)
 *     -> ROUTE RESOLUTION (6G)
 *     -> PRIORITIZATION (6O)
 *     -> APPLICATION QUEUE (consumed by the existing ApplicationEngine)
 *
 * Source workers ONLY produce discovery results. They never control the
 * application browser. The queue is handed to whoever owns submission
 * (ApplicationEngine), which enforces duplicate protection (6X) itself.
 */

import type { DiscoveredJob, DiscoveryCriteria, NormalizedJob, ResolvedRoute, SourceHealthMetrics } from './types.ts';
import type { DiscoveryConfig } from './types.ts';
import DiscoveryManager from './manager.ts';
import { normalizeAll } from './normalize.ts';
import { JobIdentityResolver, type CanonicalJob } from './identity.ts';
import { resolveRoute } from './route.ts';
import { JdRetrievalGate, type JdRetrievalResult } from './jd-retrieval.ts';
import { prioritize, scoreJob, type PrioritizationContext, type RankedJob } from './prioritize.ts';
import { SourceHealthTracker, classifyFailure } from './health.ts';
import { getSourceDefinition } from './catalog.ts';
import { logger } from '../core/logger.ts';
import pLimit from 'p-limit';

export interface OrchestratorOptions {
  /** Reuse an existing manager (tests inject onlyMock managers). */
  manager?: DiscoveryManager;
  config?: Partial<DiscoveryConfig>;
  /** Disable full-JD HTTP fetch (pure discovery benchmark, 6T). */
  fetchFullJd?: boolean;
  /** Priority context (6O). */
  priorityContext?: PrioritizationContext;
  /** Per-source health tracker (defaults to a fresh one). */
  health?: SourceHealthTracker;
  /** Retriever override (tests). */
  jdGate?: JdRetrievalGate;
}

export interface CanonicalJobRecord {
  canonical: CanonicalJob;
  job: NormalizedJob;
  route: ResolvedRoute;
  jd: JdRetrievalResult;
  rank?: number;
  score?: number;
}

export interface DiscoveryRunResult {
  /** Sources the registry had enabled for this run. */
  sourcesQueried: string[];
  searchesCompleted: number;
  searchesFailed: number;
  rawJobsDiscovered: number;
  normalizedJobs: number;
  uniqueJobs: number;          // canonical count (6F)
  duplicates: number;
  duplicateRatio: number;
  ambiguousPairs: number;
  /** 6H metrics. */
  completeJdCount: number;
  completeJdRate: number;
  jdFailureReasons: Record<string, number>;
  /** 6G metrics. */
  routesResolved: number;
  routeAvailability: number;
  routeCounts: Record<string, number>;
  /** Per-source stats. */
  jobsBySource: Record<string, number>;
  sourceLatencyMs: Record<string, number>;
  sourceFailures: Record<string, number>;
  health: SourceHealthMetrics[];
  /** 6O eligibility breakdown (quality over application count). */
  eligibility: {
    eligible: number;
    ineligible: number;
    ineligibleReasons: Record<string, number>;
  };
  /** Ranked, application-ready records (eligible first). */
  queue: CanonicalJobRecord[];
  /** All canonical records incl. not-ready ones (retained for tracking). */
  records: CanonicalJobRecord[];
  wallMs: number;
}

export class DiscoveryOrchestrator {
  private manager: DiscoveryManager;
  private resolver = new JobIdentityResolver();
  private jdGate: JdRetrievalGate;
  private health: SourceHealthTracker;
  private opts: OrchestratorOptions;

  constructor(opts: OrchestratorOptions = {}) {
    this.opts = opts;
    this.manager = opts.manager ?? new DiscoveryManager(opts.config ?? {});
    this.jdGate = opts.jdGate ?? new JdRetrievalGate();
    this.health = opts.health ?? new SourceHealthTracker();
    // Register per-source policies from the registry (6M).
    const registry = this.manager.getRegistry();
    for (const entry of registry.all()) {
      this.health.register(entry.source, registry.policyFor(entry.source));
    }
  }

  getManager(): DiscoveryManager { return this.manager; }
  getHealth(): SourceHealthTracker { return this.health; }

  /**
   * Run the full input pipeline. Never submits anything — output is a
   * prioritized application queue for the existing engine (6I/6P).
   */
  async run(criteria: DiscoveryCriteria): Promise<DiscoveryRunResult> {
    const t0 = Date.now();
    const registry = this.manager.getRegistry();
    const enabled = registry.enabledSources();
    const sourcesQueried = enabled.map(e => e.source);

    // ---- Stage 1: DISCOVERY (per-source workers, bounded) ----
    const limiter = pLimit(registry.config.sourceConcurrency ?? 4);
    const rawBySource = new Map<string, DiscoveredJob[]>();
    const latencyBySource: Record<string, number> = {};
    const failureBySource: Record<string, number> = {};
    let searchesCompleted = 0;
    let searchesFailed = 0;

    await Promise.all(enabled.map(entry => limiter(async () => {
      const source = entry.source;
      if (this.health.inCooldown(source)) {
        failureBySource[source] = (failureBySource[source] ?? 0) + 1;
        searchesFailed++;
        logger.warn('Source skipped (cooldown/degraded)', { source });
        return;
      }
      this.health.recordSearchStarted(source);
      const { waitedMs } = await this.health.acquire(source);
      const started = Date.now();
      try {
        const jobs = await this.manager.getAdapterFor(source)?.discover(criteria) ?? [];
        const wall = Date.now() - started;
        latencyBySource[source] = wall;
        rawBySource.set(source, jobs);
        this.health.recordSearchCompleted(source, jobs.length, wall + waitedMs);
        searchesCompleted++;
      } catch (error) {
        const wall = Date.now() - started;
        latencyBySource[source] = wall;
        const msg = error instanceof Error ? error.message : String(error);
        const kind = classifyFailure({ error: msg });
        const decision = this.health.recordFailure(source, kind, msg);
        failureBySource[source] = (failureBySource[source] ?? 0) + 1;
        searchesFailed++;
        logger.error('Source worker failed', { source, kind, shouldRetry: decision.shouldRetry, error: msg });
      }
    })));

    const allRaw = [...rawBySource.values()].flat();
    const jobsBySource: Record<string, number> = {};
    for (const [s, jobs] of rawBySource) jobsBySource[s] = jobs.length;

    // ---- Stage 2: NORMALIZATION (6E) ----
    const { results: normResults, normalized } = normalizeAll(allRaw);
    for (const [s, jobs] of rawBySource) {
      const normCount = jobs.length; // normalizeAll is per-job; recount by source
      this.health.recordJobsNormalized(s, normCount, 0, 0);
    }
    const normWarnings = normResults.flatMap(r => r.warnings);
    if (normWarnings.length) {
      logger.info('Normalization warnings', { count: normWarnings.length, sample: normWarnings.slice(0, 5) });
    }

    // ---- Stage 3: CROSS-SOURCE DEDUPE (6F) ----
    const dedupe = this.resolver.resolve(normalized);
    for (const c of dedupe.canonical) {
      for (const src of c.sources) {
        this.health.recordJobsNormalized(src, 0, 1, 0);
      }
    }
    for (const d of dedupe.duplicates) {
      this.health.recordJobsNormalized(d.occurrence.source, 0, 0, 1);
    }

    // ---- Stage 4: COMPLETE JD + ROUTE RESOLUTION (6H + 6G) ----
    const fetchFullJd = this.opts.fetchFullJd ?? true;
    const jdFailureReasons: Record<string, number> = {};
    const routeCounts: Record<string, number> = {};
    const records: CanonicalJobRecord[] = [];

    // Bounded JD fetch concurrency (polite to sources).
    const jdLimiter = pLimit(4);
    const built = await Promise.all(dedupe.canonical.map(c => jdLimiter(async (): Promise<CanonicalJobRecord> => {
      const job = c.primary;
      const jd = await this.jdGate.retrieveCompleteJd(job, {
        fetchPage: fetchFullJd,
        existingDescription: job.description,
      });
      this.health.recordJdRetrieval(job.source, jd.ready);
      if (!jd.ready && jd.reason) {
        jdFailureReasons[jd.reason] = (jdFailureReasons[jd.reason] ?? 0) + 1;
      }
      if (jd.ready && jd.fullText) {
        job.description = jd.fullText;
        job.jdComplete = true;
      }

      const route = resolveRoute(job);
      this.health.recordRouteResolution(job.source, route.route !== 'UNKNOWN');
      routeCounts[route.route] = (routeCounts[route.route] ?? 0) + 1;

      return { canonical: c, job, route, jd };
    })));

    // ---- Stage 5: PRIORITIZATION (6O) ----
    const routeByKey = new Map(built.map(r => [r.canonical.canonicalKey, r.route] as const));
    const ctx: PrioritizationContext = {
      ...(this.opts.priorityContext ?? {}),
      jdComplete: false, // scored per-job below
    };
    const ranked: RankedJob[] = dedupe.canonical.map(c => {
      const rec = built.find(b => b.canonical === c)!;
      const score = scoreJob(rec.job, { ...ctx, jdComplete: rec.job.jdComplete }, {
        route: rec.route,
        dedupeConfidence: c.dedupeConfidence,
      });
      return { canonical: c, job: rec.job, score };
    });
    ranked.sort((a, b) => {
      if (a.score.eligible !== b.score.eligible) return a.score.eligible ? -1 : 1;
      return b.score.total - a.score.total;
    });

    // Attach ranks to records.
    ranked.forEach((r, i) => {
      const rec = built.find(b => b.canonical === r.canonical);
      if (rec) { rec.rank = i + 1; rec.score = Number(r.score.total.toFixed(4)); }
    });

    const queue = ranked
      .filter(r => r.score.eligible)
      .map(r => built.find(b => b.canonical === r.canonical)!)
      .filter(Boolean);

    const uniqueJobs = dedupe.canonical.length;
    const duplicateRatio = normalized.length ? dedupe.duplicates.length / normalized.length : 0;
    const completeJdCount = built.filter(r => r.jd.ready).length;
    const routesResolved = built.filter(r => r.route.route !== 'UNKNOWN').length;

    const ineligibleReasons: Record<string, number> = {};
    let eligibleCount = 0;
    for (const r of ranked) {
      if (r.score.eligible) { eligibleCount++; continue; }
      for (const reason of r.score.ineligibleReasons) {
        ineligibleReasons[reason] = (ineligibleReasons[reason] ?? 0) + 1;
      }
    }

    const result: DiscoveryRunResult = {
      sourcesQueried,
      searchesCompleted,
      searchesFailed,
      rawJobsDiscovered: allRaw.length,
      normalizedJobs: normalized.length,
      uniqueJobs,
      duplicates: dedupe.duplicates.length,
      duplicateRatio,
      ambiguousPairs: dedupe.ambiguousPairs.length,
      completeJdCount,
      completeJdRate: uniqueJobs ? completeJdCount / uniqueJobs : 0,
      jdFailureReasons,
      routesResolved,
      routeAvailability: uniqueJobs ? routesResolved / uniqueJobs : 0,
      routeCounts,
      jobsBySource,
      sourceLatencyMs: latencyBySource,
      sourceFailures: failureBySource,
      health: this.health.all(),
      eligibility: {
        eligible: eligibleCount,
        ineligible: ranked.length - eligibleCount,
        ineligibleReasons,
      },
      queue,
      records: built,
      wallMs: Date.now() - t0,
    };

    logger.info('Discovery pipeline completed', {
      sources: sourcesQueried.length,
      raw: result.rawJobsDiscovered,
      unique: result.uniqueJobs,
      duplicates: result.duplicates,
      completeJd: result.completeJdCount,
      queued: result.queue.length,
      wallMs: result.wallMs,
    });
    return result;
  }
}

/** Helper: capability-driven note for a source (used by CLI output). */
export function sourceNote(sourceId: string): string {
  const def = getSourceDefinition(sourceId);
  if (!def) return 'unknown source';
  return `${def.displayName} [${def.support}/${def.capabilities.discovery}]${def.reason ? ` — ${def.reason}` : ''}`;
}
