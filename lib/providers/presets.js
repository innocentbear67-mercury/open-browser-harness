import { parseBody } from './http.js';

// One-click provider setups. Endpoints checked live on 2026-11-19 (each answered
// its /models route). Models are a sensible default; the panel fills the full
// list from the provider's /models after you paste a key.
export const PRESETS = [
  { id: 'opencode-zen', label: 'OpenCode Zen', provider: 'openai-compatible', endpoint: 'https://opencode.ai/zen/v1', model: 'deepseek-v4.1-flash' },
  { id: 'opencode-go', label: 'OpenCode Go', provider: 'openai-compatible', endpoint: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash',
    note: 'Go is built for coding agents and is monitored for abuse; a browser agent may be refused.' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash' },
  { id: 'orcarouter', label: 'OrcaRouter', provider: 'openai-compatible', endpoint: 'https://api.orcarouter.ai/v1', model: 'orcarouter/fusion-flash' },
  { id: 'openai', label: 'OpenAI', provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.1' },
  { id: 'anthropic', label: 'Anthropic', provider: 'anthropic', endpoint: '', model: 'claude-opus-5-5' },
  { id: 'gemini', label: 'Google Gemini', provider: 'gemini', endpoint: '', model: 'gemini-3.8-flash' },
  { id: 'xai', label: 'xAI Grok', provider: 'openai-compatible', endpoint: 'https://api.x.ai/v1', model: 'grok-4.7' },
  { id: 'minimax', label: 'MiniMax (global)', provider: 'openai-compatible', endpoint: 'https://api.minimax.io/v1', model: 'MiniMax-M3',
    note: 'Mainland China accounts: use https://api.minimaxi.com/v1.' },
  { id: 'qwen-code', label: 'Qwen Code (Coding Plan, intl)', provider: 'openai-compatible', endpoint: 'https://coding-intl.dashscope.aliyuncs.com/v1', model: 'qwen3.7-plus',
    note: 'China region: https://coding.dashscope.aliyuncs.com/v1. Pay-as-you-go keys use https://dashscope-intl.aliyuncs.com/compatible-mode/v1.' },
  { id: 'kimi-code', label: 'Kimi Code', provider: 'openai-compatible', endpoint: 'https://api.kimi.ai/coding/v1', model: 'kimi-for-coding',
    note: 'China accounts: https://api.kimi.com/coding/v1. Kimi Code keys do not work on api.moonshot.ai.' },
  { id: 'fireworks', label: 'Fireworks AI', provider: 'openai-compatible', endpoint: 'https://api.fireworks.ai/inference/v1', model: '' },
  { id: 'mistral', label: 'Mistral', provider: 'openai-compatible', endpoint: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  { id: 'deepseek', label: 'DeepSeek', provider: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'zai-coding', label: 'Z.ai GLM Coding Plan', provider: 'openai-compatible', endpoint: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3',
    note: 'Coding Plan keys only work on this endpoint (401 elsewhere).' },
  { id: 'zai', label: 'Z.ai (pay-as-you-go)', provider: 'openai-compatible', endpoint: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3' }
];

export const presetById = (id) => PRESETS.find(p => p.id === id) || null;

// List model ids from the provider's /models route (OpenAI, Anthropic and Gemini shapes).
export async function listModels(adapter) {
  const headers = adapter.id === 'anthropic'
    ? { 'x-api-key': adapter.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : adapter.id === 'gemini' ? { 'x-goog-api-key': adapter.key }
    : (adapter.headers?.() || { authorization: `Bearer ${adapter.key}` });
  if (!adapter.baseUrl) return [];
  let res = await adapter.fetchImpl(`${adapter.baseUrl}/models`, { method: 'GET', headers });
  // Some lists are public but reject a wrong key; show them anyway (Test capabilities flags the key).
  if (!res.ok) res = await adapter.fetchImpl(`${adapter.baseUrl}/models`, { method: 'GET', headers: {} });
  if (!res.ok) return [];
  const d = await parseBody(res);
  const ids = (d.data || d.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
