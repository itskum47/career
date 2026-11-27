/**
 * True model KV cache management for local inference runtimes
 * Only applicable when using local inference (llama.cpp, vLLM, Ollama)
 * Does NOT store raw attention tensors - just manages prefixes/sessions
 */
import { logger } from '../logger.ts';
import { config } from '../config.ts';

export interface ModelKVCacheManager {
  supportsKVCache(): boolean;
  getSessionId(): string | null;
  setSessionId(id: string): void;
  clearSession(): void;
  shouldReuseSession(): boolean;
}

export class LocalInferenceKVCache implements ModelKVCacheManager {
  private sessionId: string | null = null;
  private supports = false;

  constructor(runtime?: string) {
    // Detect if using local runtime
    if (runtime === 'ollama' || runtime === 'vllm' || runtime === 'llama.cpp') {
      this.supports = true;
    }
  }

  supportsKVCache(): boolean {
    return this.supports;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
    logger.debug('Set model KV cache session', { sessionId: id });
  }

  clearSession(): void {
    this.sessionId = null;
    logger.debug('Cleared model KV cache session');
  }

  shouldReuseSession(): boolean {
    return this.supports && this.sessionId !== null;
  }
}

export class NoopKVCache implements ModelKVCacheManager {
  supportsKVCache(): boolean { return false; }
  getSessionId(): string | null { return null; }
  setSessionId(id: string): void {}
  clearSession(): void {}
  shouldReuseSession(): boolean { return false; }
}

export class ModelKVCacheFactory {
  static create(): ModelKVCacheManager {
    const provider = config.llm.provider;
    // Only for local/custom endpoints that might be Ollama
    if (provider === 'custom' || (config.llm.baseUrl && (
      config.llm.baseUrl.includes('localhost') ||
      config.llm.baseUrl.includes('127.0.0.1') ||
      config.llm.baseUrl.includes('ollama') ||
      config.llm.baseUrl.includes('vllm')
    ))) {
      return new LocalInferenceKVCache();
    }
    return new NoopKVCache();
  }
}