import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../lib/providers/openai-compatible.js';
import { OpenAIResponsesAdapter } from '../lib/providers/openai-responses.js';
import { AnthropicAdapter } from '../lib/providers/anthropic.js';
import { GeminiAdapter } from '../lib/providers/gemini.js';
import { probeCapabilities } from '../lib/providers/probe.js';
import { normalizeError, estimateCost, dataUrlToBase64 } from '../lib/providers/base.js';
import { createAdapter } from '../lib/providers/index.js';

const calls = [];
function fakeFetch(response, status = 200) {
  return async (url, init) => {
    calls.push({ url, init: JSON.parse(init.body || '{}'), headers: init.headers || {} });
    return { ok: status < 300, status, text: async () => JSON.stringify(response) };
  };
}
const messages = [
  { role: 'user', parts: [{ text: 'look' }, { image: 'data:image/png;base64,QUJD' }] },
  { role: 'assistant', parts: [{ toolCall: { id: 'c1', name: 'click', args: { ref: 2 } } }] },
  { role: 'tool', id: 'c1', name: 'click', content: '{"ok":true}' }
];
const tools = [{ name: 'click', description: 'click', parameters: { type: 'object', properties: {} } }];
const prices = { input: 1, output: 2 };

test('OpenAI-compatible normalizes chat tool calls and usage', async () => {
  const a = new OpenAICompatibleAdapter({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', key: 'k', prices,
    fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'x', function: { name: 'click', arguments: '{"ref":3}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }) });
  const r = await a.runTurn({ system: 's', messages, tools });
  assert.deepEqual(r.toolCalls, [{ id: 'x', name: 'click', args: { ref: 3 } }]);
  assert.deepEqual(r.usage, { input: 1000, output: 500 });
  assert.ok(Math.abs(r.costUsd - 0.002) < 1e-9);
  assert.equal(calls.at(-1).init.tools[0].function.name, 'click');
  assert.equal(calls.at(-1).init.messages.find(m => m.role === 'user').content[1].type, 'image_url');
});

test('OpenAI Responses uses function_call items', async () => {
  const a = new OpenAIResponsesAdapter({ model: 'm', key: 'k', prices,
    fetchImpl: fakeFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }, { type: 'function_call', call_id: 'z', name: 'click', arguments: '{"ref":4}' }], usage: { input_tokens: 10, output_tokens: 5 } }) });
  const r = await a.runTurn({ system: 's', messages, tools });
  assert.equal(r.text, 'hi');
  assert.deepEqual(r.toolCalls, [{ id: 'z', name: 'click', args: { ref: 4 } }]);
  const input = calls.at(-1).init.input;
  assert.ok(input.some(i => i.type === 'function_call_output'));
  assert.equal(calls.at(-1).init.tools[0].type, 'function');
});

test('Anthropic sends required headers, input_schema and tool_result', async () => {
  const a = new AnthropicAdapter({ model: 'm', key: 'k', prices,
    fetchImpl: fakeFetch({ content: [{ type: 'text', text: 'yes' }, { type: 'tool_use', id: 't1', name: 'click', input: { ref: 1 } }], usage: { input_tokens: 20, output_tokens: 8 } }) });
  const r = await a.runTurn({ system: 's', messages, tools });
  assert.deepEqual(r.toolCalls, [{ id: 't1', name: 'click', args: { ref: 1 } }]);
  assert.equal(calls.at(-1).headers['anthropic-version'], '2023-06-01');
  assert.equal(calls.at(-1).headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(calls.at(-1).init.tools[0].input_schema.type, 'object');
  assert.ok(calls.at(-1).init.messages.some(m => m.content?.some(p => p.type === 'tool_result')));
});

test('Gemini uses function_declarations, inline images and keyed URL', async () => {
  const a = new GeminiAdapter({ model: 'gemini-x', key: 'SECRET', prices,
    fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'click', args: { ref: 9 } } }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12 } }) });
  const r = await a.runTurn({ system: 's', messages, tools });
  assert.equal(r.toolCalls[0].name, 'click');
  assert.doesNotMatch(calls.at(-1).url, /SECRET/);
  assert.equal(calls.at(-1).headers['x-goog-api-key'], 'SECRET');
  assert.equal(calls.at(-1).init.tools[0].function_declarations[0].name, 'click');
  assert.ok(JSON.stringify(calls.at(-1).init.contents).includes('inline_data'));
});

