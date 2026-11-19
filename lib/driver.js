// Chrome blocks every extension from scripting these, even with <all_urls>.
export function restrictedReason(url = '') {
  let u;
  try { u = new URL(url); } catch { return url ? 'Chrome does not allow extensions on this page' : 'No page loaded in this tab'; }
  if (['chrome:', 'chrome-extension:', 'edge:', 'about:', 'view-source:', 'devtools:', 'chrome-search:', 'chrome-untrusted:'].includes(u.protocol))
    return `Chrome does not let extensions control ${u.protocol}// pages`;
  if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')))
    return 'Chrome does not let extensions control the Chrome Web Store';
  return null;
}

// Browser driver. All Chrome API access is here so the rest of the harness can
// be unit-tested with a fake driver.
export class BrowserDriver {
  constructor(opts = {}) {
    this.cdpEnabled = !!opts.cdpEnabled;
    this.attached = new Set();
    this.timeout = opts.timeout ?? 12000;
  }

  async activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async listTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map(t => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
  }

  async ping(tabId) {
    try { return (await chrome.tabs.sendMessage(tabId, { type: 'harness/ping' }))?.ok === true; }
    catch { return false; }
  }

  async ensureContent(tabId) {
    if (!(await this.ping(tabId))) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    }
  }

  async send(tabId, msg) {
    await this.ensureContent(tabId);
    const res = await chrome.tabs.sendMessage(tabId, msg);
    if (!res?.ok) throw Object.assign(new Error(res?.error || 'driver_error'), { detail: res });
    return res;
  }

  async read(tabId) {
    const res = await this.send(tabId, { type: 'harness/snapshot' });
    return res.snapshot;
  }

  async cdpAttach(tabId) {
    if (this.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    this.attached.add(tabId);
  }

  async cdp(tabId, method, params = {}) {
    await this.cdpAttach(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  // CDP input bypasses the content script, so move the visible cursor first.
  async showCursor(tabId, x, y, pulse = false, ms = 220) {
    try { await this.send(tabId, { type: 'harness/cursor', x, y, pulse, ms }); } catch {}
  }

  async click(tabId, action) {
    const button = action.button || 'left', count = Number(action.clicks) || 1;
    // Right click stays synthetic: real CDP right click opens Chrome's native menu,
    // which the agent can't see or close.
    if (action.x != null && action.y != null && this.cdpEnabled && button !== 'right') {
      const x = Number(action.x), y = Number(action.y);
      await this.showCursor(tabId, x, y, true);
      for (let i = 1; i <= count; i++) {
        const common = { x, y, button, clickCount: i };
        await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
        await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
      }
      return { ok: true, via: 'cdp', x, y, button, count };
    }
    if (action.ref != null) return this.send(tabId, { type: 'harness/clickRef', ref: action.ref, button, count });
    if (action.x != null && action.y != null) {
      return this.send(tabId, { type: 'harness/clickPoint', x: action.x, y: action.y, button, count });
    }
    throw new Error('click needs ref or x/y');
  }

  // Insert text at the caret of the focused element (or a ref). CDP sends real
  // text input; otherwise the content script uses insertText.
  async typeAtCursor(tabId, action) {
    if (action.ref == null && this.cdpEnabled) {
      await this.cdp(tabId, 'Input.insertText', { text: String(action.text) });
      return { ok: true, via: 'cdp', chars: String(action.text).length };
    }
    return this.send(tabId, { type: 'harness/typeText', ref: action.ref, text: action.text });
  }

  async copy(tabId, action) { return this.send(tabId, { type: 'harness/copy', ref: action.ref }); }
  async paste(tabId, action) { return this.send(tabId, { type: 'harness/paste', ref: action.ref, text: action.text }); }

  // Fetched here, not in the page: the extension has host access, so no CORS.
  async dropFile(tabId, a, maxBytes = 10 * 1024 * 1024) {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`file_fetch_failed:${res.status}`);
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new Error('file_too_large');
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    let name = a.name;
    if (!name) { try { name = decodeURIComponent(new URL(a.url).pathname.split('/').pop()); } catch {} }
    if (!name || !name.includes('.')) name = `photo.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
    return this.send(tabId, { type: 'harness/dropFile', x: a.to_x, y: a.to_y, file: { name, type: blob.type, b64: btoa(bin) } });
  }

  // Numbered ghost cursors where queued batch steps will act; [] clears them.
  async plan(tabId, points) {
    try { await this.send(tabId, { type: 'harness/plan', points }); } catch {}
  }

  // Expects viewport CSS coordinates (validation resolves refs to element centers).
  async drag(tabId, a, steps = 12) {
    const [fx, fy, tx, ty] = [a.from_x, a.from_y, a.to_x, a.to_y].map(Number);
    if (this.cdpEnabled) {
      await this.showCursor(tabId, fx, fy, true);
      const ev = (type, x, y, extra = {}) => this.cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
      await ev('mouseMoved', fx, fy);
      await ev('mousePressed', fx, fy, { buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await ev('mouseMoved', fx + (tx - fx) * i / steps, fy + (ty - fy) * i / steps, { buttons: 1 });
      }
      await ev('mouseReleased', tx, ty, { clickCount: 1 });
      await this.showCursor(tabId, tx, ty, true, 120);
      return { ok: true, via: 'cdp' };
    }
    return this.send(tabId, { type: 'harness/drag', fromX: fx, fromY: fy, toX: tx, toY: ty });
  }

  async type(tabId, action) {
    return this.send(tabId, { type: 'harness/setInput', ref: action.ref, text: action.text });
  }

  async key(tabId, action) {
    if (this.cdpEnabled) {
      const key = String(action.key || '');
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code });
      await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code });
      return { ok: true, via: 'cdp', key };
    }
    return this.send(tabId, { type: 'harness/pressKey', ref: action.ref, key: action.key });
  }

  async scroll(tabId, action) {
    let { dx, dy } = action;
    if (action.direction) {
      const step = Number(action.amount || 600);
      const d = { up: [0, -step], down: [0, step], left: [-step, 0], right: [step, 0] }[action.direction];
      if (!d) throw new Error(`unknown direction ${action.direction}`);
      [dx, dy] = d;
    }
    const at = action.x != null && action.y != null;
    if (this.cdpEnabled) {
      const x = at ? Number(action.x) : 400, y = at ? Number(action.y) : 300;
      if (at) await this.showCursor(tabId, x, y);
      await this.cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: Number(dx) || 0, deltaY: Number(dy) || 0
      });
      return { ok: true, via: 'cdp' };
    }
    return this.send(tabId, { type: 'harness/scrollBy', dx, dy, ...(at ? { x: action.x, y: action.y } : {}) });
  }

  async navigate(tabId, url) {
    const target = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(target.protocol)) throw new Error('unsupported protocol');
    await chrome.tabs.update(tabId, { url });
    await this.waitForLoad(tabId);
    return { ok: true, url };
  }

  async waitForLoad(tabId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpdate); clearTimeout(timer); resolve(); } };
      const onUpdate = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
      chrome.tabs.onUpdated.addListener(onUpdate);
      const timer = setTimeout(finish, this.timeout);
    });
  }

  async switchTab(tabId) {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return { ok: true, tabId };
  }

  // targetWidth = viewport CSS width, so on Retina (2x) the image is scaled back to
  // CSS pixels and model coordinates line up with click/elementFromPoint.
  async screenshot(tabId, targetWidth = 1100) {
    const maxWidth = targetWidth;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    let dataUrl;
    try { dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
    catch (e) {
      // captureVisibleTab needs activeTab or <all_urls>; per-site access is not enough,
      // and activeTab is lost on reload. The debugger permission covers it instead.
      if (!/permission/i.test(String(e?.message))) throw e;
      const { data } = await this.cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
      dataUrl = `data:image/png;base64,${data}`;
    }
    if (maxWidth && dataUrl.length > 0) {
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
        if (img.width !== maxWidth) {
          const scale = maxWidth / img.width;
          const c = document.createElement('canvas');
          c.width = maxWidth; c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return { dataUrl: c.toDataURL('image/jpeg', 0.72), width: c.width, height: c.height };
        }
        return { dataUrl, width: img.width, height: img.height };
      } catch { /* fall through to original */ }
    }
    return { dataUrl, width: null, height: null };
  }

  // Magnified crop of a viewport region (CSS px) for vision models to read small text.
  async zoom(tabId, r, viewportW, maxOut = 1024) {
    const shot = await this.screenshot(tabId, viewportW);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shot.dataUrl; });
    const k = img.width / (viewportW || img.width); // image px per CSS px (1 after resize)
    const scale = Math.min(4, maxOut / r.width);
    const c = document.createElement('canvas');
    c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, r.x * k, r.y * k, r.width * k, r.height * k, 0, 0, c.width, c.height);
    return { dataUrl: c.toDataURL('image/jpeg', 0.85), width: c.width, height: c.height, scale, region: r };
  }

  async detachAll() {
    for (const tabId of this.attached) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }
    this.attached.clear();
  }
}
