import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAction } from '../lib/validation.js';
import { AgentRuntime, targetOf } from '../lib/runtime.js';
import { Executor } from '../lib/executor.js';
import { createRun } from '../lib/state.js';

globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };

// A page whose layout shifts after every action: the Email field moves down 50px.
function shiftingPage() {
  let shift = 0, value = '', focused = false, submitted = false;
  const snap = () => ({
    url: 'https://form.test', viewport: { w: 1000, h: 800 },
    text: `form ${value} ${submitted ? 'SENT' : ''}`, scrollY: 0,
    elements: [
      { ref: 3, role: 'textbox', name: 'Email', value, editable: true, visible: true, ...(focused ? { focused: true } : {}), box: { x: 100, y: 100 + shift, w: 200, h: 30 } },
      { ref: 4, role: 'button', name: 'Delete account', visible: true, box: { x: 100, y: 300 + shift, w: 120, h: 30 } }
    ]
  });
  const plans = [], acts = [];
  const driver = {
    read: async () => snap(), listTabs: async () => [{ tabId: 1 }], activeTab: async () => ({ id: 1 }), screenshot: async () => null,
    plan: async (_t, pts) => { plans.push(pts); },
    click: async (_t, a) => { acts.push(['click', a]); focused = true; shift += 50; return { ok: true }; },
    typeAtCursor: async (_t, a) => { acts.push(['type', a]); value += a.text; shift += 50; return { ok: true }; },
    key: async (_t, a) => { acts.push(['key', a]); submitted = true; return { ok: true }; },
    copy: async () => ({ ok: true, text: 'kundi@example.test' }),
    paste: async (_t, a) => { acts.push(['paste', a]); value = a.text; return { ok: true }; }
  };
  return { driver, plans, acts };
}

async function runBatch(calls, page, extraTurns = []) {
  const turns = [{ text: '', toolCalls: calls, usage: {} }, ...extraTurns,
    { text: '', toolCalls: [{ id: 'fin', name: 'finish', args: { answer: 'ok' } }], usage: {} }];
  const seen = [];
  let t = 0;
  const adapter = { runTurn: async (o) => { seen.push(structuredClone(o.messages)); return turns[Math.min(t++, turns.length - 1)]; } };
  const run = createRun({ task: 't', provider: 'p', model: 'm', caps: { toolCalling: true }, policy: {}, tabId: 1 });
  const out = await new AgentRuntime({ adapter, executor: new Executor({ driver: page.driver, settleMs: 0 }), driver: page.driver, caps: run.caps })
    .run(run, { vision: false });
  return { out, seen };
}

test('a batch runs in order, follows moving elements, and shows ghost cursors', async () => {
  const page = shiftingPage();
  page.driver.type = async (_t, a) => { page.acts.push(['replace', a]); return { ok: true }; };
  const { out } = await runBatch([
    { id: 'a', name: 'click', args: { ref: 3 } },              // focuses Email; layout shifts 50px
    { id: 'b', name: 'type', args: { text: 'hi@x.test' } },    // at the cursor; shifts again
    { id: 'c', name: 'click', args: { ref: 4, button: 'right' } }
  ], page);
  assert.equal(out.status, 'done');
  assert.deepEqual(page.acts.map(a => a[0]), ['click', 'type', 'click']);
  assert.equal(page.acts[1][1].at_cursor, true);
  assert.equal(page.acts[2][1].button, 'right');
  // Ghost for step 3 sits on "Delete account" and follows it as the page moves.
  assert.deepEqual(page.plans[0], [{ n: 3, x: 160, y: 315 }]);
  assert.deepEqual(page.plans[1], [{ n: 3, x: 160, y: 365 }]);
  assert.deepEqual(page.plans.at(-1), [], 'ghosts cleared at the end');
  assert.deepEqual(targetOf({ ref: 3 }, await page.driver.read()), { x: 200, y: 265 }); // 3 shifts of 50px
});

