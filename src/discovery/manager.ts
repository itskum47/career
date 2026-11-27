/**
 * Discovery manager - registry-driven coordination of discovery adapters.
 *
 * Phase 6A/6I:
 *   - Sources come from JobSourceRegistry (config-driven, catalog-backed).
 *     Nothing is enabled by hardcoding inside a constructor.
 *   - Source workers only produce discovery results. They never touch the
 *     application browser: results flow through the orchestrator pipeline
 *     (DISCOVERY -> NORMALIZE -> DEDUPE -> PRIORITIZE -> APPLICATION QUEUE).
 *
 * Phase 2 invariant (never regress):
 *   onlyMock=true registers ONLY MockDiscoveryAdapter with its fixtures.
 *   Real adapters NEVER fall back to mock data on failure.
 */

import type { DiscoveredJob, JobSource, DiscoveryCriteria, DiscoveryConfig, DiscoveryAdapter } from './types.ts';
import { MockDiscoveryAdapter, LinkedInDiscoveryAdapter, IndeedDiscoveryAdapter, GreenhouseDiscoveryAdapter } from './adapters.ts';
import {
  GreenhouseApiAdapter, LeverPostingsAdapter, AshbyPostingAdapter,
  RemoteOKAdapter, RemotiveAdapter, WWRssAdapter,
} from './adapters-api.ts';
import { ShineHtmlAdapter, ApnaHtmlAdapter, FreshersworldHtmlAdapter } from './adapters-html.ts';
import { JobSourceRegistry, createRegistry, type RegistryConfig } from './registry.ts';
import { logger } from '../core/logger.ts';
import pLimit from 'p-limit';

/** Factories keyed by catalog source id. Only sources WITH an adapter run. */
type AdapterFactory = (cfg: DiscoveryConfig) => DiscoveryAdapter;

const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  mock: (cfg) => new MockDiscoveryAdapter(cfg.mockJobs),
  linkedin: () => new LinkedInDiscoveryAdapter(),
  indeed: () => new IndeedDiscoveryAdapter(),
  greenhouse: (cfg) => new GreenhouseApiAdapter(cfg.atsBoards?.greenhouse ?? []),
  lever: (cfg) => new LeverPostingsAdapter(cfg.atsBoards?.lever ?? []),
  ashby: (cfg) => new AshbyPostingAdapter(cfg.atsBoards?.ashby ?? []),
  remoteok: () => new RemoteOKAdapter(),
  remotive: () => new RemotiveAdapter(),
  weworkremotely: () => new WWRssAdapter(),
  shine: () => new ShineHtmlAdapter(),
  apna: () => new ApnaHtmlAdapter(),
  freshersworld: () => new FreshersworldHtmlAdapter(),
  // NOTE: sources with capabilities.discovery === 'none' have NO factory by
  // design — the registry refuses to enable them (6A guard).
};

/** Registry overrides derived from DiscoveryConfig (back-compat bridge). */
function registryConfigFrom(config: Partial<DiscoveryConfig>): RegistryConfig {
  const rc: RegistryConfig = {};
  if (config.onlyMock) rc.onlyMock = true;
  if (config.onlySources) rc.onlySources = config.onlySources;
  if (config.excludeSources) rc.excludeSources = config.excludeSources;
  if (config.enableSources) rc.enable = config.enableSources;
  if (typeof config.maxJobsPerSource === 'number') rc.maxJobsPerSource = config.maxJobsPerSource;
  if (typeof config.sourceConcurrency === 'number') rc.sourceConcurrency = config.sourceConcurrency;
  return rc;
}

export default class DiscoveryManager {
  private adapters: Map<JobSource, DiscoveryAdapter> = new Map();
  private config: DiscoveryConfig;
  private registry: JobSourceRegistry;
  /** Per-source request timestamps for 6M rate limiting. */
  private lastRequestAt: Map<string, number> = new Map();

