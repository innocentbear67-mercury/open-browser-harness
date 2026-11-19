import { normalizeError, usageOf, estimateCost, dataUrlToBase64, dataUrlMime, mergeRoles } from './base.js';
import { parseBody } from './http.js';

export class GeminiAdapter {
  constructor({ model, key, fetchImpl, prices, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' }) {
    this.id = 'gemini';
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.model = model; this.key = key; this.fetchImpl = fetchImpl; this.prices = prices;
  }

  convert(messages) {
    return mergeRoles(messages.map(m => {
      const parts = m.parts || [];
      if (m.role === 'tool') return {
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'tool', response: { output: String(m.content || '') } } }]
      };
      // Replay model parts verbatim: Gemini rejects function calls stripped of their thoughtSignature.
      if (m.role === 'assistant' && m.native?.gemini) return { role: 'model', parts: m.native.gemini };
      const role = m.role === 'assistant' ? 'model' : 'user';
      return {
        role,
        parts: parts.map(p => p.text ? { text: p.text } :
          p.toolCall ? { functionCall: { name: p.toolCall.name, args: p.toolCall.args || {} } } :
          p.image ? { inline_data: { mime_type: dataUrlMime(p.image), data: dataUrlToBase64(p.image) } } : null).filter(Boolean)
      };
    }));
  }

  async runTurn({ system, messages = [], tools = [] }) {
    // Key in a header, not the URL, so it never lands in logs or history.
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
      body: JSON.stringify({
        contents: this.convert(messages),
        systemInstruction: { parts: [{ text: system || '' }] },
        tools: tools.length ? [{ function_declarations: tools.map(t => ({
          name: t.name, description: t.description, parameters: t.parameters
        })) }] : undefined,
        generationConfig: { temperature: 0 }
      })
    });
    const data = await parseBody(res);
    if (!res.ok) { const e = normalizeError(this.id, res.status, data); throw Object.assign(new Error(e.message), e); }
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text = '', toolCalls = [];
    for (const p of parts) {
      if (p.text) text += p.text;
      if (p.functionCall) toolCalls.push({
        id: p.functionCall.id || `fc_${Math.random().toString(36).slice(2, 9)}`,
        name: p.functionCall.name, args: p.functionCall.args || {}
      });
    }
    const usage = usageOf(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount);
    return { text, toolCalls, usage, costUsd: estimateCost(usage, this.prices), raw: data,
      native: parts.length ? { gemini: parts } : undefined };
  }
}
