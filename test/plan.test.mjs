import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../lib/runtime.js';
import { Executor } from '../lib/executor.js';
import { createRun } from '../lib/state.js';
import { PRESETS, listModels } from '../lib/providers/presets.js';
import { OpenAICompatibleAdapter } from '../lib/providers/openai-compatible.js';
import { GeminiAdapter } from '../lib/providers/gemini.js';

globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };

// A spreadsheet: the grid is a canvas (DOM never shows typed values) and typing goes
// to a hidden, focused editor that is not in the element list.
function sheet() {
  const cells = [];
  let row = 0, focused = false;
  const driver = {
    read: async () => ({
      url: 'https://docs.test/sheet', viewport: { w: 1200, h: 800 }, scrollY: 0,
      text: 'Untitled spreadsheet', elements: [{ ref: 1, role: 'grid', name: 'Grid', visible: true, box: { x: 0, y: 100, w: 1200, h: 700 } }],
      focus: focused ? { tag: 'div', name: '', editable: true } : null
    }),
    listTabs: async () => [{ tabId: 1 }], activeTab: async () => ({ id: 1 }), screenshot: async () => null, plan: async () => {},
    click: async () => { focused = true; return { ok: true }; },
    typeAtCursor: async (_t, a) => { cells[row] = a.text; return { ok: true }; },
    key: async (_t, a) => { if (a.key === 'Enter') row++; return { ok: true }; }
  };
  return { driver, cells };
}

test('plan-first: a 10-cell fill runs as one batch with one approval', async () => {
  const { driver, cells } = sheet();
  const batch = [{ id: 'c', name: 'click', args: { x: 60, y: 120 } }];
  for (let n = 1; n <= 10; n++) {
    batch.push({ id: `t${n}`, name: 'type', args: { text: String(n) } });
    batch.push({ id: `e${n}`, name: 'press_key', args: { key: 'Enter' } });
  }
  const turns = [
    { text: 'Plan: 1) click A1 2) type 1..10, Enter after each.', toolCalls: batch, usage: {} },
    { text: '', toolCalls: [{ id: 'f', name: 'finish', args: { answer: 'Filled A1:A10 with 1-10' } }], usage: {} }
  ];
  let t = 0, approvals = 0;
  const adapter = { runTurn: async () => turns[Math.min(t++, 1)] };
  const executor = new Executor({ driver, settleMs: 0, policy: { requireApproval: true },
    requestApproval: async () => { approvals++; return 'task'; } });
  const run = createRun({ task: 'fill A1:A10 with 1..10', provider: 'p', model: 'm', caps: { toolCalling: true }, policy: {}, tabId: 1 });
  const out = await new AgentRuntime({ adapter, executor, driver, caps: run.caps }).run(run, { vision: false });

  assert.equal(out.status, 'done');
  assert.equal(t, 2, 'two model calls: plan+batch, then finish');
  assert.deepEqual(cells, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.equal(approvals, 1, 'Enter approved once "for this task"');
  assert.ok(!out.steps.some(s => ['duplicate', 'no_effect', 'skipped'].includes(s.kind)));
});

test('the duplicate guard still blocks a repeat on an unchanged page', async () => {
  const driver = {
    read: async () => ({ url: 'https://shop.test', viewport: { w: 800, h: 600 }, text: 'Cart', elements: [
      { ref: 2, role: 'button', name: 'Place order', visible: true, box: { x: 0, y: 0, w: 100, h: 30 } }] }),
    listTabs: async () => [{ tabId: 1 }], activeTab: async () => ({ id: 1 }), screenshot: async () => null, plan: async () => {},
    click: async () => ({ ok: true })
  };
  const turns = [
    { text: '', toolCalls: [{ id: 'a', name: 'click', args: { ref: 2 } }], usage: {} },
    { text: '', toolCalls: [{ id: 'b', name: 'click', args: { ref: 2 } }], usage: {} },
    { text: '', toolCalls: [{ id: 'f', name: 'finish', args: { answer: 'x' } }], usage: {} }
  ];
  let t = 0;
  const run = createRun({ task: 't', provider: 'p', model: 'm', caps: { toolCalling: true }, policy: {}, tabId: 1 });
  const out = await new AgentRuntime({ adapter: { runTurn: async () => turns[Math.min(t++, 2)] },
    executor: new Executor({ driver, settleMs: 0, policy: { requireApproval: false } }), driver, caps: run.caps }).run(run, { vision: false });
  assert.equal(out.steps.filter(s => s.kind === 'duplicate').length, 1, 'second "Place order" on an unchanged page is blocked');
});

test('presets are complete and point at https endpoints', () => {
  const ids = PRESETS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const want of ['opencode-zen', 'opencode-go', 'openrouter', 'orcarouter', 'openai', 'anthropic', 'gemini', 'xai',
    'minimax', 'qwen-code', 'kimi-code', 'fireworks', 'mistral', 'deepseek', 'zai-coding']) assert.ok(ids.includes(want), want);
  for (const p of PRESETS) {
    assert.ok(['openai-compatible', 'openai', 'anthropic', 'gemini'].includes(p.provider), p.id);
    if (p.endpoint) assert.match(p.endpoint, /^https:\/\/[^/]+\/.+[^/]$/, p.id);
  }
});

test('listModels reads OpenAI and Gemini shapes', async () => {
  const fetchOf = (body) => async (url, init) => ({ ok: true, status: 200, url, init, text: async () => JSON.stringify(body) });
  const oc = new OpenAICompatibleAdapter({ baseUrl: 'https://opencode.ai/zen/v1', model: '', key: 'k', fetchImpl: fetchOf({ data: [{ id: 'b' }, { id: 'a' }] }) });
  assert.deepEqual(await listModels(oc), ['a', 'b']);
  const g = new GeminiAdapter({ model: '', key: 'k', fetchImpl: fetchOf({ models: [{ name: 'models/gemini-x' }] }) });
  assert.deepEqual(await listModels(g), ['gemini-x']);
});
