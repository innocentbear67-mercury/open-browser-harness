import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, changed, summarizeDelta } from '../lib/compare.js';

const a = { url: 'https://x.test', text: 'Revenue: 100', scrollY: 0, viewport: { w: 800, h: 600 },
  elements: [{ ref: 1, role: 'textbox', name: 'Month', value: 'all' }] };
const b = structuredClone(a);
b.elements[0].value = '2026-10';
b.text = 'Revenue: 221000';

test('fingerprint detects value, text and scroll changes', () => {
  assert.equal(fingerprint(a), fingerprint(structuredClone(a)));
  assert.equal(changed(a, b), true);
  const c = structuredClone(a); c.scrollY = 400;
  assert.equal(changed(a, c), true);
  assert.equal(changed(a, null), true);
});

test('summarizeDelta names the changed element', () => {
  const d = summarizeDelta(a, b);
  assert.match(d, /#1/);
  assert.match(d, /2026-10/);
  assert.match(d, /page text changed/);
});

test('a focus change alone counts as an effect', async () => {
  const { changed, summarizeDelta } = await import('../lib/compare.js');
  const a = { url: 'u', text: 't', elements: [{ ref: 3, role: 'textbox', name: 'Email', value: '' }] };
  const b = { url: 'u', text: 't', elements: [{ ref: 3, role: 'textbox', name: 'Email', value: '', focused: true }] };
  assert.equal(changed(a, b), true);
  assert.match(summarizeDelta(a, b), /focus -> #3 Email/);
});
