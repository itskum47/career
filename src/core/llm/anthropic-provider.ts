/**
 * Anthropic Claude provider.
 * Uses the Messages API. Only loaded when provider is 'anthropic'.
 */

import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMProvider } from './types.ts';
import { logger } from '../logger.ts';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.timeoutMs = config.timeoutMs || 30000;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async getModels(): Promise<string[]> {
    return ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const messages = request.messages.map(m => ({ role: m.role, content: m.content }));
      const systemMsg = messages.find(m => m.role === 'system');
      const userMessages = messages.filter(m => m.role !== 'system');

      const body: Record<string, unknown> = {
        model: this.model,
        messages: userMessages,
        max_tokens: request.maxTokens || 1024,
        temperature: request.temperature ?? 0.7,
      };
      if (systemMsg) body.system = systemMsg.content;
      if (request.jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      const content = data.content?.[0]?.text || '';

      return {
        content,
        model: data.model || this.model,
        provider: this.name,
        promptTokens: data.usage?.input_tokens,
        completionTokens: data.usage?.output_tokens,
        totalTokens: data.usage?.input_tokens + data.usage?.output_tokens,
        latencyMs: Date.now() - start,
        cached: false,
        finishReason: data.stop_reason,
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