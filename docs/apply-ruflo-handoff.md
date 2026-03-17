# Apply Ruflo — Complete Handoff

**Branch:** `claude/apply-ruflo-WNADe`
**Repo:** `nebnosam69-ops/ruflo`
**Date:** 2026-03-17
**Status:** Complete — committed and pushed

---

## Summary

Added full self-hosted LLM support to the Ruflo / claude-flow platform.
The platform can now talk to any local AI model (LM Studio, vLLM, Ollama,
LiteLLM proxy) via CLI commands and a standalone web chat app.

**12 files changed · 2,533 lines added**

---

## What Was Built

### 1. Two New Provider Implementations

#### `v3/@claude-flow/providers/src/custom-provider.ts`
Generic OpenAI-compatible provider for any self-hosted LLM server.

- Targets LM Studio, vLLM, LocalAI, Jan, Tabby, and any `/v1/chat/completions` server
- Full streaming SSE parsing with `doStreamComplete()`
- Health check via `/v1/models`, dynamic model list via `listModels()`
- Cost tracking always returns `$0` (local = free)
- `readonly name: LLMProvider = 'custom'`

#### `v3/@claude-flow/providers/src/litellm-provider.ts`
LiteLLM proxy provider giving access to 100+ models behind one endpoint.

- Default URL: `http://localhost:4000`
- Supports model strings like `ollama/llama3.2`, `openai/gpt-4o`,
  `anthropic/claude-3-5-sonnet-20241022`, `google/gemini-1.5-pro`
- Health check tries `/health` first, falls back to `/v1/models`
- `readonly name: LLMProvider = 'litellm'`

Both extend the existing `BaseProvider` class and use the `LLMProvider` type
(which already contained `'litellm'` and `'custom'` entries).

#### Wiring changes
- `v3/@claude-flow/providers/src/provider-manager.ts` — added `case 'litellm'`
  and `case 'custom'` to `createProvider()` switch
- `v3/@claude-flow/providers/src/index.ts` — re-exports both new classes

---

### 2. Rewritten Providers CLI Command

**File:** `v3/@claude-flow/cli/src/commands/providers.ts`

Replaced the original stub with a fully working command that:

- Reads/writes **`claude-flow.config.json`** for persistence
- Makes **live HTTP calls** to test connectivity on `providers add` and `providers test`
- Validates provider type against `['custom','litellm','ollama','anthropic','openai','google','cohere']`

#### `ProviderEntry` shape (stored in config)
```typescript
interface ProviderEntry {
  name: string;
  type: 'custom' | 'litellm' | 'anthropic' | 'openai' | 'google' | 'cohere' | 'ollama';
  apiUrl?: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
  addedAt?: string;
}
```

#### Subcommands

| Subcommand   | What it does |
|--------------|-------------|
| `list`       | Show built-in catalogue + configured providers |
| `add`        | Register provider, ping endpoint, save to config |
| `configure`  | Update URL / model / key / enable / disable |
| `remove`     | Delete from config |
| `test`       | Live connectivity check (hits `/v1/models` or `/health`) |
| `models`     | Fetch live model list or show static catalogue |
| `usage`      | Usage statistics table |

#### Key internal functions
- `pingEndpoint(url, key)` — hits `/v1/models`, returns `{ ok, models[] }`
- `pingLiteLLM(url, key)` — tries `/health` then `/v1/models`
- `loadConfig()` / `saveConfig()` — read/write `claude-flow.config.json`

#### Usage examples
```bash
# Add LM Studio
claude-flow providers add --name lmstudio --url http://localhost:1234 --model my-model

# Add LiteLLM proxy
claude-flow providers add --name litellm --type litellm --url http://localhost:4000 --model ollama/llama3.2

# Test all
claude-flow providers test --all

# Live model list
claude-flow providers models --name lmstudio
```

---

### 3. Interactive Chat CLI Command

**File:** `v3/@claude-flow/cli/src/commands/chat.ts` (~530 lines)

Full interactive REPL + pipe mode, self-contained (no `@claude-flow/providers` dep).

#### Provider support matrix