test('a failed step skips the rest of the batch; every call still gets a tool result', async () => {
  const page = shiftingPage();
  const { out, seen } = await runBatch([
    { id: 'a', name: 'click', args: { ref: 99 } },               // stale -> fails
    { id: 'b', name: 'type', args: { text: 'x' } },
    { id: 'c', name: 'press_key', args: { key: 'Enter' } }
  ], page);
  assert.equal(out.status, 'done');
  assert.equal(page.acts.length, 0, 'nothing after the failure ran');
  const results = seen[1].filter(m => m.role === 'tool').map(m => [m.id, JSON.parse(m.content).kind]);
  assert.deepEqual(results, [['a', 'validation'], ['b', 'skipped'], ['c', 'skipped']]);
});

test('copy fills the harness clipboard and paste uses it', async () => {
  const page = shiftingPage();
  const { seen } = await runBatch([
    { id: 'a', name: 'copy', args: { ref: 3 } },
    { id: 'b', name: 'paste', args: { ref: 3 } }
  ], page);
  assert.deepEqual(page.acts.find(a => a[0] === 'paste')[1], { ref: 3, text: 'kundi@example.test' });
  const copyResult = JSON.parse(seen[1].find(m => m.id === 'a').content);
  assert.equal(copyResult.copied, 'kundi@example.test');
});

test('validation: right/double click, typing at the cursor, paste and file drops', () => {
  const snap = {
    viewport: { w: 1000, h: 800 },
    elements: [
      { ref: 3, role: 'textbox', name: 'Notes', editable: true, visible: true, focused: true, box: { x: 0, y: 0, w: 100, h: 20 } },
      { ref: 4, role: 'button', name: 'Delete', visible: true, box: { x: 0, y: 50, w: 100, h: 20 } },
      { ref: 5, role: 'region', name: 'Drop photos here', visible: true, box: { x: 400, y: 400, w: 200, h: 200 } }
    ]
  };
  const ctx = { snapshot: snap, domain: 'x.test' };
  assert.equal(validateAction({ name: 'click', args: { ref: 4, button: 'right' } }, ctx).needsApproval, false);
  assert.equal(validateAction({ name: 'click', args: { ref: 4 } }, ctx).needsApproval, true);
  assert.deepEqual(validateAction({ name: 'click', args: { ref: 3, clicks: 2 } }, ctx).normalized.args, { ref: 3, clicks: 2 });
  assert.equal(validateAction({ name: 'click', args: { ref: 3, button: 'side' } }, ctx).reason, 'bad_button');
  assert.deepEqual(validateAction({ name: 'type', args: { text: 'hi' } }, ctx).normalized.args, { at_cursor: true, text: 'hi' });
  assert.equal(validateAction({ name: 'type', args: { text: 'hi' } }, { snapshot: { ...snap, elements: snap.elements.slice(1) } }).reason, 'no_focused_element');
  assert.equal(validateAction({ name: 'paste', args: {} }, ctx).reason, 'clipboard_empty');
  assert.deepEqual(validateAction({ name: 'paste', args: {} }, { ...ctx, clipboard: 'abc' }).normalized.args, { at_cursor: true, text: 'abc' });
  const drop = validateAction({ name: 'drop_file', args: { url: 'https://x.test/cat.jpg', to_ref: 5 } }, ctx);
  assert.equal(drop.needsApproval, true);
  assert.match(drop.approval.effect, /Upload "cat.jpg" to region "Drop photos here"/);
  assert.deepEqual(drop.normalized.args, { url: 'https://x.test/cat.jpg', to_x: 500, to_y: 500 });
  assert.equal(validateAction({ name: 'drop_file', args: { url: 'file:///etc/passwd', to_ref: 5 } }, ctx).reason, 'unsupported_protocol');
});

test('a not_editable rejection tells the model to click the field first', async () => {
  const page = shiftingPage();
  const { seen } = await runBatch([{ id: 'a', name: 'paste', args: { ref: 4, text: 'x' } }], page); // ref 4 is a button
  const res = JSON.parse(seen[1].find(m => m.id === 'a').content);
  assert.equal(res.error, 'not_editable');
  assert.match(res.note, /Click the field or cell first/);
});
