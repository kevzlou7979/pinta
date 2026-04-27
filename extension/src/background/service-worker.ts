/// <reference types="chrome" />

// Always show the side panel button on the extension toolbar action.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[pinta] sidePanel setup failed", err));
});

// Allow popup / content scripts to request the panel be opened in the
// active tab. (Phase 2+ will use this for select/draw mode triggers.)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "open-side-panel") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (typeof tabId === "number") {
      chrome.sidePanel.open({ tabId }).then(
        () => sendResponse({ ok: true }),
        (err: Error) => sendResponse({ ok: false, error: err.message }),
      );
      return true; // async response
    }
  }
});