| Type       | URL built                           | Auth header        |
|------------|-------------------------------------|--------------------|
| `anthropic`| `.../v1/messages`                   | `x-api-key`        |
| `openai`   | `.../v1/chat/completions`           | `Bearer`           |
| `google`   | `.../v1beta/models/{m}:streamGen... | `?key=`            |
| `ollama`   | `.../api/chat`                      | (none)             |
| `litellm`  | `.../v1/chat/completions`           | `Bearer` (opt)     |
| `custom`   | `.../v1/chat/completions`           | `Bearer` (opt)     |

#### `parseDelta()` — handles three SSE formats
- **Anthropic:** `content_block_delta`, `message_start`, `message_delta`, `message_stop`
- **Ollama:** `{ message: { content } }` newline-delimited JSON
- **OpenAI-compatible:** `{ choices[0].delta.content }`

#### Slash commands (interactive mode)
```
/help      /clear     /history   /save [name]
/load <n>  /sessions  /system    /tokens
/models    /provider  /exit      /quit
```

#### Session persistence
Sessions auto-saved to `~/.claude-flow/chat-history/<id>.json` on exit.
Resume with `--session <name>`.

#### Usage examples
```bash
# Interactive with configured provider
node v3/@claude-flow/cli/bin/cli.js chat --provider ollama

# Ad-hoc (no config needed)
node v3/@claude-flow/cli/bin/cli.js chat --url http://localhost:1234 --model my-model

# LiteLLM proxy
node v3/@claude-flow/cli/bin/cli.js chat --url http://localhost:4000 --type litellm --model ollama/llama3.2

# Pipe / one-shot
echo "What is 2+2?" | node v3/@claude-flow/cli/bin/cli.js chat --provider ollama

# With system prompt
node v3/@claude-flow/cli/bin/cli.js chat --provider ollama --system "You are a Rust expert"
```

#### Registration in `index.ts`
```typescript
// commandLoaders
chat: () => import('./chat.js'),

// sync import + cache
import { chatCommand } from './chat.js';
loadedCommands.set('chat', chatCommand);
```

---

### 4. Self-Contained Web Chat App

**File:** `scripts/chat-app.mjs` (~660 lines)

Zero npm dependencies — pure Node.js built-ins only.

#### Architecture
```
Browser ──POST /api/chat──► Node HTTP server ──POST /api/chat──► Ollama
                                    │
                              GET /api/health
                              GET / (inline HTML)
```

The server re-emits Ollama's NDJSON as OpenAI-compatible SSE so the browser
JS works with either format.

#### Config (env vars)
```bash
PORT=3000                          # default 3000
OLLAMA_URL=http://localhost:11434  # Ollama address
MODEL=llama3.2:1b                  # model to use
```

#### Startup output
```
  ╔══════════════════════════════════════════╗
  ║  RuFlo Chat  →  http://localhost:3000       ║
  ║  Phone/LAN  →  http://192.168.x.x:3000  ║
  ║  Model: llama3.2:1b                     ║
  ║  Ollama: http://localhost:11434         ║
  ╚══════════════════════════════════════════╝
```

Shows local network IP automatically for phone/LAN access.

#### Features
- Dark-themed chat UI with purple/teal accent
- Real-time streaming with blinking cursor
- System prompt input bar
- Markdown rendering (bold, italic, code blocks, inline code)
- Auto-resize textarea, Shift+Enter for newlines
- Health indicator dot (green = Ollama up, red = down)
- Clear button resets conversation
- Elapsed time per response
- CORS headers for dev

#### Run
```bash
# Basic
node scripts/chat-app.mjs

# Custom model
MODEL=llama3.2:3b node scripts/chat-app.mjs

# Custom port
PORT=8080 node scripts/chat-app.mjs
```

---

### 5. Version Bumps

All three packages bumped `3.5.15 → 3.5.17` to match published npm versions:
- `package.json`
- `ruflo/package.json`
- `v3/@claude-flow/cli/package.json`

---

## Commit History (this branch)

```
c1c8a73  fix: show local network IP on startup for phone/LAN access
d46a8d2  feat: add self-contained web chat UI (scripts/chat-app.mjs)
6887085  chore: update v3 package-lock.json
792da2b  fix: resolve build errors and expand providers add to all types
25927af  feat: add interactive chat command for self-hosted LLMs
a0d6089  feat: make providers CLI fully functional for custom/self-hosted LLMs
f172494  feat: add CustomProvider and LiteLLMProvider for self-hosted LLMs
fbc3d0f  chore: bump all packages to v3.5.17
```

---

## Current Machine State

```bash
ollama list
# NAME           ID              SIZE      MODIFIED
# llama3.2:1b    baf6a787fdff    1.3 GB    running

curl http://localhost:3000/api/health
# {"ok":true,"model":"llama3.2:1b","available":["llama3.2:1b"]}
```

---

## File Contents

### `v3/@claude-flow/providers/src/custom-provider.ts`

```typescript
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
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ProviderCapabilities, HealthCheckResult, LLMProviderError,
} from './types.js';

