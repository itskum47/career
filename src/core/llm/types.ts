/**
 * LLM provider abstraction types.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  responseSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  cached: boolean;
  finishReason?: string;
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
}

export interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'mock';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  maxTokens: number;
}

export interface LLMProvider {
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
  isAvailable(): Promise<boolean>;
  getModels(): Promise<string[]>;
}

export interface LLMCache {
  get(key: string): Promise<LLMResponse | null>;
  set(key: string, response: LLMResponse): Promise<void>;
  clear(): Promise<void>;
}