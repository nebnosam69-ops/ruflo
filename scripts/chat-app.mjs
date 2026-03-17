#!/usr/bin/env node
/**
 * RuFlo Chat App
 * Self-contained web UI + API server for local LLM chat.
 * Zero npm dependencies — pure Node.js built-ins only.
 *
 * Run:  node scripts/chat-app.mjs
 * Open: http://localhost:3000
 *
 * Config (env vars):
 *   PORT=3000
 *   OLLAMA_URL=http://localhost:11434
 *   MODEL=llama3.2:1b
 */

import { createServer }     from 'node:http';
import { readFileSync }      from 'node:fs';
import { resolve, dirname }  from 'node:path';
import { fileURLToPath }     from 'node:url';

const PORT       = parseInt(process.env.PORT       || '3000', 10);
const OLLAMA_URL = process.env.OLLAMA_URL           || 'http://localhost:11434';
const MODEL      = process.env.MODEL               || 'llama3.2:1b';

// ─── HTML App (inline — no separate files needed) ─────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RuFlo Chat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:       #0f0f13;
      --surface:  #1a1a24;
      --border:   #2a2a3a;
      --accent:   #7c6af7;
      --accent2:  #5eead4;
      --text:     #e2e2f0;
      --muted:    #6b6b8a;
      --user-bg:  #252535;
      --ai-bg:    #1a1a24;
      --radius:   12px;
      --font:     'Inter', system-ui, sans-serif;
      --mono:     'JetBrains Mono', 'Fira Code', monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      height: 100dvh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0;
    }
    .logo {
      width: 28px; height: 28px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; color: #fff;
    }
    header h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.3px; }
    .model-badge {
      margin-left: auto;
      font-size: 11px; color: var(--muted);
      background: var(--border);
      padding: 3px 8px; border-radius: 20px;
    }
    #status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e; flex-shrink: 0;
      box-shadow: 0 0 6px #22c55e88;
    }
    #status-dot.disconnected { background: #ef4444; box-shadow: 0 0 6px #ef444488; }

    /* Messages */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scroll-behavior: smooth;
    }
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

    .msg {
      max-width: 760px;
      width: 100%;
      align-self: flex-start;
    }
    .msg.user { align-self: flex-end; }

    .msg-header {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 5px;
      display: flex; align-items: center; gap: 6px;
    }
    .msg.user .msg-header { justify-content: flex-end; }

    .avatar {
      width: 18px; height: 18px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; font-weight: 700;
    }
    .avatar.ai  { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; }
    .avatar.you { background: var(--border); color: var(--muted); }

    .bubble {
      padding: 12px 16px;
      border-radius: var(--radius);
      line-height: 1.65;
      font-size: 14.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user .bubble {
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-bottom-right-radius: 4px;
    }
    .msg.ai .bubble {
      background: var(--ai-bg);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }

    /* Code blocks */
    .bubble code {
      font-family: var(--mono);
      font-size: 13px;
      background: #0d0d17;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 5px;
    }
    .bubble pre {
      background: #0d0d17;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .bubble pre code { background: none; border: none; padding: 0; }

    /* Typing cursor */
    .cursor {
      display: inline-block;
      width: 2px; height: 15px;
      background: var(--accent2);
      border-radius: 2px;
      animation: blink .7s infinite;
      vertical-align: text-bottom;
      margin-left: 2px;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* Stats */
    .msg-stats {
      font-size: 10px;
      color: var(--muted);
      margin-top: 4px;
      padding-left: 2px;
    }

    /* System message */
    .system-msg {
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      padding: 4px 0;
    }

    /* Input area */
    footer {
      padding: 14px 20px 18px;
      border-top: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0;
    }

    /* System prompt bar */
    #sys-bar {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 10px;
    }
    #sys-bar label { font-size: 11px; color: var(--muted); white-space: nowrap; }
    #system-input {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 12px;
      padding: 5px 10px;
      outline: none;
      font-family: var(--font);
    }
    #system-input:focus { border-color: var(--accent); }

    /* Message input row */
    .input-row {
      display: flex; gap: 8px; align-items: flex-end;
    }
    #user-input {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-size: 14.5px;
      padding: 11px 14px;
      outline: none;
      resize: none;
      font-family: var(--font);
      line-height: 1.5;
      max-height: 160px;
      min-height: 44px;
      overflow-y: auto;
      transition: border-color .15s;
    }
    #user-input:focus { border-color: var(--accent); }
    #user-input::placeholder { color: var(--muted); }

    #send-btn {
      background: var(--accent);
      border: none;
      color: #fff;
      border-radius: var(--radius);
      padding: 0 18px;
      height: 44px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity .15s, transform .1s;
      display: flex; align-items: center; gap: 6px;
      flex-shrink: 0;
    }
    #send-btn:hover { opacity: .9; }
    #send-btn:active { transform: scale(.97); }
    #send-btn:disabled { opacity: .4; cursor: not-allowed; }

    #clear-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: var(--radius);
      padding: 0 14px;
      height: 44px;
      font-size: 13px;
      cursor: pointer;
      transition: border-color .15s, color .15s;
      flex-shrink: 0;
    }
    #clear-btn:hover { border-color: var(--accent); color: var(--text); }

    .hint { font-size: 11px; color: var(--muted); margin-top: 6px; text-align: center; }

    /* Welcome */
    #welcome {
      margin: auto;
      text-align: center;
      color: var(--muted);
      user-select: none;
    }
    #welcome .wlogo {
      width: 56px; height: 56px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      font-size: 26px; margin: 0 auto 16px;
    }
    #welcome h2 { font-size: 22px; color: var(--text); margin-bottom: 8px; }
    #welcome p  { font-size: 14px; line-height: 1.6; max-width: 320px; }

    /* Mobile */
    @media (max-width: 600px) {
      #messages { padding: 12px; }
      footer { padding: 10px 12px 14px; }
      .msg { max-width: 100%; }
    }
  </style>
