import { BrowserDriver, restrictedReason } from '../lib/driver.js';
import { Executor } from '../lib/executor.js';
import { createAdapter, DEFAULT_MODELS } from '../lib/providers/index.js';
import { probeCapabilities, describeCaps } from '../lib/providers/probe.js';
import { PRESETS, presetById, listModels } from '../lib/providers/presets.js';
import { AgentRuntime } from '../lib/runtime.js';
import { createRun, activeRun, clearRun, canResume } from '../lib/state.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'harnessSettings';
// ponytail: key saved in chrome.storage.local (plain text in the Chrome profile,
// readable only by this extension). Use "Native companion" for Keychain storage.
const KEY_STORE = 'harnessApiKey';    // legacy single key, migrated into KEYS_STORE
const KEYS_STORE = 'harnessApiKeys';  // { [presetId | 'custom']: key }, so switching presets keeps each key
const SESSIONS_KEY = 'harnessSessions';
const MAX_SESSIONS = 40, MAX_ENTRIES = 400;

let apiKey = '';
let keys = {};
const keySlot = () => $('preset').value || 'custom';
let caps = null;
let runtime = null;
let pendingApproval = null;
let activeTabId = null;
let activeTabUrl = '';

// ---- Sessions: a thread of tasks, kept as small text entries for History ----
const newSession = () => ({ id: `s_${Date.now()}`, title: '', createdAt: Date.now(), updatedAt: Date.now(), entries: [] });
let session = newSession();
let saveTimer = null;

function saveSessionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 400);
}
async function saveSession() {
  if (!session.entries.length) return;
  session.updatedAt = Date.now();
  const { [SESSIONS_KEY]: list = [] } = await chrome.storage.local.get(SESSIONS_KEY);
  const next = [structuredClone(session), ...list.filter(s => s.id !== session.id)].slice(0, MAX_SESSIONS);
  await chrome.storage.local.set({ [SESSIONS_KEY]: next });
}

// ---- Thread rendering ----
const ERR_KINDS = new Set(['error', 'reject', 'approval_denied', 'approval_expired', 'uncertain',
  'provider_error', 'validation', 'no_effect', 'duplicate', 'approval']);

function slim(e) {
  return {
    kind: e.kind, name: e.name, text: e.text, reason: e.reason, error: e.error,
    delta: e.verification?.delta ?? e.delta, mode: e.mode, source: e.source,
    effect: e.approval?.effect ?? e.effect, err: e.err
  };
}

function stepLabel(e) {
  if (e.kind === 'executed') return e.name || 'done';
  if (e.kind === 'caps') return `Model connected · ${e.mode} mode`;
  if (e.kind === 'approval_request') return 'Waiting for approval';
  if (e.kind === 'approval_granted') return 'Approved';
  if (e.kind === 'approval_auto') return 'Approved for this task';
  return `${e.kind.replace(/_/g, ' ')}${e.name ? `: ${e.name}` : ''}`;
}

function render(e) {
  const el = document.createElement('div');
  switch (e.kind) {
    case 'run':
      el.className = 'msg-user'; el.textContent = e.text || ''; break;
    case 'thought':
      if (!e.text?.trim()) return null;
      el.className = 'msg-agent'; el.textContent = e.text; break;
    case 'answer': {
      el.className = 'msg-answer'; el.textContent = e.text || '';
      if (e.source) { const s = document.createElement('span'); s.className = 'src'; s.textContent = `Source: ${e.source}`; el.append(s); }
      break;
    }
    case 'end':
      el.className = `end${e.err ? ' err' : ''}`; el.textContent = e.text || ''; break;
    default: {
      el.className = `step${ERR_KINDS.has(e.kind) ? ' err' : ['approval_request', 'skipped'].includes(e.kind) ? ' wait' : ''}`;
      const b = document.createElement('b'); b.textContent = stepLabel(e);
      const span = document.createElement('span');
      const detail = e.effect || e.reason || e.error || e.delta || (e.kind !== 'caps' ? e.text : '') || '';
      span.append(b, detail ? ` — ${detail}` : '');
      el.append(span);
    }
  }
  return el;
}

function append(e) {
  const el = render(e);
  if (!el) return;
  $('empty').hidden = true;
  $('log').append(el);
  $('thread').scrollTop = $('thread').scrollHeight;
}

