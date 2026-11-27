/**
 * LLM cache observability
 */
import { logger } from '../logger.ts';

export interface LLMCachedMetrics {
  hits: number;
  misses: number;
  writes: number;
  invalidated: number;
  waitTimeMs: number;
  errors: number;
  tokensSaved: number;
  duplicateRequestsPrevented: number;
  costSaved: number;
}

export class LLMCachedMetricsTracker {
  private metrics: LLMCachedMetrics = {
    hits: 0,
    misses: 0,
    writes: 0,
    invalidated: 0,
    waitTimeMs: 0,
    errors: 0,
    tokensSaved: 0,
    duplicateRequestsPrevented: 0,
    costSaved: 0,
  };

  recordHit(tokensSaved = 0): void {
    this.metrics.hits++;
    this.metrics.tokensSaved += tokensSaved;
  }

  recordMiss(): void {
    this.metrics.misses++;
  }

  recordWrite(): void {
    this.metrics.writes++;
  }

  recordInvalidated(): void {
    this.metrics.invalidated++;
  }

  recordWait(waitMs: number): void {
    this.metrics.waitTimeMs += waitMs;
  }

  recordError(): void {
    this.metrics.errors++;
  }

  recordDuplicatePrevented(): void {
    this.metrics.duplicateRequestsPrevented++;
  }

  getMetrics(): LLMCachedMetrics {
    return { ...this.metrics };
  }

  getHitRate(): number {
    const total = this.metrics.hits + this.metrics.misses;
    if (total === 0) return 0;
    return (this.metrics.hits / total) * 100;
  }

  logMetrics(): void {
    const hitRate = this.getHitRate();
    logger.info('LLM cache metrics', {
      hitRate: `${hitRate.toFixed(2)}%`,
      ...this.metrics,
      llmCacheHitRate: hitRate.toFixed(2),
      tokensSaved: this.metrics.tokensSaved,
      duplicateRequestsPrevented: this.metrics.duplicateRequestsPrevented,
    });
  }

  reset(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      writes: 0,
      invalidated: 0,
      waitTimeMs: 0,
      errors: 0,
      tokensSaved: 0,
      duplicateRequestsPrevented: 0,
      costSaved: 0,
    };
  }
}

export const llmCacheMetrics = new LLMCachedMetricsTracker();
export default llmCacheMetrics;