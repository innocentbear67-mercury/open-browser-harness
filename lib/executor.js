import { validateAction, isMutating } from './validation.js';
import { changed, summarizeDelta } from './compare.js';

// The executor is the only path from model output to browser effects.
// It validates, asks for approval, executes, then re-reads to verify.
export class Executor {
  constructor({ driver, policy = {}, requestApproval, log = () => {}, settleMs = 400 }) {
    this.driver = driver;
    this.settleMs = settleMs;
    // "Allow for this task": approvals for the same action on the same target, kept
    // for this executor's run only (one executor per run).
    this.standing = new Set(); // wheel scroll animates and UIs update async; wait once before "no effect"
    this.policy = policy;
    this.requestApproval = requestApproval || (async () => false);
    this.log = log;
  }

  currentTabId(explicit) {
    return explicit;
  }

  async run(rawAction, state = {}) {
    const tabId = this.currentTabId(state.tabId);
    if (tabId == null) return { ok: false, kind: 'validation', error: 'no_tab' };

    let snap;
    try { snap = await this.driver.read(tabId); }
    catch (e) { return { ok: false, kind: 'driver', error: `read_failed:${e.message}` }; }

    const url = snap.url || '';
    let domain = '';
    try { domain = new URL(url).hostname.toLowerCase(); } catch {}
    const ctx = {
      snapshot: snap, domain,
      requireApproval: this.policy.requireApproval !== false,
      allowedOrigins: this.policy.allowedOrigins || [],
      blockedOrigins: this.policy.blockedOrigins || [],
      caps: this.policy.caps,
      knownTabs: state.knownTabs,
      cdp: !!this.policy.cdp,
      clipboard: state.clipboard
    };

    const v = validateAction(rawAction, ctx);
    if (!v.ok) {
      this.log({ kind: 'reject', name: rawAction?.name, reason: v.reason });
      return { ok: false, kind: 'validation', error: v.reason };
    }
    const { name, args } = v.normalized;
    const consequential = !!v.consequential;

    if (v.needsApproval) {
      const approval = {
        id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        tabId, domain,
        effect: v.approval.effect,
        target: v.approval.target,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      };
      // Key ignores counts/values that change per repeat ("Type 1 chars" vs "Type 2 chars").
      const key = `${domain}|${name}|${approval.target}|${approval.effect.replace(/\d+ chars/, 'N chars').replace(/ on "[^"]*"$/, '')}`;
      let granted;
      if (this.standing.has(key)) {
        granted = true;
        this.log({ kind: 'approval_auto', approval });
      } else {
        this.log({ kind: 'approval_request', approval });
        granted = await this.requestApproval(approval);
        if (granted === 'task') this.standing.add(key);
      }
      if (!granted) {
        this.log({ kind: 'approval_denied', approval });
        return { ok: false, kind: 'approval', error: 'approval_denied' };
      }
      // Re-bind: a tab switch or expiry while the prompt was open invalidates it.
      const active = await this.driver.activeTab();
      if (!active || active.id !== tabId || Date.now() > approval.expiresAt) {
        this.log({ kind: 'approval_expired', approval });
        return { ok: false, kind: 'approval', error: 'approval_expired' };
      }
      this.log({ kind: 'approval_granted', approval });
    }

    let result;
    try {
      switch (name) {
        case 'read_page': result = { snapshot: snap }; break;
        case 'list_tabs': result = { tabs: await this.driver.listTabs() }; break;
        case 'switch_tab': result = await this.driver.switchTab(args.tab_id); break;
        case 'navigate': result = await this.driver.navigate(tabId, args.url); break;
        case 'click': result = await this.driver.click(tabId, args); break;
        case 'drag': result = await this.driver.drag(tabId, args); break;
        case 'zoom': result = { zoom: await this.driver.zoom(tabId, args, snap.viewport?.w) }; break;
        case 'type': result = args.at_cursor ? await this.driver.typeAtCursor(tabId, args) : await this.driver.type(tabId, args); break;
        case 'copy': result = await this.driver.copy(tabId, args); break;
        case 'paste': result = await this.driver.paste(tabId, args); break;
        case 'drop_file': result = await this.driver.dropFile(tabId, args); break;
        case 'press_key': result = await this.driver.key(tabId, { ...args, ref: args.ref }); break;
        case 'scroll': result = await this.driver.scroll(tabId, args); break;
        case 'screenshot': result = { screenshot: await this.driver.screenshot(tabId, snap.viewport?.w) }; break;
        case 'ask_human': result = { handoff: true, reason: args.reason }; break;
        case 'finish': result = { finished: true, answer: args.answer, source: args.source }; break;
        default: return { ok: false, kind: 'validation', error: 'unhandled_tool' };
      }
    } catch (e) {
      // The effect may have happened even though the call errored. Never
      // blindly retry: mark uncertain so the runtime re-observes instead.
      this.log({ kind: 'uncertain', name, error: e.message });
      return { ok: false, kind: 'uncertain', error: e.message, name, consequential };
    }

    if (['read_page', 'list_tabs', 'screenshot', 'zoom', 'copy', 'ask_human', 'finish', 'switch_tab'].includes(name)) {
      this.log({ kind: 'executed', name, result: summarize(result) });
      return { ok: true, name, result, snapshot: snap };
    }

    let after;
    try { after = await this.driver.read(tabId); }
    catch (e) {
      this.log({ kind: 'uncertain', name, error: `verify_failed:${e.message}` });
      return { ok: false, kind: 'uncertain', error: `verify_failed:${e.message}`, name };
    }
    // Clicks by position, key presses, drags and typing at the cursor often change
    // only a canvas or hidden editor (Sheets, maps); no DOM change there is a warning,
    // not a failure, so planned batches keep going.
    const blind = (name === 'click' && args.ref == null) || name === 'press_key' || name === 'drag' || !!args.at_cursor;
    if (isMutating(name) && !blind && !changed(snap, after) && this.settleMs > 0) {
      await new Promise(r => setTimeout(r, this.settleMs));
      try { after = await this.driver.read(tabId); } catch {}
    }
    const verification = { changed: changed(snap, after), delta: summarizeDelta(snap, after) };
    this.log({ kind: 'executed', name, result: summarize(result), verification });

    if (isMutating(name) && !verification.changed && blind) {
      return { ok: true, name, result, verification, snapshot: after, unverified: true, consequential };
    }
    if (isMutating(name) && !verification.changed) {
      return { ok: false, kind: 'no_effect', error: 'no_observable_change', verification, snapshot: after, consequential };
    }
    return { ok: true, name, result, verification, snapshot: after, consequential };
  }
}

function summarize(r) {
  if (!r) return '';
  const { screenshot, snapshot, zoom, ...rest } = r;
  if (screenshot) return `screenshot ${screenshot.width}x${screenshot.height}`;
  if (zoom) return `zoom ${zoom.region.width}x${zoom.region.height} at ${zoom.scale.toFixed(1)}x`;
  if (snapshot) return `read ${snapshot.elements?.length || 0} elements`;
  return JSON.stringify(rest).slice(0, 200);
}
