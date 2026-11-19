let nativePort = null;
let seq = 0;
const pending = new Map();

function port() {
  if (!nativePort) {
    nativePort = chrome.runtime.connectNative('com.kundi.harness.broker');
    nativePort.onMessage.addListener((msg) => {
      const p = pending.get(msg?.id);
      // The broker replies with the result fields at top level ({ok, status, text, id}).
      if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error)); }
    });
    nativePort.onDisconnect.addListener(() => {
      for (const p of pending.values()) p.reject(new Error('companion_disconnected'));
      pending.clear(); nativePort = null;
    });
  }
  return nativePort;
}

export function companionCall(payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}_${++seq}`;
    const p = port();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('companion_timeout')); }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    p.postMessage({ ...payload, id });
  });
}

// Placeholder the adapter puts where the key goes; the companion swaps in the
// Keychain value for `provider`, so the real key never enters Chrome.
export const KEYCHAIN_PLACEHOLDER = '__HARNESS_KEYCHAIN_KEY__';

// Returns a fetch-like function. 'session' calls from the browser (CORS may
// apply); 'companion' relays through Native Messaging (keys never enter Chrome).
export function makeFetcher(source = 'session', provider = '') {
  if (source === 'companion') {
    return async (url, init = {}) => {
      const res = await companionCall({
        type: 'http', provider, url, method: init.method || 'GET',
        headers: init.headers || {}, body: init.body ?? null
      });
      const text = res.text || '';
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => text,
        json: async () => JSON.parse(text)
      };
    };
  }
  return (url, init) => fetch(url, init);
}

export async function parseBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}
