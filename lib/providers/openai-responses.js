import { normalizeError, usageOf, estimateCost } from './base.js';
import { parseBody } from './http.js';

export class OpenAIResponsesAdapter {
  constructor({ baseUrl = 'https://api.openai.com/v1', model, key, fetchImpl, prices }) {
    this.id = 'openai';
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.model = model; this.key = key; this.fetchImpl = fetchImpl; this.prices = prices;
  }

  convert(messages) {
    const out = [];
    for (const m of messages) {
      const parts = m.parts || [];
      if (m.role === 'tool') {
        out.push({ type: 'function_call_output', call_id: m.id, output: String(m.content || '') });
        continue;
      }
      if (m.role === 'assistant') {
        for (const p of parts) {
          if (p.text) out.push({ role: 'assistant', content: [{ type: 'output_text', text: p.text }] });
          if (p.toolCall) out.push({
            type: 'function_call', call_id: p.toolCall.id, name: p.toolCall.name,
            arguments: JSON.stringify(p.toolCall.args || {})
          });
        }
        continue;
      }
      const content = parts.map(p => p.text ? { type: 'input_text', text: p.text } :
        p.image ? { type: 'input_image', image_url: p.image, detail: 'low' } : null).filter(Boolean);
      if (content.length) out.push({ role: 'user', content });
    }
    return out;
  }

  async runTurn({ system, messages = [], tools = [] }) {
    const body = {
      model: this.model,
      instructions: system || '',
      input: this.convert(messages),
      // No temperature: reasoning models (o-series, gpt-5) reject it.
      tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))
    };
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body)
    });
    const data = await parseBody(res);
    if (!res.ok) { const e = normalizeError(this.id, res.status, data); throw Object.assign(new Error(e.message), e); }
    let text = '', toolCalls = [];
    for (const item of data.output || []) {
      if (item.type === 'message') text += (item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
      if (item.type === 'function_call') {
        let args = {}; try { args = JSON.parse(item.arguments || '{}'); } catch {}
        toolCalls.push({ id: item.call_id || item.id, name: item.name, args });
      }
    }
    const usage = usageOf(data.usage?.input_tokens, data.usage?.output_tokens);
    return { text, toolCalls, usage, costUsd: estimateCost(usage, this.prices), raw: data };
  }
}
