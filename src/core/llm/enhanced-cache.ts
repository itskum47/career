/**
 * Enhanced LLM cache with L1 (memory) + L2 (persistent) layers
 * Includes observability, get-or-create locking, proper key generation for future LLM stages
 */
import { logger } from '../logger.ts';
import { config } from '../config.ts';
import type { LLMCache, LLMResponse, LLMRequest } from './types.ts';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CacheEntry {
  response: LLMResponse;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
  provider: string;
  model: string;
  taskType?: string;
}

export interface LLMCacheMetrics {
  hits: number;
  misses: number;
  writes: number;
  invalidated: number;
  waitTimeMs: number;
  errors: number;
}

export class EnhancedLLMCache implements LLMCache {
  private l1 = new Map<string, CacheEntry>();
  private locks = new Map<string, Promise<LLMResponse | null>>();
  private metrics: LLMCacheMetrics = {
    hits: 0,
    misses: 0,
    writes: 0,
    invalidated: 0,
    waitTimeMs: 0,
    errors: 0,
  };
  private defaultTtlMs: number;
  private l2Dir: string;

  constructor(defaultTtlSeconds = config.cache?.llmTtlSeconds || 86400) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;
    this.l2Dir = path.join(process.cwd(), '.cache', 'llm');
    try {
      if (!fs.existsSync(this.l2Dir)) {
        fs.mkdirSync(this.l2Dir, { recursive: true });
      }
    } catch (e) {
      logger.warn('Failed to create L2 cache dir', { error: String(e) });
    }
  }

  private computeKey(request: {
    provider?: string;
    model?: string;
    taskType?: string;
    promptVersion?: string;
    candidateProfileHash?: string;
    jdHash?: string;
    inputParameters?: Record<string, unknown>;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    jsonMode?: boolean;
  }): string {
    const content = JSON.stringify({
      provider: request.provider || config.llm.provider,
      model: request.model || config.llm.model,
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      candidateProfileHash: request.candidateProfileHash,
      jdHash: request.jdHash,
      inputParameters: request.inputParameters,
      messages: request.messages,
      temperature: request.temperature,
      jsonMode: request.jsonMode,
    });
    return 'llm:' + createHash('sha256').update(content).digest('hex').slice(0, 32);
  }

  private l2KeyPath(key: string): string {
    return path.join(this.l2Dir, key.replace('llm:', 'llm_') + '.json');
  }

  async get(key: string): Promise<LLMResponse | null> {
    const l1Start = Date.now();
    
    // Check L1
    const l1Entry = this.l1.get(key);
    if (l1Entry) {
      if (Date.now() <= l1Entry.expiresAt) {
        l1Entry.hitCount++;
        this.metrics.hits++;
        logger.debug('LLM cache L1 hit', { key: key.slice(0, 16) });
        return l1Entry.response;
      } else {
        this.l1.delete(key);
        this.metrics.invalidated++;
      }
    }

    // Check L2 (persistent)
    try {
      const l2Path = this.l2KeyPath(key);
      if (fs.existsSync(l2Path)) {
        const data = JSON.parse(fs.readFileSync(l2Path, 'utf-8')) as CacheEntry;
        if (Date.now() <= data.expiresAt) {
          // Promote to L1
          this.l1.set(key, { ...data, hitCount: data.hitCount + 1 });
          this.metrics.hits++;
          logger.debug('LLM cache L2 hit', { key: key.slice(0, 16) });
          return data.response;
        } else {
          fs.unlinkSync(l2Path);
          this.metrics.invalidated++;
        }
      }
    } catch (e) {
      this.metrics.errors++;
      logger.warn('L2 cache read error', { error: String(e) });
    }

    this.metrics.misses++;
    logger.debug('LLM cache miss', { key: key.slice(0, 16) });
    return null;
  }

  async set(key: string, response: LLMResponse, metadata?: {
    provider?: string;
    model?: string;
    taskType?: string;
  }): Promise<void> {
    const entry: CacheEntry = {
      response: { ...response, cached: true },
      createdAt: Date.now(),
      expiresAt: Date.now() + this.defaultTtlMs,
      hitCount: 0,
      provider: metadata?.provider || config.llm.provider,
      model: metadata?.model || config.llm.model,
      taskType: metadata?.taskType,
    };

    this.l1.set(key, entry);
    this.metrics.writes++;

    // Write to L2 (best effort)
    try {
      const l2Path = this.l2KeyPath(key);
      fs.writeFileSync(l2Path, JSON.stringify(entry, null, 0));
    } catch (e) {
      logger.warn('L2 cache write error', { error: String(e) });
    }
  }

  async getOrSet(
    key: string,
    factory: () => Promise<LLMResponse>,
    metadata?: { provider?: string; model?: string; taskType?: string }
  ): Promise<LLMResponse> {
    // Check existing cache
    const cached = await this.get(key);
    if (cached) {
      return cached;
    }

    // Prevent duplicate concurrent requests
    const existingLock = this.locks.get(key);
    if (existingLock) {
      const start = Date.now();
      const result = await existingLock;
      this.metrics.waitTimeMs += (Date.now() - start);
      if (result) return result;
    }

    // Create lock
    const lockPromise = (async () => {
      try {
        const cached2 = await this.get(key);
        if (cached2) return cached2;
        const response = await factory();
        await this.set(key, response, metadata);
        return response;
      } finally {
        // Remove lock after completion
        setTimeout(() => this.locks.delete(key), 0);
      }
    })();

    this.locks.set(key, lockPromise);
    return lockPromise;
  }

  async clear(): Promise<void> {
    this.l1.clear();
    try {
      const files = fs.readdirSync(this.l2Dir);
      for (const f of files) {
        if (f.startsWith('llm_')) {
          fs.unlinkSync(path.join(this.l2Dir, f));
        }
      }
    } catch (e) {
      logger.warn('L2 cache clear error', { error: String(e) });
    }
    this.metrics = {
      hits: 0,
      misses: 0,
      writes: 0,
      invalidated: 0,
      waitTimeMs: 0,
      errors: 0,
    };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.l1.entries()) {
      if (now > entry.expiresAt) {
        this.l1.delete(key);
        this.metrics.invalidated++;
      }
    }
  }

  getMetrics(): LLMCacheMetrics {
    return { ...this.metrics };
  }

  getHitRate(): number {
    const total = this.metrics.hits + this.metrics.misses;
    if (total === 0) return 0;
    return (this.metrics.hits / total) * 100;
  }

  size(): number {
    return this.l1.size;
  }

  // Method for generating cache key from request
  generateKey(request: {
    provider?: string;
    model?: string;
    taskType?: string;
    promptVersion?: string;
    candidateProfileHash?: string;
    jdHash?: string;
    inputParameters?: Record<string, unknown>;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    jsonMode?: boolean;
  }): string {
    return this.computeKey(request);
  }
}

export const enhancedLLMCache = new EnhancedLLMCache();
export default enhancedLLMCache;
export { enhancedLLMCache as llmCache };
export { InMemoryLLMCache } from './cache.ts';
export { createCacheKey } from './cache.ts';
export type { LLMCacheMetrics as EnhancedLLMCacheMetrics };