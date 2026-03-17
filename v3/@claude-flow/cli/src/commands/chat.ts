/**
 * chat — Interactive LLM Chat Command
 *
 * Works with any provider from `claude-flow providers add`:
 *   custom · litellm · anthropic · openai · google · ollama
 *
 * Features:
 *  - Real-time streaming output
 *  - Persistent sessions (~/.claude-flow/chat-history/)
 *  - System prompt support
 *  - Slash commands: /help /clear /save /load /sessions /history /system /tokens /models /provider /exit
 *  - Non-interactive pipe mode  (echo "q" | claude-flow chat -p lmstudio)
 *  - Token + cost tracking
 *
 * Usage:
 *   claude-flow chat                                  # first enabled provider
 *   claude-flow chat -p lmstudio                      # named provider
 *   claude-flow chat -u http://localhost:1234 -m model # ad-hoc (no config)
 *   claude-flow chat -u http://localhost:4000 -t litellm -m ollama/llama3.2
 *   echo "What is Rust?" | claude-flow chat -p lmstudio
 */

import { createInterface }                                        from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync,
         readdirSync }                                           from 'node:fs';
import { resolve, join }                                         from 'node:path';
import { homedir }                                               from 'node:os';
import type { Command, CommandContext, CommandResult }           from '../types.js';
import { output }                                               from '../output.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ProviderEntry {
  name: string;
  type: 'custom' | 'litellm' | 'anthropic' | 'openai' | 'google' | 'cohere' | 'ollama';
  apiUrl?: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
}

interface ConfigFile { providers?: ProviderEntry[]; [k: string]: unknown; }

interface Stats {
  promptTokens: number; completionTokens: number;
  totalTokens: number; cost: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig(): ConfigFile {
  const p = resolve(process.cwd(), 'claude-flow.config.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as ConfigFile; } catch { return {}; }
}

function getProviders(): ProviderEntry[] {
  return loadConfig().providers?.filter(p => p.enabled) ?? [];
}

function resolveProvider(name?: string): ProviderEntry | undefined {
  const all = getProviders();
  return name ? all.find(p => p.name === name) : all[0];
}

// ─── History ──────────────────────────────────────────────────────────────────

function historyDir(): string {
  const d = join(homedir(), '.claude-flow', 'chat-history');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function saveSession(id: string, msgs: Message[]): string {
  const f = join(historyDir(), `${id}.json`);
  writeFileSync(f, JSON.stringify(msgs, null, 2), 'utf8');
  return f;
}

function loadSession(id: string): Message[] | undefined {
  const f = join(historyDir(), `${id}.json`);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, 'utf8')) as Message[]; } catch { return undefined; }
}

function listSessions(): string[] {
  try {
    return readdirSync(historyDir())
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort().reverse().slice(0, 20);
  } catch { return []; }
}

// ─── Provider helpers ─────────────────────────────────────────────────────────

function defaultUrl(t: string): string {
  const m: Record<string, string> = {
    anthropic: 'https://api.anthropic.com',
    openai:    'https://api.openai.com',
    google:    'https://generativelanguage.googleapis.com',
    ollama:    'http://localhost:11434',
    litellm:   'http://localhost:4000',
  };
  return m[t] ?? 'http://localhost:1234';
}

function defaultModel(t: string): string {
  const m: Record<string, string> = {
    anthropic: 'claude-3-5-sonnet-20241022',
    openai:    'gpt-4o-mini',
    google:    'gemini-2.0-flash',
    ollama:    'llama3.2',
    litellm:   'ollama/llama3.2',
  };
  return m[t] ?? 'custom-model';
}

function pricePer1k(model: string): { p: number; c: number } {
  if (model.includes('gpt-4o-mini'))       return { p: 0.00015, c: 0.0006 };
  if (model.includes('gpt-4o'))            return { p: 0.005,   c: 0.015  };
  if (model.includes('claude-3-5-sonnet')) return { p: 0.003,   c: 0.015  };
  if (model.includes('claude-3-opus'))     return { p: 0.015,   c: 0.075  };
  if (model.includes('gemini-2.0-flash'))  return { p: 0.00015, c: 0.0006 };
  if (model.includes('gemini-1.5-pro'))    return { p: 0.00125, c: 0.005  };
  return { p: 0, c: 0 };
}