export class CustomProvider extends BaseProvider {
  readonly name: LLMProvider = 'custom';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: [], maxContextLength: {}, maxOutputTokens: {},
    supportsStreaming: true, supportsToolCalling: true, supportsSystemMessages: true,
    supportsVision: false, supportsAudio: false, supportsFineTuning: false,
    supportsEmbeddings: false, supportsBatching: false, pricing: {},
  };
  private baseUrl: string = 'http://localhost:1234';

  constructor(options: BaseProviderOptions) { super(options); }

  protected async doInitialize(): Promise<void> {
    this.baseUrl = (this.config.apiUrl || 'http://localhost:1234').replace(/\/$/, '');
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequest(request, false);
    const response = await this.post('/v1/chat/completions', body);
    return this.transformResponse(await response.json(), request);
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const response = await this.post('/v1/chat/completions', this.buildRequest(request, true));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0, completionTokens = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(t.slice(6));
          if (chunk.choices[0]?.delta?.content)
            yield { type: 'content', delta: { content: chunk.choices[0].delta.content } };
          if (chunk.usage) { promptTokens = chunk.usage.prompt_tokens; completionTokens = chunk.usage.completion_tokens; }
          if (chunk.choices[0]?.finish_reason)
            yield { type: 'done',
              usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
              cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' } };
        } catch { /* skip malformed */ }
      }
    }
  }

  async listModels(): Promise<LLMModel[]> {
    try {
      const r = await fetch(`${this.baseUrl}/v1/models`, { headers: this.buildHeaders() });
      if (!r.ok) return [this.config.model];
      const d = await r.json();
      return d.data?.map((m: { id: string }) => m.id) || [this.config.model];
    } catch { return [this.config.model]; }
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    return {
      model, name: model,
      description: `Custom model served at ${this.baseUrl}`,
      contextLength: 8192, maxOutputTokens: 4096,
      supportedFeatures: ['chat', 'completion', 'custom'],
      pricing: { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    try {
      const r = await fetch(`${this.baseUrl}/v1/models`, { headers: this.buildHeaders() });
      return { healthy: r.ok, timestamp: new Date(),
        details: { server: 'custom', baseUrl: this.baseUrl },
        ...(!r.ok ? { error: `HTTP ${r.status}` } : {}) };
    } catch (e) {
      return { healthy: false, error: e instanceof Error ? e.message : 'Server not reachable',
        timestamp: new Date(), details: { baseUrl: this.baseUrl } };
    }
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), this.config.timeout || 120000);
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST', headers: this.buildHeaders(),
        body: JSON.stringify(body), signal: c.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        const text = await r.text();
        throw new LLMProviderError(text, `CUSTOM_${r.status}`, 'custom', r.status, r.status >= 500);
      }
      return r;
    } catch (e) { clearTimeout(t); throw this.transformError(e); }
  }

  private buildRequest(req: LLMRequest, stream: boolean) {
    const messages = req.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    }));
    const body: Record<string, unknown> = { model: req.model || this.config.model, messages, stream };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stopSequences?.length) body.stop = req.stopSequences;
    if (req.tools?.length) { body.tools = req.tools; body.tool_choice = req.toolChoice || 'auto'; }
    return body;
  }

  private transformResponse(data: any, req: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    const pt = data.usage?.prompt_tokens || 0, ct = data.usage?.completion_tokens || 0;
    return {
      id: data.id || `custom-${Date.now()}`,
      model: (data.model || req.model || this.config.model) as LLMModel,
      provider: 'custom', content: choice.message.content || '',
      usage: { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct },
      cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' },
      finishReason: choice.finish_reason || 'stop',
    };
  }
}
```

---

### `v3/@claude-flow/providers/src/litellm-provider.ts`

```typescript
/**
 * V3 LiteLLM Provider — 100+ models via a single OpenAI-compatible proxy.
 *
 * Quick start:
 *   pip install litellm
 *   litellm --model ollama/llama3.2 --port 4000
 *
 * Model string examples:
 *   ollama/llama3.2   openai/gpt-4o
 *   anthropic/claude-3-5-sonnet-20241022
 *   google/gemini-1.5-pro
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ProviderCapabilities, HealthCheckResult, LLMProviderError,
} from './types.js';

export class LiteLLMProvider extends BaseProvider {
  readonly name: LLMProvider = 'litellm';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: [
      'ollama/llama3.2', 'ollama/llama3.1', 'ollama/mistral', 'ollama/codellama',
      'openai/gpt-4o', 'openai/gpt-4o-mini',
      'anthropic/claude-3-5-sonnet-20241022', 'google/gemini-1.5-pro',
    ],
    maxContextLength: {}, maxOutputTokens: {},
    supportsStreaming: true, supportsToolCalling: true, supportsSystemMessages: true,
    supportsVision: false, supportsAudio: false, supportsFineTuning: false,
    supportsEmbeddings: true, supportsBatching: false,
    rateLimit: { requestsPerMinute: 10000, tokensPerMinute: 10000000, concurrentRequests: 50 },
    pricing: {},
  };
  private baseUrl = 'http://localhost:4000';

  constructor(options: BaseProviderOptions) { super(options); }

  protected async doInitialize(): Promise<void> {
    this.baseUrl = (this.config.apiUrl || 'http://localhost:4000').replace(/\/$/, '');
    const health = await this.doHealthCheck();
    if (!health.healthy)
      this.logger.warn('LiteLLM proxy not detected. Start with: litellm --model <model>', { baseUrl: this.baseUrl });
  }

  // doComplete, doStreamComplete, listModels — same SSE parsing pattern as CustomProvider
  // Health check tries /health first, falls back to /v1/models

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    for (const path of ['/health', '/v1/models']) {
      try {
        const r = await fetch(`${this.baseUrl}${path}`, {
          headers: this.buildHeaders(), signal: AbortSignal.timeout(5000),
        });
        if (r.ok) return { healthy: true, timestamp: new Date(),
          details: { server: 'litellm', baseUrl: this.baseUrl } };
      } catch { /* try next */ }
    }
    return { healthy: false, error: 'LiteLLM proxy not reachable', timestamp: new Date(),
      details: { baseUrl: this.baseUrl, hint: 'litellm --model ollama/llama3.2 --port 4000' } };
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }
}
```

---

### `v3/@claude-flow/cli/src/commands/providers.ts` — Key sections

```typescript
// Config file: claude-flow.config.json
interface ProviderEntry {
  name: string;
  type: 'custom' | 'litellm' | 'anthropic' | 'openai' | 'google' | 'cohere' | 'ollama';
  apiUrl?: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
  addedAt?: string;
}

