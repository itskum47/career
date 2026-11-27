/**
 * Phase 6A — JobSourceRegistry.
 *
 * Central, configuration-driven source registry. NOTHING is enabled by
 * hardcoding inside an adapter constructor: the catalog supplies defaults,
 * config (or env) decides what actually runs.
 *
 * Configuration supported:
 *   onlyMock            -> only the mock fixture source (tests/benchmarks)
 *   onlySources         -> allowlist of source ids
 *   excludeSources      -> denylist of source ids
 *   maxJobsPerSource    -> global per-source job cap (6J search depth)
 *   sourceConcurrency   -> global cap on concurrent source workers (6I/6M)
 *   overrides[sourceId] -> per-source field overrides
 *
 * Guards (the Phase 2 discovery bug cannot return):
 *   - Only sources with capabilities.discovery !== 'none' can be enabled.
 *   - onlyMock and onlySources are mutually exclusive (onlyMock wins, warn).
 *   - Unknown source ids in config throw (silent typos cannot disable work).
 *   - Mock is NEVER enabled implicitly alongside real sources.
 */

import {
  SOURCE_CATALOG,
  getSourceDefinition,
  type SourceDefinition,
} from './catalog.ts';
import type { AdapterConfig, RateLimitPolicy, SourceHealthMetrics } from './types.ts';
import { logger } from '../core/logger.ts';

export interface SourceConfigEntry extends AdapterConfig {
  source: string;
  /** Global/per-source job cap (6J). */
  maxJobsPerSource: number;
  /** Concurrent discovery workers for this source (6I). */
  concurrency: number;
  rateLimitMs: number;
  timeoutMs: number;
  pagination: boolean;
  loginRequired: boolean;
  discoveryEnabled: boolean;
  applicationSupported: boolean;
  category: string;
  priority: number;
}

export interface RegistryConfig {
  onlyMock?: boolean;
  onlySources?: string[];
  excludeSources?: string[];
  maxJobsPerSource?: number;
  sourceConcurrency?: number;
  overrides?: Record<string, Partial<SourceConfigEntry>>;
  /** Enable a supported source even if its catalog default is disabled. */
  enable?: string[];
}

function fail(msg: string): never {
  throw new Error(`[JobSourceRegistry] ${msg}`);
}

