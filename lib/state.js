// Pure run-state helpers (testable) plus thin chrome.storage.session wrappers.
export const STATE_KEY = 'harnessRuns';
export const ACTIVE_KEY = 'harnessActiveRun';

export function createRun({ task, provider, model, caps, policy, tabId }) {
  return {
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    task, provider, model,
    caps: { toolCalling: !!caps?.toolCalling, vision: !!caps?.vision },
    policy: { ...policy },
    tabId, status: 'running', startedAt: Date.now(), updatedAt: Date.now(),
    steps: [], messages: [], usage: { input: 0, output: 0, costUsd: 0 },
    final: null
  };
}

export function appendStep(run, entry) {
  run.steps.push({ at: Date.now(), ...entry });
  run.updatedAt = Date.now();
  return run;
}

export function actionSignature(name, args, domain = '') {
  const a = args || {};
  const stable = JSON.stringify(Object.fromEntries(Object.keys(a).sort().map(k => [k, a[k]])));
  return `${domain}|${name}|${stable}`;
}

// A duplicate is a consequential action (submit, pay, upload, Enter in a form) already
// done in an EARLIER turn on the same page state. Repeats inside one planned batch are
// intentional (Enter after each cell), so `step` (the current turn) is excluded.
export function alreadyExecuted(run, sig, step) {
  return (run.steps || []).some(s => ['executed', 'uncertain', 'no_effect'].includes(s.kind) && s.signature === sig &&
    s.consequential !== false && (step == null || s.step !== step));
}

export function canResume(run) {
  return !!run && (run.status === 'running' || run.status === 'paused');
}

// Drops old page observations (the bulk of the tokens). Tool results are never
// dropped: OpenAI, Anthropic and Gemini all reject a tool call whose result is
// missing. ponytail: tool results are small JSON; summarize them if runs get very long.
export function compactHistory(history, keepObservations = 6) {
  const obsIdx = [];
  history.forEach((m, i) => { if (m.parts?.some(p => p.observation)) obsIdx.push(i); });
  const drop = new Set(obsIdx.slice(0, Math.max(0, obsIdx.length - keepObservations)));
  return history.filter((_, i) => !drop.has(i));
}

export async function saveRun(run) {
  const all = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || {};
  all[run.id] = run;
  await chrome.storage.session.set({ [STATE_KEY]: all, [ACTIVE_KEY]: run.id });
  return run;
}

export async function loadRun(id) {
  const all = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || {};
  return all[id] || null;
}

export async function activeRun() {
  const { [ACTIVE_KEY]: id } = await chrome.storage.session.get(ACTIVE_KEY);
  return id ? loadRun(id) : null;
}

export async function clearRun(id) {
  const all = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || {};
  delete all[id];
  await chrome.storage.session.set({ [STATE_KEY]: all, [ACTIVE_KEY]: null });
}
