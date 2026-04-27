/// <reference types="chrome" />

import { captureFullPage } from "./screenshot.js";

// Always show the side panel button on the extension toolbar action.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[pinta] sidePanel setup failed", err));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "open-side-panel") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (typeof tabId === "number") {
      chrome.sidePanel.open({ tabId }).then(
        () => sendResponse({ ok: true }),
        (err: Error) => sendResponse({ ok: false, error: err.message }),
      );
      return true;
    }
  }

  if (msg?.type === "capture.full-page") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "no tabId" });
      return false;
    }
    captureFullPage(tabId).then(
      (capture) => sendResponse({ ok: true, capture }),
      (err: Error) => {
        console.error("[pinta] capture failed", err);
        sendResponse({ ok: false, error: err.message });
      },
    );
    return true;
  }
});