function renderThread() {
  $('log').replaceChildren();
  $('empty').hidden = session.entries.length > 0;
  for (const e of session.entries) append(e);
}

function log(entry) {
  const e = slim(entry);
  if (e.kind === 'run' && !session.title) session.title = (e.text || '').slice(0, 90);
  session.entries.push(e);
  if (session.entries.length > MAX_ENTRIES) session.entries.splice(0, session.entries.length - MAX_ENTRIES);
  append(e);
  saveSessionSoon();
}

// ---- Tab, settings ----
async function refreshTab() {
  const tab = await new BrowserDriver().activeTab();
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url || '';
  const el = $('tabInfo');
  let host = '';
  try { const u = new URL(activeTabUrl); host = u.protocol.startsWith('http') ? u.hostname : `${u.protocol}//${u.hostname}`; } catch {}
  const blocked = tab ? restrictedReason(activeTabUrl) : null;
  el.textContent = tab ? `${host || `tab ${tab.id}`}${blocked ? ' · not accessible' : ''}` : 'No tab detected';
  el.title = blocked || activeTabUrl;
  el.classList.toggle('muted', !tab || !!blocked);
  $('task').placeholder = blocked ? 'Switch to a normal web page to run a task' : 'What should I do on this page?';
}

function settingsFromUI() {
  const num = (id) => {
    const raw = $(id).value.trim();
    return raw === '' ? null : Number(raw);
  };
  return {
    preset: $('preset').value,
    provider: $('provider').value,
    keySource: $('keySource').value,
    endpoint: $('endpoint').value.trim(),
    model: $('model').value.trim(),
    maxSteps: Number($('maxSteps').value) || 30,
    maxSpend: Number($('maxSpend').value) || 0,
    vision: $('vision').checked,
    cdpMode: $('cdpMode').checked,
    requireApproval: $('requireApproval').checked,
    priceIn: num('priceIn'), priceOut: num('priceOut')
  };
}

function pricesFrom(s) {
  return s.priceIn == null || s.priceOut == null ? null : { input: s.priceIn, output: s.priceOut };
}

function adapterFrom(s) {
  return createAdapter({
    provider: s.provider, model: s.model, key: apiKey,
    endpoint: s.endpoint, keySource: s.keySource, prices: pricesFrom(s)
  });
}

function updateEndpointRow() {
  const p = $('provider').value;
  $('endpointRow').hidden = !(p === 'openai-compatible' || p === 'openai');
  $('endpoint').placeholder = p === 'openai' ? 'https://api.openai.com/v1 (default)' : 'https://openrouter.ai/api/v1';
  $('keyHint').textContent = $('keySource').value === 'companion'
    ? 'Key is fetched from the OS keychain by the companion; it never enters Chrome.'
    : 'Key is saved in this browser profile and sent only to the provider above. Nothing is logged.';
}

function updateChrome() {
  $('modelLabel').textContent = $('model').value.trim() || 'Set model';
  const ask = $('requireApproval').checked;
  $('approvalPillText').textContent = ask ? 'Ask first' : 'Auto';
  $('approvalPill').classList.toggle('auto', !ask);
  $('approvalPill').title = ask ? 'Changes need your approval. Click to switch to Auto.' : 'Auto: no approval prompts. Click to ask first.';
  $('startBtn').classList.toggle('ready', !!$('task').value.trim());
}

async function saveSettings() {
  updateChrome();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsFromUI() });
}

async function loadSettings() {
  const { [SETTINGS_KEY]: s, [KEY_STORE]: legacy, [KEYS_STORE]: stored } =
    await chrome.storage.local.get([SETTINGS_KEY, KEY_STORE, KEYS_STORE]);
  for (const p of PRESETS) $('preset').add(new Option(p.label, p.id));
  keys = stored || {};
  if (legacy && !Object.keys(keys).length) {
    keys[s?.preset || 'custom'] = legacy;
    await chrome.storage.local.set({ [KEYS_STORE]: keys });
    await chrome.storage.local.remove(KEY_STORE);
  }
  if (s) {
    $('preset').value = presetById(s.preset) ? s.preset : '';
    $('provider').value = s.provider || 'openai-compatible';
    $('keySource').value = s.keySource || 'session';
    $('endpoint').value = s.endpoint || '';
    $('model').value = s.model || presetById(s.preset)?.model || DEFAULT_MODELS[$('provider').value] || '';
    $('maxSteps').value = s.maxSteps ?? 30;
    $('maxSpend').value = s.maxSpend ?? 0.5;
    $('vision').checked = s.vision !== false;
    $('cdpMode').checked = !!s.cdpMode;
    $('requireApproval').checked = s.requireApproval !== false;
    $('priceIn').value = s.priceIn ?? '';
    $('priceOut').value = s.priceOut ?? '';
  }
  apiKey = keys[keySlot()] || '';
  $('key').value = apiKey;
  showPresetNote();
  updateEndpointRow();
  updateChrome();
  refreshModels();
}