</head>
<body>

<header>
  <div class="logo">R</div>
  <h1>RuFlo Chat</h1>
  <div class="model-badge" id="model-badge">loading…</div>
  <div id="status-dot" class="disconnected" title="Ollama status"></div>
</header>

<div id="messages">
  <div id="welcome">
    <div class="wlogo">🤖</div>
    <h2>RuFlo Chat</h2>
    <p>Local AI powered by Ollama.<br>Your data never leaves this machine.</p>
  </div>
</div>

<footer>
  <div id="sys-bar">
    <label>System:</label>
    <input id="system-input" type="text" placeholder="You are a helpful assistant…" />
  </div>
  <div class="input-row">
    <textarea id="user-input" rows="1" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="clear-btn" title="Clear conversation">Clear</button>
    <button id="send-btn">Send ↑</button>
  </div>
  <p class="hint">Ctrl+Enter also sends · responses stream in real-time</p>
</footer>

<script>
  const $ = id => document.getElementById(id);
  const msgs      = $('messages');
  const input     = $('user-input');
  const sendBtn   = $('send-btn');
  const clearBtn  = $('clear-btn');
  const sysInput  = $('system-input');
  const modelBadge = $('model-badge');
  const statusDot  = $('status-dot');
  const welcome    = $('welcome');

  let history = [];
  let streaming = false;

  // ── Health check ──────────────────────────────────────────────────────────
  async function checkHealth() {
    try {
      const r = await fetch('/api/health');
      const d = await r.json();
      statusDot.className = d.ok ? '' : 'disconnected';
      modelBadge.textContent = d.model || 'unknown';
    } catch {
      statusDot.className = 'disconnected';
      modelBadge.textContent = 'offline';
    }
  }
  checkHealth();
  setInterval(checkHealth, 15000);

  // ── Render helpers ────────────────────────────────────────────────────────
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderMarkdown(text) {
    // Code blocks
    text = text.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, (_, code) =>
      '<pre><code>' + escHtml(code.trim()) + '</code></pre>');
    // Inline code
    text = text.replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + escHtml(c) + '</code>');
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return text;
  }

  function addMessage(role, content, stats) {
    if (welcome.parentNode) welcome.remove();

    const div = document.createElement('div');
    div.className = \`msg \${role}\`;

    const label = role === 'user' ? 'You' : 'AI';
    const avatarClass = role === 'user' ? 'you' : 'ai';
    const avatarLetter = role === 'user' ? 'U' : 'R';

    div.innerHTML = \`
      <div class="msg-header">
        <div class="avatar \${avatarClass}">\${avatarLetter}</div>
        <span>\${label}</span>
      </div>
      <div class="bubble">\${role === 'ai' ? renderMarkdown(escHtml(content)) : escHtml(content)}</div>
      \${stats ? \`<div class="msg-stats">\${stats}</div>\` : ''}
    \`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  function addSystem(text) {
    const d = document.createElement('div');
    d.className = 'system-msg';
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ── Send message ──────────────────────────────────────────────────────────
  async function send() {
    const text = input.value.trim();
    if (!text || streaming) return;

    streaming = true;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    addMessage('user', text);
    history.push({ role: 'user', content: text });

    // AI bubble with cursor
    const aiDiv = document.createElement('div');
    aiDiv.className = 'msg ai';
    aiDiv.innerHTML = \`
      <div class="msg-header"><div class="avatar ai">R</div><span>AI</span></div>
      <div class="bubble"><span class="cursor"></span></div>
    \`;
    msgs.appendChild(aiDiv);
    msgs.scrollTop = msgs.scrollHeight;
    const bubble = aiDiv.querySelector('.bubble');

    let fullText = '';
    const t0 = Date.now();

    try {
      const system = sysInput.value.trim();
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, system }),
      });

      if (!res.ok) {
        const err = await res.text();
        bubble.innerHTML = '<em style="color:#ef4444">Error: ' + escHtml(err) + '</em>';
        history.pop();
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            const delta = obj.choices?.[0]?.delta?.content || obj.message?.content || '';
            if (delta) {
              fullText += delta;
              bubble.innerHTML = renderMarkdown(escHtml(fullText)) + '<span class="cursor"></span>';
              msgs.scrollTop = msgs.scrollHeight;
            }
          } catch { /* skip */ }
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      bubble.innerHTML = renderMarkdown(escHtml(fullText));

      const statsDiv = document.createElement('div');
      statsDiv.className = 'msg-stats';
      statsDiv.textContent = \`\${elapsed}s\`;
      aiDiv.appendChild(statsDiv);

      history.push({ role: 'assistant', content: fullText });

    } catch (e) {
      bubble.innerHTML = '<em style="color:#ef4444">Connection error: ' + escHtml(e.message) + '</em>';
      history.pop();
    } finally {
      streaming = false;
      sendBtn.disabled = false;
      msgs.scrollTop = msgs.scrollHeight;
      input.focus();
    }
  }

  // ── Clear ─────────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    history = [];
    msgs.innerHTML = '';
    msgs.appendChild(welcome);
    addSystem('Conversation cleared');
  });

  // ── Auto-resize textarea ──────────────────────────────────────────────────
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Enter' && e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  sendBtn.addEventListener('click', send);
</script>
</body>
</html>`;

// ─── API handlers ─────────────────────────────────────────────────────────────

async function handleHealth(res) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    const models = d.models?.map(m => m.name) || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: MODEL, available: models }));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, model: MODEL, error: e.message }));
  }
}

