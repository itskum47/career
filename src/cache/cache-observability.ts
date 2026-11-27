/**
 * Cache observability and metrics
 */
import { logger } from '../core/logger.ts';

export interface CacheMetrics {
  jd: { hits: number; misses: number; writes: number; invalidated: number };
  match: { hits: number; misses: number; writes: number; invalidated: number };
  artifact: { hits: number; misses: number; writes: number; invalidated: number };
  llm: { hits: number; misses: number; writes: number; invalidated: number };
}

export class CacheObserver {
  private metrics: CacheMetrics = {
    jd: { hits: 0, misses: 0, writes: 0, invalidated: 0 },
    match: { hits: 0, misses: 0, writes: 0, invalidated: 0 },
    artifact: { hits: 0, misses: 0, writes: 0, invalidated: 0 },
    llm: { hits: 0, misses: 0, writes: 0, invalidated: 0 },
  };

  record(type: keyof CacheMetrics, event: 'hit' | 'miss' | 'write' | 'invalidated'): void {
    if (event === 'hit') this.metrics[type].hits++;
    else if (event === 'miss') this.metrics[type].misses++;
    else if (event === 'write') this.metrics[type].writes++;
    else if (event === 'invalidated') this.metrics[type].invalidated++;
    logger.debug('cache.event', { type, event });
  }

  getHitRate(type: keyof CacheMetrics): number {
    const t = this.metrics[type];
    const total = t.hits + t.misses;
    if (total === 0) return 0;
    return (t.hits / total) * 100;
  }

  /** Phase 4C: read-only snapshot for benchmarks/tests (no mutation). */
  snapshot(): CacheMetrics {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  getReport(): string {
    const lines: string[] = ['# Cache Metrics'];
    lines.push('');
    for (const [type, m] of Object.entries(this.metrics)) {
      const rate = this.getHitRate(type as keyof CacheMetrics);
      lines.push(`## ${type.toUpperCase()} Cache`);
      lines.push(`- Hit rate: ${rate.toFixed(2)}% (${m.hits} hits / ${m.hits + m.misses} total)`);
      lines.push(`- Writes: ${m.writes}`);
      lines.push(`- Invalidated: ${m.invalidated}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  logReport(): void {
    logger.info('Cache observability report', { metrics: this.metrics });
  }
}

export const cacheObserver = new CacheObserver();
export default cacheObserver;