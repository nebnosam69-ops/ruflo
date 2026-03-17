/**
 * V3 Custom Provider (Any OpenAI-Compatible Endpoint)
 *
 * Supports any server that speaks the OpenAI chat-completions API:
 *   - LM Studio  (default: http://localhost:1234)
 *   - vLLM       (default: http://localhost:8000)
 *   - LocalAI    (default: http://localhost:8080)
 *   - Jan        (default: http://localhost:1337)
 *   - Tabby      (default: http://localhost:5000)
 *   - Any custom OpenAI-compatible endpoint
 *
 * Required config:
 *   apiUrl   - base URL of the server (no trailing slash)
 *   model    - model identifier as the server expects it
 *   apiKey   - optional (many local servers accept any string)
 *
 * @module @claude-flow/providers/custom-provider
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider,
  LLMModel,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
  ProviderCapabilities,
  HealthCheckResult,
  LLMProviderError,
} from './types.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class CustomProvider extends BaseProvider {
  readonly name: LLMProvider = 'custom';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: [],            // Populated dynamically or left open
    maxContextLength: {},
    maxOutputTokens: {},
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    pricing: {},
  };

  private baseUrl: string = 'http://localhost:1234';

  constructor(options: BaseProviderOptions) {
    super(options);
  }

  protected async doInitialize(): Promise<void> {
    this.baseUrl = (this.config.apiUrl || 'http://localhost:1234').replace(/\/$/, '');
    this.logger.info('CustomProvider initialized', { baseUrl: this.baseUrl, model: this.config.model });
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequest(request, false);
    const response = await this.post('/v1/chat/completions', body);
    const data = await response.json() as OpenAIResponse;
    return this.transformResponse(data, request);
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const body = this.buildRequest(request, true);
    const response = await this.post('/v1/chat/completions', body);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk: OpenAIStreamChunk = JSON.parse(trimmed.slice(6));
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
            yield { type: 'content', delta: { content: delta.content } };
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }

          if (chunk.choices[0]?.finish_reason) {
            yield {
              type: 'done',
              usage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
              },
              cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' },
            };
          }
        } catch {
          // Ignore malformed SSE lines
        }
      }
    }
  }

  async listModels(): Promise<LLMModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.buildHeaders(),
      });
      if (!response.ok) return [this.config.model];
      const data = await response.json() as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id as LLMModel) || [this.config.model];
    } catch {
      return [this.config.model];
    }
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    return {
      model,
      name: model,
      description: `Custom model served at ${this.baseUrl}`,
      contextLength: this.capabilities.maxContextLength[model] || 8192,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 4096,
      supportedFeatures: ['chat', 'completion', 'custom'],
      pricing: { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.buildHeaders(),
      });
      return {
        healthy: response.ok,
        timestamp: new Date(),
        details: { server: 'custom', baseUrl: this.baseUrl },
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Server not reachable',
        timestamp: new Date(),
        details: { baseUrl: this.baseUrl, hint: 'Ensure your LLM server is running' },
      };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout || 120000);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new LLMProviderError(
          text || `HTTP ${response.status}`,
          `CUSTOM_${response.status}`,
          'custom',
          response.status,
          response.status >= 500
        );
      }

      return response;
    } catch (error) {
      clearTimeout(timeout);
      throw this.transformError(error);
    }
  }

  private buildRequest(request: LLMRequest, stream: boolean): OpenAIRequest {
    const messages: OpenAIMessage[] = request.messages.map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
    }));

    const body: OpenAIRequest = {
      model: request.model || this.config.model,
      messages,
      stream,
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;

    if (request.maxTokens) body.max_tokens = request.maxTokens;
    else if (this.config.maxTokens) body.max_tokens = this.config.maxTokens;

    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.stopSequences?.length) body.stop = request.stopSequences;
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice || 'auto';
    }

    return body;
  }

  private transformResponse(data: OpenAIResponse, request: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;

    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      id: data.id || `custom-${Date.now()}`,
      model: (data.model || request.model || this.config.model) as LLMModel,
      provider: 'custom',
      content: choice.message.content || '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' },
      finishReason: (choice.finish_reason as LLMResponse['finishReason']) || 'stop',
    };
  }
}