function estimateCost(model: string, pt: number, ct: number): number {
  const { p, c } = pricePer1k(model);
  return (pt / 1000) * p + (ct / 1000) * c;
}

// ─── HTTP streaming ───────────────────────────────────────────────────────────

function buildHeaders(prov: ProviderEntry): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (prov.type === 'anthropic') {
    h['x-api-key']         = prov.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    h['anthropic-version'] = '2023-06-01';
  } else {
    const key = prov.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (key) h['Authorization'] = `Bearer ${key}`;
  }
  return h;
}

function buildUrl(prov: ProviderEntry): string {
  const base = (prov.apiUrl ?? defaultUrl(prov.type)).replace(/\/$/, '');
  if (prov.type === 'anthropic') return `${base}/v1/messages`;
  if (prov.type === 'ollama')    return `${base}/api/chat`;
  if (prov.type === 'google') {
    const key = prov.apiKey ?? process.env.GOOGLE_API_KEY ?? '';
    return `${base}/v1beta/models/${prov.model}:streamGenerateContent?alt=sse&key=${key}`;
  }
  return `${base}/v1/chat/completions`;
}

function buildBody(prov: ProviderEntry, msgs: Message[], maxTok: number, temp: number): unknown {
  const model = prov.model;
  if (prov.type === 'anthropic') {
    const sys   = msgs.find(m => m.role === 'system')?.content;
    const convo = msgs.filter(m => m.role !== 'system');
    return { model, max_tokens: maxTok, temperature: temp, stream: true,
      ...(sys ? { system: sys } : {}),
      messages: convo.map(m => ({ role: m.role, content: m.content })) };
  }
  if (prov.type === 'ollama') {
    return { model, stream: true, options: { temperature: temp, num_predict: maxTok },
      messages: msgs.map(m => ({ role: m.role, content: m.content })) };
  }
  return { model, temperature: temp, max_tokens: maxTok, stream: true,
    messages: msgs.map(m => ({ role: m.role, content: m.content })) };
}

function parseDelta(line: string, type: string): { text?: string; done?: boolean; pt?: number; ct?: number } {
  if (line === '[DONE]') return { done: true };
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;

    if (type === 'anthropic') {
      const t = obj.type as string;
      if (t === 'content_block_delta') return { text: ((obj.delta as Record<string,string>)?.text) ?? '' };
      if (t === 'message_start') {
        const u = (obj.message as Record<string, Record<string,number>>)?.usage;
        return { pt: u?.input_tokens ?? 0 };
      }
      if (t === 'message_delta') {
        const u = (obj.usage as Record<string,number>);
        return { ct: u?.output_tokens ?? 0 };
      }
      if (t === 'message_stop') return { done: true };
      return {};
    }

    if (type === 'ollama') {
      const msg = (obj.message as Record<string,string>);
      return { text: msg?.content ?? '', done: !!(obj.done) };
    }

    // OpenAI-compatible
    const choices = obj.choices as Array<Record<string, unknown>>;
    if (!choices?.length) return {};
    const delta  = choices[0]?.delta  as Record<string, unknown>;
    const finish = choices[0]?.finish_reason as string | null;
    const usage  = obj.usage as Record<string, number> | undefined;
    return {
      text: (delta?.content as string) ?? '',
      done: finish === 'stop' || finish === 'length',
      ...(usage ? { pt: usage.prompt_tokens, ct: usage.completion_tokens } : {}),
    };
  } catch { return {}; }
}

async function stream(
  prov: ProviderEntry, msgs: Message[], maxTok: number, temp: number,
  onChunk: (t: string) => void
): Promise<Stats> {
  const res = await fetch(buildUrl(prov), {
    method: 'POST', headers: buildHeaders(prov),
    body: JSON.stringify(buildBody(prov, msgs, maxTok, temp)),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try { msg = (JSON.parse(txt) as { error?: { message?: string } }).error?.message ?? txt; } catch { /* ok */ }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  const reader = res.body!.getReader();
  const dec    = new TextDecoder();
  let buf = '';
  const s: Stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const data = t.startsWith('data: ') ? t.slice(6) : t;
      const d = parseDelta(data, prov.type);
      if (d.text)  onChunk(d.text);
      if (d.pt)    s.promptTokens     += d.pt;
      if (d.ct)    s.completionTokens += d.ct;
    }
  }

  s.totalTokens = s.promptTokens + s.completionTokens;
  s.cost        = estimateCost(prov.model, s.promptTokens, s.completionTokens);
  return s;
}

