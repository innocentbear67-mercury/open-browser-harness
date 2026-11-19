import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDriver } from '../lib/driver.js';

test('screenshot falls back to CDP when captureVisibleTab lacks activeTab', async () => {
  const cmds = [];
  globalThis.chrome = {
    tabs: {
      get: async () => ({ id: 3, windowId: 1, active: true }),
      captureVisibleTab: async () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required."); }
    },
    debugger: {
      attach: async () => {},
      sendCommand: async (_t, method) => { cmds.push(method); return { data: 'QUJD' }; }
    }
  };
  const shot = await new BrowserDriver().screenshot(3, 1000);
  assert.equal(shot.dataUrl, 'data:image/png;base64,QUJD');
  assert.deepEqual(cmds, ['Page.captureScreenshot']);

  chrome.tabs.captureVisibleTab = async () => { throw new Error('Tabs cannot be edited right now'); };
  await assert.rejects(new BrowserDriver().screenshot(3, 1000), /cannot be edited/); // other errors still surface
});

test('restrictedReason flags pages Chrome blocks for extensions', async () => {
  const { restrictedReason } = await import('../lib/driver.js');
  assert.match(restrictedReason('chrome://extensions/'), /chrome:/);
  assert.match(restrictedReason('chrome-extension://abc/page.html'), /chrome-extension/);
  assert.match(restrictedReason('https://chromewebstore.google.com/detail/x'), /Web Store/);
  assert.equal(restrictedReason('http://localhost:8765/dashboard.html'), null);
  assert.equal(restrictedReason('https://example.com'), null);
});