/** Env bridge so ops can steer discovery without code changes. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  const cfg: RegistryConfig = {};
  if (env.DISCOVERY_ONLY_MOCK === 'true') cfg.onlyMock = true;
  if (env.DISCOVERY_ONLY_SOURCES) cfg.onlySources = env.DISCOVERY_ONLY_SOURCES.split(',').map(s => s.trim()).filter(Boolean);
  if (env.DISCOVERY_EXCLUDE_SOURCES) cfg.excludeSources = env.DISCOVERY_EXCLUDE_SOURCES.split(',').map(s => s.trim()).filter(Boolean);
  if (env.DISCOVERY_MAX_PER_SOURCE) cfg.maxJobsPerSource = parseInt(env.DISCOVERY_MAX_PER_SOURCE, 10);
  if (env.DISCOVERY_SOURCE_CONCURRENCY) cfg.sourceConcurrency = parseInt(env.DISCOVERY_SOURCE_CONCURRENCY, 10);
  if (env.DISCOVERY_ENABLE_SOURCES) cfg.enable = env.DISCOVERY_ENABLE_SOURCES.split(',').map(s => s.trim()).filter(Boolean);
  return cfg;
}

export class JobSourceRegistry {
  private readonly entries = new Map<string, SourceConfigEntry>();
  private readonly definitions = new Map<string, SourceDefinition>();
  readonly config: Required<Pick<RegistryConfig, 'onlyMock' | 'maxJobsPerSource' | 'sourceConcurrency'>> &
    RegistryConfig;

  constructor(cfg: RegistryConfig = {}) {
    const onlyMock = cfg.onlyMock ?? false;
    this.config = {
      ...cfg,
      onlyMock,
      maxJobsPerSource: cfg.maxJobsPerSource ?? 50,
      sourceConcurrency: cfg.sourceConcurrency ?? 4,
    };

    const only = cfg.onlySources?.length ? [...new Set(cfg.onlySources)] : undefined;
    const exclude = new Set(cfg.excludeSources ?? []);
    const enable = new Set(cfg.enable ?? []);

    // Validate ids up front — a typo must never silently disable a source.
    for (const id of [...(only ?? []), ...exclude, ...enable]) {
      if (!getSourceDefinition(id)) fail(`unknown source id in config: "${id}"`);
    }
    if (onlyMock && only?.length) {
      logger.warn('onlyMock=true ignores onlySources', { onlySources: only });
    }

    for (const def of SOURCE_CATALOG) {
      const entry = this.buildEntry(def, { onlyMock, only, exclude, enable });
      const override = cfg.overrides?.[def.id];
      if (override) Object.assign(entry, override);
      this.definitions.set(def.id, def);
      this.entries.set(def.id, entry);
    }

    // Mock must never be implicitly enabled next to real sources
    // (Phase 2 bug: mock hid behind real adapters and polluted results).
    if (!onlyMock) {
      const mock = this.entries.get('mock')!;
      const anyRealEnabled = [...this.entries.values()].some(
        e => e.source !== 'mock' && e.enabled && this.definitions.get(e.source)?.category !== 'internal'
      );
      if (mock.enabled && anyRealEnabled) {
        mock.enabled = false;
        logger.warn('mock source was implicitly enabled alongside real sources — disabled', {
          rule: 'mock-only-when-onlyMock',
        });
      }
    }
  }

  private buildEntry(
    def: SourceDefinition,
    ctx: { onlyMock: boolean; only?: string[]; exclude: Set<string>; enable: Set<string> }
  ): SourceConfigEntry {
    const d = def.defaults;
    let enabled = d.enabled;

    if (ctx.onlyMock) {
      enabled = def.id === 'mock';
    } else if (ctx.only?.length) {
      enabled = ctx.only.includes(def.id);
    } else {
      if (ctx.exclude.has(def.id)) enabled = false;
      if (ctx.enable.has(def.id)) enabled = true;
    }

    if (enabled && def.capabilities.discovery === 'none') {
      logger.warn('source requested but discovery capability is none — forcing disabled', {
        source: def.id,
        support: def.support,
        reason: def.reason,
      });
      enabled = false;
    }
    if (ctx.only?.includes(def.id) && def.capabilities.discovery === 'none') {
      fail(`onlySources includes "${def.id}" but its discovery capability is 'none' (${def.reason ?? 'unsupported'})`);
    }

    return {
      source: def.id,
      enabled,
      priority: d.priority,
      rateLimit: d.rateLimitMs,
      rateLimitMs: d.rateLimitMs,
      concurrency: ctx.onlyMock ? 1 : Math.min(d.concurrency, this.sourceConcurrencyCap(ctx)),
      maxJobsPerSource: this.config?.maxJobsPerSource ?? 50,
      timeoutMs: d.timeoutMs,
      pagination: def.capabilities.pagination,
      loginRequired: def.capabilities.loginRequired,
      discoveryEnabled: def.capabilities.discoveryEnabledByDefault && enabled,
      applicationSupported: def.capabilities.applicationSupportedByDefault && enabled,
      category: def.category,
    };
  }

  private sourceConcurrencyCap(ctx: { onlyMock: boolean }): number {
    return this.config?.sourceConcurrency ?? 4;
  }

  // -- queries -------------------------------------------------------------

  get(sourceId: string): SourceConfigEntry {
    const e = this.entries.get(sourceId);
    if (!e) fail(`unknown source: ${sourceId}`);
    return e;
  }

  definition(sourceId: string): SourceDefinition | undefined {
    return this.definitions.get(sourceId);
  }

  has(sourceId: string): boolean {
    return this.entries.has(sourceId);
  }

  /** Enabled sources in priority order (the discovery work queue). */
  enabledSources(): SourceConfigEntry[] {
    return [...this.entries.values()]
      .filter(e => e.enabled)
      .sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source));
  }

  all(): SourceConfigEntry[] {
    return [...this.entries.values()].sort((a, b) => a.priority - b.priority);
  }

  setEnabled(sourceId: string, enabled: boolean): void {
    const e = this.get(sourceId);
    if (enabled && this.definitions.get(sourceId)?.capabilities.discovery === 'none') {
      fail(`cannot enable "${sourceId}": discovery capability is none`);
    }
    e.enabled = enabled;
    e.discoveryEnabled = enabled && e.discoveryEnabled;
  }

  /** Max jobs this source may yield in one search (6J). */
  capFor(sourceId: string): number {
    return Math.min(this.get(sourceId).maxJobsPerSource, this.config.maxJobsPerSource);
  }

  /** Effective rate-limit policy for health/backoff (6M). */
  policyFor(sourceId: string): RateLimitPolicy {
    const e = this.get(sourceId);
    return {
      rateLimitMs: e.rateLimitMs,
      failureThreshold: 3,
      cooldownMs: Math.max(30_000, e.rateLimitMs * 10),
      retryAttempts: 2,
      retryDelayMs: Math.max(1_000, e.rateLimitMs),
      concurrency: e.concurrency,
    };
  }

  /** Human-readable capability report (6B "explicit capability reporting"). */
  capabilityReport(): Array<{
    source: string;
    displayName: string;
    category: string;
    support: string;
    reason?: string;
    enabled: boolean;
    discovery: string;
    application: boolean;
    loginRequired: boolean;
    priority: number;
    evidence?: string;
  }> {
    return this.all().map(e => {
      const def = this.definitions.get(e.source)!;
      return {
        source: e.source,
        displayName: def.displayName,
        category: def.category,
        support: def.support,
        reason: def.reason,
        enabled: e.enabled,
        discovery: def.capabilities.discovery,
        application: def.capabilities.application,
        loginRequired: def.capabilities.loginRequired,
        priority: e.priority,
        evidence: def.probeEvidence?.measured,
      };
    });
  }
}

/** Default registry: catalog defaults + environment overrides. */
export function createRegistry(cfg: RegistryConfig = {}): JobSourceRegistry {
  return new JobSourceRegistry({ ...configFromEnv(), ...cfg });
}

export type { SourceHealthMetrics };