async function handleChat(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let messages, system;
  try {
    ({ messages, system } = JSON.parse(body));
  } catch {
    res.writeHead(400); res.end('Bad JSON'); return;
  }

  // Build Ollama message list
  const ollamaMsgs = [];
  if (system) ollamaMsgs.push({ role: 'system', content: system });
  for (const m of messages) ollamaMsgs.push({ role: m.role, content: m.content });

  // Proxy to Ollama with streaming, re-emit as OpenAI-compatible SSE
  let ollamaRes;
  try {
    ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: ollamaMsgs, stream: true }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    res.writeHead(502); res.end(e.message); return;
  }

  if (!ollamaRes.ok) {
    const txt = await ollamaRes.text();
    res.writeHead(ollamaRes.status); res.end(txt); return;
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader  = ollamaRes.body.getReader();
  const decoder = new TextDecoder();
  let   buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          // Re-emit as OpenAI-compatible SSE so the browser JS works for both
          const chunk = {
            choices: [{ delta: { content: obj.message?.content || '' }, finish_reason: obj.done ? 'stop' : null }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (obj.done) { res.write('data: [DONE]\n\n'); break; }
        } catch { /* skip */ }
      }
    }
  } catch { /* client disconnected */ }

  res.end();
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS (for dev)
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);

  } else if (url === '/api/health' && req.method === 'GET') {
    await handleHealth(res);

  } else if (url === '/api/chat' && req.method === 'POST') {
    await handleChat(req, res);

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log(`  ║   RuFlo Chat  →  http://localhost:${PORT}  ║`);
  console.log(`  ║   Model: ${MODEL.padEnd(23)}║`);
  console.log(`  ║   Ollama: ${OLLAMA_URL.padEnd(22)}║`);
  console.log('  ╚══════════════════════════════════╝');
  console.log('');
  console.log('  Ctrl+C to stop');
  console.log('');
});
