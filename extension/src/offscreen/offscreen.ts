/// <reference types="chrome" />

// Offscreen document for the Voice Command module (Phase 20).
//
// This is the single place the extension runs the Web Speech API. The
// service worker spawns it on demand and connects over a long-lived
// "voice-offscreen" port; we own the microphone + a SpeechRecognition
// instance and stream transcripts back out. Running here — in the
// EXTENSION origin — means the mic is granted once (via a visible
// extension surface) and reused by the side panel AND any website page,
// with no per-site permission prompts.
//
// Wire (over the port):
//   SW → here:   { t: "start", lang }  |  { t: "stop" }
//   here → SW:   { t: "result", transcript, isFinal }
//                { t: "error", code }  |  { t: "end" }

// SpeechRecognition typings aren't in every TS lib version; treat the
// constructor + events loosely. The capability check below is the guard.
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};

const SR: (new () => SpeechRecognitionLike) | undefined =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).SpeechRecognition ?? (self as any).webkitSpeechRecognition;

const port = chrome.runtime.connect({ name: "voice-offscreen" });

let recognition: SpeechRecognitionLike | null = null;

function stop(): void {
  try {
    recognition?.stop();
  } catch {
    // already stopped / never started
  }
  recognition = null;
}

function start(lang: string): void {
  if (!SR) {
    port.postMessage({ t: "error", code: "unsupported" });
    return;
  }
  stop(); // never run two recognizers at once
  const rec = new SR();
  recognition = rec;
  rec.lang = lang || "en-US";
  rec.continuous = false; // v1: one utterance per activation
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (e: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = e as any;
    let final = "";
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (final.trim()) {
      port.postMessage({ t: "result", transcript: final, isFinal: true });
    } else if (interim.trim()) {
      port.postMessage({ t: "result", transcript: interim, isFinal: false });
    }
  };

  rec.onerror = (e: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    port.postMessage({ t: "error", code: (e as any)?.error ?? "unknown" });
  };

  rec.onend = () => {
    recognition = null;
    port.postMessage({ t: "end" });
  };

  try {
    rec.start();
  } catch {
    recognition = null;
    port.postMessage({ t: "error", code: "start-failed" });
  }
}

port.onMessage.addListener((msg: { t?: string; lang?: string }) => {
  if (msg?.t === "start") start(msg.lang ?? "en-US");
  else if (msg?.t === "stop") stop();
});