function showPresetNote() {
  const note = presetById($('preset').value)?.note;
  $('presetNote').hidden = !note;
  $('presetNote').textContent = note || '';
}

function applyPreset(id) {
  const p = presetById(id);
  if (p) {
    $('provider').value = p.provider;
    $('endpoint').value = p.endpoint;
    $('model').value = p.model;
  }
  apiKey = keys[keySlot()] || '';
  $('key').value = apiKey;
  caps = null; $('caps').textContent = 'not tested';
  showPresetNote();
  updateEndpointRow();
  saveSettings();
  refreshModels();
}

// Fill the model picker from the provider's /models list (needs the key).
let modelsTimer = null;
function refreshModels() {
  clearTimeout(modelsTimer);
  modelsTimer = setTimeout(async () => {
    const s = settingsFromUI();
    const hint = $('modelHint');
    if (s.keySource === 'session' && !apiKey) { hint.hidden = true; return; }
    try {
      const ids = await listModels(adapterFrom(s));
      $('modelList').replaceChildren(...ids.map(id => new Option(id, id)));
      hint.hidden = false;
      hint.textContent = ids.length ? `${ids.length} models available — click the field to pick one.` : 'This provider did not return a model list; type the model id.';
      if (ids.length && !$('model').value.trim()) { $('model').value = ids[0]; saveSettings(); }
    } catch {
      hint.hidden = false; hint.textContent = 'Could not load the model list; type the model id.';
    }
  }, 500);
}

// ---- Sheets ----
function openSheet(id) {
  for (const s of ['settingsView', 'historyView']) $(s).hidden = s !== id;
  if (id === 'historyView') renderHistory();
}
const closeSheets = () => { $('settingsView').hidden = true; $('historyView').hidden = true; };

async function renderHistory() {
  const { [SESSIONS_KEY]: list = [] } = await chrome.storage.local.get(SESSIONS_KEY);
  const ul = $('historyList');
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No past sessions yet.';
    ul.append(li); return;
  }
  for (const s of list) {
    const tasks = s.entries.filter(e => e.kind === 'run').length;
    const last = [...s.entries].reverse().find(e => e.kind === 'end');
    const li = document.createElement('li');
    const btn = document.createElement('button');
    if (s.id === session.id) btn.setAttribute('aria-current', 'true');
    const t = document.createElement('span'); t.className = 't'; t.textContent = s.title || 'Untitled session';
    const sub = document.createElement('span'); sub.className = 's';
    sub.textContent = `${new Date(s.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${tasks} task${tasks === 1 ? '' : 's'}${last ? ` · ${last.text}` : ''}`;
    btn.append(t, sub);
    btn.addEventListener('click', () => {
      if (runtime) return;
      session = structuredClone(s);
      renderThread();
      closeSheets();
    });
    li.append(btn); ul.append(li);
  }
}

function startNewSession() {
  if (runtime) return;
  session = newSession();
  renderThread();
  $('resume').hidden = true;
  $('task').value = '';
  autoGrow();
  closeSheets();
  $('task').focus();
}

function autoGrow() {
  const t = $('task');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  updateChrome();
}

// ---- Approvals ----
function requestApproval(approval) {
  return new Promise((resolve) => {
    if (pendingApproval) { resolve(false); return; }
    const finish = (v) => {
      if (!pendingApproval) return;
      clearTimeout(pendingApproval.timer);
      pendingApproval = null;
      $('approvalCard').hidden = true;
      resolve(v);
    };
    pendingApproval = {
      finish,
      timer: setTimeout(() => finish(false), 60000)
    };
    $('approvalText').textContent = `${approval.effect} on ${approval.domain || 'this page'} (${approval.target})`;
    $('approvalCard').hidden = false;
    $('allowBtn').focus();
  });
}

