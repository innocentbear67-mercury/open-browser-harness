// Typed, content-independent action validation. This is the trust boundary:
// model output is data, and page text can never grant approval here.
const SENSITIVE = /submit|pay|purchase|order|checkout|transfer|delete|remove|send|publish|confirm|sign|approve|place\s*order/i;
const CREDENTIAL = /password|passphrase|cvv|card\s*number|secret/i;

export function validateAction(action, ctx = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, reason: 'action_not_object' };
  }
  const { name, args = {} } = action;
  if (typeof name !== 'string') return { ok: false, reason: 'missing_tool_name' };
  const snap = ctx.snapshot || {};
  const vp = snap.viewport || {};
  const requireApproval = ctx.requireApproval !== false;
  const el = args.ref != null ? (snap.elements || []).find(e => e.ref === args.ref) : null;
  const rejected = (reason) => ({ ok: false, reason });
  const inView = (x, y) => !vp.w || (x >= 0 && y >= 0 && x <= vp.w && y <= vp.h);
  // Resolve one end of a pointer gesture: a ref (its box center) or explicit x/y.
  const pointOf = (ref, x, y, label) => {
    if (ref != null) {
      const e = (snap.elements || []).find(e => e.ref === Number(ref));
      if (!e) return { reason: 'stale_target' };
      if (!e.visible) return { reason: 'invisible_target' };
      if (!e.box) return { reason: `${label}_has_no_box` };
      return { x: Math.round(e.box.x + e.box.w / 2), y: Math.round(e.box.y + e.box.h / 2), el: e };
    }
    const px = Number(x), py = Number(y);
    if (x == null || y == null || !Number.isFinite(px) || !Number.isFinite(py)) return { reason: `${label}_needs_ref_or_xy` };
    return { x: Math.round(px), y: Math.round(py) };
  };
  const label = (p) => p.el ? `${p.el.role} "${p.el.name}"` : `(${p.x},${p.y})`;

  switch (name) {
    case 'read_page': case 'list_tabs': case 'screenshot':
      if (name === 'screenshot' && ctx.caps && ctx.caps.vision === false) return rejected('vision_unavailable');
      return { ok: true, normalized: { name, args: {} } };

    case 'switch_tab': {
      const id = Number(args.tab_id);
      if (!Number.isInteger(id)) return rejected('bad_tab_id');
      if (ctx.knownTabs && !ctx.knownTabs.includes(id)) return rejected('stale_tab');
      return { ok: true, normalized: { name, args: { tab_id: id } } };
    }

    case 'navigate': {
      let u;
      try { u = new URL(String(args.url)); } catch { return rejected('bad_url'); }
      if (!['http:', 'https:'].includes(u.protocol)) return rejected('unsupported_protocol');
      const host = u.hostname.toLowerCase();
      if ((ctx.blockedOrigins || []).some(o => host === o || host.endsWith('.' + o))) return rejected('blocked_domain');
      const allow = ctx.allowedOrigins || [];
      const offAllow = allow.length > 0 && !allow.some(o => host === o || host.endsWith('.' + o));
      return {
        ok: true,
        needsApproval: requireApproval && offAllow,
        approval: { effect: `Navigate to ${u.origin}${u.pathname}`, domain: host, target: u.href },
        normalized: { name, args: { url: u.href } }
      };
    }

    case 'click': {
      const button = args.button == null ? 'left' : args.button;
      if (!['left', 'right', 'middle'].includes(button)) return rejected('bad_button');
      const clicks = args.clicks == null ? 1 : Number(args.clicks);
      if (![1, 2, 3].includes(clicks)) return rejected('bad_clicks');
      const extra = { ...(button !== 'left' ? { button } : {}), ...(clicks !== 1 ? { clicks } : {}) };
      const verb = `${clicks === 2 ? 'Double-click' : clicks === 3 ? 'Triple-click' : 'Click'}${button !== 'left' ? ` (${button})` : ''}`;
      if (args.ref != null) {
        if (!el) return rejected('stale_target');
        if (!el.visible) return rejected('invisible_target');
        if (el.disabled) return rejected('disabled_target');
        // Only a left click activates; opening a context menu on "Delete" deletes nothing.
        const risky = button === 'left' && (SENSITIVE.test(el.name || '') || CREDENTIAL.test(el.name || ''));
        const sensitive = requireApproval && risky;
        return {
          ok: true, needsApproval: sensitive, consequential: risky,
          approval: { effect: `${verb} ${el.role} "${el.name}"`, domain: ctx.domain || '', target: `#${el.ref}` },
          normalized: { name, args: { ref: el.ref, ...extra } }
        };
      }
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return rejected('click_needs_ref_or_xy');
      if (!inView(x, y)) return rejected('coordinate_out_of_viewport');
      return { ok: true, normalized: { name, args: { x, y, ...extra } } };
    }

    case 'drag': {
      const from = pointOf(args.from_ref, args.from_x, args.from_y, 'from');
      if (from.reason) return rejected(from.reason);
      const to = pointOf(args.to_ref, args.to_x, args.to_y, 'to');
      if (to.reason) return rejected(to.reason);
      // Off-screen ends would land on whatever is at that point; scroll first.
      if (!inView(from.x, from.y) || !inView(to.x, to.y)) return rejected('coordinate_out_of_viewport');
      const sensitive = requireApproval && [from.el, to.el].some(e => e && (SENSITIVE.test(e.name || '') || CREDENTIAL.test(e.name || '')));
      return {
        ok: true, needsApproval: sensitive,
        approval: { effect: `Drag ${label(from)} to ${label(to)}`, domain: ctx.domain || '', target: `(${from.x},${from.y})->(${to.x},${to.y})` },
        normalized: { name, args: { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y } }
      };
    }

    case 'zoom': {
      if (ctx.caps && ctx.caps.vision === false) return rejected('vision_unavailable');
      let [x, y, w, h] = [args.x, args.y, args.width, args.height].map(Number);
      if (![x, y, w, h].every(Number.isFinite)) return rejected('zoom_needs_x_y_width_height');
      if (w < 8 || h < 8) return rejected('zoom_region_too_small');
      if (vp.w) { // clamp to the viewport
        x = Math.max(0, Math.min(x, vp.w - 8)); y = Math.max(0, Math.min(y, vp.h - 8));
        w = Math.min(w, vp.w - x); h = Math.min(h, vp.h - y);
      }
      return { ok: true, normalized: { name, args: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) } } };
    }

    case 'type': case 'paste': {
      // No ref: act on the focused field, at the caret.
      const f = snap.focus;
      const target = args.ref != null ? el
        : (snap.elements || []).find(e => e.focused)
          || (f?.editable ? { ref: f.ref, name: f.name, editable: true } : null)
          // CDP sends real keystrokes to whatever has focus, even inside iframes/canvas apps.
          || (ctx.cdp ? { name: f?.name || 'focused element', editable: true } : null);
      if (!target) return rejected(args.ref != null ? 'stale_target' : 'no_focused_element');
      if (!target.editable) return rejected('not_editable');
      const text = name === 'type' ? args.text : (args.text ?? ctx.clipboard);
      if (typeof text !== 'string') return rejected(name === 'type' ? 'text_not_string' : 'clipboard_empty');
      if (name === 'paste' && !text) return rejected('clipboard_empty');
      const risky = CREDENTIAL.test(target.name || '') || SENSITIVE.test(target.name || '');
      const sensitive = requireApproval && risky;
      const verb = name === 'type' ? 'Type' : 'Paste';
      return {
        ok: true, needsApproval: sensitive, consequential: risky,
        approval: { effect: `${verb} ${text.length} chars into "${target.name}"`, domain: ctx.domain || '', target: target.ref != null ? `#${target.ref}` : 'active element' },
        normalized: { name, args: { ...(args.ref != null ? { ref: target.ref } : { at_cursor: true }), text } }
      };
    }

    case 'copy': {
      if (args.ref != null && !el) return rejected('stale_target');
      return { ok: true, normalized: { name, args: args.ref != null ? { ref: el.ref } : {} } };
    }

    case 'drop_file': {
      let u;
      try { u = new URL(String(args.url)); } catch { return rejected('bad_url'); }
      if (!['http:', 'https:', 'data:'].includes(u.protocol)) return rejected('unsupported_protocol');
      const to = pointOf(args.to_ref, args.to_x, args.to_y, 'to');
      if (to.reason) return rejected(to.reason);
      if (!inView(to.x, to.y)) return rejected('coordinate_out_of_viewport');
      const file = args.name ? String(args.name) : (u.protocol === 'data:' ? 'file' : u.pathname.split('/').pop() || 'file');
      return {
        ok: true, needsApproval: requireApproval, consequential: true, // dropping a file uploads it to the site
        approval: { effect: `Upload "${file.slice(0, 60)}" to ${label(to)}`, domain: ctx.domain || '', target: `(${to.x},${to.y})` },
        normalized: { name, args: { url: u.href, ...(args.name ? { name: String(args.name) } : {}), to_x: to.x, to_y: to.y } }
      };
    }

    case 'press_key': {
      const key = String(args.key || '');
      if (!key) return rejected('empty_key');
      if (args.ref != null && !el) return rejected('stale_target');
      const sensitive = requireApproval && /^(enter|return)$/i.test(key);
      const on = el || (snap.focus ? { ref: snap.focus.ref, name: snap.focus.name, inForm: snap.focus.inForm } : null);
      return {
        // Enter inside a form can submit it; in a sheet or editor it is just a new line.
        ok: true, needsApproval: sensitive, consequential: /^(enter|return)$/i.test(key) && !!on?.inForm,
        approval: sensitive ? { effect: `Press Enter${on ? ` on "${on.name}"` : ''}`, domain: ctx.domain || '', target: on?.ref != null ? `#${on.ref}` : 'active element' } : undefined,
        normalized: { name, args: { key, ...(el ? { ref: el.ref } : {}) } }
      };
    }

    case 'scroll': {
      if (!['up', 'down', 'left', 'right'].includes(args.direction)) return rejected('bad_direction');
      const amount = args.amount == null ? 600 : Number(args.amount);
      if (!Number.isFinite(amount) || Math.abs(amount) > 10000) return rejected('bad_amount');
      const at = {};
      if (args.x != null || args.y != null) {
        const x = Number(args.x), y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return rejected('scroll_point_needs_x_and_y');
        if (!inView(x, y)) return rejected('coordinate_out_of_viewport');
        Object.assign(at, { x: Math.round(x), y: Math.round(y) });
      }
      return { ok: true, normalized: { name, args: { direction: args.direction, amount, ...at } } };
    }

    case 'finish': {
      if (typeof args.answer !== 'string' || !args.answer.trim()) return rejected('empty_answer');
      return {
        ok: true,
        needsApproval: requireApproval && !!ctx.onChangeSite && /transfer|send|pay|delete/i.test(args.answer),
        normalized: { name, args: { answer: args.answer, source: String(args.source || '') } }
      };
    }

    case 'ask_human': {
      if (typeof args.reason !== 'string' || !args.reason.trim()) return rejected('empty_reason');
      return { ok: true, normalized: { name, args: { reason: args.reason } } };
    }

    default:
      return rejected(`unknown_tool:${name}`);
  }
}

export function isMutating(name) {
  return ['click', 'drag', 'type', 'paste', 'drop_file', 'press_key', 'navigate', 'scroll'].includes(name);
}