  constructor(config: Partial<DiscoveryConfig> = {}) {
    const onlyMock = config.onlyMock ?? false;
    this.config = {
      adapters: {},
      concurrency: config.concurrency ?? 5,
      rateLimitMs: config.rateLimitMs ?? 1000,
      retryAttempts: config.retryAttempts ?? 3,
      retryDelayMs: config.retryDelayMs ?? 2000,
      onlyMock,
      mockJobs: config.mockJobs,
      onlySources: config.onlySources,
      excludeSources: config.excludeSources,
      enableSources: config.enableSources,
      maxJobsPerSource: config.maxJobsPerSource,
      sourceConcurrency: config.sourceConcurrency,
      atsBoards: config.atsBoards,
    };

    // Registry = catalog defaults + config + env (6A). createRegistry applies
    // env overrides only when the caller did not set them explicitly.
    this.registry = config.onlyMock
      ? new JobSourceRegistry({ ...registryConfigFrom(config), onlyMock: true })
      : createRegistry(registryConfigFrom(config));

    for (const entry of this.registry.enabledSources()) {
      const factory = ADAPTER_FACTORIES[entry.source];
      if (!factory) {
        logger.warn('Enabled source has no adapter implementation — skipped', {
          source: entry.source,
          support: this.registry.definition(entry.source)?.support,
        });
        continue;
      }
      const adapter = factory(this.config);
      this.registerAdapter(adapter);
      this.config.adapters[entry.source] = { enabled: true, priority: entry.priority };
    }

    logger.info('Discovery initialized from source registry', {
      onlyMock,
      enabled: [...this.adapters.keys()],
      registrySources: this.registry.all().length,
    });
  }

  /** The registry backing this manager (capability reports, health, caps). */
  getRegistry(): JobSourceRegistry {
    return this.registry;
  }

  /** Adapter for a source (undefined when no implementation exists). */
  getAdapterFor(source: string): DiscoveryAdapter | undefined {
    return this.adapters.get(source);
  }

  registerAdapter(adapter: DiscoveryAdapter): void {
    this.adapters.set(adapter.source, adapter);
    logger.info('Discovery adapter registered', { source: adapter.source, name: adapter.name });
  }

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const enabledAdapters = [...this.adapters.values()]
      .filter(a => this.config.adapters[a.source]?.enabled !== false);

    logger.info('Starting job discovery', {
      adapters: enabledAdapters.map(a => a.source),
      criteria,
    });

    const limiter = pLimit(this.config.concurrency);
    const allJobs: DiscoveredJob[] = [];

    const promises = enabledAdapters.map(adapter =>
      limiter(async () => {
        const source = adapter.source;
        try {
          await this.waitForRateLimit(source);
          const startedAt = Date.now();
          const cap = this.registry.capFor(source);
          const scoped: DiscoveryCriteria = { ...criteria, maxResults: Math.min(criteria.maxResults ?? cap, cap) };
          const jobs = await adapter.discover(scoped);
          this.lastRequestAt.set(source, Date.now());
          logger.info('Source discovery finished', {
            source, jobs: jobs.length, wallMs: Date.now() - startedAt, cap,
          });
          allJobs.push(...jobs);
        } catch (error) {
          // A failing source never poisons the run and never falls back to mock.
          this.lastRequestAt.set(source, Date.now());
          logger.error('Discovery adapter failed', {
            source,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    await Promise.all(promises);

    // Deduplicate by URL (fast pass). Cross-source identity resolution happens
    // in JobIdentityResolver (6F) during the orchestrator pipeline.
    const seen = new Set<string>();
    const uniqueJobs = allJobs.filter(job => {
      if (seen.has(job.url)) return false;
      seen.add(job.url);
      return true;
    });

    logger.info('Discovery completed', {
      totalFound: allJobs.length,
      uniqueJobs: uniqueJobs.length,
      duplicatesRemoved: allJobs.length - uniqueJobs.length,
    });

    return uniqueJobs;
  }

  /** 6M: enforce the registry's per-source minimum interval between requests. */
  private async waitForRateLimit(source: string): Promise<void> {
    const rateLimitMs = this.registry.get(source)?.rateLimitMs ?? 0;
    const last = this.lastRequestAt.get(source) ?? 0;
    const wait = last + rateLimitMs - Date.now();
    if (wait > 0) {
      logger.debug('Source rate limit wait', { source, waitMs: wait });
      await new Promise(r => setTimeout(r, wait));
    }
  }

  async *discoverStream(criteria: DiscoveryCriteria): AsyncIterable<DiscoveredJob> {
    const jobs = await this.discover(criteria);
    for (const job of jobs) {
      yield job;
    }
  }

  async verifyJob(job: DiscoveredJob): Promise<DiscoveredJob> {
    const adapter = this.adapters.get(job.source);
    if (!adapter) {
      logger.warn('No adapter for job source', { source: job.source });
      return job;
    }

    const result = await adapter.verifyJob(job);
    return {
      ...job,
      description: result.fullDescription ?? job.description,
    };
  }

  getRegisteredSources(): JobSource[] {
    return Array.from(this.adapters.keys());
  }
}

export function createDefaultDiscoveryManager(overrides: Partial<DiscoveryConfig> = {}): DiscoveryManager {
  return new DiscoveryManager({
    concurrency: 5,
    rateLimitMs: 1000,
    retryAttempts: 3,
    retryDelayMs: 2000,
    ...overrides,
  });
}
