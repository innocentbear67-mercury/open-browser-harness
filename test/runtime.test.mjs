import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../lib/runtime.js';
import { Executor } from '../lib/executor.js';
import { createRun } from '../lib/state.js';

// runtime imports saveRun, which touches chrome.storage.session at call time.
globalThis.chrome = {
  storage: { session: { get: async () => ({}), set: async () => {} } }
};

function dashboard() {
  return {
    url: 'https://dash.test/revenue', title: 'Revenue',
    scrollY: 0, viewport: { w: 1000, h: 800 },
    text: 'Revenue by month\nAll months\nRevenue: 984000',
    elements: [
      { ref: 1, role: 'combobox', name: 'Month', value: 'All months', editable: true, visible: true, disabled: false },
      { ref: 2, role: 'button', name: 'Generate report', editable: false, visible: true, disabled: false },
      { ref: 3, role: 'textbox', name: 'Search', value: '', editable: true, visible: true, disabled: false }
    ]
  };
}

class FakeDriver {
  constructor() { this.snap = dashboard(); this.calls = []; }
  async read() { return structuredClone(this.snap); }
  async listTabs() { return [{ tabId: 7 }]; }
  async activeTab() { return { id: 7 }; }
  async screenshot() { return null; }
  async type(ref, text) {
    this.calls.push(['type', ref, text]);
    this.snap.elements[0].value = text;
    this.snap.text = 'Revenue by month\nRevenue: 339000';
    return { ok: true };
  }
  async click() { return { ok: true }; }
}

test('end-to-end: read, change a filter, verify, then finish with a source', async () => {
  const script = [
    { toolCalls: [{ id: 'a', name: 'read_page', args: {} }], text: '' },
    { toolCalls: [{ id: 'b', name: 'type', args: { ref: 1, text: '2026-10' } }], text: '' },
    { toolCalls: [{ id: 'c', name: 'read_page', args: {} }], text: '' },
    { toolCalls: [{ id: 'd', name: 'finish', args: { answer: '$339000', source: 'read_page ref 1 / page text' } }], text: '' }
  ];
  let i = 0;
  const adapter = { runTurn: async () => ({ ...script[Math.min(i++, script.length - 1)], usage: { input: 100, output: 20 }, costUsd: null }) };
  const fake = new FakeDriver();
  // Adapt the minimal fake to the driver interface used by Executor.
  const driver = {
    read: () => fake.read(), listTabs: () => fake.listTabs(), activeTab: () => fake.activeTab(),
    screenshot: () => fake.screenshot(),
    type: (tabId, args) => fake.type(args.ref, args.text),
    click: (tabId, args) => fake.click(args),
    key: async () => ({ ok: true }), scroll: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }), switchTab: async () => ({ ok: true })
  };
  const executor = new Executor({ driver, requestApproval: async () => false });
  const run = createRun({ task: "Find last month's revenue", provider: 'test', model: 'test',
    caps: { toolCalling: true, vision: false }, policy: {}, tabId: 7 });
  const rt = new AgentRuntime({ adapter, executor, driver, caps: run.caps, policy: {} });

  const out = await rt.run(run, { maxSteps: 10, vision: false });
  assert.equal(out.status, 'done');
  assert.equal(out.final.answer, '$339000');
  assert.match(out.final.source, /read_page/);
  assert.ok(fake.calls.some(c => c[0] === 'type' && c[2] === '2026-10'));
  assert.equal(out.usage.input, 400);
  assert.ok(out.steps.length >= 3);
});

test('text-only model runs read-only extraction and cannot execute anything', async () => {
  let calls = 0, execCalls = 0;
  const adapter = { runTurn: async () => { calls++; return { text: 'Revenue is $984000.', toolCalls: [], usage: { input: 50, output: 10 }, costUsd: null }; } };
  const driver = { read: async () => dashboard(), screenshot: async () => null, listTabs: async () => [], activeTab: async () => ({ id: 7 }) };
  const executor = { run: async () => { execCalls++; return { ok: false }; } };
  const run = createRun({ task: 'Summarize the page', provider: 'test', model: 'test',
    caps: { toolCalling: false, vision: false }, policy: {}, tabId: 7 });
  const rt = new AgentRuntime({ adapter, executor, driver, caps: run.caps, policy: {} });

  const out = await rt.run(run, { maxSteps: 10, vision: false });
  assert.equal(out.status, 'done');
  assert.equal(out.final.mode, 'readonly');
  assert.equal(out.final.answer, 'Revenue is $984000.');
  assert.equal(calls, 1);
  assert.equal(execCalls, 0);
  assert.match(out.final.source, /dash.test/);
});

test('stop flag pauses before replaying any further action', async () => {
  const adapter = { runTurn: async () => ({ toolCalls: [{ id: 'a', name: 'read_page', args: {} }], text: '', usage: {}, costUsd: null }) };
  const driver = { read: async () => dashboard(), screenshot: async () => null, listTabs: async () => [], activeTab: async () => ({ id: 7 }) };
  const executor = { run: async () => ({ ok: true, name: 'read_page', result: {} }) };
  const run = createRun({ task: 'x', provider: 'test', model: 'test', caps: { toolCalling: true, vision: false }, policy: {}, tabId: 7 });
  const rt = new AgentRuntime({ adapter, executor, driver, caps: run.caps, policy: {} });
  rt.stop();
  const out = await rt.run(run, { maxSteps: 5, vision: false });
  assert.equal(out.status, 'paused');
});

test('withRetry retries transient errors only', async () => {
  const { withRetry } = await import('../lib/runtime.js');
  let n = 0;
  const flaky = async () => { if (++n < 3) throw Object.assign(new Error('busy'), { retryable: true }); return 'ok'; };
  assert.equal(await withRetry(flaky, () => {}, 3, 1), 'ok');
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw Object.assign(new Error('auth'), { retryable: false }); }, () => {}, 3, 1));
  assert.equal(m, 1);
});

test('no-tool-call nudge is a user message, never an orphan tool result', async () => {
  let turn = 0; const seen = [];
  const adapter = { runTurn: async (o) => { seen.push(o.messages); turn++;
    return turn === 1 ? { text: 'hmm', toolCalls: [], usage: {} } : { text: '', toolCalls: [{ id: 'f', name: 'finish', args: { answer: 'x' } }], usage: {} }; } };
  const driver = { read: async () => dashboard(), screenshot: async () => null, listTabs: async () => [{ tabId: 7 }], activeTab: async () => ({ id: 7 }) };
  const executor = new Executor({ driver });
  const run = createRun({ task: 't', provider: 'p', model: 'm', caps: { toolCalling: true }, policy: {}, tabId: 7 });
  const out = await new AgentRuntime({ adapter, executor, driver, caps: run.caps }).run(run, { vision: false });
  assert.equal(out.status, 'done');
  assert.ok(!seen[1].some(m => m.role === 'tool' && m.id === 'sys'));
});
