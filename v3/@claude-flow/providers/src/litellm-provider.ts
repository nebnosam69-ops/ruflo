/**
 * V3 LiteLLM Provider
 *
 * Routes requests through a LiteLLM proxy server, giving access to 100+ models
 * via a single OpenAI-compatible endpoint:
 *
 *   openai/gpt-4o         openai/gpt-4o-mini
 *   anthropic/claude-3-5-sonnet-20241022
 *   google/gemini-1.5-pro  vertex_ai/gemini-pro
 *   ollama/llama3.2        huggingface/mistralai/Mistral-7B
 *   together_ai/togethercomputer/RedPajama-INCITE-7B
 *   ... and 100+ more: https://docs.litellm.ai/docs/providers
 *
 * Quick start:
 *   pip install litellm
 *   litellm --model ollama/llama3.2       # local
 *   litellm --model gpt-4o --port 4000    # proxy
 *
 * Config:
 *   apiUrl  - LiteLLM proxy base URL (default: http://localhost:4000)
 *   model   - model string with provider prefix (e.g. "ollama/llama3.2")
 *   apiKey  - optional master key if set on the proxy
 *
 * @module @claude-flow/providers/litellm-provider
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
}

interface LiteLLMRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
}

interface LiteLLMResponse {
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
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // LiteLLM-specific metadata
  _response_ms?: number;
  _hidden_params?: Record<string, unknown>;
}

interface LiteLLMStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface LiteLLMModelsResponse {
  data: Array<{ id: string; object: string }>;
}

export class LiteLLMProvider extends BaseProvider {
  readonly name: LLMProvider = 'litellm';
  readonly capabilities: ProviderCapabilities = {
    // LiteLLM dynamically proxies any model — list populated at runtime
    supportedModels: [
      // Common defaults; actual list comes from /v1/models at runtime
      'ollama/llama3.2',
      'ollama/llama3.1',
      'ollama/mistral',
      'ollama/codellama',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'anthropic/claude-3-5-sonnet-20241022',
      'google/gemini-1.5-pro',
      'custom-model',
    ],
    maxContextLength: {},
    maxOutputTokens: {},
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: false,     // Depends on upstream model
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: true,  // LiteLLM supports /v1/embeddings
    supportsBatching: false,
    rateLimit: {
      requestsPerMinute: 10000,
      tokensPerMinute: 10000000,
      concurrentRequests: 50,
    },
    pricing: {},               // Cost depends on upstream; LiteLLM tracks it server-side
  };

  private baseUrl: string = 'http://localhost:4000';

  constructor(options: BaseProviderOptions) {
    super(options);
  }

  protected async doInitialize(): Promise<void> {
    this.baseUrl = (this.config.apiUrl || 'http://localhost:4000').replace(/\/$/, '');

    const health = await this.doHealthCheck();
    if (!health.healthy) {
      this.logger.warn('LiteLLM proxy not detected. Start it with: litellm --model <model>', {
        baseUrl: this.baseUrl,
      });
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequest(request, false);
    const response = await this.post('/v1/chat/completions', body);
    const data = await response.json() as LiteLLMResponse;
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
          const chunk: LiteLLMStreamChunk = JSON.parse(trimmed.slice(6));
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
          // Skip malformed SSE lines
        }
      }
    }
  }

  async listModels(): Promise<LLMModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.buildHeaders(),
      });
      if (!response.ok) return this.capabilities.supportedModels;
      const data = await response.json() as LiteLLMModelsResponse;
      const models = data.data?.map((m) => m.id as LLMModel) || [];
      return models.length ? models : this.capabilities.supportedModels;
    } catch {
      return this.capabilities.supportedModels;
    }
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    // LiteLLM model IDs are typically "provider/model-name"
    const [providerPrefix, ...rest] = model.split('/');
    const modelName = rest.join('/') || model;

    return {
      model,
      name: model,
      description: `${modelName} via LiteLLM proxy (${providerPrefix || 'custom'} backend)`,
      contextLength: this.capabilities.maxContextLength[model] || 8192,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 4096,
      supportedFeatures: ['chat', 'completion', 'litellm-proxy'],
      pricing: { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return {
          healthy: true,
          timestamp: new Date(),
          details: { server: 'litellm', baseUrl: this.baseUrl },
        };
      }

      // Fallback: try /v1/models (some deployments don't expose /health)
      const modelsResp = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });

      return {
        healthy: modelsResp.ok,
        timestamp: new Date(),
        details: { server: 'litellm', baseUrl: this.baseUrl },
        ...(modelsResp.ok ? {} : { error: `HTTP ${modelsResp.status}` }),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'LiteLLM proxy not reachable',
        timestamp: new Date(),
        details: {
          baseUrl: this.baseUrl,
          hint: 'Start LiteLLM: litellm --model ollama/llama3.2 --port 4000',
        },
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
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed.error?.message || parsed.detail || text;
        } catch { /* use raw text */ }

        throw new LLMProviderError(
          message,
          `LITELLM_${response.status}`,
          'litellm',
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

  private buildRequest(request: LLMRequest, stream: boolean): LiteLLMRequest {
    const messages: OpenAIMessage[] = request.messages.map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
    }));

    const body: LiteLLMRequest = {
      model: request.model || this.config.model,
      messages,
      stream,
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;

    if (request.maxTokens) body.max_tokens = request.maxTokens;
    else if (this.config.maxTokens) body.max_tokens = this.config.maxTokens;

    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stopSequences?.length) body.stop = request.stopSequences;
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice || 'auto';
    }

    return body;
  }

  private transformResponse(data: LiteLLMResponse, request: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;

    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      id: data.id || `litellm-${Date.now()}`,
      model: (data.model || request.model || this.config.model) as LLMModel,
      provider: 'litellm',
      content: choice.message.content || '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' },
      finishReason: (choice.finish_reason as LLMResponse['finishReason']) || 'stop',
      latency: data._response_ms,
    };
  }
}
