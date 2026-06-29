/* ============================================================
   AutoFill v3 — background/background.js
   Loaded via importScripts (after brain.js + brain-api.js).
   Handles:
     - Extension icon click → open/focus dashboard tab
     - On Google Form tab → also relay show_prompt to content script
     - First install → seed brain dictionary + open dashboard
   ============================================================ */

'use strict';

const DASHBOARD_URL = 'dashboard/dashboard.html';

// ── Extension icon clicked ───────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  // If currently on a Google Form, re-trigger the fill prompt
  if (tab.url && tab.url.includes('docs.google.com/forms')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'show_prompt' });
    } catch (_) { /* content script may already be showing it */ }
  }

  await openDashboard();
});

// ── Open / focus dashboard tab ────────────────────────────────
async function openDashboard() {
  const fullUrl  = chrome.runtime.getURL(DASHBOARD_URL);
  const existing = await chrome.tabs.query({ url: fullUrl });

  if (existing.length > 0) {
    const t = existing[0];
    await chrome.tabs.update(t.id, { active: true });
    try {
      const win = await chrome.windows.get(t.windowId);
      await chrome.windows.update(win.id, { focused: true });
    } catch (_) {}
  } else {
    await chrome.tabs.create({ url: fullUrl });
  }
}

// ── First install ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // Seed the brain with the 80-entry alias dictionary
    await seedOnInstall();
    // Open dashboard for first-time setup
    chrome.tabs.create({ url: chrome.runtime.getURL(DASHBOARD_URL) });
  }
});