test('errors are normalized without leaking bodies, cost needs prices', async () => {
  assert.equal(normalizeError('x', 401, { error: { message: 'invalid api key' } }).code, 'auth');
  assert.equal(normalizeError('x', 429, { error: { message: 'rate limit' } }).retryable, true);
  assert.equal(normalizeError('x', 402, { error: { message: 'billing' } }).code, 'billing');
  assert.equal(estimateCost({ input: 10, output: 10 }, null), null);
  assert.equal(dataUrlToBase64('data:image/png;base64,QUJD'), 'QUJD');
});

test('factory builds all four adapters', () => {
  for (const p of ['openai-compatible', 'openai', 'anthropic', 'gemini']) {
    const a = createAdapter({ provider: p, model: 'm', key: 'k', endpoint: 'https://e.test/v1', fetchImpl: fakeFetch({}) });
    assert.equal(a.id, p);
  }
});

test('capability probe derives full / dom / readonly modes', async () => {
  let n = 0;
  const full = { runTurn: async () => (++n === 1 ? { toolCalls: [{ name: 'capability_probe' }], text: '' } : { toolCalls: [], text: 'red' }) };
  assert.equal((await probeCapabilities(full)).mode, 'full');
  let m = 0;
  const dom = { runTurn: async () => {
    m++;
    if (m === 1) return { toolCalls: [{ name: 'capability_probe' }], text: '' };
    throw Object.assign(new Error('no image support'), { code: 'bad_request' });
  } };
  const d = await probeCapabilities(dom);
  assert.equal(d.mode, 'dom');
  assert.equal(d.vision, false);
  const textOnly = { runTurn: async () => ({ toolCalls: [], text: 'hello' }) };
  const t = await probeCapabilities(textOnly);
  assert.equal(t.mode, 'readonly');
  assert.equal(t.textOnly, true);
});

test('errors classify by status; Anthropic sends no temperature and replays native blocks', async () => {
  assert.equal(normalizeError('x', 529, { error: { message: 'Overloaded' } }).retryable, true);
  assert.equal(normalizeError('x', 400, { error: { message: 'model does not support tools' } }).code, 'bad_request');
  assert.equal(normalizeError('x', 400, {}).retryable, false);
  const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'click', input: { ref: 1 } }];
  const a = new AnthropicAdapter({ model: 'm', key: 'k', fetchImpl: fakeFetch({ content: blocks, usage: {} }) });
  const r = await a.runTurn({ system: 's', messages, tools });
  assert.equal(calls.at(-1).init.temperature, undefined);
  assert.deepEqual(r.native.anthropic, blocks);
  const replay = a.convert([{ role: 'user', parts: [{ text: 'q' }] }, { role: 'assistant', parts: [], native: r.native }]);
  assert.deepEqual(replay[1].parts, blocks);
  assert.ok(calls.at(-1).init.messages.every(m => Array.isArray(m.content) && !m.parts));
});

test('OpenAI-compatible sends a stable x-opencode-session only to opencode hosts', async () => {
  const ok = { choices: [{ message: { content: 'hi' } }], usage: {} };
  const oc = new OpenAICompatibleAdapter({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'm', key: 'k', fetchImpl: fakeFetch(ok) });
  await oc.runTurn({ system: 's', messages, tools });
  const first = calls.at(-1).headers['x-opencode-session'];
  await oc.runTurn({ system: 's', messages, tools });
  assert.ok(first);
  assert.equal(calls.at(-1).headers['x-opencode-session'], first);
  const or = new OpenAICompatibleAdapter({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', key: 'k', fetchImpl: fakeFetch(ok) });
  await or.runTurn({ system: 's', messages, tools });
  assert.equal(calls.at(-1).headers['x-opencode-session'], undefined);
});
