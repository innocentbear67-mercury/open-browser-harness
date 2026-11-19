// Classic (non-module) content script in the ISOLATED world (executeScript default):
// shares the DOM with the page, so dispatched events reach React/Vue listeners,
// but page scripts cannot reach chrome.runtime or impersonate the extension.
(() => {
  // No "already installed" flag: after an extension reload the old copy is dead but
  // shares this isolated world, so a flag would stop the new copy from installing.
  // The driver only injects after a failed ping, so there is never a live copy here.
  document.querySelectorAll('[data-harness-cursor]').forEach(n => n.remove());

  const SEL = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
    '[role]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const MAX_ELEMENTS = 200;
  const MAX_TEXT = 12000;
  // Stable refs: an element keeps its ref for the life of the page, so a ref the
  // model saw can never silently point at a different element after a re-render.
  const refOf = new WeakMap();
  let nextRef = 1;
  let elements = new Map(); // ref -> element, from the latest snapshot

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const nameOf = (el) => {
    const raw = el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('placeholder') || (el.value && typeof el.value === 'string' ? el.value : '') ||
      (el.innerText || '').trim() || el.textContent?.trim() || el.getAttribute('name') || el.tagName;
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 120);
  };
  const roleOf = (el) => el.getAttribute('role') || ({
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', SUMMARY: 'button'
  }[el.tagName] || el.tagName.toLowerCase());

  function collect() {
    const found = Array.from(document.querySelectorAll(SEL)).filter(isVisible).slice(0, MAX_ELEMENTS);
    elements = new Map();
    return found.map((el) => {
      if (!refOf.has(el)) refOf.set(el, nextRef++);
      const ref = refOf.get(el);
      elements.set(ref, el);
      const r = el.getBoundingClientRect();
      const editable = el.matches('input,textarea,select,[contenteditable="true"]') && !el.disabled && !el.readOnly;
      let value = '';
      if (el.tagName === 'SELECT') value = el.options[el.selectedIndex]?.text || '';
      else if ('value' in el) value = String(el.value || '').slice(0, 200);
      else if (el.isContentEditable) value = (el.innerText || '').slice(0, 200);
      // Custom widgets (sliders, progress, spinbuttons) expose their value via ARIA.
      else if (el.hasAttribute('aria-valuenow')) value = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow');
      return {
        ref, tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el),
        value, editable, disabled: !!el.disabled, visible: true, // collect() keeps visible elements only
        ...(el === document.activeElement ? { focused: true } : {}),
        ...(el.form || el.closest('form') ? { inForm: true } : {}),
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      };
    });
  }

  function snapshot() {
    return {
      ok: true,
      snapshot: {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, MAX_TEXT),
        scrollY: Math.round(window.scrollY),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        elements: collect(),
        focus: focusInfo()
      }
    };
  }
  const byRef = (ref) => elements.get(Number(ref));
  // The focused element even when it's hidden (Sheets/Docs type into an off-screen editor).
  function focusInfo() {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return null;
    const ref = refOf.get(a);
    return {
      tag: a.tagName.toLowerCase(), name: nameOf(a), editable: isEditable(a),
      ...(a.closest('form') ? { inForm: true } : {}),
      ...(ref && elements.has(ref) ? { ref } : {})
    };
  }

  // ---- Visible agent cursor -------------------------------------------------
  // Closed shadow root + pointer-events:none: it never intercepts
  // elementFromPoint or real clicks, has no text, and matches no selector.
  let cur = null;
  function cursor() {
    if (cur?.host.isConnected) return cur;
    const host = document.createElement('div');
    host.setAttribute('data-harness-cursor', '');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .c{position:fixed;left:0;top:0;transform:translate(-60px,-60px);transition:transform .22s ease-out;pointer-events:none}
      .c svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}
      .r{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #4f8cff;opacity:0;pointer-events:none}
      .r.on{animation:p .45s ease-out}
      @keyframes p{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.7)}}
      .g{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(79,140,255,.25);border:1.5px dashed #4f8cff;color:#fff;font:600 11px/17px -apple-system,sans-serif;text-align:center;text-shadow:0 0 2px #000;transition:opacity .2s}
    </style><div class="p"></div><div class="c"><svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.5-6.5 1.8L8.6 19z" fill="#4f8cff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div><div class="r"></div>`;
    (document.body || document.documentElement).appendChild(host);
    cur = { host, c: root.querySelector('.c'), r: root.querySelector('.r'), p: root.querySelector('.p') };
    return cur;
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // The arrow's tip is at its top-left corner, so translate straight to (x, y).
  async function moveCursor(x, y, ms = 220) {
    const { c } = cursor();
    c.style.transitionDuration = `${ms}ms`;
    c.style.transform = `translate(${x}px, ${y}px)`;
    await sleep(ms);
  }
  function pulse(x, y) {
    const { r } = cursor();
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    r.classList.remove('on'); void r.offsetWidth; r.classList.add('on');
  }
  // Ghost cursors: numbered markers where the queued steps of a batch will act.
  function plan(points = []) {
    const { p } = cursor();
    p.replaceChildren(...points.map(({ n, x, y }) => {
      const g = document.createElement('div');
      g.className = 'g'; g.textContent = String(n);
      g.style.left = `${x}px`; g.style.top = `${y}px`;
      return g;
    }));
    return { ok: true, shown: points.length };
  }
  const center = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; };
  const mouse = (x, y, extra = {}) => ({
    bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra
  });

  // ---- Actions ----------------------------------------------------------------
  // One click sequence for every button. Right click fires `contextmenu` (page menus);
  // the native Chrome menu is never opened, so the agent can't get stuck in it.
  function fireClick(el, x, y, button = 'left', count = 1) {
    const b = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    const held = { left: 1, middle: 4, right: 2 }[button] ?? 1;
    for (let i = 1; i <= count; i++) {
      el.dispatchEvent(new PointerEvent('pointerdown', mouse(x, y, { button: b, buttons: held, detail: i })));
      el.dispatchEvent(new MouseEvent('mousedown', mouse(x, y, { button: b, buttons: held, detail: i })));
      if (i === 1 && b === 0) el.focus?.({ preventScroll: true });
      el.dispatchEvent(new PointerEvent('pointerup', mouse(x, y, { button: b, detail: i })));
      el.dispatchEvent(new MouseEvent('mouseup', mouse(x, y, { button: b, detail: i })));
      if (b === 0) el.dispatchEvent(new MouseEvent('click', mouse(x, y, { detail: i })));
      if (b === 1) el.dispatchEvent(new MouseEvent('auxclick', mouse(x, y, { button: 1, detail: i })));
    }
    if (b === 0 && count >= 2) el.dispatchEvent(new MouseEvent('dblclick', mouse(x, y, { detail: 2 })));
    if (b === 2) el.dispatchEvent(new MouseEvent('contextmenu', mouse(x, y, { button: 2, buttons: 0 })));
  }

  // ---- Actionability (as browse/Playwright do it) ------------------------------
  // Before acting on a ref: wait until it is visible, enabled and not moving, scroll
  // it into view, and check that it (not an overlay) is what sits under the point.
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const deepAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    for (let inner; el?.shadowRoot && (inner = el.shadowRoot.elementFromPoint(x, y)) && inner !== el;) el = inner;
    return el;
  };
  const within = (el, n) => { for (; n; n = n.parentNode || n.host) if (n === el) return true; return false; };
  const sameBox = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  async function actionPoint(ref, timeout = 2000) {
    const until = Date.now() + timeout;
    let covers = 0;
    for (;;) {
      const el = byRef(ref);
      if (!el?.isConnected) return { ok: false, error: 'stale_target' }; // refs are bound to nodes; it won't return
      let why;
      if (!isVisible(el)) why = 'not_visible';
      else if (el.disabled || el.getAttribute('aria-disabled') === 'true') why = 'not_enabled';
      else {
        el.scrollIntoViewIfNeeded?.(true);
        const a = el.getBoundingClientRect(); await frame(); const b = el.getBoundingClientRect();
        if (!sameBox(a, b)) why = 'not_stable';
        else {
          const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
          const hit = deepAt(x, y);
          if (!hit || within(el, hit) || [...(el.labels || [])].some(l => within(l, hit))) return { ok: true, x, y };
          // A fading toast or a layout shift clears in a few tries; a modal does not.
          if (++covers >= 3) return { ok: false, error: `covered: ${roleOf(hit)} "${nameOf(hit).slice(0, 50)}" is on top of it` };
        }
      }
      if (Date.now() > until) return { ok: false, error: why || 'covered' };
      await sleep(why ? 100 : 150);
    }
  }

  // Resolves once the DOM has been quiet for `quiet` ms (or after `cap`), so the
  // next read sees the page after the action, not halfway through re-rendering.
  function settle(quiet = 80, cap = 800) {
    return new Promise((resolve) => {
      let t;
      const done = () => { mo.disconnect(); clearTimeout(t); clearTimeout(hard); resolve({ ok: true }); };
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      t = setTimeout(done, quiet);
      const hard = setTimeout(done, cap);
    });
  }

  async function clickRef(ref, button, count) {
    const p = await actionPoint(ref);
    if (!p.ok) return p;
    const el = byRef(ref);
    await moveCursor(p.x, p.y);
    pulse(p.x, p.y);
    fireClick(el, p.x, p.y, button, count);
    return { ok: true, clicked: { ref, name: nameOf(el), button: button || 'left', count: count || 1 } };
  }

  async function clickPoint(x, y, button, count) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, error: 'no_element_at_point' };
    await moveCursor(x, y);
    pulse(x, y);
    // Real pointer/mouse events with coordinates so canvas handlers read clientX/Y.
    fireClick(el, x, y, button, count);
    return { ok: true, clicked: { tag: el.tagName.toLowerCase(), name: nameOf(el), button: button || 'left', count: count || 1 } };
  }

  // ---- Typing and clipboard ---------------------------------------------------
  const isEditable = (el) => !!el && (el.isContentEditable ||
    (el.matches?.('input,textarea') && !el.disabled && !el.readOnly && !/^(button|submit|checkbox|radio|file|range|color|image|reset)$/i.test(el.type || '')));

  // Insert at the caret (keeps existing text), like real typing.
  function insertText(el, text) {
    el.focus?.({ preventScroll: true });
    if (document.execCommand?.('insertText', false, text)) return true;
    if (el.isContentEditable) { el.append(text); el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text })); return true; }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value.slice(0, start) + text + el.value.slice(end));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    return true;
  }

  async function typeText(ref, text) {
    const el = ref != null ? byRef(ref) : document.activeElement;
    if (ref != null && (!el || !el.isConnected)) return { ok: false, error: 'stale_target' };
    if (!isEditable(el)) return { ok: false, error: 'not_editable' };
    const [x, y] = center(el);
    await moveCursor(x, y);
    insertText(el, text);
    return { ok: true, typed: { name: nameOf(el), chars: text.length } };
  }

  function copyText(ref) {
    const selected = String(getSelection?.() || '').trim();
    if (ref == null) return selected ? { ok: true, text: selected, from: 'selection' } : { ok: false, error: 'nothing_selected' };
    const el = byRef(ref);
    if (!el || !el.isConnected) return { ok: false, error: 'stale_target' };
    const text = ('value' in el && typeof el.value === 'string' && el.value) || (el.innerText || el.textContent || '').trim();
    return text ? { ok: true, text: text.slice(0, 20000), from: nameOf(el) } : { ok: false, error: 'nothing_to_copy' };
  }

  // Fires a real `paste` event first (rich editors read clipboardData); if the page
  // doesn't handle it, inserts the text at the caret.
  async function pasteText(ref, text) {
    const el = ref != null ? byRef(ref) : document.activeElement;
    if (ref != null && (!el || !el.isConnected)) return { ok: false, error: 'stale_target' };
    if (!isEditable(el)) return { ok: false, error: 'not_editable' };
    const [x, y] = center(el);
    await moveCursor(x, y);
    el.focus?.({ preventScroll: true });
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const handled = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
    if (!handled) insertText(el, text);
    return { ok: true, pasted: { name: nameOf(el), chars: text.length, handledByPage: handled } };
  }

  // ---- Files ------------------------------------------------------------------
  function fileFrom(f) {
    const bin = atob(f.b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name, { type: f.type || 'application/octet-stream' });
  }

  // Drop a file (e.g. a photo) at a point: a file input gets it via .files, anything
  // else gets dragenter/dragover/drop with the file in dataTransfer.
  async function dropFile(x, y, f) {
    const target = document.elementFromPoint(x, y);
    if (!target) return { ok: false, error: 'no_element_at_point' };
    await moveCursor(x, y);
    pulse(x, y);
    const file = fileFrom(f);
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = target.closest('input[type=file]') || (target.closest('label')?.control?.type === 'file' ? target.closest('label').control : null);
    if (input && !input.disabled) {
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, dropped: { name: file.name, bytes: file.size, via: 'file_input', target: nameOf(input) } };
    }
    target.dispatchEvent(new DragEvent('dragenter', mouse(x, y, { dataTransfer: dt })));
    target.dispatchEvent(new DragEvent('dragover', mouse(x, y, { dataTransfer: dt })));
    const accepted = !target.dispatchEvent(new DragEvent('drop', mouse(x, y, { dataTransfer: dt })));
    return { ok: true, dropped: { name: file.name, bytes: file.size, via: 'drop', target: nameOf(target), acceptedByPage: accepted } };
  }

  // Synthetic drag: pointer/mouse down-move-up, plus HTML5 drag events when the
  // source is draggable="true". ponytail: libraries that call setPointerCapture on
  // a synthetic pointer (dnd-kit, some sliders) need CDP mode, which sends real input.
  async function drag(fx, fy, tx, ty, steps = 12) {
    const src = document.elementFromPoint(fx, fy);
    if (!src) return { ok: false, error: 'no_element_at_point' };
    await moveCursor(fx, fy);
    pulse(fx, fy);
    src.dispatchEvent(new PointerEvent('pointerdown', mouse(fx, fy, { buttons: 1 })));
    src.dispatchEvent(new MouseEvent('mousedown', mouse(fx, fy, { buttons: 1 })));
    const native = src.closest('img, a[href]');
    const dragSrc = src.closest('[draggable="true"]') || (native && !native.closest('[draggable="false"]') ? native : null);
    const dt = dragSrc ? new DataTransfer() : null;
    if (dt && native) {
      const url = native.currentSrc || native.src || native.href;
      dt.setData('text/uri-list', url); dt.setData('text/plain', url);
      if (native.tagName === 'IMG') {
        dt.setData('text/html', native.outerHTML);
        // ponytail: same-origin/CORS images only; others drag as a URL.
        try {
          const blob = await (await fetch(url)).blob();
          const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const base = url.startsWith('data:') ? '' : decodeURIComponent(url.split('?')[0].split('/').pop() || '');
          dt.items.add(new File([blob], base.includes('.') ? base : `image.${ext}`, { type: blob.type }));
        } catch {}
      }
    }
    if (dt) dragSrc.dispatchEvent(new DragEvent('dragstart', mouse(fx, fy, { dataTransfer: dt })));
    let over = src;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(fx + (tx - fx) * i / steps), y = Math.round(fy + (ty - fy) * i / steps);
      await moveCursor(x, y, 25);
      const t = document.elementFromPoint(x, y) || document.body;
      t.dispatchEvent(new PointerEvent('pointermove', mouse(x, y, { buttons: 1 })));
      t.dispatchEvent(new MouseEvent('mousemove', mouse(x, y, { buttons: 1 })));
      if (dt) {
        if (t !== over) t.dispatchEvent(new DragEvent('dragenter', mouse(x, y, { dataTransfer: dt })));
        t.dispatchEvent(new DragEvent('dragover', mouse(x, y, { dataTransfer: dt })));
      }
      over = t;
    }
    if (dt) {
      over.dispatchEvent(new DragEvent('drop', mouse(tx, ty, { dataTransfer: dt })));
      dragSrc.dispatchEvent(new DragEvent('dragend', mouse(tx, ty, { dataTransfer: dt })));
    }
    over.dispatchEvent(new PointerEvent('pointerup', mouse(tx, ty)));
    over.dispatchEvent(new MouseEvent('mouseup', mouse(tx, ty)));
    pulse(tx, ty);
    return { ok: true, dragged: { from: nameOf(src), to: nameOf(over), html5: !!dt } };
  }

  function setInput(ref, text) {
    const el = byRef(ref);
    if (!el || !el.isConnected || !isVisible(el)) return { ok: false, error: 'stale_target' };
    if (el.disabled || el.readOnly) return { ok: false, error: 'not_editable' };
    if (el.tagName === 'SELECT') {
      el.value = text;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, set: { ref, name: nameOf(el) } };
  }

  function pressKey(ref, key) {
    const el = ref ? byRef(ref) : document.activeElement;
    if (ref && (!el || !el.isConnected)) return { ok: false, error: 'stale_target' };
    const target = el || document.body;
    const init = { key, bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true, key, target: nameOf(target) };
  }

  // Scroll at a point scrolls the nearest scrollable container under it
  // (a list, a panel); without a point it scrolls the window.
  async function scrollBy(dx, dy, x, y) {
    dx = Number(dx) || 0; dy = Number(dy) || 0;
    let target = null;
    if (x != null && y != null) {
      await moveCursor(Number(x), Number(y));
      for (let el = document.elementFromPoint(Number(x), Number(y)); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        const st = getComputedStyle(el);
        const canY = dy && el.scrollHeight > el.clientHeight && /(auto|scroll|overlay)/.test(st.overflowY);
        const canX = dx && el.scrollWidth > el.clientWidth && /(auto|scroll|overlay)/.test(st.overflowX);
        if (canY || canX) { target = el; break; }
      }
    }
    if (target) { target.scrollBy(dx, dy); return { ok: true, scrolled: nameOf(target), scrollTop: Math.round(target.scrollTop) }; }
    window.scrollBy(dx, dy);
    return { ok: true, scrollY: Math.round(window.scrollY) };
  }

  async function handle(msg) {
    switch (msg?.type) {
      case 'harness/ping': return { ok: true, pong: true };
      case 'harness/snapshot': return snapshot();
      case 'harness/clickRef': return clickRef(msg.ref, msg.button, Number(msg.count) || 1);
      case 'harness/point': return actionPoint(msg.ref);
      case 'harness/settle': return settle();
      case 'harness/clickPoint': return clickPoint(Number(msg.x), Number(msg.y), msg.button, Number(msg.count) || 1);
      case 'harness/typeText': return typeText(msg.ref, String(msg.text ?? ''));
      case 'harness/copy': return copyText(msg.ref);
      case 'harness/paste': return pasteText(msg.ref, String(msg.text ?? ''));
      case 'harness/dropFile': return dropFile(Number(msg.x), Number(msg.y), msg.file);
      case 'harness/plan': return plan(msg.points);
      case 'harness/drag': return drag(Number(msg.fromX), Number(msg.fromY), Number(msg.toX), Number(msg.toY));
      case 'harness/cursor': // shown before CDP input, which bypasses this script
        await moveCursor(Number(msg.x), Number(msg.y), Number(msg.ms) || 220);
        if (msg.pulse) pulse(Number(msg.x), Number(msg.y));
        return { ok: true };
      case 'harness/setInput': return setInput(msg.ref, String(msg.text ?? ''));
      case 'harness/pressKey': return pressKey(msg.ref, String(msg.key ?? ''));
      case 'harness/scrollBy': return scrollBy(msg.dx, msg.dy, msg.x, msg.y);
      default: return { ok: false, error: 'unknown_message' };
    }
  }

  // Chrome only keeps the channel open for an async reply if the listener returns true.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    Promise.resolve().then(() => handle(msg)).then(reply,
      (e) => reply({ ok: false, error: 'content_error', message: String(e) }));
    return true;
  });
})();
