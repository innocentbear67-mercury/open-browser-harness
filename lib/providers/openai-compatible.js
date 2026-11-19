import { normalizeError, usageOf, estimateCost } from './base.js';
import { parseBody } from './http.js';

export class OpenAICompatibleAdapter {
  constructor({ baseUrl, model, key, fetchImpl, prices }) {
    this.id = 'openai-compatible';
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.model = model; this.key = key; this.fetchImpl = fetchImpl; this.prices = prices;
    // One adapter per run, so this is one stable id per conversation. OpenCode Go
    // requires it (x-opencode-session) for routing and prompt caching.
    this.sessionId = globalThis.crypto?.randomUUID?.() || `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  headers() {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${this.key}` };
    let host = '';
    try { host = new URL(this.baseUrl).hostname; } catch {}
    if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) h['x-opencode-session'] = this.sessionId;
    return h;
  }

  convert(messages) {
    return messages.map(m => {
      const parts = m.parts || [];
      if (m.role === 'system') return { role: 'system', content: parts.map(p => p.text || '').join('\n') };
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: String(m.content || '') };
      if (m.role === 'assistant') {
        const txt = parts.filter(p => p.text).map(p => p.text).join('');
        const calls = parts.filter(p => p.toolCall).map(p => ({
          id: p.toolCall.id, type: 'function',
          function: { name: p.toolCall.name, arguments: JSON.stringify(p.toolCall.args || {}) }
        }));
        return { role: 'assistant', content: txt || null, ...(calls.length ? { tool_calls: calls } : {}) };
      }
      const content = parts.map(p => p.text ? { type: 'text', text: p.text } :
        p.image ? { type: 'image_url', image_url: { url: p.image, detail: 'low' } } : null).filter(Boolean);
      return { role: 'user', content };
    });
  }

  async runTurn({ system, messages = [], tools = [] }) {
    if (!this.baseUrl) throw Object.assign(new Error('base_url_required'), { code: 'config' });
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system || '' }, ...this.convert(messages)],
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: 0
    };
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    const data = await parseBody(res);
    if (!res.ok) throw Object.assign(new Error(normalizeError(this.id, res.status, data).message), normalizeError(this.id, res.status, data));
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).map(c => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      return { id: c.id, name: c.function?.name, args };
    });
    const usage = usageOf(data.usage?.prompt_tokens, data.usage?.completion_tokens);
    return { text: msg.content || '', toolCalls, usage, costUsd: estimateCost(usage, this.prices), raw: data };
  }
}
