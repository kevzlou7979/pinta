/// <reference types="chrome" />

// Surface-side controller for the Voice Command module (Phase 20). One
// instance per execution context (the side panel and each content script
// get their own). It owns a long-lived "voice" port to the service
// worker, tracks which text field is currently dictating, and splices
// incoming transcripts into that field — dispatching a bubbling `input`
// event so Svelte `bind:value` picks the change up with zero per-component
// logic. Both the per-field mic button and the global Alt+V hotkey drive
// it through the same API.

import { insertAtCaret } from "./insert";

export type VoiceTarget = HTMLInputElement | HTMLTextAreaElement;

type PortMsg =
  | { t: "result"; transcript: string; isFinal: boolean }
  | { t: "error"; code: string }
  | { t: "end" };

/** Human-readable copy for the speech-recognition error codes we relay. */
function errorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Enable it for Pinta in Settings.";
    case "no-speech":
      return "Didn't catch that — try again.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition needs an internet connection.";
    case "unsupported":
      return "This browser doesn't support speech recognition.";
    default:
      return "Voice input failed. Try again.";
  }
}

/** Is `el` a text field we can dictate into? */
export function isTextField(el: unknown): el is VoiceTarget {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    // Free-text input types only — never color / date / checkbox / etc.
    return t === "text" || t === "search" || t === "url" || t === "email";
  }
  return false;
}

/** Resolve the truly-focused element, drilling through shadow roots (the
 *  on-page overlay renders inside a shadow DOM). */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

class VoiceController {
  /** The field currently receiving dictation, or null when idle. */
  activeEl: VoiceTarget | null = null;
  /** Last error message (dismissible in the UI), or null. */
  error: string | null = null;

  private port: chrome.runtime.Port | null = null;
  private subs = new Set<() => void>();

  get listening(): boolean {
    return this.activeEl !== null;
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private notify(): void {
    for (const fn of this.subs) fn();
  }

  private ensurePort(): chrome.runtime.Port | null {
    if (this.port) return this.port;
    try {
      const port = chrome.runtime.connect({ name: "voice" });
      port.onMessage.addListener((m: PortMsg) => this.onMessage(m));
      port.onDisconnect.addListener(() => {
        this.port = null;
        if (this.activeEl) {
          this.activeEl = null;
          this.notify();
        }
      });
      this.port = port;
      return port;
    } catch {
      return null;
    }
  }

  private onMessage(msg: PortMsg): void {
    if (msg.t === "result") {
      // v1 inserts on final results only — interim text would be inserted
      // then duplicated by the final. The interim still keeps the mic in
      // its "listening" state (no UI change needed here).
      if (msg.isFinal && this.activeEl) {
        this.applyTranscript(this.activeEl, msg.transcript.trim());
      }
    } else if (msg.t === "error") {
      this.error = errorMessage(msg.code);
      this.activeEl = null;
      this.notify();
    } else if (msg.t === "end") {
      // Single-utterance recognition finished; drop back to idle.
      this.activeEl = null;
      this.notify();
    }
  }

  private applyTranscript(el: VoiceTarget, text: string): void {
    if (!text) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const { value, caret } = insertAtCaret(el.value, start, end, text);
    el.value = value;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // some input types reject setSelectionRange — harmless
    }
    // Let Svelte's bind:value (and any oninput handlers) see the change.
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Begin dictation into `el`. Re-pointing to a new field mid-stream is
   *  allowed (the offscreen recognizer simply retargets). */
  start(el: VoiceTarget, lang: string): void {
    const port = this.ensurePort();
    if (!port) {
      this.error = errorMessage("unsupported");
      this.notify();
      return;
    }
    this.error = null;
    this.activeEl = el;
    this.notify();
    el.focus();
    port.postMessage({ t: "start", lang: lang || "en-US" });
  }

  /** Stop the current dictation. */
  stop(): void {
    this.port?.postMessage({ t: "stop" });
    if (this.activeEl) {
      this.activeEl = null;
      this.notify();
    }
  }

  /** Toggle dictation for a specific field (mic-button click). */
  toggle(el: VoiceTarget, lang: string): void {
    if (this.activeEl === el) this.stop();
    else this.start(el, lang);
  }

  /** Toggle dictation for whatever text field is focused (Alt+V). Returns
   *  true when it acted on a field, false when nothing was focused. */
  toggleForFocused(lang: string): boolean {
    const el = deepActiveElement();
    if (!isTextField(el)) return false;
    this.toggle(el, lang);
    return true;
  }

  clearError(): void {
    if (this.error !== null) {
      this.error = null;
      this.notify();
    }
  }
}

/** Singleton for this surface. */
export const voice = new VoiceController();
