// Minimal service worker. The agent loop lives in the side panel so it can be
// observed and interrupted; run state is persisted to chrome.storage.session so
// a panel/service-worker restart can resume without replaying a submission.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ harnessRuns: {}, harnessSettings: null });
});

// Permission prompts are requested directly in the panel's click handlers:
// relaying them here loses the user gesture Chrome requires.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "harness/ping") {
    reply({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
});
