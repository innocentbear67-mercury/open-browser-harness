import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../lib/executor.js';

function baseSnap() {
  return {
    url: 'https://shop.test/order', title: 'Order', scrollY: 0, viewport: { w: 800, h: 600 },
    text: 'Total: 100',
    elements: [
      { ref: 1, role: 'button', name: 'Submit order', editable: false, visible: true, disabled: false, value: '' },
      { ref: 2, role: 'textbox', name: 'Search', editable: true, visible: true, disabled: false, value: '' }
    ]
  };
}

class FakeDriver {
  constructor(opts = {}) { this.snap = baseSnap(); this.opts = opts; this.clicks = 0; }
  async read() { return structuredClone(this.snap); }
  async activeTab() { return { id: this.opts.activeTabId ?? 7 }; }
  async listTabs() { return [{ tabId: 7 }]; }
  async click() {
    this.clicks++;
    if (this.opts.throwOnClick) throw new Error('dispatch failed');
    if (!this.opts.noEffect) { this.snap.text = 'Total: 100 · Submitted'; this.snap.elements[0].name = 'Order placed'; }
    return { ok: true };
  }
  async type() { this.snap.elements[1].value = 'typed'; return { ok: true }; }
  async key() { return { ok: true }; }
  async scroll() { this.snap.scrollY = 600; return { ok: true }; }
  async navigate() { this.snap.url = 'https://other.test/'; return { ok: true }; }
  async switchTab() { return { ok: true }; }
  async screenshot() { return { dataUrl: 'data:image/png;base64,AA', width: 800, height: 600 }; }
}

test('approved sensitive click executes and is verified against a fresh snapshot', async () => {
  const d = new FakeDriver();
  const requests = [];
  const ex = new Executor({ driver: d, requestApproval: async (a) => { requests.push(a); return true; } });
  const out = await ex.run({ name: 'click', args: { ref: 1 } }, { tabId: 7 });
  assert.equal(out.ok, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].effect, /Submit order/);
  assert.equal(out.verification.changed, true);
  assert.match(out.verification.delta, /page text changed/);
});

test('denied approval issues no action', async () => {
  const d = new FakeDriver();
  const ex = new Executor({ driver: d, requestApproval: async () => false });
  const out = await ex.run({ name: 'click', args: { ref: 1 } }, { tabId: 7 });
  assert.equal(out.kind, 'approval');
  assert.equal(d.clicks, 0);
});

test('tab switch during approval expires it', async () => {
  const d = new FakeDriver({ activeTabId: 9 });
  const ex = new Executor({ driver: d, requestApproval: async () => true });
  const out = await ex.run({ name: 'click', args: { ref: 1 } }, { tabId: 7 });
  assert.equal(out.error, 'approval_expired');
  assert.equal(d.clicks, 0);
});

test('no observable change is treated as a failure, not a success', async () => {
  const ex = new Executor({ driver: new FakeDriver({ noEffect: true }), requestApproval: async () => true });
  const out = await ex.run({ name: 'click', args: { ref: 1 } }, { tabId: 7 });
  assert.equal(out.kind, 'no_effect');
});

test('dispatch errors are marked uncertain rather than silently retried', async () => {
  const ex = new Executor({ driver: new FakeDriver({ throwOnClick: true }), requestApproval: async () => true });
  const out = await ex.run({ name: 'click', args: { ref: 1 } }, { tabId: 7 });
  assert.equal(out.kind, 'uncertain');
});

test('read, screenshot and finish return without a mutation check', async () => {
  const d = new FakeDriver();
  const ex = new Executor({ driver: d });
  assert.equal((await ex.run({ name: 'read_page', args: {} }, { tabId: 7 })).ok, true);
  assert.equal((await ex.run({ name: 'screenshot', args: {} }, { tabId: 7 })).ok, true);
  const f = await ex.run({ name: 'finish', args: { answer: '221000', source: 'ref 2' } }, { tabId: 7 });
  assert.equal(f.result.finished, true);
  assert.equal(f.result.answer, '221000');
});

test('a slow effect (animated scroll) is re-read once before no_effect', async () => {
  const { Executor } = await import('../lib/executor.js');
  let reads = 0;
  const base = { url: 'https://x.test', scrollY: 0, viewport: { w: 800, h: 600 }, text: 't', elements: [] };
  const driver = {
    read: async () => ({ ...base, scrollY: ++reads >= 3 ? 600 : 0 }), // moves only on the 3rd read
    scroll: async () => ({ ok: true }), activeTab: async () => ({ id: 1 })
  };
  const r = await new Executor({ driver, settleMs: 5 }).run({ name: 'scroll', args: { direction: 'down' } }, { tabId: 1 });
  assert.equal(r.ok, true);
  assert.match(r.verification.delta, /scroll 0 -> 600/);
});
