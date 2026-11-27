/**
 * LLM provider factory - creates the appropriate provider based on configuration.
 */

import type { LLMProvider, LLMConfig as LLMProviderConfig, LLMCache } from './types.ts';
import { MockLLMProvider } from './mock-provider.ts';
import { InMemoryLLMCache, createCacheKey } from './cache.ts';
import { logger } from '../logger.ts';
import { config } from '../config.ts';

let anthropicProvider: any = null;
let openaiProvider: any = null;

export async function createLLMProvider(): Promise<LLMProvider> {
  const llmConfig = config.llm;

  // Use mock in test mode or when explicitly configured
  if (config.testing.mockLLM || llmConfig.provider === 'mock') {
    logger.info('Using mock LLM provider');
    return new MockLLMProvider();
  }

  // Try to load provider dynamically based on config
  switch (llmConfig.provider) {
    case 'anthropic': {
      if (!anthropicProvider) {
        try {
          const { AnthropicProvider } = await import('./anthropic-provider.js');
          anthropicProvider = new AnthropicProvider({
            apiKey: llmConfig.apiKey,
            model: llmConfig.model,
            baseUrl: llmConfig.baseUrl,
            timeoutMs: llmConfig.timeoutMs,
          });
        } catch (e) {
          logger.warn('Failed to load Anthropic provider, falling back to mock', { error: String(e) });
          return new MockLLMProvider();
        }
      }
      const available = await anthropicProvider.isAvailable();
      if (!available) {
        logger.warn('Anthropic provider not available (missing API key), falling back to mock');
        return new MockLLMProvider();
      }
      logger.info('Using Anthropic LLM provider', { model: llmConfig.model });
      return anthropicProvider;
    }

    case 'openai': {
      if (!openaiProvider) {
        try {
          const { OpenAIProvider } = await import('./openai-provider.js');
          openaiProvider = new OpenAIProvider({
            apiKey: llmConfig.apiKey,
            model: llmConfig.model,
            baseUrl: llmConfig.baseUrl,
            timeoutMs: llmConfig.timeoutMs,
          });
        } catch (e) {
          logger.warn('Failed to load OpenAI provider, falling back to mock', { error: String(e) });
          return new MockLLMProvider();
        }
      }
      const available = await openaiProvider.isAvailable();
      if (!available) {
        logger.warn('OpenAI provider not available (missing API key), falling back to mock');
        return new MockLLMProvider();
      }
      logger.info('Using OpenAI LLM provider', { model: llmConfig.model });
      return openaiProvider;
    }

    default:
      logger.warn('Unknown LLM provider, using mock', { provider: llmConfig.provider });
      return new MockLLMProvider();
  }
}

export function createLLMCache(): LLMCache {
  return new InMemoryLLMCache();
}

export async function generateWithCache(
  provider: LLMProvider,
  cache: LLMCache,
  request: { messages: Array<{ role: string; content: string }>; model: string; temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<{ response: any; cached: boolean }> {
  const cacheKey = createCacheKey(request);
  const cached = await cache.get(cacheKey);

  if (cached) {
    logger.debug('LLM cache hit', { key: cacheKey });
    return { response: cached, cached: true };
  }

  const fullRequest = {
    messages: request.messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    jsonMode: request.jsonMode,
  };

  const response = await provider.generate(fullRequest);
  await cache.set(cacheKey, response);
  logger.debug('LLM cache miss, stored response', { key: cacheKey });

  return { response, cached: false };
}