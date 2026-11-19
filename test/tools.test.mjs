import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFS, TOOL_NAMES, toolsForCapabilities, SYSTEM_PROMPT } from '../lib/tools.js';

test('tool contract is unique and complete', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  for (const t of TOOL_DEFS) {
    assert.ok(t.name && t.description, `${t.name} has name and description`);
    assert.equal(t.parameters.type, 'object');
    assert.equal(t.parameters.additionalProperties, false);
  }
  for (const n of ['read_page', 'click', 'type', 'navigate', 'screenshot', 'finish', 'ask_human']) {
    assert.ok(TOOL_NAMES.includes(n), `has ${n}`);
  }
});

test('capability gating removes screenshot and disables tools for text-only', () => {
  const full = toolsForCapabilities({ toolCalling: true, vision: true });
  const dom = toolsForCapabilities({ toolCalling: true, vision: false });
  assert.ok(full.some(t => t.name === 'screenshot'));
  assert.ok(!dom.some(t => t.name === 'screenshot'));
  assert.equal(toolsForCapabilities({ toolCalling: false, vision: true }).length, 0);
});

test('system prompt treats page content as untrusted', () => {
  assert.match(SYSTEM_PROMPT, /UNTRUSTED DATA/);
  assert.match(SYSTEM_PROMPT, /ref/);
  assert.match(SYSTEM_PROMPT, /verify/i);
});