// ─── Slash help ───────────────────────────────────────────────────────────────

const HELP = `
  /help              Show this message
  /clear             Clear conversation (keep system prompt)
  /history           Print conversation so far
  /save [name]       Save session to ~/.claude-flow/chat-history/
  /load <name>       Load a saved session
  /sessions          List saved sessions
  /system [text]     Get or set the system prompt
  /tokens            Show token + cost stats for this session
  /models            Fetch model list from current endpoint
  /provider          Show current provider details
  /exit  /quit       Exit`.trim();

// ─── Interactive REPL ─────────────────────────────────────────────────────────

async function runInteractive(prov: ProviderEntry, msgs: Message[], sid: string, maxTok: number, temp: number): Promise<void> {
  const rl    = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const total: Stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };

  process.stdout.write('\n');
  process.stdout.write(output.bold('  RuFlo Chat') + '  ' + output.dim(`[${prov.name} · ${prov.model}]`) + '\n');
  process.stdout.write(output.dim('  /help for commands · /exit to quit\n'));
  process.stdout.write(output.dim('  ' + '─'.repeat(54)) + '\n\n');

  const ask = () => rl.question(output.bold(output.cyan('You')) + output.dim(': '), handle);

  const handle = async (raw: string) => {
    const line = raw.trim();
    if (!line) { ask(); return; }

    // Slash commands
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(' ');
      const arg = rest.join(' ').trim();
      switch (cmd.toLowerCase()) {

        case 'exit': case 'quit':
          process.stdout.write('\n' + output.dim('  Bye!\n\n'));
          rl.close(); return;

        case 'help':
          process.stdout.write('\n' + HELP.split('\n').map(l => '  ' + l).join('\n') + '\n\n');
          break;

        case 'clear': {
          const sys = msgs.find(m => m.role === 'system');
          msgs.length = 0; if (sys) msgs.push(sys);
          process.stdout.write(output.dim('  Cleared.\n\n')); break;
        }

        case 'history':
          process.stdout.write('\n');
          for (const m of msgs) {
            if (m.role === 'system') { process.stdout.write(output.dim('  [system] ' + m.content.slice(0,80)) + '\n'); continue; }
            const lbl = m.role === 'user' ? output.cyan('  You') + output.dim(': ') : output.green('  AI') + output.dim(':  ');
            process.stdout.write(lbl + (m.content.length > 120 ? m.content.slice(0,120) + '…' : m.content) + '\n');
          }
          process.stdout.write('\n'); break;

        case 'save': {
          const name = arg || sid;
          const f = saveSession(name, msgs);
          process.stdout.write(output.success(`  Saved → ${f}\n\n`)); break;
        }

        case 'load': {
          if (!arg) { process.stdout.write(output.warning('  Usage: /load <name>\n\n')); break; }
          const loaded = loadSession(arg);
          if (!loaded) { process.stdout.write(output.warning(`  Session "${arg}" not found.\n\n`)); break; }
          msgs.length = 0; msgs.push(...loaded);
          process.stdout.write(output.success(`  Loaded "${arg}" (${loaded.filter(m=>m.role!=='system').length} msgs)\n\n`)); break;
        }

        case 'sessions': {
          const ss = listSessions();
          if (!ss.length) { process.stdout.write(output.dim('  No saved sessions.\n\n')); break; }
          process.stdout.write('\n  Saved sessions:\n');
          ss.forEach(s => process.stdout.write(output.dim(`    ${s}\n`)));
          process.stdout.write('\n'); break;
        }

        case 'system':
          if (!arg) {
            const s = msgs.find(m => m.role === 'system');
            process.stdout.write('\n' + (s ? output.dim('  System: ') + s.content : output.dim('  (none)')) + '\n\n');
          } else {
            const i = msgs.findIndex(m => m.role === 'system');
            if (i >= 0) msgs[i].content = arg; else msgs.unshift({ role: 'system', content: arg });
            process.stdout.write(output.success('  System prompt set.\n\n'));
          }
          break;

        case 'tokens':
          process.stdout.write(
            `\n  Tokens: ${output.bold(String(total.totalTokens))}` +
            `  (prompt ${total.promptTokens} · completion ${total.completionTokens})\n` +
            `  Cost: $${total.cost.toFixed(6)}\n\n`
          ); break;

        case 'models': {
          const base = (prov.apiUrl ?? defaultUrl(prov.type)).replace(/\/$/, '');
          const h: Record<string,string> = prov.apiKey ? { Authorization: `Bearer ${prov.apiKey}` } : {};
          try {
            const r = await fetch(`${base}/v1/models`, { headers: h, signal: AbortSignal.timeout(5000) });
            if (r.ok) {
              const d = await r.json() as { data?: Array<{id:string}> };
              const ms = d.data?.map(m => m.id) ?? [];
              process.stdout.write('\n  Models:\n');
              ms.slice(0,30).forEach(m => process.stdout.write(output.dim(`    ${m}\n`)));
              if (ms.length > 30) process.stdout.write(output.dim(`    … +${ms.length-30} more\n`));
              process.stdout.write('\n');
            } else { process.stdout.write(output.warning(`  HTTP ${r.status}\n\n`)); }
          } catch (e) { process.stdout.write(output.warning(`  ${e instanceof Error ? e.message : e}\n\n`)); }
          break;
        }

        case 'provider':
          process.stdout.write(
            `\n  Name:  ${prov.name}\n  Type:  ${prov.type}\n` +
            `  URL:   ${prov.apiUrl ?? defaultUrl(prov.type)}\n  Model: ${prov.model}\n\n`
          ); break;

        default:
          process.stdout.write(output.warning(`  Unknown: /${cmd}\n\n`));
      }
      ask(); return;
    }

    // Normal message
    msgs.push({ role: 'user', content: line });
    process.stdout.write('\n' + output.bold(output.green('AI')) + output.dim(':  '));

    try {
      let reply = '';
      const s = await stream(prov, msgs, maxTok, temp, chunk => { process.stdout.write(chunk); reply += chunk; });
      process.stdout.write('\n\n');
      if (s.totalTokens > 0) {
        process.stdout.write(output.dim(`  [${s.totalTokens} tok${s.cost > 0 ? ` · $${s.cost.toFixed(6)}` : ''}]\n\n`));
      }
      total.promptTokens     += s.promptTokens;
      total.completionTokens += s.completionTokens;
      total.totalTokens      += s.totalTokens;
      total.cost             += s.cost;
      msgs.push({ role: 'assistant', content: reply });
    } catch (err) {
      process.stdout.write('\n');
      process.stdout.write(output.error(`  Error: ${err instanceof Error ? err.message : String(err)}\n\n`));
      msgs.pop();
    }
    ask();
  };

  rl.on('close', () => {
    if (msgs.some(m => m.role !== 'system')) {
      saveSession(sid, msgs);
      process.stdout.write(output.dim(`\n  Auto-saved as "${sid}"\n\n`));
    }
    process.exit(0);
  });

  ask();
}