function wireApprovalButtons() {
  $('allowBtn').addEventListener('click', () => pendingApproval?.finish(true));
  $('allowTaskBtn').addEventListener('click', () => pendingApproval?.finish('task'));
  $('denyBtn').addEventListener('click', () => pendingApproval?.finish(false));
  chrome.tabs.onActivated.addListener(() => {
    if (pendingApproval) {
      log({ kind: 'approval_expired' });
      pendingApproval.finish(false);
    }
    refreshTab();
  });
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === 'complete') refreshTab();
  });
}

// Extension pages skip CORS only for origins they hold host permission for. The
// manifest grants <all_urls>, so this is normally a no-op; it only prompts if the
// user narrowed site access in chrome://extensions (needs the click's user gesture).
async function ensureHostAccess(url) {
  const origins = [new URL(url).origin + '/*'];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function testCapabilities() {
  const s = settingsFromUI();
  if ($('keySource').value === 'session' && !apiKey) {
    $('caps').textContent = 'enter a key first';
    return null;
  }
  const adapter = adapterFrom(s);
  if (s.keySource === 'session') {
    if (!adapter.baseUrl) { $('caps').textContent = 'enter a base URL first'; return null; }
    let granted = false;
    try { granted = await ensureHostAccess(adapter.baseUrl); } catch (e) { $('caps').textContent = `bad base URL: ${e.message}`; return null; }
    if (!granted) { $('caps').textContent = `access to ${new URL(adapter.baseUrl).origin} denied — needed to call the provider`; return null; }
  }
  $('caps').textContent = 'testing…';
  try {
    caps = await probeCapabilities(adapter);
    $('caps').textContent = describeCaps(caps);
    if (caps.mode === 'readonly') $('caps').textContent += ' (read-only)';
    log({ kind: 'caps', mode: caps.mode, errors: caps.errors });
    return caps;
  } catch (e) {
    caps = null;
    $('caps').textContent = `failed: ${e.code || e.message}`;
    return null;
  }
}

async function buildContext(s) {
  const adapter = adapterFrom(s);
  const orig = adapter.runTurn.bind(adapter);
  adapter.runTurn = async (opts) => {
    const obs = opts.messages.filter(m => m.parts?.some(p => p.observation)).slice(-1)[0];
    const txt = obs?.parts?.find(p => p.text)?.text || '';
    $('sentData').textContent = `${opts.system?.slice(0, 200) || ''}\n\n${txt.slice(0, 2500)}`;
    return orig(opts);
  };
  const driver = new BrowserDriver({ cdpEnabled: s.cdpMode });
  const executor = new Executor({
    driver,
    policy: { requireApproval: s.requireApproval, allowedOrigins: [], blockedOrigins: [], caps, cdp: s.cdpMode },
    requestApproval,
    // The runtime already logs each outcome (incl. rejections); keep executor-only events (approvals).
    log: (e) => { if (!['executed', 'reject', 'uncertain'].includes(e.kind)) log(e); }
  });
  return { adapter, driver, executor };
}

function setRunning(on) {
  $('startBtn').hidden = on;
  $('stopBtn').hidden = !on;
  $('stopBtn').disabled = !on;
  $('newBtn').disabled = on;
  $('historyBtn').disabled = on;
}

async function startRun(existingRun = null) {
  if (runtime) return;
  const s = settingsFromUI();
  await saveSettings();
  if (activeTabId == null) await refreshTab();
  if (activeTabId == null) { $('status').textContent = 'no active tab'; return; }
  const blocked = restrictedReason(activeTabUrl);
  if (blocked) { $('status').textContent = `${blocked} — switch to a normal web page`; return; }
  if ($('keySource').value === 'session' && !apiKey) {
    $('status').textContent = 'add an API key in Settings'; openSheet('settingsView'); return;
  }

  const task = $('task').value.trim();
  if (!existingRun && !task) { $('status').textContent = 'enter a task first'; $('task').focus(); return; }
  if (!caps) caps = await testCapabilities();
  if (!caps) { $('status').textContent = 'capability test failed — check Settings'; return; }

  const { adapter, driver, executor } = await buildContext(s);
  const run = existingRun || createRun({
    task, provider: s.provider, model: s.model, caps,
    policy: { requireApproval: s.requireApproval }, tabId: activeTabId
  });
  run.tabId = activeTabId;
  run.options = { maxSteps: s.maxSteps, maxSpend: s.maxSpend, vision: s.vision };
  runtime = new AgentRuntime({
    adapter, executor, driver, caps, policy: run.policy,
    emit: (e) => {
      if (e.kind === 'log') log(e.entry);
      if (e.kind === 'status') $('status').textContent = e.text;
    }
  });

  setRunning(true);
  $('resume').hidden = true;
  $('status').textContent = 'running…';
  log({ kind: 'run', text: task || run.task });
  $('task').value = '';
  autoGrow();

  try {
    const final = await runtime.run(run, {
      maxSteps: s.maxSteps,
      maxSpend: pricesFrom(s) && s.maxSpend > 0 ? s.maxSpend : null, // 0/blank = no cap
      vision: s.vision
    });
    $('steps').textContent = String(final.steps.length);
    $('spend').textContent = final.usage.costUsd != null ? `$${final.usage.costUsd.toFixed(3)}` : 'n/a';
    const statusText = final.status === 'done' ? 'done' : `${final.status}${final.final?.reason ? ': ' + final.final.reason : ''}`;
    $('status').textContent = statusText;
    if (final.final?.answer) log({ kind: 'answer', text: final.final.answer, source: final.final.source || 'not stated' });
    log({ kind: 'end', text: statusText, err: final.status !== 'done' });
    if (final.status === 'paused') $('resume').hidden = false;
  } catch (e) {
    $('status').textContent = `error: ${e.message}`;
    log({ kind: 'error', reason: e.message });
  } finally {
    setRunning(false);
    await driver.detachAll();
    runtime = null;
    await saveSession();
  }
}

function wire() {
  $('preset').addEventListener('change', () => applyPreset($('preset').value));
  $('provider').addEventListener('change', () => {
    $('model').value = DEFAULT_MODELS[$('provider').value] || '';
    caps = null;
    updateEndpointRow(); saveSettings(); refreshModels();
  });
  $('keySource').addEventListener('change', () => { caps = null; updateEndpointRow(); saveSettings(); });
  $('endpoint').addEventListener('input', () => { caps = null; saveSettings(); refreshModels(); });
  $('model').addEventListener('input', () => { caps = null; saveSettings(); });
  for (const id of ['maxSteps', 'maxSpend', 'priceIn', 'priceOut']) $(id).addEventListener('input', saveSettings);
  for (const id of ['vision', 'cdpMode', 'requireApproval']) $(id).addEventListener('change', saveSettings);
  $('key').addEventListener('input', () => {
    apiKey = $('key').value.trim(); caps = null; $('caps').textContent = 'not tested';
    if (apiKey) keys[keySlot()] = apiKey; else delete keys[keySlot()]; // clear the field to forget this key
    chrome.storage.local.set({ [KEYS_STORE]: keys });
    refreshModels();
  });
  $('testBtn').addEventListener('click', testCapabilities);

  // Composer
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); startRun(); });
  $('task').addEventListener('input', autoGrow);
  $('task').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('stopBtn').addEventListener('click', () => { runtime?.stop(); $('status').textContent = 'stopping…'; });
  $('approvalPill').addEventListener('click', () => {
    $('requireApproval').checked = !$('requireApproval').checked;
    saveSettings();
  });
  $('modelLabel').addEventListener('click', () => openSheet('settingsView'));

  // Top bar
  $('settingsBtn').addEventListener('click', () => $('settingsView').hidden ? openSheet('settingsView') : closeSheets());
  $('historyBtn').addEventListener('click', () => $('historyView').hidden ? openSheet('historyView') : closeSheets());
  $('newBtn').addEventListener('click', startNewSession);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

  // Resume
  $('resumeBtn').addEventListener('click', async () => {
    const run = await activeRun();
    if (run && canResume(run)) {
      $('provider').value = run.provider;
      $('model').value = run.model;
      await startRun(run);
    }
  });
  $('discardBtn').addEventListener('click', async () => {
    const run = await activeRun();
    if (run) await clearRun(run.id);
    $('resume').hidden = true;
  });
}

(async () => {
  wire();
  wireApprovalButtons();
  await loadSettings();
  await refreshTab();
  renderThread();
  const run = await activeRun();
  if (run && canResume(run)) {
    $('resumeText').textContent = `Interrupted: ${run.task.slice(0, 80)} (${run.steps.length} steps)`;
    $('resume').hidden = false;
  }
  $('task').focus();
})();
