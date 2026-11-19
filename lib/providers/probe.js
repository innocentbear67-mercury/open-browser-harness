import { dataUrlToBase64, dataUrlMime, estimateCost } from './base.js';

export const PROBE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyeHFTEMLQkAid1GAXiz9RcAAAAASUVORK5CYII=';

const PROBE_TOOL = {
  name: 'capability_probe',
  description: 'Call this tool to confirm tool calling works.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
};

// Capability contract: tool calling + vision -> full; tool calling only -> DOM;
// neither -> read-only summary. Results are discovered, never assumed.
export async function probeCapabilities(adapter) {
  const caps = { toolCalling: false, vision: false, textOnly: false, mode: 'readonly', errors: [] };

  try {
    const r1 = await adapter.runTurn({
      system: 'Call the capability_probe tool exactly once. No prose.',
      messages: [{ role: 'user', parts: [{ text: 'Probe tool calling now.' }] }],
      tools: [PROBE_TOOL]
    });
    caps.toolCalling = r1.toolCalls.some(c => c.name === 'capability_probe');
    caps.providerMessage = r1.text || '';
  } catch (e) {
    caps.errors.push(`tool_probe:${e.code || 'error'}: ${String(e.message || '').slice(0, 160)}`);
  }

  if (caps.toolCalling) {
    try {
      const r2 = await adapter.runTurn({
        system: 'Answer with one short word.',
        messages: [{ role: 'user', parts: [
          { text: 'What is the dominant colour of this image? Answer one word.' },
          { image: PROBE_IMAGE }
        ] }],
        tools: []
      });
      // A successful image request plus a non-empty model answer is the test.
      // Providers that reject images throw and land in the catch below.
      caps.vision = !!r2.text && !/cannot (view|see|process) image/i.test(r2.text);
    } catch (e) {
      caps.errors.push(`vision_probe:${e.code || 'error'}: ${String(e.message || '').slice(0, 160)}`);
    }
  }

  caps.textOnly = !caps.toolCalling;
  caps.mode = caps.toolCalling && caps.vision ? 'full' : caps.toolCalling ? 'dom' : 'readonly';
  return caps;
}

export function describeCaps(caps) {
  if (!caps) return 'not tested';
  const bits = [caps.toolCalling ? 'tool-call ✓' : 'tool-call ✗', caps.vision ? 'vision ✓' : 'vision ✗'];
  if (caps.textOnly) bits.push('read-only');
  if (caps.errors?.length) bits.push(`errors: ${caps.errors.join(', ')}`);
  return bits.join(' · ');
}
