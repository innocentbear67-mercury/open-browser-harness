import { normalizeError, usageOf, estimateCost, dataUrlToBase64, dataUrlMime, mergeRoles } from './base.js';
import { parseBody } from './http.js';

export class AnthropicAdapter {
  constructor({ model, key, fetchImpl, prices, baseUrl = 'https://api.anthropic.com/v1' }) {
    this.id = 'anthropic';
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.model = model; this.key = key; this.fetchImpl = fetchImpl; this.prices = prices;
  }

  convert(messages) {
    return mergeRoles(messages.map(m => {
      const parts = m.parts || [];
      if (m.role === 'tool') return {
        role: 'user',
        parts: [{ type: 'tool_result', tool_use_id: m.id, content: String(m.content || '') }]
      };
      // Replay the exact blocks the API returned (thinking blocks must come back unchanged).
      if (m.role === 'assistant' && m.native?.anthropic) return { role: 'assistant', parts: m.native.anthropic };
      if (m.role === 'assistant') return {
        role: 'assistant',
        parts: parts.map(p => p.text ? { type: 'text', text: p.text } :
          p.toolCall ? { type: 'tool_use', id: p.toolCall.id, name: p.toolCall.name, input: p.toolCall.args || {} } : null).filter(Boolean)
      };
      return {
        role: 'user',
        parts: parts.map(p => p.text ? { type: 'text', text: p.text } :
          p.image ? { type: 'image', source: { type: 'base64', media_type: dataUrlMime(p.image), data: dataUrlToBase64(p.image) } } : null).filter(Boolean)
      };
    }));
  }

  async runTurn({ system, messages = [], tools = [] }) {
    const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        // No temperature: current Claude models reject sampling params with a 400.
        // max_tokens leaves room for (always-on) adaptive thinking before the tool call.
        model: this.model, max_tokens: 16000,
        // mergeRoles works on `parts`; the Messages API wants `content`.
        system: system || '', messages: this.convert(messages).map(m => ({ role: m.role, content: m.parts })),
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      })
    });
    const data = await parseBody(res);
    if (!res.ok) { const e = normalizeError(this.id, res.status, data); throw Object.assign(new Error(e.message), e); }
    let text = '', toolCalls = [];
    for (const b of data.content || []) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
    }
    const usage = usageOf(data.usage?.input_tokens, data.usage?.output_tokens);
    if (data.stop_reason === 'refusal') text = text || `(model declined: ${data.stop_details?.category || 'refusal'})`;
    return { text, toolCalls, usage, costUsd: estimateCost(usage, this.prices), raw: data,
      native: { anthropic: data.content || [] } };
  }
}
