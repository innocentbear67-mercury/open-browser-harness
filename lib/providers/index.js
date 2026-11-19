import { makeFetcher, KEYCHAIN_PLACEHOLDER } from './http.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { OpenAIResponsesAdapter } from './openai-responses.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';

export const PROVIDERS = ['openai-compatible', 'openai', 'anthropic', 'gemini'];
export const DEFAULT_MODELS = {
  'openai-compatible': '', // depends on the endpoint; picked from its /models list
  openai: 'gpt-5.1',
  anthropic: 'claude-opus-5-5',
  gemini: 'gemini-3.8-flash'
};

export function createAdapter({ provider, model, key, endpoint, keySource = 'session', prices, fetchImpl }) {
  const fetcher = fetchImpl || makeFetcher(keySource, provider);
  if (keySource === 'companion') key = KEYCHAIN_PLACEHOLDER;
  switch (provider) {
    case 'openai-compatible': return new OpenAICompatibleAdapter({ baseUrl: endpoint, model, key, fetchImpl: fetcher, prices });
    case 'openai': return new OpenAIResponsesAdapter({ baseUrl: endpoint || undefined, model, key, fetchImpl: fetcher, prices });
    case 'anthropic': return new AnthropicAdapter({ model, key, fetchImpl: fetcher, prices });
    case 'gemini': return new GeminiAdapter({ model, key, fetchImpl: fetcher, prices });
    default: throw new Error(`unknown_provider:${provider}`);
  }
}
