import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAction } from '../lib/validation.js';
import { toolsForCapabilities } from '../lib/tools.js';
import { AgentRuntime, observationMessage } from '../lib/runtime.js';
import { Executor } from '../lib/executor.js';
import { createRun } from '../lib/state.js';

globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };

const snap = {
  url: 'https://board.test', viewport: { w: 1000, h: 800 }, text: 'board',
  elements: [
    { ref: 5, role: 'listitem', name: 'Card A', visible: true, box: { x: 100, y: 100, w: 200, h: 40 } },
    { ref: 6, role: 'region', name: 'Done', visible: true, box: { x: 600, y: 80, w: 200, h: 400 } },
    { ref: 7, role: 'region', name: 'Delete', visible: true, box: { x: 600, y: 600, w: 100, h: 100 } },
    { ref: 8, role: 'listitem', name: 'Far', visible: true, box: { x: 100, y: 2000, w: 100, h: 40 } }
  ]
};
const ctx = { snapshot: snap, domain: 'board.test', caps: { vision: true } };

test('drag resolves refs to element centers and validates both ends', () => {
  const v = validateAction({ name: 'drag', args: { from_ref: 5, to_ref: 6 } }, ctx);
  assert.equal(v.ok, true);
  assert.deepEqual(v.normalized.args, { from_x: 200, from_y: 120, to_x: 700, to_y: 280 });
  assert.equal(v.needsApproval, false);
  // mixed: ref start, coordinate end
  assert.deepEqual(validateAction({ name: 'drag', args: { from_ref: 5, to_x: 50, to_y: 60 } }, ctx).normalized.args,
    { from_x: 200, from_y: 120, to_x: 50, to_y: 60 });
  assert.equal(validateAction({ name: 'drag', args: { from_ref: 99, to_ref: 6 } }, ctx).reason, 'stale_target');
  assert.equal(validateAction({ name: 'drag', args: { from_ref: 5 } }, ctx).reason, 'to_needs_ref_or_xy');
  assert.equal(validateAction({ name: 'drag', args: { from_ref: 8, to_ref: 6 } }, ctx).reason, 'coordinate_out_of_viewport');
});

test('dragging onto a sensitive target needs approval', () => {
  const v = validateAction({ name: 'drag', args: { from_ref: 5, to_ref: 7 } }, ctx);
  assert.equal(v.needsApproval, true);
  assert.match(v.approval.effect, /Card A.*Delete/);
});

test('zoom is vision-only and clamped to the viewport; scroll can target a point', () => {
  assert.equal(validateAction({ name: 'zoom', args: { x: 0, y: 0, width: 50, height: 50 } }, { ...ctx, caps: { vision: false } }).reason, 'vision_unavailable');
  assert.deepEqual(validateAction({ name: 'zoom', args: { x: 900, y: 700, width: 400, height: 400 } }, ctx).normalized.args,
    { x: 900, y: 700, width: 100, height: 100 });
  assert.equal(validateAction({ name: 'zoom', args: { x: 0, y: 0, width: 4, height: 50 } }, ctx).reason, 'zoom_region_too_small');
  assert.deepEqual(validateAction({ name: 'scroll', args: { direction: 'down', x: 700, y: 300 } }, ctx).normalized.args,
    { direction: 'down', amount: 600, x: 700, y: 300 });
  assert.equal(validateAction({ name: 'scroll', args: { direction: 'down', x: 700 } }, ctx).reason, 'scroll_point_needs_x_and_y');
  const names = (c) => toolsForCapabilities(c).map(t => t.name);
  assert.ok(names({ toolCalling: true, vision: true }).includes('zoom'));
  assert.ok(!names({ toolCalling: true, vision: false }).includes('zoom'));
  assert.ok(names({ toolCalling: true, vision: false }).includes('drag'));
});

test('observations show element centers; a zoom image reaches the next observation', async () => {
  const obs = observationMessage(snap, null, 1);
  assert.match(obs.parts[0].text, /#5 listitem "Card A" @200,120/);

  let turn = 0; const seen = [];
  const adapter = { runTurn: async (o) => { seen.push(o.messages); turn++;
    return turn === 1
      ? { text: '', toolCalls: [{ id: 'z', name: 'zoom', args: { x: 100, y: 100, width: 200, height: 40 } }], usage: {} }
      : { text: '', toolCalls: [{ id: 'f', name: 'finish', args: { answer: 'read it' } }], usage: {} }; } };
  const driver = {
    read: async () => structuredClone(snap), screenshot: async () => null,
    listTabs: async () => [{ tabId: 1 }], activeTab: async () => ({ id: 1 }),
    zoom: async (_t, r) => ({ dataUrl: 'data:image/jpeg;base64,QUJD', width: 1000, height: 200, scale: 5, region: r })
  };
  const run = createRun({ task: 't', provider: 'p', model: 'm', caps: { toolCalling: true, vision: true }, policy: {}, tabId: 1 });
  const out = await new AgentRuntime({ adapter, executor: new Executor({ driver }), driver, caps: run.caps }).run(run, { vision: false });
  assert.equal(out.status, 'done');
  const lastObs = seen[1].filter(m => m.parts?.some(p => p.observation)).at(-1);
  assert.ok(lastObs.parts.some(p => p.image === 'data:image/jpeg;base64,QUJD'));
  assert.ok(lastObs.parts.some(p => /Zoomed region x=100 y=100 200x40/.test(p.text || '')));
});