// Live health checks
async function pingEndpoint(apiUrl, apiKey?, timeoutMs=5000) {
  // hits /v1/models → returns { ok, models[] }
}
async function pingLiteLLM(apiUrl, apiKey?, timeoutMs=5000) {
  // tries /health then /v1/models → returns { ok, models[] }
}

// Subcommands: list | add | configure | remove | test | models | usage
export const providersCommand: Command = { name: 'providers', subcommands: [...] };
```

---

### `v3/@claude-flow/cli/src/commands/chat.ts` — Key sections

```typescript
// Resolve provider from claude-flow.config.json or ad-hoc flags
function resolveProvider(name?: string): ProviderEntry | undefined

// Build provider-specific URL
function buildUrl(prov: ProviderEntry): string
// anthropic → /v1/messages
// ollama    → /api/chat
// google    → /v1beta/models/{m}:streamGenerateContent?alt=sse&key=...
// others    → /v1/chat/completions

// Parse SSE delta — handles 3 formats
function parseDelta(line, type): { text?, done?, pt?, ct? }

// Main streaming function
async function stream(prov, msgs, maxTok, temp, onChunk): Promise<Stats>

// Interactive REPL with readline
async function runInteractive(prov, msgs, sid, maxTok, temp): Promise<void>

// Non-interactive stdin → stdout
async function runPipe(prov, msgs, input, maxTok, temp): Promise<void>

export const chatCommand: Command = { name: 'chat', ... }
```

---

### `scripts/chat-app.mjs` — Key sections

```javascript
// Config
const PORT       = parseInt(process.env.PORT       || '3000', 10);
const OLLAMA_URL = process.env.OLLAMA_URL           || 'http://localhost:11434';
const MODEL      = process.env.MODEL               || 'llama3.2:1b';

// Endpoints
GET  /              → inline HTML chat UI
GET  /api/health    → { ok, model, available[] }
POST /api/chat      → proxy to Ollama, re-emit as OpenAI SSE

// Startup — detects LAN IP automatically
server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();  // node:os networkInterfaces()
  console.log(`Phone/LAN  →  http://${localIP}:${PORT}`);
});
```

---

## Possible Next Steps

1. **Wire `chat.ts` to `@claude-flow/providers`** — currently uses inline HTTP client;
   could import `ProviderManager.createProvider()` for consistency and circuit-breaker support

2. **Model switcher in web app** — dropdown to change model without restart;
   fetch `/api/health` available[] list and populate a `<select>`

3. **Conversation persistence in web app** — `localStorage` to restore chat on reload

4. **Publish to npm** — per CLAUDE.md, must publish all three packages:
   `@claude-flow/cli`, `claude-flow`, `ruflo` with tags `alpha`, `latest`, `v3alpha`

5. **LM Studio / vLLM setup guide** — short doc in `/docs/` for users who don't use Ollama

6. **WebSocket streaming** — lower latency than SSE+proxy for the web app

7. **Add `benchmark` provider type** — run the same prompt against multiple providers
   and compare latency, token count, and quality side-by-side
