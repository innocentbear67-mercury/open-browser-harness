export function dataUrlToBase64(dataUrl) {
  const i = String(dataUrl || '').indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : String(dataUrl || '');
}

export function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)/.exec(String(dataUrl || ''));
  return m ? m[1] : 'image/png';
}

export function normalizeError(provider, status, payload) {
  const msg = payload?.error?.message || payload?.message || payload?.error ||
    (typeof payload === 'string' ? payload : '') || `HTTP ${status}`;
  const low = String(msg).toLowerCase();
  // Status first (reliable), message text only as a tiebreak.
  const code = status === 401 || status === 403 || /unauthorized|invalid.*key|authentication/.test(low) ? 'auth' :
    status === 402 || /quota|billing|payment|insufficient.*credit/.test(low) ? 'billing' :
    status === 429 || /rate.?limit/.test(low) ? 'rate_limited' :
    status === 404 ? 'model' :
    status === 400 || status === 422 ? 'bad_request' : 'provider_error';
  // 429 without billing wording, 408/409, 5xx (incl. 529 overloaded) are transient.
  const retryable = code === 'rate_limited' || status === 408 || status === 409 || status >= 500;
  return { code, message: String(msg).slice(0, 400), status, retryable };
}

export function usageOf(input, output, extra = {}) {
  return { input: Number(input) || 0, output: Number(output) || 0, ...extra };
}

// Cost is estimated ONLY from prices the user supplies (USD per 1M tokens).
// No prices are hardcoded: an unknown price is reported as null, not guessed.
export function estimateCost(usage, prices) {
  if (!usage || !prices || prices.input == null || prices.output == null) return null;
  const input = Number(prices.input), output = Number(prices.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return (usage.input / 1e6) * input + (usage.output / 1e6) * output;
}

// Merge adjacent messages with the same role (Anthropic/Gemini require it).
export function mergeRoles(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.parts = [...(last.parts || []), ...(m.parts || [])];
    else out.push({ ...m, parts: [...(m.parts || [])] });
  }
  return out;
}
