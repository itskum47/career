/**
 * Prompt/context caching abstraction for LLM providers
 * Handles provider-native prompt caching where supported
 */
import { logger } from '../logger.ts';

export interface PromptCacheProvider {
  supportsPromptCaching(): boolean;
  getStaticCacheKey(): string | null;
  buildCachedMessages(messages: any[]): any[];
  markAsCached(messages: any[]): void;
}

export class AnthropicPromptCache implements PromptCacheProvider {
  supportsPromptCaching(): boolean {
    return true; // Anthropic supports cache control
  }
  getStaticCacheKey(): string | null {
    return null;
  }
  buildCachedMessages(messages: any[]): any[] {
    // For Anthropic, add cache control to static/system messages
    if (messages.length === 0) return messages;
    const result = [...messages];
    // Cache the last system message or first few messages typically
    if (result[0] && result[0].role === 'system') {
      result[0] = {
        ...result[0],
        cache_control: { type: 'ephemeral' }
      };
    }
    return result;
  }
  markAsCached(messages: any[]): void {
    // No-op for Anthropic, handled via cache control
  }
}

export class OpenAIPromptCache implements PromptCacheProvider {
  supportsPromptCaching(): boolean {
    return false; // OpenAI cache varies by model/endpoint
  }
  getStaticCacheKey(): string | null {
    return null;
  }
  buildCachedMessages(messages: any[]): any[] {
    return messages;
  }
  markAsCached(messages: any[]): void {}
}

export class GenericPromptCache implements PromptCacheProvider {
  supportsPromptCaching(): boolean {
    return false;
  }
  getStaticCacheKey(): string | null {
    return null;
  }
  buildCachedMessages(messages: any[]): any[] {
    return messages;
  }
  markAsCached(messages: any[]): void {}
}

export class PromptCacheProviderFactory {
  static create(provider: string): PromptCacheProvider {
    switch (provider.toLowerCase()) {
      case 'anthropic':
        return new AnthropicPromptCache();
      case 'openai':
        return new OpenAIPromptCache();
      default:
        return new GenericPromptCache();
    }
  }
}