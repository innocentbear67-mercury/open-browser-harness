import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, appendStep, actionSignature, alreadyExecuted, canResume, compactHistory } from '../lib/state.js';

test('createRun and appendStep track state', () => {
  const r = createRun({ task: 'find revenue', provider: 'openai', model: 'gpt', caps: { vision: true }, policy: {}, tabId: 7 });
  assert.equal(r.status, 'running');
  assert.equal(r.tabId, 7);
  appendStep(r, { kind: 'executed', name: 'read_page' });
  assert.equal(r.steps.length, 1);
  assert.equal(canResume(r), true);
  r.status = 'done';
  assert.equal(canResume(r), false);
});

test('action signatures are order-independent and detect prior submissions', () => {
  const sig = actionSignature('click', { ref: 4, x: 10 }, 'example.com');
  assert.equal(sig, actionSignature('click', { x: 10, ref: 4 }, 'example.com'));
  const r = createRun({ task: 't', policy: {}, tabId: 1 });
  assert.equal(alreadyExecuted(r, sig), false);
  appendStep(r, { kind: 'executed', name: 'click', signature: sig });
  assert.equal(alreadyExecuted(r, sig), true);
});

test('compactHistory drops old observations but never a tool result', () => {
  const h = [];
  for (let i = 0; i < 10; i++) h.push({ role: 'user', parts: [{ text: 'o', observation: true }] });
  for (let i = 0; i < 20; i++) h.push({ role: 'tool', id: String(i), content: 'x' });
  const c = compactHistory(h, 3);
  assert.equal(c.filter(m => m.parts?.[0]?.observation).length, 3);
  assert.equal(c.filter(m => m.role === 'tool').length, 20);
});
