/**
 * Simple in-memory LLM response cache with TTL.
 */

import type { LLMCache, LLMResponse } from './types.ts';

interface CacheEntry {
  response: LLMResponse;
  expiresAt: number;
}

export class InMemoryLLMCache implements LLMCache {
  private cache = new Map<string, CacheEntry>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 3600000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  async get(key: string): Promise<LLMResponse | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.response;
  }

  async set(key: string, response: LLMResponse): Promise<void> {
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.defaultTtlMs,
    });
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  // Cleanup expired entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  size(): number {
    return this.cache.size;
  }
}

export function createCacheKey(request: { messages: Array<{ role: string; content: string }>; model: string; temperature?: number; jsonMode?: boolean }): string {
  const content = JSON.stringify({
    messages: request.messages,
    model: request.model,
    temperature: request.temperature,
    jsonMode: request.jsonMode,
  });
  // Simple hash
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return `llm_${Math.abs(hash).toString(36)}`;
}