// ─── Pipe mode ────────────────────────────────────────────────────────────────

async function runPipe(prov: ProviderEntry, msgs: Message[], input: string, maxTok: number, temp: number): Promise<void> {
  msgs.push({ role: 'user', content: input });
  await stream(prov, msgs, maxTok, temp, chunk => process.stdout.write(chunk));
  process.stdout.write('\n');
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const chatCommand: Command = {
  name: 'chat',
  description: 'Interactive chat with any configured LLM provider',
  options: [
    { name: 'provider',    short: 'p', type: 'string',  description: 'Named provider from config' },
    { name: 'model',       short: 'm', type: 'string',  description: 'Override model' },
    { name: 'system',      short: 's', type: 'string',  description: 'System prompt' },
    { name: 'session',                 type: 'string',  description: 'Resume saved session by name' },
    { name: 'max-tokens',              type: 'number',  description: 'Max tokens per reply', default: 2048 },
    { name: 'temperature',             type: 'number',  description: 'Temperature (0–2)',    default: 0.7 },
    { name: 'url',         short: 'u', type: 'string',  description: 'Ad-hoc endpoint URL (no config needed)' },
    { name: 'type',        short: 't', type: 'string',  description: 'Provider type for ad-hoc: custom|litellm|ollama|anthropic|openai' },
    { name: 'key',         short: 'k', type: 'string',  description: 'API key for ad-hoc endpoint' },
  ],
  examples: [
    { command: 'claude-flow chat',                                                           description: 'Chat with default provider' },
    { command: 'claude-flow chat -p lmstudio',                                               description: 'Named provider' },
    { command: 'claude-flow chat -u http://localhost:1234 -m my-model',                      description: 'Ad-hoc (no config)' },
    { command: 'claude-flow chat -u http://localhost:4000 -t litellm -m ollama/llama3.2',    description: 'LiteLLM proxy' },
    { command: 'claude-flow chat -p lmstudio -s "You are a Rust expert"',                    description: 'With system prompt' },
    { command: 'echo "Explain async/await" | claude-flow chat -p lmstudio',                  description: 'Pipe / one-shot mode' },
    { command: 'claude-flow chat --session 20260317-143022',                                 description: 'Resume saved session' },
  ],

  action: async (ctx: CommandContext): Promise<CommandResult> => {

    // Resolve provider
    let prov: ProviderEntry;
    const adHocUrl  = ctx.flags.url  as string | undefined;
    const adHocType = (ctx.flags.type as string) || 'custom';

    if (adHocUrl) {
      prov = {
        name:    'adhoc',
        type:    adHocType as ProviderEntry['type'],
        apiUrl:  adHocUrl,
        model:   (ctx.flags.model as string) || defaultModel(adHocType),
        apiKey:  ctx.flags.key as string | undefined,
        enabled: true,
      };
    } else {
      const named = resolveProvider(ctx.flags.provider as string | undefined);
      if (!named) {
        output.writeln();
        output.printError('No provider configured. Add one first:');
        output.writeln(output.dim('  claude-flow providers add -n lmstudio -u http://localhost:1234 -m my-model'));
        output.writeln(output.dim('  claude-flow providers add -n litellm -t litellm -u http://localhost:4000 -m ollama/llama3.2'));
        output.writeln();
        output.writeln(output.dim('Or specify directly: claude-flow chat -u http://localhost:1234 -m my-model'));
        return { success: false, exitCode: 1 };
      }
      prov = { ...named };
      if (ctx.flags.model as string) prov.model = ctx.flags.model as string;
    }

    const maxTok = (ctx.flags['max-tokens'] as number) || 2048;
    const temp   = (ctx.flags.temperature   as number) || 0.7;

    // Build initial messages
    const msgs: Message[] = [];
    const sysPrompt = ctx.flags.system as string | undefined;
    if (sysPrompt) msgs.push({ role: 'system', content: sysPrompt });

    const sessionName = ctx.flags.session as string | undefined;
    if (sessionName) {
      const loaded = loadSession(sessionName);
      if (!loaded) {
        output.printError(`Session "${sessionName}" not found. Run: claude-flow chat --session list`);
        return { success: false, exitCode: 1 };
      }
      msgs.push(...loaded);
    }

    // Pipe vs interactive
    if (!process.stdin.isTTY) {
      const chunks: string[] = [];
      for await (const chunk of process.stdin) chunks.push(String(chunk));
      const userInput = chunks.join('').trim();
      if (!userInput) { output.printError('No stdin input'); return { success: false, exitCode: 1 }; }
      try { await runPipe(prov, msgs, userInput, maxTok, temp); }
      catch (e) { output.printError(e instanceof Error ? e.message : String(e)); return { success: false, exitCode: 1 }; }
      return { success: true };
    }

    const sid = sessionName || (() => {
      const n = new Date();
      return `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}-${String(n.getHours()).padStart(2,'0')}${String(n.getMinutes()).padStart(2,'0')}${String(n.getSeconds()).padStart(2,'0')}`;
    })();

    await runInteractive(prov, msgs, sid, maxTok, temp);
    return { success: true };
  },
};

export default chatCommand;
