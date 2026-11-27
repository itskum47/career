/**
 * OpenAI provider.
 * Uses the Chat Completions API. Only loaded when provider is 'openai'.
 */

import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMProvider } from './types.ts';
import { logger } from '../logger.ts';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://api.openai.com';
    this.timeoutMs = config.timeoutMs || 30000;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async getModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const messages = request.messages.map(m => ({ role: m.role, content: m.content }));

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        max_tokens: request.maxTokens || 1024,
        temperature: request.temperature ?? 0.7,
      };
      if (request.jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      return {
        content,
        model: data.model || this.model,
        provider: this.name,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
        latencyMs: Date.now() - start,
        cached: false,
        finishReason: data.choices?.[0]?.finish_reason,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.generate(request);
    const words = response.content.split(/(\s+)/);
    for (const word of words) {
      yield { content: word, done: false };
    }
    yield { content: '', done: true };
  }
}