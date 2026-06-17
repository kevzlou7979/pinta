import type {
  Annotation,
  AnnotationTarget,
  AuditCatalogExport,
  AuditCategoryId,
  AuditCategoryResult,
  AuditCheck,
  AuditCheckStatus,
  AuditDisposition,
  AuditOverlay,
  AuditRun,
  ClientMessage,
  ImportedSession,
  ServerMessage,
  Session,
  SessionModule,
  InstalledModule,
  ModulePackage,
  ModuleCapability,
  ModuleBoard,
} from "@pinta/shared";
import {
  BUILTIN_MODULES,
  getModuleSpec,
  manifestToSpec,
  moduleIsConfigured,
  type ModuleSpec,
} from "./modules.js";
import {
  parseReportPayload,
  rangeWindow,
  renderReportMarkdown,
  type ReportRange,
  type ReportRun,
} from "./report.js";
import { WsClient, type WsClientStatus } from "./ws-client.js";
import {
  discoverCompanions,
  type Companion,
} from "./companions.js";
import { findCompanionForUrl, matchAny } from "./url-patterns.js";
import {
  loadByOrigin,
  save as saveLocal,
  clearOrigin as clearLocal,
  originOf,
  getImportedSessions,
  addImportedSession,
  removeImportedSession,
  clearImportedSessions,
} from "./local-store.js";
import { decodePintaFile, decodePintaMarkdown } from "./pinta-file.js";
import { uid } from "./id.js";
import {
  countRedactionPlaceholders,
  redactPii,
  scanCapturedContextForInjection,
} from "./chat-guards.js";
import {
  composeTestDocMarkdown as composeTestDocMarkdownPure,
  composeTesterSheetMarkdown,
  composeTesterSheetDocx,
  composeResultsDocx,
  nextUserTestId as nextUserTestIdPure,
  parseTestDocMarkdown,
} from "./test-pilot-doc.js";
import {
  categoryDisplayName,
  composeAuditFixComment,
  computeCategoryScore,
  mergeAuditRun,
  ratingFromScore,
} from "./audit-flow.js";
import {
  composeAuditCatalog,
  mergeAuditOverlays,
  normalizeAuditOverlay,
} from "./audit-catalog-doc.js";
import {
  composeSettingsBundle,
  type PintaSettingsBundle,
} from "./pinta-settings.js";

const SELECTED_KEY = "pinta-selected-companion";

export type ExtensionMode = "draw" | "select" | "review" | "idle";

/** What the user has done with a test row in the current catalog. */
export type TestPilotStatus = "untested" | "pass" | "fail";

/** A pasted / attached image on a chat message. Inline base64 payload
 *  the agent writes to a tempfile and reads for vision context. Same
 *  shape as `AnnotationImage` minus the placement coords — chat images
 *  don't get placed on the page. */
export type ChatImage = {
  /** `data:image/...;base64,...`. The sender is expected to downscale
   *  before producing this — see ChatSheet's onpaste handler for the
   *  1280px JPEG q=0.85 policy. */
  dataUrl: string;
  /** MIME type. Practically always `image/jpeg` after the resizer. */
  mediaType: string;
  /** Original filename if pasted from a file picker. Optional — most
   *  clipboard pastes are blob-only. */
  name?: string;
};

/** One turn in a per-row chat thread. Phase 14 replaces the static
 *  Notes textarea with this interactive dialogue surface. */
export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  /** Markdown allowed — renders through the same `parseStep` + Prism
   *  pipeline as the detail steps. */
  text: string;
  at: number;
  /** Optional images attached to a user-role message. Currently only
   *  the global tier supports paste; other tiers don't populate this.
   *  Renders as a thumbnail grid below the bubble text. */
  images?: ChatImage[];
  /** Optional annotation-target chip rendered above the bubble text.
   *  Set by the Annotate "Just Ask" sequential-per-annotation flow so
   *  each user bubble shows which DOM element its question is about.
   *  Other chat surfaces (global, Test Pilot) leave this undefined. */
  targetSelector?: string;
  /** Round-trip time in ms, set on agent messages only. Computed as
   *  `Date.now() - previousUserMessage.at` when the reply lands.
   *  Surfaced under the bubble ("12s" / "1.4m"). */
  elapsedMs?: number;
  /** Total tokens reported by the agent for this reply, if available.
   *  The agent may include `usage.totalTokens` in its mark_session_done
   *  payload but the field is optional — older skills / agents without
   *  usage telemetry just omit it and the field stays unset. */
  tokens?: number;
};

/** A single test row in the catalog. */
export type TestPilotTest = {
  id: string;
  test: string;
  expected: string;
  /** Local-only — not part of the agent's catalog JSON. */
  status: TestPilotStatus;
  /** Per-row detail cache, populated when the user clicks "?". */
  detail?: { steps: string[]; askedAt: number };
  /**
   * Per-row chat thread (Phase 14). Replaces the v0.3.x `comment` field
   * — testers can now ask the agent questions about this specific test
   * row in-context, and the agent's replies are stored alongside the
   * questions. Persisted with the catalog via `saveTestPilot()` and
   * exported as a per-section Conversation block. Empty / unset when
   * the user hasn't asked anything yet.
   */
  chat?: ChatMessage[];
};

/** A heading group within the catalog (e.g. "1.1 Authentication"). */
export type TestPilotSection = {
  title: string;
  tests: TestPilotTest[];
  /** Phase 14.7 — section-scoped chat thread. The section chat icon
   *  opens a conversation about the whole section (all its rows are
   *  sent to the agent as context). Persisted with the catalog via
   *  `saveTestPilot()`, same as the per-row `TestPilotTest.chat`.
   *  Empty / unset until the tester asks something. Keyed off the
   *  section title for routing, so it's carried over by-title on
   *  regen (see applyCatalogResult). */
  chat?: ChatMessage[];
};

/** The full catalog extracted from one imported markdown doc. */
export type TestPilotCatalog = {
  docId: string;
  filename: string;
  importedAt: number;
  sections: TestPilotSection[];
  /** Optional human-authored metadata. Editable inline from the
   *  Test Pilot header; preserved across re-imports of the same docId
   *  so the user doesn't have to retype it. Surfaced in the exported
   *  markdown report. */
  title?: string;
  author?: string;
  description?: string;
};

/** In-flight query metadata so we can route the eventual session.synced
 *  to the right Test Pilot slot. */
export type TestPilotPending =
  | { kind: "doc-parse"; sessionId: string; filename: string }
  | { kind: "doc-generate"; sessionId: string; startedAt: number }
  | { kind: "detail-steps"; sessionId: string; testId: string };

/**
 * Top-level connection mode.
 * - `discovering`: first scan in flight, don't render mode-dependent UI yet
 * - `connected`: at least one companion is running; existing WS-driven flow
 * - `standalone`: no companions running anywhere; session lives in IndexedDB,
 *   only Copy is exposed (no agent submit). Designed for testers hitting
 *   deployed URLs who have no project on disk.
 */
export type AppMode = "discovering" | "connected" | "standalone";

/**
 * Repair text that was decoded as Latin-1 / Windows-1252 somewhere
 * upstream when its bytes were actually UTF-8. Symptom seen in agent
 * replies on Windows: French / Spanish accents render as `Ã©`, `Ã `,
 * `Ã§`, etc. — that's the 0xC3 0xXX UTF-8 byte pair being read one
 * byte per character.
 *
 * Heuristic: precheck for the telltale `Ã` + Latin-1-tail pattern.
 * If found, reinterpret each char's low byte as a UTF-8 byte and
 * try to decode (`fatal: true` so we bail on garbage). Only flips
 * to the repaired text if the decode succeeds — otherwise the
 * original is returned unchanged.
 *
 * Conservative on purpose: every char in the input must fit in
 * Latin-1 (charCode ≤ 0xFF) for the round-trip to be meaningful.
 * Mixed strings (some already-good UTF-8 + some mojibake'd) get
 * left alone rather than corrupted further.
 */
/**
 * Heuristic repair for Unicode replacement characters (U+FFFD) that
 * leak through the agent → companion → extension pipeline when a
 * multi-byte UTF-8 character is truncated upstream (most often the
 * em-dash `—` losing its leading byte on Windows stdout — agent emits
 * "row — confirm", a byte drops, decoder substitutes `�`, you see
 * "row � confirm" in the side panel).
 *
 * The bad bytes are gone by the time we see the string — we can't
 * recover the original. But we CAN observe what the agent actually
 * tends to write: a `�` between two word characters with surrounding
 * spaces is almost always an em-dash separator. Other patterns are
 * left alone because guessing wrong would silently rewrite real
 * content. Bare `�` (no spaces) also stays put.
 *
 * Also fires a console warning per call so the underlying transmission
 * bug stays visible — repaired ≠ "no problem".
 */
function repairReplacementChars(s: string): string {
  if (!s.includes("�")) return s;
  // eslint-disable-next-line no-console
  console.warn(
    "[pinta] agent text contained replacement chars (\\uFFFD) — most likely a multi-byte UTF-8 character was truncated upstream. Attempting heuristic repair.",
  );
  // " — " is the only safe substitution. Spaces on both sides + word
  // chars on either side narrow the pattern down to "punctuation
  // separator between phrases" — the em-dash case. Multiple
  // consecutive `�` (rare; happens when two adjacent multi-byte chars
  // both got mangled) collapse to a single em-dash here, which is
  // closer to the agent's likely intent than three pasted `—`s.
  return s.replace(/(\w)\s+�+\s+(\w)/g, "$1 — $2");
}

function repairMojibake(s: string): string {
  // 0xC3 followed by a UTF-8 continuation byte (0x80-0xBF) is the
  // unmistakable signature of mojibake'd Latin codepoints — the
  // leading 0xC3 always renders as the upper-case A-tilde glyph.
  // Use code-unit hex escapes throughout so the regex carries no
  // non-ASCII characters and the class-range syntax is unambiguous
  // (a literal `-` at the start of a class is just a dash, not a
  // range marker — that was the bug in the first cut of this).
  if (!/\xC3[\x80-\xBF]/.test(s)) return s;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return s;
  }
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      bytes[i] = s.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

type ParsedChatReply = {
  payload: { type?: string; reply?: string; [k: string]: unknown } | null;
  replyText: string;
  wasLooseFallback: boolean;
};

/** Lenient parser for the chat surfaces' `mark_session_done` payload.
 *  Per SKILL.md §7.10.3 the agent should return strict JSON shaped like
 *  `{"type":"chat","reply":"<markdown>"}` — but skill versions vary and
 *  models occasionally wrap the envelope in a markdown code fence or
 *  ship a bare prose answer. Rather than strand the user with "couldn't
 *  parse," try three escalating strategies and fall back to using the
 *  raw summary as the reply. Postel's law — show the answer, log the
 *  protocol violation. */
function parseAgentChatReply(summary: string): ParsedChatReply {
  if (!summary) return { payload: null, replyText: "", wasLooseFallback: false };

  const candidates: string[] = [summary];
  const fence = summary.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) candidates.push(fence[1]);
  const firstBrace = summary.indexOf("{");
  const lastBrace = summary.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(summary.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ParsedChatReply["payload"];
      if (parsed && typeof parsed.reply === "string") {
        return {
          payload: parsed,
          replyText: repairReplacementChars(repairMojibake(parsed.reply)),
          wasLooseFallback: false,
        };
      }
    } catch {
      // try next candidate
    }
  }

  console.warn(
    "[pinta] chat agent didn't return a parseable JSON envelope; falling back to raw summary as reply text. Check the skill version. First 200 chars:",
    summary.slice(0, 200),
  );
  return {
    payload: null,
    replyText: repairReplacementChars(repairMojibake(summary.trim())),
    wasLooseFallback: true,
  };
}

/** Best-effort token-count extractor from an agent chat payload.
 *  Accepts the structured `usage.totalTokens` shape (preferred) plus
 *  a couple of common fallbacks (`tokens`, `usage.total_tokens`,
 *  `usage.outputTokens` + `usage.inputTokens`). Returns undefined when
 *  the agent didn't include any usage telemetry. */
function extractTokens(payload: { [k: string]: unknown }): number | undefined {
  if (typeof payload.tokens === "number" && payload.tokens > 0) {
    return payload.tokens;
  }
  const usage = payload.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.totalTokens === "number" && u.totalTokens > 0) return u.totalTokens;
    if (typeof u.total_tokens === "number" && u.total_tokens > 0) return u.total_tokens;
    const inp = typeof u.inputTokens === "number" ? u.inputTokens : 0;
    const out = typeof u.outputTokens === "number" ? u.outputTokens : 0;
    if (inp + out > 0) return inp + out;
  }
  return undefined;
}

function newDraft(url: string): Session {
  return {
    id: crypto.randomUUID(),
    url,
    projectRoot: "",
    startedAt: Date.now(),
    annotations: [],
    status: "drafting",
    producer: "extension",
  };
}

class ExtensionState {
  session = $state<Session | null>(null);
  /**
   * Phase 20 — async batches. Annotation batches the user already
   * submitted that the agent is still applying (status submitted /
   * applying) or has just finished (done / error, shown briefly in the
   * footer tray until dismissed). The active *editable* draft stays in
   * `this.session`; these are detached, agent-owned copies updated by id
   * from `session.synced`. Lets the user keep annotating — even on other
   * pages — while earlier batches apply in the background. Connected mode
   * only (standalone has no agent to apply anything). In-memory: a panel
   * reload drops the tray, but the companion still applies the work.
   */
  inFlightBatches = $state<Session[]>([]);
  mode = $state<ExtensionMode>("idle");
  selectedAnnotationId = $state<string | null>(null);
  connectionStatus = $state<WsClientStatus>("disconnected");
  lastError = $state<string | null>(null);

  /** Phase 18a — soft "still waiting for an agent" notice. Distinct from
   *  `lastError` / the per-surface error slots: a long-queue hint is NOT a
   *  failure, so it renders as an amber warning, not a red error. Keyed by
   *  the waiting session's id so a later claim/clear for that session can
   *  retire it. One at a time — the user waits on one submission at a
   *  time per surface. */
  claimNotice = $state<{ sessionId: string; text: string } | null>(null);

  /** All running companions, refreshed via rescan(). */
  companions = $state<Companion[]>([]);
  /** Which companion this side panel is connected to. */
  selectedCompanion = $state<Companion | null>(null);
  /** True while the first discovery scan is in flight. */
  scanning = $state(false);

  /** Sessions imported from `.pinta` share files. Read-only — viewable
   *  in History, optionally forkable into an editable local session. */
  importedSessions = $state<ImportedSession[]>([]);
  /** When set, the side panel renders a read-only viewer for this
   *  imported session instead of the regular drafting UI. Closing the
   *  viewer (or forking it) clears this back to null. */
  viewingImportedId = $state<string | null>(null);

  /**
   * Per-module enable + settings, persisted to chrome.storage.local under
   * the `pinta-modules` key. Keyed by module id; modules without an entry
   * are treated as disabled with empty settings. The Settings panel
   * mutates this; submit reads from it.
   */
  modules = $state<
    Record<
      string,
      { enabled: boolean; settings: Record<string, string | boolean> }
    >
  >({});
  /**
   * Imported (third-party) modules installed in the active companion's
   * project (`.pinta/modules/`). Phase 19. Fetched from
   * `GET /v1/modules` on companion connect; merged with `BUILTIN_MODULES`
   * everywhere the UI renders module specs (`manifestToSpec`). Companion-
   * scoped — cleared when no companion is selected (standalone).
   */
  installedModules = $state<InstalledModule[]>([]);
  /**
   * Dedicated error banner for import / uninstall failures, shown in the
   * Settings panel with a dismiss X (every error banner in the extension
   * is dismissible — see the Annotate / AuditFlow pattern).
   */
  moduleError = $state<string | null>(null);
  /**
   * Per-session opt-in checkboxes — module ids the user has ticked for
   * the current submit. In-memory only; cleared on each new session so
   * the user always has to consciously opt in (matches the existing
   * `autoApply` / `includeScreenshot` pattern).
   */
  tickedModules = $state<Record<string, boolean>>({});
  /** True when Settings panel is open in the side panel. */
  viewingSettings = $state<boolean>(false);
  /**
   * Visual feedback toggles. `pulse` controls the pink/blue/etc.
   * pulsating glow that surrounds the page edges while the agent is
   * applying a session. Off by default — purely cosmetic.
   * Persisted to chrome.storage.local under `pinta-pulse-settings`.
   */
  pulseSettings = $state<{ enabled: boolean; color: string }>({
    enabled: false,
    color: "#3B82F6",
  });

  /**
   * Test Pilot — interactive module state. The user imports a markdown
   * test spec; the agent extracts a catalog of sections + test rows
   * (via a `kind: "query"` session with `op: "doc-parse"`). Each row
   * can be marked Pass / Fail locally and can be expanded via the
   * "?" button to ask the agent for detailed steps (`op: "detail-steps"`).
   *
   * Persisted to chrome.storage.local under `pinta-test-pilot:current`.
   * `pending` tracks an in-flight query session so the side panel can
   * show loading state and route the eventual `session.synced` back
   * into this slot instead of the annotation draft.
   */
  testPilot = $state<{
    catalog: TestPilotCatalog | null;
    /** Singleton slot for doc-parse / doc-generate. Those are blocking
     *  flows the user sees as a full-panel overlay, so one at a time. */
    pending: TestPilotPending | null;
    /** Concurrent in-flight detail-steps fetches, keyed by testId. The
     *  user can click ? on AUTH-01, go back, click ? on AUTH-02, and
     *  both spinners run side-by-side until the agent answers each. */
    pendingDetails: Record<string, { askedAt: number }>;
    /** Concurrent in-flight chat asks, keyed by testId. Mirrors
     *  `pendingDetails` — multiple rows can have asks in flight at
     *  once, each row's send button drives its own spinner. */
    pendingChats: Record<string, { askedAt: number }>;
    // Phase 14.6 — section-level "Suggest Test". `pendingSectionSuggest`
    // drives the pill spinner (keyed by section title); `sectionSuggestions`
    // holds the agent's returned scenarios for the inline checklist until
    // the user adds or dismisses them. Both transient — NOT persisted.
    pendingSectionSuggest: Record<string, { askedAt: number }>;
    sectionSuggestions: Record<
      string,
      { test: string; expected: string; checked: boolean }[]
    >;
    // Phase 14.7 — in-flight section-chat asks, keyed by section title.
    // Mirrors `pendingChats` (per-row) so a section's send button can
    // spin independently.
    pendingSectionChats: Record<string, { askedAt: number }>;
    error: string | null;
    /** True while the user has an inline edit (section rename, test
     *  title / expected, catalog meta) in flight. Set by the side
     *  panel on `startEditing`, cleared on `commitEdit` / `cancelEdit`.
     *  `applyCatalogResult` bails when this is true so a mid-edit
     *  Generate result doesn't clobber the user's in-progress text. */
    editingActive: boolean;
  }>({ catalog: null, pending: null, pendingDetails: {}, pendingChats: {}, pendingSectionSuggest: {}, sectionSuggestions: {}, pendingSectionChats: {}, error: null, editingActive: false });

  /**
   * Phase 14 — cross-cutting chat state for the two non-Test-Pilot
   * surfaces. Test Pilot per-row threads live inside `testPilot.catalog`
   * already (`tests[].chat[]`); this slot covers the other two:
   *
   * - `global` — one rolling thread for the header chat icon (FAQ-style
   *   asks with no surface context). Capped at CHAT_HISTORY_CAP * 4 (~80
   *   messages) so payload + render stay bounded for long sessions;
   *   `sendGlobalChatMessage` trims the head on overflow.
   * - `annotateBatch` — per-draft-session thread, keyed by sessionId.
   *   When the user ticks "Just Ask" on Annotate's submit footer, the
   *   thread is scoped to the current annotation draft so asking
   *   questions about a batch doesn't leak into other sessions.
   *
   * Pending maps drive per-surface spinners. Errors share the top-level
   * `testPilot.error` slot for now since all chat ops route through the
   * same module.query.submit envelope.
   */
  chat = $state<{
    global: ChatMessage[];
    pendingGlobal: boolean;
    annotateBatch: Record<string, ChatMessage[]>;
    pendingAnnotateBatch: Record<string, boolean>;
    /** Phase 14.5 (Phase D) — per-batch chat-hardening summary from
     *  the most recent send. Surfaced by ChatSheet as a badge above
     *  the input so the user knows the agent is reasoning over
     *  scrubbed context. `counts` is `[REDACTED:<kind>]` occurrences
     *  in the queryComment (token + PII patterns); `injection` is
     *  the list of prompt-injection marker kinds detected. Cleared
     *  on Clear chat. */
    annotateRedactions: Record<
      string,
      { counts: Record<string, number>; injection: string[] }
    >;
    error: string | null;
  }>({
    global: [],
    pendingGlobal: false,
    annotateBatch: {},
    pendingAnnotateBatch: {},
    annotateRedactions: {},
    error: null,
  });

  /** Storage keys for the cross-cutting chat slots. Test Pilot threads
   *  ride inside `pinta-test-pilot:current:<companion>` already. */
  private static readonly GLOBAL_CHAT_KEY = "pinta-global-chat";
  private static readonly ANNOTATE_CHATS_KEY = "pinta-annotate-chats";
  /** Soft cap on the global thread length so localStorage + agent
   *  payload don't grow unbounded across long sessions. */
  private static readonly GLOBAL_CHAT_MAX = 200;

  /** Timer that fires if a Test Pilot query never gets a response —
   *  prevents the "Asking the agent…" spinner from sticking forever
   *  when no `/pinta` skill is listening, or the agent crashed mid-run. */
  private testPilotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-testId timers for concurrent detail fetches. Same purpose as
   *  `testPilotTimer` but one-per-row so each ? can time out
   *  independently. */
  private detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-testId timers for concurrent chat sends. Mirrors
   *  `detailTimers` — keyed by row id so each chat ask times out on
   *  its own clock without stomping a parallel one. */
  private chatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-section-title timers for concurrent section-chat sends (Phase
   *  14.7). Same shape as `chatTimers` but keyed by section title. */
  private sectionChatTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Hard ceiling for any single Test Pilot query (doc-parse or
   *  detail-steps). Generous — long markdown docs take a while — but
   *  bounded. After this we surface a recovery message. */
  private static readonly TEST_PILOT_TIMEOUT_MS = 120_000;
  /** doc-generate is materially slower — the agent reads the whole
   *  project and writes a fresh UAT spec. Bump the ceiling so a
   *  legitimate multi-minute scan isn't killed early. */
  private static readonly TEST_PILOT_GENERATE_TIMEOUT_MS = 600_000;

  /** Extra grace AFTER an op's normal threshold before we treat a wait
   *  as truly stuck and show a red error. A busy / slow `/pinta` agent
   *  is NOT a failure — BYO-Claude work legitimately runs for minutes —
   *  so the normal threshold now only flips us to an amber "still
   *  working" notice (keeping the spinner alive); the red give-up waits
   *  this much longer. See `armAgentWait`. */
  private static readonly AGENT_GIVEUP_GRACE_MS = 600_000; // +10 min
  /** Synthetic `claimNotice.sessionId` tag for the shared slow-agent
   *  amber notice, so it never collides with a real Phase-18a unclaimed
   *  session warning and `retireAgentWaitNotice` can recognise its own. */
  private static readonly AGENT_WAIT_KEY = "__agent-wait__";

  private client: WsClient | null = null;
  private creatingSession = false;
  /** Timer that recovers a stuck `creatingSession = true` if the
   *  companion never echoes back `session.created` / `session.synced`. */
  private creatingSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CREATE_SESSION_TIMEOUT_MS = 10_000;
  private lastUrl: string | null = null;
  /** Origin currently driving the standalone-mode session (IDB key). */
  private currentOrigin: string | null = null;

  /**
   * Origins the user has explicitly opted into standalone mode for via
   * the "Use standalone for this site" button on the associate prompt.
   * Persisted to `chrome.storage.local["pinta-standalone-origins"]` so
   * the preference survives reloads. `rescan()` consults this set
   * BEFORE auto-routing to a companion — without it, a tab on an
   * unknown URL with a single running companion would silently get
   * auto-picked back into that project on every navigation.
   *
   * Explicitly picking a companion from the project picker removes the
   * current origin from the set (the user signaled "I do want this
   * one"), so reverting from standalone is one click away.
   */
  private standaloneOrigins = new Set<string>();
  private static readonly STANDALONE_ORIGINS_KEY = "pinta-standalone-origins";

  /**
   * Top-level connection mode. Standalone whenever no companion is
   * currently selected — covers both "no companions running" (tester
   * case) and "companions exist but none matched this URL" (tester on
   * a URL the dev forgot to register). The picker still appears in the
   * header so the user can associate manually if they want. Distinct
   * from `mode` above which controls the active drawing tool.
   */
  get appMode(): AppMode {
    if (this.selectedCompanion) return "connected";
    if (this.scanning && this.companions.length === 0) return "discovering";
    return "standalone";
  }

  /** True if the active tab's origin has been opt-in pinned to
   *  standalone mode. UI flag — App.svelte uses this to decorate the
   *  picker / show a "managed standalone" hint instead of the normal
   *  associate prompt. */
  get isUrlPinnedStandalone(): boolean {
    const origin = originOf(this.lastUrl);
    return !!origin && this.standaloneOrigins.has(origin);
  }

  /**
   * Begin the extension lifecycle. Discovers companions, picks one
   * (auto via URL pattern, or honoring a previously-stored choice),
   * and opens the WebSocket. Safe to call multiple times — subsequent
   * calls just rescan + re-evaluate.
   */
  async start(activeTabUrl: string | null): Promise<void> {
    this.lastUrl = activeTabUrl;
    // Hydrate imported sessions in parallel with the scan — they live
    // in IndexedDB and don't depend on which companion we land on.
    void this.refreshImported();
    void this.loadModules();
    void this.loadPulseSettings();
    void this.loadStandaloneOrigins();
    void this.loadGlobalChat();
    void this.loadAnnotateChats();
    void this.loadAuditRun();
    void this.loadAuditDispositions();
    void this.loadAuditCheckChats();
    void this.loadAuditFiledIssues();
    void this.loadReportRun();
    void this.loadModuleBoards();
    // Stage the legacy global catalog (if any) for the first companion
    // to claim. The actual per-project load happens inside connectTo.
    void this.readLegacyTestPilot();
    await this.rescan(activeTabUrl);
  }

  // ─── Pulse settings (cosmetic processing-glow on the page edges) ────

  private static readonly PULSE_KEY = "pinta-pulse-settings";

  // ─── Standalone-origin opt-ins ─────────────────────────────────────

  async loadStandaloneOrigins(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.STANDALONE_ORIGINS_KEY,
      );
      const raw = stored?.[ExtensionState.STANDALONE_ORIGINS_KEY] as
        | string[]
        | undefined;
      if (Array.isArray(raw)) {
        this.standaloneOrigins = new Set(
          raw.filter((s): s is string => typeof s === "string"),
        );
      }
    } catch {
      // storage missing — empty set is fine
    }
  }

  private async saveStandaloneOrigins(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.STANDALONE_ORIGINS_KEY]: [
          ...this.standaloneOrigins,
        ],
      });
    } catch {
      // ignore — in-memory set still drives current session behavior
    }
  }

  /**
   * Pin the current URL's origin to standalone mode. Disconnects any
   * active companion + hydrates the local-store session for the origin.
   * Persistent — survives reloads, navigations, and rescans until the
   * user explicitly picks a companion from the project picker (which
   * removes the origin via `select()`).
   */
  async pinCurrentUrlToStandalone(): Promise<void> {
    const origin = originOf(this.lastUrl);
    if (!origin) return;
    this.standaloneOrigins.add(origin);
    void this.saveStandaloneOrigins();
    // Disconnect the active companion so the side panel immediately
    // flips into standalone mode for this tab. Routing on subsequent
    // rescans honors the set so it doesn't snap back.
    await this.connectTo(null);
    await this.hydrateStandalone(this.lastUrl);
  }

  /** Remove the current origin's standalone pin (used implicitly when
   *  the user picks a companion). */
  private unpinOriginFromStandalone(origin: string | null): void {
    if (!origin) return;
    if (this.standaloneOrigins.delete(origin)) {
      void this.saveStandaloneOrigins();
    }
  }

  async loadPulseSettings(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.PULSE_KEY,
      );
      const raw = stored?.[ExtensionState.PULSE_KEY] as
        | { enabled?: boolean; color?: string }
        | undefined;
      if (raw && typeof raw === "object") {
        if (typeof raw.enabled === "boolean") this.pulseSettings.enabled = raw.enabled;
        if (typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color)) {
          this.pulseSettings.color = raw.color;
        }
      }
    } catch {
      // storage missing — defaults stand
    }
  }

  private async savePulseSettings(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.PULSE_KEY]: $state.snapshot(this.pulseSettings),
      });
    } catch {
      // ignore
    }
  }

  setPulseEnabled(enabled: boolean): void {
    this.pulseSettings.enabled = enabled;
    void this.savePulseSettings();
  }

  setPulseColor(hex: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    this.pulseSettings.color = hex;
    void this.savePulseSettings();
  }

  // ─── Test Pilot (interactive module) ───────────────────────────────

  /** Legacy global slot from v0.3.1 and earlier, before catalogs were
   *  scoped per-project. Read once on startup; the first companion the
   *  user connects to after upgrade inherits it (see loadTestPilot).
   *  After migration the key is removed. */
  private static readonly LEGACY_TEST_PILOT_KEY = "pinta-test-pilot:current";

  /** Per-companion storage key. Uses `projectRoot` (stable absolute
   *  path) rather than `port` (ephemeral, reassigned on restart). */
  private static testPilotKeyFor(companion: Companion): string {
    return `pinta-test-pilot:${companion.projectRoot}`;
  }

  /** Holds the legacy catalog between `readLegacyTestPilot` (called from
   *  `start`) and the first `loadTestPilot(companion)` call that claims
   *  it. Null afterwards. */
  private legacyTestPilotCatalog: TestPilotCatalog | null = null;

  /** Walk a catalog and convert pre-Phase 14 `comment` strings into
   *  seeded chat threads with one user-role message each. Mutates in
   *  place. Removes `comment` after migration so re-running this is a
   *  no-op. Phase 14 dropped the static Notes field in favor of an
   *  interactive per-row chat thread; this preserves notes typed
   *  under the prior version. */
  private static migrateCommentsToChat(catalog: TestPilotCatalog): void {
    if (!Array.isArray(catalog.sections)) return;
    for (const section of catalog.sections) {
      if (!Array.isArray(section.tests)) continue;
      for (const test of section.tests) {
        // Legacy field — typed as the old TestPilotTest.comment; not
        // declared on the new type, so reach for it via index access.
        const legacy = (test as unknown as { comment?: string }).comment;
        if (typeof legacy === "string" && legacy.trim() !== "") {
          if (!Array.isArray(test.chat) || test.chat.length === 0) {
            test.chat = [
              {
                id: crypto.randomUUID(),
                role: "user",
                text: legacy,
                at: catalog.importedAt ?? Date.now(),
              },
            ];
          }
        }
        delete (test as unknown as { comment?: string }).comment;
      }
    }
  }

  /** Read the pre-v0.3.2 global catalog slot, if any. Doesn't write to
   *  state.testPilot — just stages it for the first connectTo to claim. */
  private async readLegacyTestPilot(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.LEGACY_TEST_PILOT_KEY,
      );
      const raw = stored?.[ExtensionState.LEGACY_TEST_PILOT_KEY] as
        | TestPilotCatalog
        | undefined;
      if (raw && typeof raw === "object" && Array.isArray(raw.sections)) {
        this.legacyTestPilotCatalog = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  /** Wipe in-memory Test Pilot state. Used when switching companions or
   *  dropping into standalone — the previous project's catalog, pending
   *  fetches, timers, and error all belong to that project, not this
   *  one. Persisted catalog is untouched (lives in chrome.storage). */
  private resetTestPilotState(): void {
    for (const id of Object.keys(this.testPilot.pendingDetails)) {
      this.clearDetailTimer(id);
    }
    for (const id of Object.keys(this.testPilot.pendingChats)) {
      this.clearChatTimer(id);
    }
    this.clearTestPilotTimeout();
    this.testPilot.catalog = null;
    this.testPilot.pending = null;
    this.testPilot.pendingDetails = {};
    this.testPilot.pendingChats = {};
    this.testPilot.error = null;
  }

  /** Hydrate Test Pilot state for the given companion. Pass null to
   *  enter standalone (clears state, no load). Idempotent. */
  async loadTestPilot(companion: Companion | null): Promise<void> {
    this.resetTestPilotState();
    if (!companion) return;
    const key = ExtensionState.testPilotKeyFor(companion);
    try {
      const stored = await chrome.storage?.local?.get(key);
      const raw = stored?.[key] as TestPilotCatalog | undefined;
      if (raw && typeof raw === "object" && Array.isArray(raw.sections)) {
        // One-shot migration: pre-Phase 14 catalogs persisted a static
        // `comment` field per row. Seed the new `chat` thread with a
        // single user-role message so the tester's notes aren't lost
        // when the field disappears in this version. Idempotent —
        // running again on a migrated catalog is a no-op because
        // `comment` is gone after the first pass.
        ExtensionState.migrateCommentsToChat(raw);
        this.testPilot.catalog = raw;
        // Overlay the per-author results sidecar from disk. Disk wins
        // on conflict — it's the durable source of truth. No-op when
        // the file doesn't exist (fresh catalog, no marks yet) or
        // when there's no companion (standalone). Fire-and-forget so
        // the panel can render the cached catalog immediately and
        // the overlay refines it once the network round-trip lands.
        void this.loadResultsFromCompanion();
        return;
      }
      // Legacy migration — the first companion picked after upgrade
      // inherits the pre-v0.3.2 global catalog. After this runs the
      // legacy key is gone and subsequent companion switches just see
      // empty state until they import their own.
      if (this.legacyTestPilotCatalog) {
        this.testPilot.catalog = this.legacyTestPilotCatalog;
        this.legacyTestPilotCatalog = null;
        await chrome.storage?.local?.set({
          [key]: $state.snapshot(this.testPilot.catalog),
        });
        await chrome.storage?.local?.remove(
          ExtensionState.LEGACY_TEST_PILOT_KEY,
        );
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  /**
   * Returns true if a storage error is the chrome.storage.local quota
   * being exceeded. Chrome throws an Error with `QuotaExceededError`
   * in the message string; Firefox + the DOMException variant carry
   * `name === "QuotaExceededError"`. Match either.
   */
  private static isQuotaExceeded(err: unknown): boolean {
    if (!err) return false;
    const e = err as { name?: string; message?: string };
    if (e.name === "QuotaExceededError") return true;
    return typeof e.message === "string"
      ? /quota.*exceed|QUOTA_BYTES/i.test(e.message)
      : false;
  }

  private async saveTestPilot(): Promise<void> {
    const companion = this.selectedCompanion;
    // Standalone has no project context to scope this catalog to.
    // Mutations from the UI shouldn't reach here in standalone (the
    // empty state hides the import/generate affordances), but if they
    // do, drop the write silently rather than leaking back into the
    // legacy global slot.
    if (!companion) return;
    const key = ExtensionState.testPilotKeyFor(companion);
    try {
      if (this.testPilot.catalog) {
        await chrome.storage?.local?.set({
          [key]: $state.snapshot(this.testPilot.catalog),
        });
      } else {
        await chrome.storage?.local?.remove(key);
      }
    } catch (err) {
      // Quota exceeded is the failure mode most likely to surprise
      // users — silent loss of their Pass/Fail marks because chrome
      // ran out of room. Surface it so they know what to clear.
      // The on-disk markdown is the recovery path (Phase 13 disk
      // sync writes status into the Result column on every change).
      if (ExtensionState.isQuotaExceeded(err)) {
        this.testPilot.error =
          "Browser storage is full — Test Pilot couldn't save your latest change. " +
          "Most likely cause: global chat with image attachments. " +
          "Try clearing global chat (header icon → … or via DevTools: chrome.storage.local.remove('pinta-global-chat')). " +
          "Your catalog structure + Pass/Fail marks are still safe on disk at .pinta/test-docs/.";
      }
    }
  }

  /**
   * User imported a markdown test doc. Fire a one-shot
   * `module.query.submit` carrying the raw doc; the companion creates
   * a fresh ephemeral session, attaches a `kind: "query"` annotation
   * with the JSON-encoded request, and extracts the content to
   * `.pinta/test-docs/{docId}.md` for the agent to read. When the
   * agent calls `mark_session_done(id, payload)`, `onMessage` routes
   * the eventual `session.synced` into `testPilot.catalog`.
   */
  /**
   * Ask the agent to generate a fresh UAT markdown spec for the whole
   * app from project context, then return the parsed catalog. Same
   * result shape as importTestDoc — just no markdown to upload.
   */
  async generateTestDoc(): Promise<void> {
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use Test Pilot.";
      return;
    }
    // Reuse the existing catalog's docId so the agent overwrites
    // `.pinta/test-docs/{docId}.md` in place — the file becomes a
    // maintained artifact across spec revisions. A fresh UUID is minted
    // only on the first generate (no prior catalog).
    const docId = this.testPilot.catalog?.docId ?? crypto.randomUUID();
    const url = this.lastUrl ?? "";
    this.testPilot.error = null;
    this.testPilot.pending = {
      kind: "doc-generate",
      sessionId: "",
      startedAt: Date.now(),
    };
    this.armTestPilotTimeout();
    const queryComment = JSON.stringify({ op: "generate-doc", docId });
    const settings = this.modules["test-pilot"]?.settings ?? {};
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  async importTestDoc(filename: string, content: string): Promise<void> {
    // Standalone branch — no companion, no agent. Parse the markdown
    // locally so external testers can open a developer-shipped tester
    // sheet and walk through it without needing a Claude Code terminal
    // running. Falls through to the agent-assisted path when connected
    // because the agent's parse handles edge cases (free-form spec
    // formats, fix-ups, deduping) that the local parser doesn't.
    if (!this.client || this.connectionStatus !== "connected") {
      const parsed = parseTestDocMarkdown(filename, content);
      if (!parsed) {
        this.testPilot.error =
          "Couldn't read this file — does it look like a Pinta test sheet? Expected `# Title`, `## Section`, and a `| ID | Test | Expected | Result |` table per section.";
        return;
      }
      // Reuse the existing catalog's docId on re-import so any per-doc
      // disk artifacts stay anchored.
      if (this.testPilot.catalog?.docId) parsed.docId = this.testPilot.catalog.docId;
      this.testPilot.catalog = parsed;
      this.testPilot.pending = null;
      this.testPilot.error = null;
      void this.saveTestPilot();
      return;
    }
    // Same rationale as generateTestDoc — reuse the existing docId so a
    // re-import overwrites `.pinta/test-docs/{docId}.md` in place. The
    // companion's `extractTestDocContent` writes the new content; with
    // a stable docId, no orphan files accumulate.
    const docId = this.testPilot.catalog?.docId ?? crypto.randomUUID();
    const url = this.lastUrl ?? "";
    this.testPilot.error = null;
    this.testPilot.pending = { kind: "doc-parse", sessionId: "", filename };
    this.armTestPilotTimeout();
    const queryComment = JSON.stringify({
      op: "doc-parse",
      docId,
      filename,
      content,
    });
    const settings = this.modules["test-pilot"]?.settings ?? {};
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  /**
   * User clicked the "?" on a test row in the catalog. Fire another
   * query session with `op: "detail-steps"` and the test id.
   *
   * `overrideDetailedSteps` lets the detail view's inline "Details"
   * checkbox flip verbosity per re-ask without permanently changing
   * the module-wide setting. Pass undefined (default) to honor the
   * module's `detailed_steps` setting verbatim.
   */
  async fetchDetailSteps(
    testId: string,
    opts: { overrideDetailedSteps?: boolean } = {},
  ): Promise<void> {
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use Test Pilot.";
      return;
    }
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    // Already in flight — don't double-submit (e.g. user clicked ? while
    // the spinner was still running on that same row).
    if (this.testPilot.pendingDetails[testId]) return;
    let section: TestPilotSection | null = null;
    for (const s of catalog.sections) {
      if (s.tests.some((t) => t.id === testId)) {
        section = s;
        break;
      }
    }
    if (!section) return;
    const url = this.lastUrl ?? "";
    this.testPilot.error = null;
    this.testPilot.pendingDetails[testId] = { askedAt: Date.now() };
    this.armDetailTimeout(testId);
    // Compute the effective verbosity for this specific call. Overrides
    // win; otherwise honor the module-wide setting.
    const baseSettings = this.modules["test-pilot"]?.settings ?? {};
    const effectiveDetailed =
      opts.overrideDetailedSteps !== undefined
        ? opts.overrideDetailedSteps
        : baseSettings.detailed_steps === true;
    // Carry the verbosity in BOTH the queryComment AND the module
    // settings. The queryComment is the canonical per-call signal the
    // agent reads first (single-place lookup, can't drift if the agent
    // misses the deeper modules[].settings path). modules[].settings
    // keeps backward-compat with the original wire contract.
    const queryComment = JSON.stringify({
      op: "detail-steps",
      docId: catalog.docId,
      testId,
      sectionTitle: section.title,
      detailedSteps: effectiveDetailed,
    });
    const settings: Record<string, string | boolean> = {
      ...baseSettings,
      detailed_steps: effectiveDetailed,
    };
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  /** Cancel an in-flight detail fetch (user clicked Cancel under the
   *  spinner). Removes the entry and clears its timer. */
  cancelDetailFetch(testId: string): void {
    if (!this.testPilot.pendingDetails[testId]) return;
    this.clearDetailTimer(testId);
    delete this.testPilot.pendingDetails[testId];
  }

  private armDetailTimeout(testId: string): void {
    this.clearDetailTimer(testId);
    this.armAgentWait({
      softMs: ExtensionState.TEST_PILOT_TIMEOUT_MS,
      what: `get steps for ${testId}`,
      setHandle: (t) => this.detailTimers.set(testId, t),
      stillPending: () => !!this.testPilot.pendingDetails[testId],
      giveUp: () => {
        delete this.testPilot.pendingDetails[testId];
        this.detailTimers.delete(testId);
        this.testPilot.error = ExtensionState.slowWaitGiveUp(
          `get steps for ${testId}`,
        );
      },
    });
  }

  private clearDetailTimer(testId: string): void {
    const t = this.detailTimers.get(testId);
    if (t) {
      clearTimeout(t);
      this.detailTimers.delete(testId);
    }
    this.retireAgentWaitNotice();
  }

  /** User clicked Cancel on a stuck Test Pilot spinner. */
  cancelTestPilotPending(): void {
    if (!this.testPilot.pending) return;
    this.clearTestPilotTimeout();
    this.testPilot.pending = null;
    this.testPilot.error = "Cancelled.";
  }

  /**
   * Arm a fresh timeout for the current `testPilot.pending`. If it
   * fires, the user gets a recovery message explaining the most
   * common cause (no `/pinta` agent listening). doc-generate uses a
   * much longer ceiling because a full-app scan is legitimately slow.
   */
  private armTestPilotTimeout(): void {
    this.clearTestPilotTimeout();
    const pending = this.testPilot.pending;
    if (!pending) return;
    const softMs =
      pending.kind === "doc-generate"
        ? ExtensionState.TEST_PILOT_GENERATE_TIMEOUT_MS
        : ExtensionState.TEST_PILOT_TIMEOUT_MS;
    const what =
      pending.kind === "doc-parse"
        ? "parse the test doc"
        : pending.kind === "doc-generate"
          ? "generate the test spec"
          : "get the test steps";
    this.armAgentWait({
      softMs,
      what,
      setHandle: (t) => {
        this.testPilotTimer = t;
      },
      stillPending: () => !!this.testPilot.pending,
      giveUp: () => {
        if (!this.testPilot.pending) return;
        this.testPilot.pending = null;
        this.testPilot.error = ExtensionState.slowWaitGiveUp(what);
      },
    });
  }

  private clearTestPilotTimeout(): void {
    if (this.testPilotTimer) {
      clearTimeout(this.testPilotTimer);
      this.testPilotTimer = null;
    }
    this.retireAgentWaitNotice();
  }

  // ─── Slow-agent-aware waits (shared across all modules) ─────────────
  //
  // A slow or busy `/pinta` agent is NOT a failure: bring-your-own-Claude
  // work can legitimately take minutes, and the agent is often actively
  // applying changes when the old single-stage timers fired a red error.
  // So EVERY wait on an agent is now two-stage:
  //   • soft (the op's normal threshold): keep the spinner alive and
  //     surface an amber "still working" notice via `claimNotice` — the
  //     same banner Phase 18a renders across tabs. We tear nothing down;
  //     the user can Cancel anytime.
  //   • hard (soft + AGENT_GIVEUP_GRACE_MS): only now treat it as stuck —
  //     run `giveUp()`, which clears the pending spinner and sets the
  //     surface's red error.
  // The eventual `session.synced` cancels the timer (via the caller's
  // clear*()) and retires the amber notice before either stage matters.

  private static slowWaitNotice(what: string): string {
    return (
      `Still working — the agent is taking a while to ${what}. ` +
      `A busy \`/pinta\` terminal is normal, so this keeps waiting. ` +
      `Cancel and retry if your terminal looks idle.`
    );
  }

  private static slowWaitGiveUp(what: string): string {
    return (
      `Gave up waiting for the agent to ${what}. ` +
      `Make sure \`/pinta\` is running in a Claude Code terminal for this ` +
      `project, then try again.`
    );
  }

  /**
   * Arm a two-stage, slow-agent-aware timer. `setHandle` stores the
   * currently-live timer into the caller's own slot (a field or a Map
   * entry) so the caller's existing clear*() cancels whichever stage is
   * active. `stillPending` is re-checked at fire time so a response that
   * already landed makes both stages no-ops. `what` names the operation
   * for the amber + red copy; `giveUp` does the hard teardown.
   */
  private armAgentWait(opts: {
    softMs: number;
    what: string;
    setHandle: (t: ReturnType<typeof setTimeout>) => void;
    stillPending: () => boolean;
    giveUp: () => void;
  }): void {
    const { softMs, what, setHandle, stillPending, giveUp } = opts;
    const soft = setTimeout(() => {
      if (!stillPending()) return;
      // Soft stage — reassure, do NOT tear anything down.
      this.claimNotice = {
        sessionId: ExtensionState.AGENT_WAIT_KEY,
        text: ExtensionState.slowWaitNotice(what),
      };
      const hard = setTimeout(() => {
        if (!stillPending()) return;
        this.retireAgentWaitNotice();
        giveUp();
      }, ExtensionState.AGENT_GIVEUP_GRACE_MS);
      setHandle(hard);
    }, softMs);
    setHandle(soft);
  }

  /** Retire the shared slow-agent amber notice. Scoped by the synthetic
   *  key so it never clobbers a real Phase-18a unclaimed-session warning.
   *  Called from every clear*() so success / cancel paths drop it. */
  private retireAgentWaitNotice(): void {
    if (this.claimNotice?.sessionId === ExtensionState.AGENT_WAIT_KEY) {
      this.claimNotice = null;
    }
  }

  /**
   * Fetch with a hard timeout via AbortController. Without this, a
   * hung companion (FD-leak, blocked event loop, antivirus stalling
   * the socket) wedges every caller's UI spinner forever.
   */
  private static async fetchWithTimeout(
    input: RequestInfo,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = 8_000, ...rest } = init;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(input, { ...rest, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Centralized setter for `creatingSession` that pairs the flag with a
   * recovery timer. When set true, schedules a 10s fallback that clears
   * the flag and surfaces an error — guards against the wedge where
   * the companion is reachable but never echoes back `session.created`
   * (e.g. mid-crash, broken pipe).
   */
  private markCreatingSession(active: boolean, reason?: string): void {
    if (this.creatingSessionTimer) {
      clearTimeout(this.creatingSessionTimer);
      this.creatingSessionTimer = null;
    }
    this.creatingSession = active;
    if (!active) return;
    this.creatingSessionTimer = setTimeout(() => {
      if (!this.creatingSession) return;
      this.creatingSession = false;
      this.creatingSessionTimer = null;
      this.lastError =
        reason ??
        "Couldn't start a session — the companion didn't respond. Check that pinta-companion is running.";
    }, ExtensionState.CREATE_SESSION_TIMEOUT_MS);
  }

  setTestStatus(testId: string, status: TestPilotStatus): void {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          t.status = status;
          void this.saveTestPilot();
          // Two disk writes per status change:
          //  - .md gets the Result column updated so the spec stays a
          //    human-readable sign-off artifact and re-imports recover
          //    via the agent's doc-parse handler.
          //  - .results.{author}.json is the per-author durable store
          //    that survives chrome.storage loss AND keeps each
          //    tester's marks isolated from others'.
          this.pushTestDocToCompanion();
          this.pushResultsToCompanion();
          return;
        }
      }
    }
  }

  // ─── Phase 14 — chat (per-row interactive dialogue with the agent) ──
  //
  // Replaces the v0.3.x Notes textarea. Each test row carries an
  // optional `chat: ChatMessage[]` thread; the tester sends a prompt,
  // the agent answers in markdown (same `parseStep` + Prism render
  // pipeline as detail-steps), and the exchange persists with the
  // catalog. Concurrent across rows — multiple rows can have asks in
  // flight at the same time, mirroring the `pendingDetails` pattern.

  /** Hard ceiling on the history we ship back to the agent. Keeps the
   *  payload bounded for long-running conversations. */
  private static readonly CHAT_HISTORY_CAP = 12;

  /**
   * Send a chat prompt for one test row. Optimistically appends the
   * user message to `test.chat`, persists, and fires a
   * `module.query.submit` with `op: "chat"` carrying the row context
   * + recent history. The eventual `session.synced` is routed to
   * `handleChatSync(session, testId)` via the queryOp branch in
   * `onMessage`.
   *
   * No-op if the catalog or row is gone, the companion isn't
   * connected, or another chat is already in flight for this testId
   * (don't double-submit). The pending UI keys off
   * `testPilot.pendingChats[testId]` for per-row spinner state.
   */
  async sendChatMessage(
    testId: string,
    prompt: string,
    images: ChatImage[] = [],
  ): Promise<void> {
    const text = prompt.trim();
    // Allow image-only sends — a pasted screenshot + Send ("is this
    // right?") is a valid ask. Bail only when both fields are empty.
    if (!text && images.length === 0) return;
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    if (this.testPilot.pendingChats[testId]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use chat.";
      return;
    }
    let section: TestPilotSection | null = null;
    let test: TestPilotTest | null = null;
    for (const s of catalog.sections) {
      for (const t of s.tests) {
        if (t.id === testId) {
          section = s;
          test = t;
          break;
        }
      }
      if (test) break;
    }
    if (!section || !test) return;

    // Optimistically append the user's message + persist. The send is
    // fire-and-forget over WS; the agent's reply lands via
    // session.synced and gets routed to handleChatSync.
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    };
    test.chat = [...(test.chat ?? []), userMsg];
    this.testPilot.error = null;
    void this.saveTestPilot();
    // Persist optimistically to the per-author sidecar — if the user
    // closes the panel before the agent replies, the question still
    // survives a chrome.storage wipe.
    this.pushResultsToCompanion();

    // Cap history so payloads stay bounded for long threads. Last
    // N messages including the just-appended user prompt.
    const history = (test.chat ?? []).slice(-ExtensionState.CHAT_HISTORY_CAP);
    const url = this.lastUrl ?? "";
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    const queryComment = JSON.stringify({
      op: "chat",
      docId: catalog.docId,
      testId,
      prompt: text,
      context: {
        kind: "test-detail",
        title: test.test,
        expected: test.expected,
        sectionTitle: section.title,
        status: test.status,
        steps: test.detail?.steps,
        detailedResponses,
      },
      // History strips images to bounded `[N image]` placeholders; the
      // agent re-receives only the latest attachments via top-level
      // `images`. Mirrors sendGlobalChatMessage.
      history: history.map((m) => ({
        role: m.role,
        text: m.text + (m.images?.length ? ` [${m.images.length} image]` : ""),
      })),
      ...(images.length > 0 ? { images } : {}),
    });
    const settings = this.modules["test-pilot"]?.settings ?? {};
    this.testPilot.pendingChats[testId] = { askedAt: Date.now() };
    this.armChatTimeout(testId);
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Phase 14.6 — section-level "Suggest Test". The user clicks the
  // "Suggest Test" pill on a section header; the agent inspects the
  // spec + app for coverage gaps *within that section's theme* and
  // returns new scenarios. They render in an inline checklist under
  // the header; ticked rows land as USER-N tests via addTestPilotTests
  // (the same commit path as the per-row chat "Add N" affordance).
  //
  // Routing key is the section title (not a testId): op "suggest-tests"
  // with a top-level `sectionTitle`, handled by handleSuggestSync.
  // Agent handler: SKILL.md §7.10.4.
  // ────────────────────────────────────────────────────────────────

  /** Ask the agent for additional test scenarios for one section. */
  async requestSectionSuggestions(sectionTitle: string): Promise<void> {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    if (this.testPilot.pendingSectionSuggest[sectionTitle]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to suggest tests.";
      return;
    }
    const section = catalog.sections.find((s) => s.title === sectionTitle);
    if (!section) return;

    const existing = section.tests.map((t) => ({
      id: t.id,
      test: t.test,
      expected: t.expected,
    }));
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    const queryComment = JSON.stringify({
      op: "suggest-tests",
      docId: catalog.docId,
      sectionTitle,
      existing,
      count: 6,
      detailedResponses,
    });
    const settings = this.modules["test-pilot"]?.settings ?? {};

    this.testPilot.pendingSectionSuggest[sectionTitle] = {
      askedAt: Date.now(),
    };
    // Drop any stale prior suggestions so the panel doesn't flash old
    // picks while the new request is in flight.
    delete this.testPilot.sectionSuggestions[sectionTitle];
    this.testPilot.error = null;
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  /** Handle a suggest-tests session.synced. Parses the agent's
   *  structured suggestion list and stashes it for the inline
   *  checklist keyed by sectionTitle. Mirrors handleChatSync. */
  private handleSuggestSync(session: Session, sectionTitle: string): void {
    if (session.status === "done") {
      delete this.testPilot.pendingSectionSuggest[sectionTitle];
      const summary = session.appliedSummary ?? "";
      let items: { test: string; expected: string }[] = [];
      try {
        const payload = JSON.parse(summary) as {
          type?: string;
          suggestions?: { test?: string; expected?: string }[];
        };
        if (Array.isArray(payload.suggestions)) {
          items = payload.suggestions
            .map((s) => ({
              test: (s.test ?? "").trim(),
              expected: (s.expected ?? "").trim(),
            }))
            .filter((s) => s.test.length > 0);
        }
      } catch {
        // Fall back to the markdown suggestion parser (the same shape
        // the per-row chat "Add N" button uses) so a prose reply that
        // skipped the JSON envelope still yields rows.
        // Malformed JSON envelope — leave items empty; the
        // "no suggestions" branch below surfaces a retry hint.
        items = [];
      }
      if (items.length === 0) {
        this.testPilot.error = `No new test suggestions came back for "${sectionTitle}".`;
        return;
      }
      this.testPilot.sectionSuggestions[sectionTitle] = items.map((it) => ({
        ...it,
        checked: true,
      }));
    } else if (session.status === "error") {
      delete this.testPilot.pendingSectionSuggest[sectionTitle];
      this.testPilot.error =
        session.errorMessage ?? "Suggestion request failed.";
    }
  }

  /** Add the ticked suggestions for a section as USER-N rows, then
   *  clear the inline panel. */
  addCheckedSuggestions(sectionTitle: string): void {
    const list = this.testPilot.sectionSuggestions[sectionTitle];
    if (!list) return;
    const picked = list
      .filter((s) => s.checked)
      .map((s) => ({ test: s.test, expected: s.expected }));
    if (picked.length > 0) {
      this.addTestPilotTests(sectionTitle, picked);
    }
    delete this.testPilot.sectionSuggestions[sectionTitle];
  }

  /** Discard the inline suggestion panel without adding anything. */
  dismissSectionSuggestions(sectionTitle: string): void {
    delete this.testPilot.sectionSuggestions[sectionTitle];
  }

  // ────────────────────────────────────────────────────────────────
  // Phase 14.7 — section-scoped chat. Mirrors the per-row chat
  // (`sendChatMessage` / `handleChatSync` / `applyChatResult`) but the
  // thread lives on `TestPilotSection.chat` and the agent gets ALL the
  // section's rows as context (kind: "test-section"). Routed by section
  // title since there's no testId. Agent handler: SKILL.md §7.10.3d.
  // ────────────────────────────────────────────────────────────────

  /** Send a chat prompt scoped to a whole section. */
  async sendSectionChatMessage(
    sectionTitle: string,
    prompt: string,
    images: ChatImage[] = [],
  ): Promise<void> {
    const text = prompt.trim();
    if (!text && images.length === 0) return;
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    if (this.testPilot.pendingSectionChats[sectionTitle]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use chat.";
      return;
    }
    const section = catalog.sections.find((s) => s.title === sectionTitle);
    if (!section) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    };
    section.chat = [...(section.chat ?? []), userMsg];
    this.testPilot.error = null;
    void this.saveTestPilot();
    this.pushResultsToCompanion();

    const history = (section.chat ?? []).slice(
      -ExtensionState.CHAT_HISTORY_CAP,
    );
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    const queryComment = JSON.stringify({
      op: "chat",
      docId: catalog.docId,
      sectionTitle,
      prompt: text,
      context: {
        kind: "test-section",
        sectionTitle,
        tests: section.tests.map((t) => ({
          id: t.id,
          test: t.test,
          expected: t.expected,
          status: t.status,
        })),
        detailedResponses,
      },
      history: history.map((m) => ({
        role: m.role,
        text: m.text + (m.images?.length ? ` [${m.images.length} image]` : ""),
      })),
      ...(images.length > 0 ? { images } : {}),
    });
    const settings = this.modules["test-pilot"]?.settings ?? {};
    this.testPilot.pendingSectionChats[sectionTitle] = { askedAt: Date.now() };
    this.armSectionChatTimeout(sectionTitle);
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  /** Wipe a section's chat thread. Persists. */
  clearSectionChat(sectionTitle: string): void {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    const section = catalog.sections.find((s) => s.title === sectionTitle);
    if (section?.chat && section.chat.length > 0) {
      delete section.chat;
      void this.saveTestPilot();
    }
  }

  private armSectionChatTimeout(sectionTitle: string): void {
    this.clearSectionChatTimer(sectionTitle);
    this.armAgentWait({
      softMs: ExtensionState.TEST_PILOT_TIMEOUT_MS,
      what: `answer for "${sectionTitle}"`,
      setHandle: (t) => this.sectionChatTimers.set(sectionTitle, t),
      stillPending: () => !!this.testPilot.pendingSectionChats[sectionTitle],
      giveUp: () => {
        delete this.testPilot.pendingSectionChats[sectionTitle];
        this.sectionChatTimers.delete(sectionTitle);
        this.testPilot.error = ExtensionState.slowWaitGiveUp(
          `answer for "${sectionTitle}"`,
        );
      },
    });
  }

  private clearSectionChatTimer(sectionTitle: string): void {
    const t = this.sectionChatTimers.get(sectionTitle);
    if (t) {
      clearTimeout(t);
      this.sectionChatTimers.delete(sectionTitle);
    }
    this.retireAgentWaitNotice();
  }

  /** Routed from `onMessage` when a `session.synced` with `op: "chat"`
   *  and no testId (a section-scoped ask) arrives. Appends the reply as
   *  an agent-role message on the section's thread. */
  private handleSectionChatSync(
    session: Session,
    sectionTitle: string,
  ): void {
    const hadPending = !!this.testPilot.pendingSectionChats[sectionTitle];
    if (session.status === "done") {
      this.clearSectionChatTimer(sectionTitle);
      const summary = session.appliedSummary ?? "";
      const { payload, replyText } = parseAgentChatReply(summary);
      const reply =
        (payload && typeof payload.reply === "string"
          ? payload.reply
          : replyText) ?? "";
      if (reply) {
        this.applySectionChatResult(sectionTitle, reply, payload ?? {});
      } else {
        this.testPilot.error = "Agent returned an empty response.";
      }
      if (hadPending)
        delete this.testPilot.pendingSectionChats[sectionTitle];
    } else if (session.status === "error") {
      this.clearSectionChatTimer(sectionTitle);
      this.testPilot.error =
        session.errorMessage ?? `Chat query failed for "${sectionTitle}".`;
      if (hadPending)
        delete this.testPilot.pendingSectionChats[sectionTitle];
    }
  }

  /** Append an agent reply to a section's chat thread + persist. */
  private applySectionChatResult(
    sectionTitle: string,
    reply: string,
    payload: { [k: string]: unknown },
  ): void {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    const section = catalog.sections.find((s) => s.title === sectionTitle);
    if (!section) return;
    const cleaned = repairReplacementChars(repairMojibake(reply));
    const lastUser = [...(section.chat ?? [])]
      .reverse()
      .find((m) => m.role === "user");
    const now = Date.now();
    const agentMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "agent",
      text: cleaned,
      at: now,
      elapsedMs: lastUser ? now - lastUser.at : undefined,
      tokens: extractTokens(payload),
    };
    section.chat = [...(section.chat ?? []), agentMsg];
    this.testPilot.error = null;
    void this.saveTestPilot();
    this.pushResultsToCompanion();
  }

  /** Cancel an in-flight chat send (rarely needed in UI — single
   *  message at a time per row — but mirrors `cancelDetailFetch` for
   *  symmetry and stuck-spinner recovery). */
  cancelChatSend(testId: string): void {
    if (!this.testPilot.pendingChats[testId]) return;
    this.clearChatTimer(testId);
    delete this.testPilot.pendingChats[testId];
  }

  /** Wipe a row's chat thread. Persists. */
  clearChat(testId: string): void {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          if (t.chat && t.chat.length > 0) {
            delete t.chat;
            void this.saveTestPilot();
          }
          return;
        }
      }
    }
  }

  private armChatTimeout(testId: string): void {
    this.clearChatTimer(testId);
    this.armAgentWait({
      softMs: ExtensionState.TEST_PILOT_TIMEOUT_MS,
      what: `answer for ${testId}`,
      setHandle: (t) => this.chatTimers.set(testId, t),
      stillPending: () => !!this.testPilot.pendingChats[testId],
      giveUp: () => {
        delete this.testPilot.pendingChats[testId];
        this.chatTimers.delete(testId);
        this.testPilot.error = ExtensionState.slowWaitGiveUp(
          `answer for ${testId}`,
        );
      },
    });
  }

  private clearChatTimer(testId: string): void {
    const t = this.chatTimers.get(testId);
    if (t) {
      clearTimeout(t);
      this.chatTimers.delete(testId);
    }
    this.retireAgentWaitNotice();
  }

  /** Apply a `test-pilot-chat` payload from the agent. Appends the
   *  reply as an agent-role message on the matching row's thread.
   *
   *  `fallbackTestId` is the testId already pulled from the original
   *  queryComment (passed in by `handleChatSync`). The agent's reply
   *  SHOULD echo `testId` per SKILL.md §7.10.3a, but historically some
   *  agent versions omit it. The fallback prevents a silently-dropped
   *  reply when the agent's payload only carries `type` + `reply`.
   */
  private applyChatResult(
    payload: { [k: string]: unknown },
    fallbackTestId?: string,
  ): void {
    const payloadTestId =
      typeof payload.testId === "string" ? payload.testId : null;
    const testId = payloadTestId ?? fallbackTestId ?? null;
    const reply =
      typeof payload.reply === "string"
        ? repairReplacementChars(repairMojibake(payload.reply))
        : "";
    if (!testId || !reply) return;
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          // Telemetry: round-trip time = Date.now() - most recent user
          // message's `at`. Token count if the agent reported it.
          const lastUser = [...(t.chat ?? [])]
            .reverse()
            .find((m) => m.role === "user");
          const now = Date.now();
          const agentMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "agent",
            text: reply,
            at: now,
            elapsedMs: lastUser ? now - lastUser.at : undefined,
            tokens: extractTokens(payload),
          };
          t.chat = [...(t.chat ?? []), agentMsg];
          this.testPilot.error = null;
          void this.saveTestPilot();
          // Persist the agent reply to the per-author sidecar too —
          // a chrome.storage wipe before the user has a chance to
          // ack the reply would otherwise lose the whole thread.
          this.pushResultsToCompanion();
          return;
        }
      }
    }
  }

  /** Routed from `onMessage` when a `session.synced` with `op: "chat"`
   *  arrives. The reply lands as a new agent-role message on the row's
   *  chat thread; absence of a pendingChats entry does NOT block this
   *  (e.g. timer fired early, panel re-mounted, race on rapid sends).
   *  We always try to apply the reply if it's well-formed — better to
   *  surface a late agent answer than silently lose it. */
  private handleChatSync(session: Session, testId: string): void {
    const hadPending = !!this.testPilot.pendingChats[testId];
    if (session.status === "done") {
      this.clearChatTimer(testId);
      const summary = session.appliedSummary ?? "";
      const { payload, replyText } = parseAgentChatReply(summary);

      if (payload && (payload.type === "test-pilot-chat" || payload.type === "chat")) {
        // Strict happy path — agent followed SKILL.md §7.10.3a contract.
        this.applyChatResult(payload, testId);
      } else if (payload) {
        // Parsed but wrong `type` — agent improvised. Use the payload anyway
        // so usage/telemetry still flow through; applyChatResult already
        // tolerates missing testId via its fallback arg.
        console.warn(
          `[pinta] chat reply for ${testId} had unrecognized type=${String(payload.type)}; using payload anyway`,
          payload,
        );
        this.applyChatResult(payload, testId);
      } else if (replyText) {
        // JSON parse failed entirely — synthesize a minimal payload from
        // the raw text so applyChatResult can still post the message.
        this.applyChatResult({ reply: replyText }, testId);
      } else {
        this.testPilot.error = "Agent returned an empty response.";
      }
      if (hadPending) delete this.testPilot.pendingChats[testId];
    } else if (session.status === "error") {
      this.clearChatTimer(testId);
      this.testPilot.error =
        session.errorMessage ?? `Chat query failed for ${testId}.`;
      if (hadPending) delete this.testPilot.pendingChats[testId];
    }
  }

  // ─── Phase 14 — global + annotate chat surfaces ────────────────────
  //
  // The Test Pilot tier above stores threads on `TestPilotTest.chat[]`
  // inside the catalog blob. The two cross-cutting surfaces (global
  // header icon, Annotate "Just Ask" checkbox) store their threads
  // separately on the top-level `chat` slot. All three reach the same
  // agent over `module.query.submit` with `op: "chat"`; only the
  // `context.kind` differs (`test-detail`, `annotate-batch`, `global`).

  /** Track pending global/annotate chats so we can route the eventual
   *  session.synced back to the right slot. Keyed by sessionId of the
   *  module.query.submit so multiple in-flight asks don't collide. */
  private pendingChatSessions: Map<
    string,
    | { kind: "global" }
    | { kind: "annotate-batch"; batchId: string }
  > = new Map();

  /** Soft-trim helper to keep the global thread bounded. */
  private trimGlobalChat(): void {
    if (this.chat.global.length > ExtensionState.GLOBAL_CHAT_MAX) {
      this.chat.global = this.chat.global.slice(
        -ExtensionState.GLOBAL_CHAT_MAX,
      );
    }
  }

  async loadGlobalChat(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.GLOBAL_CHAT_KEY,
      );
      const raw = stored?.[ExtensionState.GLOBAL_CHAT_KEY] as
        | ChatMessage[]
        | undefined;
      if (Array.isArray(raw)) {
        this.chat.global = raw
          .filter(
            (m) =>
              m &&
              typeof m === "object" &&
              typeof m.id === "string" &&
              (m.role === "user" || m.role === "agent") &&
              typeof m.text === "string",
          )
          // Defense in depth: scrub `images[].dataUrl` entries that
          // don't look like real data: URLs before they hit the
          // rendering path (ChatSheet wires the dataUrl into both
          // `<img src>` and `<a href target="_blank">`). chrome.storage
          // isolation means we don't expect bad data in practice, but
          // a future import / migration path could re-introduce it.
          .map((m) => {
            if (!Array.isArray((m as ChatMessage).images)) return m;
            const cleaned = (m as ChatMessage).images!.filter(
              (im) =>
                im &&
                typeof im.dataUrl === "string" &&
                im.dataUrl.startsWith("data:image/"),
            );
            return cleaned.length > 0
              ? { ...(m as ChatMessage), images: cleaned }
              : { ...(m as ChatMessage), images: undefined };
          }) as ChatMessage[];
      }
    } catch {
      // storage missing — empty thread is fine
    }
  }

  private async saveGlobalChat(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.GLOBAL_CHAT_KEY]: $state.snapshot(this.chat.global),
      });
    } catch (err) {
      // Global chat is the most common culprit for quota exhaustion
      // (image attachments balloon storage). Surface it so the user
      // knows to clear something — silent failure would mean their
      // latest exchange disappears on reload.
      if (ExtensionState.isQuotaExceeded(err)) {
        this.chat.error =
          "Browser storage is full — couldn't save chat history. " +
          "Try clearing the thread (Clear chat in the sheet) or removing image attachments from older messages. " +
          "Your latest message is still in memory until you close the panel.";
      }
    }
  }

  async loadAnnotateChats(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.ANNOTATE_CHATS_KEY,
      );
      const raw = stored?.[ExtensionState.ANNOTATE_CHATS_KEY] as
        | Record<string, ChatMessage[]>
        | undefined;
      if (raw && typeof raw === "object") {
        const cleaned: Record<string, ChatMessage[]> = {};
        for (const [sid, msgs] of Object.entries(raw)) {
          if (Array.isArray(msgs)) cleaned[sid] = msgs;
        }
        this.chat.annotateBatch = cleaned;
      }
    } catch {
      // storage missing — empty map is fine
    }
  }

  private async saveAnnotateChats(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.ANNOTATE_CHATS_KEY]: $state.snapshot(
          this.chat.annotateBatch,
        ),
      });
    } catch (err) {
      if (ExtensionState.isQuotaExceeded(err)) {
        this.chat.error =
          "Browser storage is full — couldn't save chat history. " +
          "Try clearing older Annotate chat threads (older session ids accumulate here). " +
          "Your latest message stays in memory until you close the panel.";
      }
    }
  }

  /** Send a message on the global chat thread. No surface context —
   *  agent only sees session basics (appMode, activeTab, pageUrl).
   *  Optionally accepts pasted images (downscaled client-side in
   *  ChatSheet) which ride along on the queryComment payload for
   *  vision-aware replies. */
  async sendGlobalChatMessage(
    prompt: string,
    images: ChatImage[] = [],
  ): Promise<void> {
    const text = prompt.trim();
    // Allow image-only messages — pasted screenshot + send is a valid
    // ask ("what's this?"). Bail only when both fields are empty.
    if (!text && images.length === 0) return;
    if (this.chat.pendingGlobal) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.chat.error =
        "No companion connected. Start `pinta-companion .` in your project to use chat.";
      return;
    }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    };
    this.chat.global = [...this.chat.global, userMsg];
    this.trimGlobalChat();
    this.chat.error = null;
    void this.saveGlobalChat();

    const history = this.chat.global.slice(
      -ExtensionState.CHAT_HISTORY_CAP,
    );
    const url = this.lastUrl ?? "";
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    const queryComment = JSON.stringify({
      op: "chat",
      prompt: text,
      context: {
        kind: "global",
        appMode: this.appMode,
        pageUrl: url,
        projectRoot: this.selectedCompanion?.projectRoot ?? null,
        detailedResponses,
      },
      // History strips images to keep payload size bounded — the agent
      // re-receives the latest images via the top-level `images` field
      // below. Past images are summarized as "[image]" placeholders so
      // the agent at least knows they existed in the thread.
      history: history.map((m) => ({
        role: m.role,
        text: m.text + (m.images?.length ? ` [${m.images.length} image]` : ""),
      })),
      ...(images.length > 0 ? { images } : {}),
    });
    this.chat.pendingGlobal = true;
    // Track the queued session by a synthesized id; the actual session
    // id arrives in `module.query.created` and gets recorded then.
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "chat",
      moduleSettings: {},
      queryComment,
    });
  }

  /** Send a message on the Annotate "Just Ask" chat for a specific
   *  draft session. The session's annotations + screenshot path are
   *  attached as context so the agent can reason about the batch
   *  without editing source files. */
  async sendAnnotateChatMessage(
    batchId: string,
    prompt: string,
    images: ChatImage[] = [],
  ): Promise<void> {
    const text = prompt.trim();
    if (!text && images.length === 0) return;
    if (this.chat.pendingAnnotateBatch[batchId]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.chat.error =
        "No companion connected. Start `pinta-companion .` in your project to use chat.";
      return;
    }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    };
    const existing = this.chat.annotateBatch[batchId] ?? [];
    this.chat.annotateBatch[batchId] = [...existing, userMsg];
    this.chat.error = null;
    void this.saveAnnotateChats();

    const history = this.chat.annotateBatch[batchId].slice(
      -ExtensionState.CHAT_HISTORY_CAP,
    );
    const session = this.session;
    const url = this.lastUrl ?? "";
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    // Phase 14.5 — if the chat module's redact_pii setting is on
    // (default), scrub emails / phone / card / SSN / long-id patterns
    // from each captured outerHTML + nearbyText entry before they go
    // over the wire. Token / API-key scrubbing already happens at
    // capture time (content/capture.ts:scrubInlineSecrets) and is
    // always on.
    const redactPiiEnabled =
      this.modules["chat"]?.settings?.redact_pii !== false;
    const annotationsForContext = (session?.annotations ?? []).map((a, i) => {
      const primary = a.targets?.[0] ?? a.target;
      const rawHtml = primary?.outerHTML?.slice(0, 600);
      const rawNearby = primary?.nearbyText?.slice(0, 5);
      return {
        id: a.id,
        index: i + 1,
        kind: a.kind,
        comment: a.comment,
        selector: primary?.selector,
        outerHTML:
          rawHtml && redactPiiEnabled ? redactPii(rawHtml) : rawHtml,
        nearbyText:
          rawNearby && redactPiiEnabled
            ? rawNearby.map((t) => redactPii(t))
            : rawNearby,
        url: a.url,
      };
    });
    // Phase 14.5 — flag captured page content that contains prompt-
    // injection openings so the skill can be extra cautious (and a
    // future UI badge can warn the user). Detection only — we don't
    // alter the payload here. The skill's §7.10.3 trust-boundary rules
    // tell the agent to treat captured fields as data regardless.
    const injectionMarkers = scanCapturedContextForInjection(annotationsForContext);
    if (injectionMarkers.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pinta] captured page content contained possible prompt-injection markers: ${injectionMarkers.join(", ")}. Forwarding to agent with a trust-boundary flag.`,
      );
    }
    const queryComment = JSON.stringify({
      op: "chat",
      batchId,
      prompt: text,
      context: {
        kind: "annotate-batch",
        annotationCount: session?.annotations.length ?? 0,
        pageUrl: url,
        annotations: annotationsForContext,
        detailedResponses,
        ...(injectionMarkers.length > 0 ? { injectionMarkers } : {}),
      },
      history: history.map((m) => ({
        role: m.role,
        text: m.text + (m.images?.length ? ` [${m.images.length} image]` : ""),
      })),
      // User-pasted reference images (screenshots). Not page-captured,
      // so the PII/injection scrubbing above doesn't apply to them.
      ...(images.length > 0 ? { images } : {}),
    });
    // Phase 14.5 — stash a redaction summary for the UI badge. Counted
    // from the final serialized payload so the numbers reflect what
    // actually went over the wire (after both capture-time scrubbing
    // and chat-side PII redaction). Cleared on Clear chat.
    this.chat.annotateRedactions[batchId] = {
      counts: countRedactionPlaceholders(queryComment),
      injection: injectionMarkers,
    };
    this.chat.pendingAnnotateBatch[batchId] = true;
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "chat",
      moduleSettings: {},
      queryComment,
    });
  }

  /**
   * Per-annotation variant used by the Annotate "Just Ask" auto-compose
   * flow. Pushes a single user bubble carrying the annotation's selector
   * chip + comment, then sends a focused chat ask scoped to JUST that
   * annotation so the agent's reply lands inline below it rather than
   * being one wall-of-text consolidated reply at the end of the batch.
   *
   * Caller is expected to drive this in a sequential loop — await this
   * call, then poll `chat.pendingAnnotateBatch[batchId]` until it
   * clears (the reply has landed via `handleNonTestPilotChatSync`),
   * then issue the next annotation. That ordering is what produces the
   * "lazy-loading" feel of bubbles + replies appearing one at a time.
   */
  async sendAnnotateChatMessageForAnnotation(
    batchId: string,
    annotation: Annotation,
    prompt: string,
    selector: string,
  ): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    if (this.chat.pendingAnnotateBatch[batchId]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.chat.error =
        "No companion connected. Start `pinta-companion .` in your project to use chat.";
      return;
    }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      targetSelector: selector,
    };
    const existing = this.chat.annotateBatch[batchId] ?? [];
    this.chat.annotateBatch[batchId] = [...existing, userMsg];
    this.chat.error = null;
    void this.saveAnnotateChats();

    const history = this.chat.annotateBatch[batchId].slice(
      -ExtensionState.CHAT_HISTORY_CAP,
    );
    const url = this.lastUrl ?? "";
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    const primary = annotation.targets?.[0] ?? annotation.target;
    const redactPiiEnabled =
      this.modules["chat"]?.settings?.redact_pii !== false;
    const rawHtml = primary?.outerHTML?.slice(0, 600);
    const rawNearby = primary?.nearbyText?.slice(0, 5);
    const scopedAnnotation = {
      id: annotation.id,
      index: 1,
      kind: annotation.kind,
      comment: annotation.comment,
      selector: primary?.selector,
      outerHTML:
        rawHtml && redactPiiEnabled ? redactPii(rawHtml) : rawHtml,
      nearbyText:
        rawNearby && redactPiiEnabled
          ? rawNearby.map((t) => redactPii(t))
          : rawNearby,
      url: annotation.url,
    };
    // Phase 14.5 — same injection-marker scan as the batch sender, but
    // over the single annotation in this scoped ask. See sibling method
    // for rationale.
    const injectionMarkers = scanCapturedContextForInjection([scopedAnnotation]);
    if (injectionMarkers.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pinta] captured page content for ${annotation.id} contained possible prompt-injection markers: ${injectionMarkers.join(", ")}.`,
      );
    }
    const queryComment = JSON.stringify({
      op: "chat",
      batchId,
      prompt: text,
      context: {
        kind: "annotate-batch",
        annotationCount: 1,
        pageUrl: url,
        // Scoped to one annotation so the agent doesn't try to address
        // the whole batch in this reply — the next annotation will get
        // its own focused ask in the caller's sequential loop.
        annotations: [scopedAnnotation],
        detailedResponses,
        /** Hint for the skill: this ask is intentionally narrow. Reply
         *  should focus on this annotation only; don't enumerate the
         *  whole batch. Older skills that ignore the flag still get the
         *  scoped `annotations` array so behavior degrades gracefully. */
        perAnnotation: true,
        ...(injectionMarkers.length > 0 ? { injectionMarkers } : {}),
      },
      history: history.map((m) => ({ role: m.role, text: m.text })),
    });
    // Phase 14.5 — accumulate redaction counts across the sequential
    // per-annotation flow so the UI badge reflects the total across
    // ALL annotations in this batch, not just the most recent one.
    const newCounts = countRedactionPlaceholders(queryComment);
    const existingSummary = this.chat.annotateRedactions[batchId];
    const mergedCounts: Record<string, number> = {
      ...(existingSummary?.counts ?? {}),
    };
    for (const [k, v] of Object.entries(newCounts)) {
      mergedCounts[k] = (mergedCounts[k] ?? 0) + v;
    }
    const mergedInjection = [
      ...new Set([...(existingSummary?.injection ?? []), ...injectionMarkers]),
    ];
    this.chat.annotateRedactions[batchId] = {
      counts: mergedCounts,
      injection: mergedInjection,
    };
    this.chat.pendingAnnotateBatch[batchId] = true;
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "chat",
      moduleSettings: {},
      queryComment,
    });
  }

  /** Routed from `onMessage` when `module.query.created` arrives for
   *  a `moduleId: "chat"` ephemeral session — record the actual
   *  session id so the eventual `session.synced` can be dispatched
   *  back to the right slot. */
  rememberChatSession(
    sessionId: string,
    binding:
      | { kind: "global" }
      | { kind: "annotate-batch"; batchId: string },
  ): void {
    this.pendingChatSessions.set(sessionId, binding);
  }

  /** Apply an agent reply for the global or annotate-batch chat
   *  surfaces. Looks up the pending binding by sessionId, appends the
   *  reply as an agent-role message, clears the pending flag. */
  private handleNonTestPilotChatSync(session: Session): boolean {
    const binding = this.pendingChatSessions.get(session.id);
    if (!binding) return false;
    if (session.status === "done") {
      const summary = session.appliedSummary ?? "";
      const { payload, replyText: reply } = parseAgentChatReply(summary);
      if (reply) {
        // Telemetry: round-trip time = now - most recent user message's at.
        // Token count if the agent reported it.
        const thread =
          binding.kind === "global"
            ? this.chat.global
            : (this.chat.annotateBatch[binding.batchId] ?? []);
        const lastUser = [...thread].reverse().find((m) => m.role === "user");
        const now = Date.now();
        const agentMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "agent",
          text: reply,
          at: now,
          elapsedMs: lastUser ? now - lastUser.at : undefined,
          tokens: payload ? extractTokens(payload) : undefined,
        };
        if (binding.kind === "global") {
          this.chat.global = [...this.chat.global, agentMsg];
          this.trimGlobalChat();
          void this.saveGlobalChat();
        } else {
          const existing = this.chat.annotateBatch[binding.batchId] ?? [];
          this.chat.annotateBatch[binding.batchId] = [...existing, agentMsg];
          void this.saveAnnotateChats();
        }
        this.chat.error = null;
      } else {
        // Truly empty response — agent returned no parseable text AND
        // no raw fallback either, OR the summary was whitespace-only.
        // Surface a recovery hint instead of a bare error: explains
        // the most likely cause (agent had no answer for an
        // image-context-needed prompt) and what to try.
        this.chat.error =
          "Agent returned an empty response. This usually means the prompt needed visual context the agent couldn't see " +
          "(e.g. \"suggest icons that match this\" without a screenshot), or a tool call failed silently. " +
          "Try rephrasing with more context (paste a screenshot, mention the file path), or restart `/pinta` if the agent seems stuck.";
      }
      this.pendingChatSessions.delete(session.id);
      if (binding.kind === "global") this.chat.pendingGlobal = false;
      else delete this.chat.pendingAnnotateBatch[binding.batchId];
      return true;
    }
    if (session.status === "error") {
      this.chat.error = session.errorMessage ?? "Chat query failed.";
      this.pendingChatSessions.delete(session.id);
      if (binding.kind === "global") this.chat.pendingGlobal = false;
      else delete this.chat.pendingAnnotateBatch[binding.batchId];
      return true;
    }
    return false;
  }

  /** Wipe the global chat thread. */
  clearGlobalChat(): void {
    this.chat.global = [];
    this.chat.error = null;
    void this.saveGlobalChat();
  }

  /** Wipe an annotate-batch chat thread. Called by the side panel when
   *  the user discards a draft session or submits it. */
  clearAnnotateChat(batchId: string): void {
    delete this.chat.annotateBatch[batchId];
    delete this.chat.annotateRedactions[batchId];
    void this.saveAnnotateChats();
  }

  // ─── /Phase 14 cross-cutting ───────────────────────────────────────

  // ─── Phase 13 — manual catalog editing ─────────────────────────────
  //
  // The companion's `.pinta/test-docs/{docId}.md` is the source of truth
  // for which rows exist + their wording. Every mutator below mutates
  // the in-memory `testPilot.catalog` (Svelte 5 picks up the $state
  // reactivity), persists to `chrome.storage.local` via
  // `saveTestPilot()`, then PUTs the composed-back markdown to the
  // companion so the agent's `?` (detail-steps) flow works against
  // user-added rows and edits survive regen.

  /**
   * Single in-flight PUT promise — concurrent edits chain via `.then()`
   * so the file on disk is always written in the order the user made
   * the changes. Without this, rapid-fire add-delete-add could race
   * and leave the on-disk spec in a state that doesn't match the UI.
   */
  private testDocPushChain: Promise<void> = Promise.resolve();

  /** Same serialization shape as `testDocPushChain` but for the
   *  per-author `.results.{slug}.json` file. Independent chain so a
   *  slow results PUT doesn't block a structural .md edit. */
  private resultsPushChain: Promise<void> = Promise.resolve();

  /** Slugify the catalog's author for use in the on-disk filename.
   *  Lowercase kebab-case, strips diacritics, drops anything outside
   *  [a-z0-9-]. Empty author or all-punctuation slugs become "" so
   *  the file falls into the `{docId}.results.json` single-author
   *  bucket — matches the companion's empty-slug fallback. */
  private static slugifyAuthor(author: string | undefined): string {
    if (!author) return "";
    const normalized = author
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip combining diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    return normalized;
  }

  /**
   * Push the current author's Pass/Fail marks + chat threads + detail
   * cache to `.pinta/test-docs/{docId}.results{.slug}.json`. Survives
   * chrome.storage wipes — the recovery path that the Result column
   * in the .md can't fully cover (Result is one Pass/Fail per row;
   * the sidecar holds the full per-row state including chat).
   *
   * Fire-and-forget through a serialized chain so concurrent edits
   * land in order. Each PUT is a full file replacement — no partial
   * sync state to reconcile.
   */
  private pushResultsToCompanion(): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    const base = this.httpBase();
    if (!base) return; // standalone — no companion, nothing to push
    const authorSlug = ExtensionState.slugifyAuthor(c.author);
    const results: Record<
      string,
      { status?: TestPilotStatus; chat?: ChatMessage[]; detail?: { steps: string[]; askedAt: number } }
    > = {};
    for (const section of c.sections) {
      for (const t of section.tests) {
        const entry: {
          status?: TestPilotStatus;
          chat?: ChatMessage[];
          detail?: { steps: string[]; askedAt: number };
        } = {};
        if (t.status && t.status !== "untested") entry.status = t.status;
        if (t.chat && t.chat.length > 0) entry.chat = t.chat;
        if (t.detail) entry.detail = t.detail;
        if (Object.keys(entry).length > 0) results[t.id] = entry;
      }
    }
    const payload = JSON.stringify({
      $pinta_test_results: 1,
      docId: c.docId,
      author: c.author ?? "",
      savedAt: Date.now(),
      results,
    });
    const url = `${base}/v1/test-docs/${encodeURIComponent(c.docId)}/results${authorSlug ? `/${authorSlug}` : ""}`;
    this.resultsPushChain = this.resultsPushChain
      .catch(() => {})
      .then(async () => {
        try {
          const res = await ExtensionState.fetchWithTimeout(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: payload }),
            timeoutMs: 8_000,
          });
          if (res.status === 404) {
            // Companion is on an older build that doesn't have the
            // /v1/test-docs/:docId/results/:author route yet (the body
            // text typically reads "no route for PUT ..."). Distinguish
            // this from a real failure: chrome.storage still has every
            // mark, so the user hasn't lost data — they just need to
            // restart their companion to get the durable sidecar.
            // Warn once per panel-load via the flag below; don't keep
            // spamming the banner on every Pass click.
            if (!this.resultsEndpointWarned) {
              this.resultsEndpointWarned = true;
              console.warn(
                "[pinta] /v1/test-docs/:docId/results/:author endpoint missing on this companion. " +
                "Restart `pinta-companion` to enable the per-author durable results sidecar. " +
                "Marks are still being saved to chrome.storage in the meantime.",
              );
            }
            return;
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
              `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
            );
          }
          if (this.testPilot.error?.startsWith("Couldn't sync results")) {
            this.testPilot.error = null;
          }
        } catch (err) {
          this.testPilot.error = `Couldn't sync results to disk: ${(err as Error).message}`;
        }
      });
  }

  /** One-shot guard so a companion-without-the-endpoint warning fires
   *  once per panel load (in the console) instead of red-banner-ing
   *  the user on every Pass/Fail click. Reset on connectTo so a
   *  companion restart re-arms the check. */
  private resultsEndpointWarned = false;

  /**
   * Read the per-author results sidecar from disk and overlay it onto
   * the in-memory catalog. Called from `loadTestPilot` after the
   * chrome.storage hydrate so disk wins on conflict — disk is the
   * durable source, chrome.storage is a fast cache. No-op when the
   * file doesn't exist (404 — fresh catalog with no test results yet)
   * or when there's no companion to talk to.
   */
  private async loadResultsFromCompanion(): Promise<void> {
    const c = this.testPilot.catalog;
    if (!c) return;
    const base = this.httpBase();
    if (!base) return;
    const authorSlug = ExtensionState.slugifyAuthor(c.author);
    const url = `${base}/v1/test-docs/${encodeURIComponent(c.docId)}/results${authorSlug ? `/${authorSlug}` : ""}`;
    try {
      const res = await ExtensionState.fetchWithTimeout(url, {
        method: "GET",
        timeoutMs: 8_000,
      });
      if (res.status === 404) return; // no results yet — nothing to overlay
      if (!res.ok) return; // transient; non-fatal
      const body = (await res.json()) as {
        results?: Record<
          string,
          {
            status?: TestPilotStatus;
            chat?: ChatMessage[];
            detail?: { steps: string[]; askedAt: number };
          }
        >;
      };
      const results = body.results ?? {};
      for (const section of c.sections) {
        for (const t of section.tests) {
          const r = results[t.id];
          if (!r) continue;
          // Disk wins — overwrite the in-memory values. This is what
          // makes the sidecar a true recovery path: even if
          // chrome.storage had stale or no values for this test, the
          // disk file restores it.
          if (r.status) t.status = r.status;
          if (r.chat) t.chat = r.chat;
          if (r.detail) t.detail = r.detail;
        }
      }
      // Persist the merged catalog back to chrome.storage so the next
      // panel open sees the disk-overlaid values without re-fetching.
      void this.saveTestPilot();
    } catch {
      // Network / parse failure — leave in-memory catalog as-is.
    }
  }

  /**
   * Compose the current catalog back to markdown for round-tripping to
   * the companion. Delegates to a pure helper in `test-pilot-doc.ts`
   * so the logic is unit-testable without booting the state class /
   * chrome.* surface. No-op when no catalog is loaded.
   */
  private composeTestDocMarkdown(): string {
    const c = this.testPilot.catalog;
    if (!c) return "";
    // Strip the Svelte 5 reactive proxy before passing — the pure
    // helper only needs the raw shape.
    return composeTestDocMarkdownPure($state.snapshot(c) as TestPilotCatalog);
  }

  /**
   * Push the composed catalog to the companion. Fire-and-forget but
   * serialized via `testDocPushChain` so writes never race. On
   * companion failure, surfaces `testPilot.error`; the browser-side
   * edit still stands and the next successful edit re-PUTs the full
   * file (each PUT is a full replacement, no reconciliation needed).
   */
  private pushTestDocToCompanion(): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    const docId = c.docId;
    const base = this.httpBase();
    if (!base) return; // standalone mode — no disk sync, just in-memory + chrome.storage.
    const content = this.composeTestDocMarkdown();
    this.testDocPushChain = this.testDocPushChain
      .catch(() => {
        // swallow prior errors so a single failure doesn't poison the
        // whole chain — each PUT is independent.
      })
      .then(async () => {
        try {
          const res = await ExtensionState.fetchWithTimeout(
            `${base}/v1/test-docs/${encodeURIComponent(docId)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content }),
              timeoutMs: 8_000,
            },
          );
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
              `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
            );
          }
          // Clear any stale sync error from a prior failure now that
          // we know the companion is reachable again.
          if (this.testPilot.error?.startsWith("Couldn't sync spec")) {
            this.testPilot.error = null;
          }
        } catch (err) {
          this.testPilot.error = `Couldn't sync spec to disk: ${(err as Error).message}`;
        }
      });
  }

  /**
   * Compute the next free `USER-N` id. Delegates to `test-pilot-doc.ts`
   * so the logic is unit-tested in isolation. Returns `USER-1` for an
   * empty catalog (used when this is called before any catalog exists).
   */
  private nextUserTestId(): string {
    const c = this.testPilot.catalog;
    if (!c) return "USER-1";
    return nextUserTestIdPure($state.snapshot(c) as TestPilotCatalog);
  }

  /**
   * Find a section by title. Returns the index too so callers can do
   * reorder math without re-scanning. Returns null if not found.
   */
  private findSection(
    title: string,
  ): { idx: number; section: TestPilotSection } | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    const idx = c.sections.findIndex((s) => s.title === title);
    if (idx === -1) return null;
    return { idx, section: c.sections[idx]! };
  }

  /**
   * Find a test by id across all sections. Returns the indexes too so
   * callers can do reorder math without re-scanning.
   */
  private findTest(
    testId: string,
  ): { sIdx: number; tIdx: number; section: TestPilotSection; test: TestPilotTest } | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    for (let i = 0; i < c.sections.length; i++) {
      const section = c.sections[i]!;
      const tIdx = section.tests.findIndex((t) => t.id === testId);
      if (tIdx !== -1) {
        return { sIdx: i, tIdx, section, test: section.tests[tIdx]! };
      }
    }
    return null;
  }

  /** After any catalog mutation, fan-out to local persistence + disk
   *  sync. Single call site means we never forget either step. */
  private commitCatalogEdit(): void {
    void this.saveTestPilot();
    this.pushTestDocToCompanion();
  }

  /** Append a new section to the catalog. Title may be empty — the
   *  UI sets `editingField = "section:"` immediately after to focus
   *  the inline input for typing. */
  addTestPilotSection(title: string): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    c.sections.push({ title, tests: [] });
    this.commitCatalogEdit();
  }

  /** Rename a section by current title. No-op on collision (two
   *  sections sharing a title would break the title-keyed lookup). */
  renameTestPilotSection(oldTitle: string, newTitle: string): void {
    if (oldTitle === newTitle) return;
    const found = this.findSection(oldTitle);
    if (!found) return;
    const c = this.testPilot.catalog!;
    if (c.sections.some((s, i) => i !== found.idx && s.title === newTitle)) {
      this.testPilot.error = `A section named "${newTitle}" already exists.`;
      return;
    }
    found.section.title = newTitle;
    this.commitCatalogEdit();
  }

  /** Remove a section and every test inside it. */
  removeTestPilotSection(title: string): void {
    const found = this.findSection(title);
    if (!found) return;
    this.testPilot.catalog!.sections.splice(found.idx, 1);
    this.commitCatalogEdit();
  }

  /** Move a section up or down within the catalog. No-op at
   *  boundaries (no wraparound). */
  moveTestPilotSection(title: string, direction: "up" | "down"): void {
    const found = this.findSection(title);
    if (!found) return;
    const sections = this.testPilot.catalog!.sections;
    const newIdx = direction === "up" ? found.idx - 1 : found.idx + 1;
    if (newIdx < 0 || newIdx >= sections.length) return;
    const [moved] = sections.splice(found.idx, 1);
    sections.splice(newIdx, 0, moved!);
    this.commitCatalogEdit();
  }

  /** Reorder a section to an absolute index. Used by drag-and-drop
   *  (Phase 14.4) where the user drops the section at a specific
   *  position rather than nudging it one slot at a time. Clamps
   *  `toIdx` into valid bounds; no-op when source and destination
   *  resolve to the same slot. */
  reorderTestPilotSection(title: string, toIdx: number): void {
    const found = this.findSection(title);
    if (!found) return;
    const sections = this.testPilot.catalog!.sections;
    const clamped = Math.max(0, Math.min(toIdx, sections.length - 1));
    if (found.idx === clamped) return;
    const [moved] = sections.splice(found.idx, 1);
    sections.splice(clamped, 0, moved!);
    this.commitCatalogEdit();
  }

  /** Append a test to the named section. Auto-mints a `USER-N` id if
   *  the caller didn't supply one. `test`/`expected` default to empty
   *  strings so the UI can drop the user into inline-edit mode. */
  addTestPilotTest(
    sectionTitle: string,
    input: { id?: string; test?: string; expected?: string },
  ): string | null {
    const found = this.findSection(sectionTitle);
    if (!found) return null;
    const id = input.id ?? this.nextUserTestId();
    found.section.tests.push({
      id,
      test: input.test ?? "",
      expected: input.expected ?? "",
      status: "untested",
    });
    this.commitCatalogEdit();
    return id;
  }

  /** Batch-add multiple tests to a section in one commit. Used by the
   *  chat "Add N to spec" affordance — when the agent suggests a list
   *  of test scenarios, the user clicks once and all of them land
   *  under the row's section with sequential USER-N ids. One persist
   *  + one disk push at the end (not N), so the on-disk markdown
   *  stays atomic from the user's perspective. Returns the new ids
   *  in insertion order, or null if the section wasn't found.
   *
   *  Skips entries whose test text is empty (defensive against a
   *  loose parser returning blank rows). */
  addTestPilotTests(
    sectionTitle: string,
    inputs: { test: string; expected: string }[],
  ): string[] | null {
    const found = this.findSection(sectionTitle);
    if (!found) return null;
    const ids: string[] = [];
    // Mint ids by walking the catalog after each push so collisions
    // are impossible even within the batch (nextUserTestId reads the
    // current catalog state).
    for (const input of inputs) {
      const test = input.test.trim();
      if (!test) continue;
      const id = this.nextUserTestId();
      found.section.tests.push({
        id,
        test,
        expected: (input.expected ?? "").trim(),
        status: "untested",
      });
      ids.push(id);
    }
    if (ids.length === 0) return ids;
    this.commitCatalogEdit();
    return ids;
  }

  /** Create a new section AND bulk-add tests into it in one commit.
   *  Used by the chat "+ New section…" affordance — the user can
   *  route agent suggestions into a fresh category instead of the
   *  row's current parent. One persist + one disk push at end:
   *  either the new section exists with all its tests, or nothing
   *  landed (atomic from the user's POV). Empty inputs are skipped
   *  the same way addTestPilotTests does.
   *
   *  Returns the new test ids in insertion order, or null if there's
   *  no catalog loaded. An empty input array still creates the
   *  section (the user might want to seed it manually after). */
  addTestPilotSectionWithTests(
    sectionTitle: string,
    inputs: { test: string; expected: string }[],
    /** Title of an existing section to insert the new section
     *  immediately after. Used by the chat-suggestions flow so a new
     *  category lands next to the section the user was asking about,
     *  not at the bottom of the catalog. Falls back to a normal
     *  `push` when omitted or not found. */
    insertAfterSectionTitle?: string,
  ): string[] | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    const title = sectionTitle.trim();
    if (!title) return null;
    const section: TestPilotSection = { title, tests: [] };
    const ids: string[] = [];
    for (const input of inputs) {
      const test = input.test.trim();
      if (!test) continue;
      // Walk the WHOLE catalog (including the not-yet-pushed section)
      // for the next id so within-batch collisions stay impossible.
      // Push the in-progress section first so its tests count.
      const id = this.nextUserTestIdConsidering([
        ...c.sections,
        section,
      ]);
      section.tests.push({
        id,
        test,
        expected: (input.expected ?? "").trim(),
        status: "untested",
      });
      ids.push(id);
    }
    const anchorIdx = insertAfterSectionTitle
      ? c.sections.findIndex((s) => s.title === insertAfterSectionTitle)
      : -1;
    if (anchorIdx >= 0) {
      c.sections.splice(anchorIdx + 1, 0, section);
    } else {
      c.sections.push(section);
    }
    this.commitCatalogEdit();
    return ids;
  }

  /** Like nextUserTestId() but takes an explicit sections list so the
   *  caller can include rows that haven't been pushed into the catalog
   *  yet (e.g. mid-batch when assembling a new section). Pure derived
   *  computation — no state mutation. */
  private nextUserTestIdConsidering(
    sections: { tests: { id: string }[] }[],
  ): string {
    let max = 0;
    for (const s of sections) {
      for (const t of s.tests) {
        const m = /^USER-(\d+)$/.exec(t.id);
        if (m) {
          const n = parseInt(m[1]!, 10);
          if (n > max) max = n;
        }
      }
    }
    return `USER-${max + 1}`;
  }

  /** Patch a test's `test` (title) or `expected` fields. Ignores
   *  empty/undefined patch values — pass empty string explicitly to
   *  clear a field. */
  updateTestPilotTest(
    testId: string,
    patch: { test?: string; expected?: string },
  ): void {
    const found = this.findTest(testId);
    if (!found) return;
    if (patch.test !== undefined) found.test.test = patch.test;
    if (patch.expected !== undefined) found.test.expected = patch.expected;
    this.commitCatalogEdit();
  }

  /** Remove a test from its containing section. */
  removeTestPilotTest(testId: string): void {
    const found = this.findTest(testId);
    if (!found) return;
    found.section.tests.splice(found.tIdx, 1);
    this.commitCatalogEdit();
  }

  /** Move a test up or down within its section. No-op at boundaries.
   *  Cross-section moves are explicitly out of scope for v1. */
  moveTestPilotTest(testId: string, direction: "up" | "down"): void {
    const found = this.findTest(testId);
    if (!found) return;
    const newIdx = direction === "up" ? found.tIdx - 1 : found.tIdx + 1;
    if (newIdx < 0 || newIdx >= found.section.tests.length) return;
    const [moved] = found.section.tests.splice(found.tIdx, 1);
    found.section.tests.splice(newIdx, 0, moved!);
    this.commitCatalogEdit();
  }

  /** Reorder a test to an absolute index within its section. Used by
   *  drag-and-drop (Phase 14.4). Same within-section-only contract as
   *  moveTestPilotTest. Clamps `toIdx`; no-op when source and
   *  destination resolve to the same slot. */
  reorderTestPilotTest(testId: string, toIdx: number): void {
    const found = this.findTest(testId);
    if (!found) return;
    const tests = found.section.tests;
    const clamped = Math.max(0, Math.min(toIdx, tests.length - 1));
    if (found.tIdx === clamped) return;
    const [moved] = tests.splice(found.tIdx, 1);
    tests.splice(clamped, 0, moved!);
    this.commitCatalogEdit();
  }

  /** UI signals an inline edit is in flight so an incoming catalog
   *  payload (e.g. user re-runs Generate mid-edit) doesn't clobber it.
   *  Side panel calls this on startEditing/commitEdit/cancelEdit. */
  setTestPilotEditingActive(active: boolean): void {
    this.testPilot.editingActive = active;
  }

  // ─── /Phase 13 ──────────────────────────────────────────────────────

  // ─── Phase 15 — AuditFlow ───────────────────────────────────────────
  //
  // Interactive module like Test Pilot. The user picks categories +
  // scope and clicks Run; the agent inspects the project and returns
  // a structured AuditRun (overall score + per-category checks). Each
  // check has a status (pass/warn/fail/info) and an optional fixHint
  // that the user can route into Annotate via Fix-with-agent.
  //
  // 15a ships Security only; rest of categories arrive in 15b. Single
  // in-flight run + single persisted last-completed run for v1 (no
  // run history yet — that's 15d).

  /** Persisted across panel reloads. Same shape Test Pilot uses for
   *  its current catalog — one key, one value. */
  private static readonly AUDIT_KEY = "pinta-audit-current-run";
  /** Per-user category-selection preference. Survives panel reloads
   *  so users don't re-tick boxes every run. */
  private static readonly AUDIT_SELECTED_KEY = "pinta-audit-selected-categories";
  /** Per-finding remediation dispositions, keyed by the check's stable
   *  fingerprint id. Stored OUTSIDE the AuditRun so re-running an audit
   *  doesn't wipe the user's progress — looked up by id at render
   *  time. Mirrors Test Pilot's separate result map. */
  private static readonly AUDIT_DISPOSITIONS_KEY = "pinta-audit-dispositions";
  /** User-curated catalog overlay (Phase 15 "Slice 2"). Layered over
   *  the raw agent run by mergeAuditRun so user edits survive re-runs.
   *  Persisted separately from AUDIT_KEY (which now holds the raw agent
   *  run, not the merged view). */
  private static readonly AUDIT_OVERLAY_KEY = "pinta-audit-overlay";

  /** Per-finding Discuss chat threads (Phase 15e), keyed by check.id. */
  private static readonly AUDIT_CHECK_CHATS_KEY = "pinta-audit-check-chats";

  /** Findings filed as an issue/task (GitLab or local), keyed by check.id. */
  private static readonly AUDIT_FILED_ISSUES_KEY = "pinta-audit-filed-issues";

  /** Last generated report run + the user's range preference (Phase 16). */
  private static readonly REPORT_KEY = "pinta-report-current-run";
  private static readonly REPORT_RANGE_KEY = "pinta-report-range";
  /** Extra repo paths to combine into the report (Phase 16b). */
  private static readonly REPORT_PROJECTS_KEY = "pinta-report-projects";
  /** A whole-window gather (git log + gh/glab + Pinta history) is
   *  legitimately slow — same generous ceiling as a full audit. */
  private static readonly REPORT_TIMEOUT_MS = 600_000;

  /** Per-finding op timers (Discuss / File-issue), keyed by
   *  `${op}:${checkId}` so a stuck agent reply clears its spinner. */
  private auditOpTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Per-finding op timeout (Discuss / File-issue). Shorter than a full
   *  audit run — these are single-finding round-trips. */
  private static readonly AUDIT_OP_TIMEOUT_MS = 120_000;

  /** Hard ceiling on a single audit run. Security category alone is
   *  ~30s typical; full 5-category audit can run minutes. Generous so
   *  legitimate slow runs aren't killed, bounded so a wedged agent
   *  doesn't spin forever. Mirrors Test Pilot's generate-doc ceiling. */
  private static readonly AUDIT_TIMEOUT_MS = 600_000;

  /** Persisted boards for imported interactive modules (Phase 19
   *  interactive tabs), keyed by module id. One value holds the map so
   *  a board survives panel reloads, mirroring AUDIT_KEY. */
  private static readonly MODULE_BOARDS_KEY = "pinta-module-boards";
  /** Hard ceiling on one interactive imported-module op (e.g. a
   *  Workflow board refresh that runs `/tasks --today`). Same generous
   *  bound as an audit run. */
  private static readonly MODULE_OP_TIMEOUT_MS = 600_000;

  /** How long a session can sit in "submitted" status before we
   *  warn the user that no `/pinta` terminal is claiming it. Agents
   *  with SSE see new sessions instantly, but a busy agent can be
   *  mid-think (coalescing / running another tool) for a while before
   *  it gets around to the claim POST, so 10s was too eager — it
   *  surfaced the warning on perfectly healthy slow claims. 3min is a
   *  generous ceiling that still catches the real cases: no `/pinta`
   *  running, OR role flags (Phase 18a) that don't cover this
   *  session's kind. The warning surfaces a concrete `/pinta --flag`
   *  hint based on session.modules so the user knows exactly which
   *  terminal they need.
   *
   *  Separate from the per-flow timeouts (audit 600s, test pilot
   *  120s, etc.) — those handle "agent claimed but stuck"; this
   *  handles "no agent claimed at all". */
  private static readonly CLAIM_WARNING_MS = 180_000;

  /** Per-session claim-warning timers. Keyed by session.id so
   *  multiple in-flight submissions each get their own timer.
   *  Cleared when the session moves out of "submitted" status. */
  private claimWarnings = new Map<string, ReturnType<typeof setTimeout>>();

  audit = $state<{
    /** Raw AGENT-generated run, recomputed each re-audit, or null if
     *  the user hasn't run yet. The user-facing `currentRun` is DERIVED
     *  from this + `overlay` via recomputeAuditRun(). */
    agentRun: AuditRun | null;
    /** User-curated catalog overlay (added / edited / deleted checks +
     *  categories). Layered over `agentRun` by mergeAuditRun so edits
     *  survive re-runs. */
    overlay: AuditOverlay;
    /** DERIVED view = mergeAuditRun(agentRun, overlay). Never assigned
     *  directly outside recomputeAuditRun() — mutate `agentRun` /
     *  `overlay` then call that helper. */
    currentRun: AuditRun | null;
    /** In-flight run metadata. Cleared on completion / error / cancel.
     *  `partial` marks a single-category re-run (one category's ⋮ →
     *  "Re-run category"): its result is spliced into the existing run
     *  rather than replacing it, and the full-screen "Running audit…"
     *  panel is suppressed so other category cards stay visible.
     *  `categoryId` is the category being re-run (for the per-card
     *  spinner). */
    pending: {
      runId: string;
      startedAt: number;
      partial?: boolean;
      categoryId?: string;
    } | null;
    /** Which categories the user wants the next run to cover. The
     *  picker in AuditFlowTab writes to this; runAudit reads from it.
     *  Defaults to ["security"] (the always-available v1 category).
     *  Persists to chrome.storage so the user's selection sticks. */
    selectedCategories: AuditCategoryId[];
    /** Per-finding remediation dispositions, keyed by check.id (the
     *  stable fingerprint). Persists independently of the AuditRun so
     *  progress survives re-runs. An actionable check absent from this
     *  map defaults to "open". */
    dispositions: Record<string, AuditDisposition>;
    /** Per-category in-flight "Suggest checks" requests, keyed by
     *  category id. In-memory only (mirrors Test Pilot's
     *  pendingSectionSuggest); the spinner on the kebab reads this. */
    pendingAuditSuggest: Record<string, boolean>;
    /** Per-category agent-returned check suggestions awaiting the user's
     *  pick. In-memory only — ticked rows land as USER- checks via
     *  addAuditCheck. Mirrors Test Pilot's sectionSuggestions. */
    suggestions: Record<
      string,
      { label: string; description?: string; status?: AuditCheckStatus }[]
    >;
    /** Per-finding "Discuss" chat threads (Phase 15e), keyed by check.id.
     *  Persists independently of the run (like dispositions) so threads
     *  survive re-audits + chrome reloads. */
    checkChats: Record<string, ChatMessage[]>;
    /** In-flight Discuss sends, keyed by check.id — drives the thread
     *  spinner. In-memory only. */
    pendingCheckChat: Record<string, boolean>;
    /** Findings filed as an issue/task, keyed by check.id. `target`
     *  records where it landed — a GitLab issue via `glab`, or the local
     *  `.pinta/tasks.md` fallback. Persisted so the ✓ + link survive a
     *  reload. */
    filedIssues: Record<
      string,
      {
        target: "gitlab" | "local";
        url?: string;
        path?: string;
        title?: string;
        at: number;
      }
    >;
    /** In-flight File-issue sends, keyed by check.id. In-memory only. */
    pendingFileIssue: Record<string, boolean>;
    error: string | null;
  }>({
    agentRun: null,
    overlay: { addedCategories: [], addedChecks: {}, edits: {}, deleted: [] },
    currentRun: null,
    pending: null,
    selectedCategories: ["security"],
    dispositions: {},
    pendingAuditSuggest: {},
    suggestions: {},
    checkChats: {},
    pendingCheckChat: {},
    filedIssues: {},
    pendingFileIssue: {},
    error: null,
  });

  private auditTimer: ReturnType<typeof setTimeout> | null = null;

  /** Report module (Phase 16). `currentRun` is the last generated report
   *  (true-dated days; the UI folds weekends at render). `range` is the
   *  user's selected window for the next generate. */
  report = $state<{
    currentRun: ReportRun | null;
    pending: {
      runId: string;
      startedAt: number;
      range: ReportRange;
      anchorDate: string;
      /** Phase 16 — the ephemeral query session's id, pinned from
       *  `module.query.created`. Lets `reconcileReport()` recover a run
       *  whose `session.synced(done)` was missed during a (half-open) WS
       *  blip — the companion never replays ephemeral module-query
       *  sessions on reconnect. Null until the created-ack lands. */
      sessionId: string | null;
    } | null;
    range: ReportRange;
    /** Extra repo paths to fold into the report alongside the current
     *  companion's project (Phase 16b). Absolute paths the user typed —
     *  the agent runs `git -C <path>` per repo and tags each item's
     *  `project`. The primary (companion) project is always included
     *  implicitly, so it is NOT in this list. */
    projects: string[];
    error: string | null;
  }>({
    currentRun: null,
    pending: null,
    range: "weekly",
    projects: [],
    error: null,
  });
  private reportTimer: ReturnType<typeof setTimeout> | null = null;

  /** Boards for imported INTERACTIVE modules (Phase 19 dynamic tabs),
   *  keyed by module id. Each slot mirrors the audit slot: the agent's
   *  returned board, an in-flight op marker, and the last error. Fully
   *  generic — no module-specific fields — so any board-style plugin
   *  reuses the same renderer (ModuleBoardTab). */
  moduleBoards = $state<
    Record<
      string,
      {
        board: ModuleBoard | null;
        pending: { runId: string; startedAt: number; op: string } | null;
        error: string | null;
        /** Phase 19 — the ephemeral query session's id, pinned from
         *  `module.query.created`. Lets `reconcileModuleBoards()` recover a
         *  run whose `session.synced(done)` was missed during a WS blip
         *  (the companion only replays the active session on reconnect, not
         *  ephemeral module-query sessions). Not persisted. */
        pendingSessionId?: string | null;
      }
    >
  >({});

  /** Per-module op timers, keyed by module id. */
  private moduleOpTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Recompute the DERIVED `currentRun` from the raw agent run + the
   *  user overlay. Call after every mutation to either input. Snapshots
   *  the reactive inputs so mergeAuditRun (a pure fn) sees plain data. */
  private recomputeAuditRun(): void {
    this.audit.currentRun = mergeAuditRun(
      this.audit.agentRun ? $state.snapshot(this.audit.agentRun) : null,
      $state.snapshot(this.audit.overlay),
    );
  }

  async loadAuditRun(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.AUDIT_KEY,
      );
      const raw = stored?.[ExtensionState.AUDIT_KEY] as AuditRun | undefined;
      if (raw && typeof raw === "object" && Array.isArray(raw.categories)) {
        this.audit.agentRun = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
    // Restore the user-curated overlay (added / edited / deleted
    // checks + categories). Defensive shape-check so a corrupt value
    // doesn't crash the merge — fall back to the empty overlay.
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.AUDIT_OVERLAY_KEY,
      );
      const raw = stored?.[ExtensionState.AUDIT_OVERLAY_KEY] as
        | AuditOverlay
        | undefined;
      if (
        raw &&
        typeof raw === "object" &&
        Array.isArray(raw.addedCategories) &&
        Array.isArray(raw.deleted) &&
        raw.addedChecks &&
        typeof raw.addedChecks === "object" &&
        raw.edits &&
        typeof raw.edits === "object"
      ) {
        this.audit.overlay = raw;
      }
    } catch {
      // storage missing — empty overlay default stands
    }
    // Derive the user-facing run from agentRun + overlay.
    this.recomputeAuditRun();
    // Also restore the user's category-selection preference so the
    // empty-state checkboxes reflect what they picked last time.
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.AUDIT_SELECTED_KEY,
      );
      const raw = stored?.[ExtensionState.AUDIT_SELECTED_KEY] as
        | string[]
        | undefined;
      if (Array.isArray(raw) && raw.length > 0) {
        // Only accept ids we currently recognize. New phases may add
        // ids (cross-browser, custom audits); old stored selections
        // that mention them are kept verbatim — runAudit just sends
        // them on the wire and the agent decides what to do.
        this.audit.selectedCategories = raw.filter(
          (s): s is AuditCategoryId => typeof s === "string",
        );
      }
    } catch {
      // storage missing — defaults stand
    }
  }

  /** Update the audit category selection. Writes to memory + persists
   *  to chrome.storage so the empty-state checkboxes rehydrate
   *  correctly on next panel open. Empty arrays are rejected (the
   *  Run button is also disabled at zero — defense-in-depth). */
  setAuditSelectedCategories(categories: AuditCategoryId[]): void {
    if (categories.length === 0) return;
    this.audit.selectedCategories = categories;
    try {
      void chrome.storage?.local?.set({
        [ExtensionState.AUDIT_SELECTED_KEY]: categories,
      });
    } catch {
      // ignore — in-memory still drives the next run this session
    }
  }

  private async saveAuditRun(): Promise<void> {
    try {
      // AUDIT_KEY holds the RAW agent run (not the merged view); the
      // overlay is stored separately so user edits persist independently.
      if (this.audit.agentRun) {
        await chrome.storage?.local?.set({
          [ExtensionState.AUDIT_KEY]: $state.snapshot(this.audit.agentRun),
        });
      } else {
        await chrome.storage?.local?.remove(ExtensionState.AUDIT_KEY);
      }
      await chrome.storage?.local?.set({
        [ExtensionState.AUDIT_OVERLAY_KEY]: $state.snapshot(this.audit.overlay),
      });
    } catch (err) {
      if (ExtensionState.isQuotaExceeded(err)) {
        this.audit.error =
          "Browser storage is full — audit results couldn't save. " +
          "Try clearing chat history or older Test Pilot catalogs.";
      }
    }
  }

  /** Hydrate the per-finding disposition map from chrome.storage.
   *  Mirrors loadAuditRun — read one key, one value. Tolerates a
   *  missing storage API (test env) by leaving the {} default. */
  async loadAuditDispositions(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.AUDIT_DISPOSITIONS_KEY,
      );
      const raw = stored?.[ExtensionState.AUDIT_DISPOSITIONS_KEY] as
        | Record<string, AuditDisposition>
        | undefined;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.audit.dispositions = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  /** Persist the disposition map. Mirrors saveAuditRun — snapshot the
   *  reactive map before handing it to chrome.storage. */
  private async saveAuditDispositions(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.AUDIT_DISPOSITIONS_KEY]: $state.snapshot(
          this.audit.dispositions,
        ),
      });
    } catch (err) {
      if (ExtensionState.isQuotaExceeded(err)) {
        this.audit.error =
          "Browser storage is full — audit progress couldn't save. " +
          "Try clearing chat history or older Test Pilot catalogs.";
      }
    }
  }

  /** Set (or clear) a finding's remediation disposition. Keyed by the
   *  check's stable fingerprint id so it survives re-runs. Setting back
   *  to "open" deletes the entry to keep the stored map lean (an absent
   *  key already defaults to "open"). Persists after each change. */
  setAuditDisposition(checkId: string, d: AuditDisposition): void {
    if (d === "open") {
      delete this.audit.dispositions[checkId];
    } else {
      this.audit.dispositions[checkId] = d;
    }
    void this.saveAuditDispositions();
  }

  // ─── Per-finding Discuss (chat) + File issue (Phase 15e) ───────────
  //
  // Discuss reuses the Chat module's per-row pattern (op "audit-discuss",
  // context.kind "audit-check"). File issue rides op "audit-file-issue":
  // the agent files a GitLab issue via `glab` when the gitlab-issues
  // module is configured, else appends the finding to .pinta/tasks.md.
  // Both run in the user's interactive Claude Code terminal (the
  // companion never shells out) — same compliance lane as the rest.

  private async loadAuditCheckChats(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.AUDIT_CHECK_CHATS_KEY,
      );
      const raw = stored?.[ExtensionState.AUDIT_CHECK_CHATS_KEY] as
        | Record<string, ChatMessage[]>
        | undefined;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.audit.checkChats = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  private async saveAuditCheckChats(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.AUDIT_CHECK_CHATS_KEY]: $state.snapshot(
          this.audit.checkChats,
        ),
      });
    } catch (err) {
      if (ExtensionState.isQuotaExceeded(err)) {
        this.audit.error =
          "Browser storage is full — the Discuss thread couldn't save. " +
          "Try clearing chat history or older Test Pilot catalogs.";
      }
    }
  }

  private async loadAuditFiledIssues(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.AUDIT_FILED_ISSUES_KEY,
      );
      const raw = stored?.[ExtensionState.AUDIT_FILED_ISSUES_KEY] as
        | (typeof this.audit)["filedIssues"]
        | undefined;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.audit.filedIssues = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  private async saveAuditFiledIssues(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.AUDIT_FILED_ISSUES_KEY]: $state.snapshot(
          this.audit.filedIssues,
        ),
      });
    } catch (err) {
      if (ExtensionState.isQuotaExceeded(err)) {
        this.audit.error =
          "Browser storage is full — the filed-issue record couldn't save.";
      }
    }
  }

  /** Arm a per-finding op timeout so a stuck agent clears the spinner. */
  private armAuditOpTimer(
    op: string,
    checkId: string,
    pendingMap: Record<string, boolean>,
  ): void {
    const key = `${op}:${checkId}`;
    this.clearAuditOpTimer(op, checkId);
    this.armAgentWait({
      softMs: ExtensionState.AUDIT_OP_TIMEOUT_MS,
      what: "respond",
      setHandle: (t) => this.auditOpTimers.set(key, t),
      stillPending: () => !!pendingMap[checkId],
      giveUp: () => {
        this.auditOpTimers.delete(key);
        delete pendingMap[checkId];
        this.audit.error = ExtensionState.slowWaitGiveUp("respond");
      },
    });
  }

  private clearAuditOpTimer(op: string, checkId: string): void {
    const key = `${op}:${checkId}`;
    const t = this.auditOpTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.auditOpTimers.delete(key);
    }
    this.retireAgentWaitNotice();
  }

  /** Send a Discuss message about one finding. Mirrors Test Pilot's
   *  per-row `sendChatMessage` — optimistic append, fire over WS, reply
   *  lands via session.synced → handleAuditCheckChatSync. */
  async sendAuditCheckChat(
    check: AuditCheck,
    prompt: string,
    images: ChatImage[] = [],
  ): Promise<void> {
    const text = prompt.trim();
    if (!text && images.length === 0) return;
    if (this.audit.pendingCheckChat[check.id]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.audit.error =
        "No companion connected. Start `pinta-companion .` in your project to use Discuss.";
      return;
    }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    };
    this.audit.checkChats[check.id] = [
      ...(this.audit.checkChats[check.id] ?? []),
      userMsg,
    ];
    this.audit.error = null;
    void this.saveAuditCheckChats();

    const history = (this.audit.checkChats[check.id] ?? []).slice(
      -ExtensionState.CHAT_HISTORY_CAP,
    );
    const detailedResponses =
      this.modules["chat"]?.settings?.detailed_responses === true;
    const queryComment = JSON.stringify({
      op: "audit-discuss",
      runId: this.audit.currentRun?.runId,
      checkId: check.id,
      prompt: text,
      context: {
        kind: "audit-check",
        category: check.category,
        label: check.label,
        description: check.description,
        fixHint: check.fixHint,
        status: check.status,
        where: check.where,
        detailedResponses,
      },
      history: history.map((m) => ({
        role: m.role,
        text: m.text + (m.images?.length ? ` [${m.images.length} image]` : ""),
      })),
      ...(images.length > 0 ? { images } : {}),
    });
    this.audit.pendingCheckChat[check.id] = true;
    this.armAuditOpTimer("audit-discuss", check.id, this.audit.pendingCheckChat);
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "audit-flow",
      moduleSettings: this.modules["audit-flow"]?.settings ?? {},
      queryComment,
    });
  }

  private applyAuditCheckChatResult(
    payload: { [k: string]: unknown },
    fallbackCheckId?: string,
  ): void {
    const cid =
      (typeof payload.checkId === "string" ? payload.checkId : null) ??
      fallbackCheckId ??
      null;
    const reply =
      typeof payload.reply === "string"
        ? repairReplacementChars(repairMojibake(payload.reply))
        : "";
    if (!cid || !reply) return;
    const thread = this.audit.checkChats[cid] ?? [];
    const lastUser = [...thread].reverse().find((m) => m.role === "user");
    const now = Date.now();
    const agentMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "agent",
      text: reply,
      at: now,
      elapsedMs: lastUser ? now - lastUser.at : undefined,
      tokens: extractTokens(payload),
    };
    this.audit.checkChats[cid] = [...thread, agentMsg];
    this.audit.error = null;
    void this.saveAuditCheckChats();
  }

  private handleAuditCheckChatSync(session: Session, checkId: string): void {
    const hadPending = !!this.audit.pendingCheckChat[checkId];
    if (session.status === "done") {
      this.clearAuditOpTimer("audit-discuss", checkId);
      const { payload, replyText } = parseAgentChatReply(
        session.appliedSummary ?? "",
      );
      if (payload) this.applyAuditCheckChatResult(payload, checkId);
      else if (replyText) this.applyAuditCheckChatResult({ reply: replyText }, checkId);
      else this.audit.error = "Agent returned an empty response.";
      if (hadPending) delete this.audit.pendingCheckChat[checkId];
    } else if (session.status === "error") {
      this.clearAuditOpTimer("audit-discuss", checkId);
      this.audit.error =
        session.errorMessage ?? "Discuss failed for this finding.";
      if (hadPending) delete this.audit.pendingCheckChat[checkId];
    }
  }

  /** File one finding as an issue. The agent files a GitLab issue via
   *  `glab` when the gitlab-issues module is configured, else appends it
   *  to `.pinta/tasks.md` (the local fallback). */
  async fileAuditCheckAsIssue(check: AuditCheck): Promise<void> {
    if (this.audit.pendingFileIssue[check.id]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.audit.error =
        "No companion connected. Start `pinta-companion .` in your project to file an issue.";
      return;
    }
    const gl = this.modules["gitlab-issues"];
    const gitlab = gl?.enabled
      ? {
          projectId: (gl.settings?.project_id as string) || undefined,
          labels: (gl.settings?.labels as string) || undefined,
        }
      : null;
    const queryComment = JSON.stringify({
      op: "audit-file-issue",
      runId: this.audit.currentRun?.runId,
      checkId: check.id,
      finding: {
        category: check.category,
        label: check.label,
        description: check.description,
        fixHint: check.fixHint,
        status: check.status,
        value: check.value,
        where: check.where,
      },
      gitlab,
      fallbackToLocal: true,
    });
    this.audit.error = null;
    this.audit.pendingFileIssue[check.id] = true;
    this.armAuditOpTimer("audit-file-issue", check.id, this.audit.pendingFileIssue);
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "audit-flow",
      moduleSettings: this.modules["audit-flow"]?.settings ?? {},
      queryComment,
    });
  }

  private handleAuditFileIssueSync(session: Session, checkId: string): void {
    const hadPending = !!this.audit.pendingFileIssue[checkId];
    if (session.status === "done") {
      this.clearAuditOpTimer("audit-file-issue", checkId);
      let payload: { [k: string]: unknown } | null = null;
      try {
        payload = JSON.parse(session.appliedSummary ?? "");
      } catch {
        payload = null;
      }
      if (payload && payload.type === "audit-issue-filed") {
        this.audit.filedIssues[checkId] = {
          target: payload.target === "gitlab" ? "gitlab" : "local",
          url: typeof payload.url === "string" ? payload.url : undefined,
          path: typeof payload.path === "string" ? payload.path : undefined,
          title: typeof payload.title === "string" ? payload.title : undefined,
          at: Date.now(),
        };
        this.audit.error = null;
        void this.saveAuditFiledIssues();
      } else {
        this.audit.error =
          "Couldn't file this finding — the agent didn't confirm where it landed.";
      }
      if (hadPending) delete this.audit.pendingFileIssue[checkId];
    } else if (session.status === "error") {
      this.clearAuditOpTimer("audit-file-issue", checkId);
      this.audit.error = session.errorMessage ?? "Filing this finding failed.";
      if (hadPending) delete this.audit.pendingFileIssue[checkId];
    }
  }

  /** Kick off an audit run. Reads `this.audit.selectedCategories`
   *  for which categories to inspect (set by the picker UI), or
   *  accepts an explicit override for ad-hoc runs / re-runs. Bails
   *  in standalone — audits need the agent to read project files. */
  async runAudit(categories?: AuditCategoryId[]): Promise<void> {
    if (this.audit.pending) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.audit.error =
        "No companion connected. Start `pinta-companion .` in your project to run AuditFlow.";
      return;
    }
    const cats = categories ?? this.audit.selectedCategories;
    // Custom categories the user added — sent so the agent actually
    // evaluates them (their effective checks come from the merged
    // currentRun; overlay.addedCategories[*].checks is always []).
    const customCategories = this.collectCustomCategoriesForQuery();
    if (cats.length === 0 && customCategories.length === 0) {
      this.audit.error = "Pick at least one category before running the audit.";
      return;
    }
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    this.audit.pending = { runId, startedAt };
    this.audit.error = null;
    this.claimNotice = null;
    this.armAuditTimeout();
    const url = this.lastUrl ?? "";
    const queryComment = JSON.stringify({
      op: "audit",
      runId,
      categories: cats,
      customCategories,
      userChecks: this.collectUserChecksForQuery(),
      scope: { kind: "project" }, // 15a: project scope only
      partial: false,
    });
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "audit-flow",
      moduleSettings: {},
      queryComment,
    });
  }

  /** Re-run a single category (built-in or custom) from its ⋮ menu. The
   *  result is spliced into the existing run (see applyAuditResult's
   *  partial branch) so the other category cards stay put. */
  async runAuditCategory(categoryId: string): Promise<void> {
    if (this.audit.pending) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.audit.error =
        "No companion connected. Start `pinta-companion .` in your project to run AuditFlow.";
      return;
    }
    const isCustom = categoryId.startsWith("audit-flow-custom:");
    const customCategories = isCustom
      ? this.collectCustomCategoriesForQuery().filter((c) => c.id === categoryId)
      : [];
    const cats: AuditCategoryId[] = isCustom
      ? []
      : [categoryId as AuditCategoryId];
    if (cats.length === 0 && customCategories.length === 0) {
      // Custom category vanished from the merged view (e.g. deleted) —
      // nothing to re-run.
      return;
    }
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    this.audit.pending = { runId, startedAt, partial: true, categoryId };
    this.audit.error = null;
    this.armAuditTimeout();
    const queryComment = JSON.stringify({
      op: "audit",
      runId,
      categories: cats,
      customCategories,
      userChecks: this.collectUserChecksForQuery().filter(
        (u) => u.categoryId === categoryId,
      ),
      scope: { kind: "project" },
      partial: true,
    });
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "audit-flow",
      moduleSettings: {},
      queryComment,
    });
  }

  /** Snapshot the user's custom categories (with their effective merged
   *  checks) into the lean shape the agent needs to evaluate them. */
  private collectCustomCategoriesForQuery(): {
    id: string;
    name: string;
    checks: {
      id: string;
      label: string;
      description?: string;
      status: AuditCheckStatus;
    }[];
  }[] {
    const cats = this.audit.currentRun?.categories ?? [];
    return cats
      .filter((c) => c.id.startsWith("audit-flow-custom:"))
      .map((c) => ({
        id: c.id,
        name: c.name,
        checks: (c.checks ?? []).map((ck) => ({
          id: ck.id,
          label: ck.label,
          description: ck.description,
          status: ck.status,
        })),
      }));
  }

  /** User-added checks WITHIN built-in categories (USER- ids), in the
   *  lean shape the agent evaluates. Custom *categories* go via
   *  collectCustomCategoriesForQuery; this covers checks the user added
   *  (or accepted from "Suggest checks") onto Security / Performance /
   *  etc. — sending them so a (re-)run actually EVALUATES them, giving
   *  each a real status, description, where + fixHint, and unlocking
   *  Fix-with-agent. The agent echoes them back inside the built-in
   *  category's checks[] with the same id, and mergeAuditRun lets that
   *  evaluated copy replace the user's placeholder. */
  private collectUserChecksForQuery(): {
    categoryId: string;
    id: string;
    label: string;
    description?: string;
  }[] {
    const out: {
      categoryId: string;
      id: string;
      label: string;
      description?: string;
    }[] = [];
    for (const c of this.audit.currentRun?.categories ?? []) {
      if (c.id.startsWith("audit-flow-custom:")) continue;
      for (const ck of c.checks ?? []) {
        if (typeof ck.id === "string" && ck.id.startsWith("USER-")) {
          out.push({
            categoryId: c.id,
            id: ck.id,
            label: ck.label,
            description: ck.description,
          });
        }
      }
    }
    return out;
  }

  /** User clicked Cancel on a stuck audit run. */
  cancelAudit(): void {
    if (!this.audit.pending) return;
    this.clearAuditTimeout();
    this.audit.pending = null;
    this.claimNotice = null;
    this.audit.error = "Audit cancelled.";
  }

  private armAuditTimeout(): void {
    this.clearAuditTimeout();
    this.armAgentWait({
      softMs: ExtensionState.AUDIT_TIMEOUT_MS,
      what: "finish the audit",
      setHandle: (t) => {
        this.auditTimer = t;
      },
      stillPending: () => !!this.audit.pending,
      giveUp: () => {
        if (!this.audit.pending) return;
        this.audit.pending = null;
        this.audit.error = ExtensionState.slowWaitGiveUp("finish the audit");
      },
    });
  }

  private clearAuditTimeout(): void {
    if (this.auditTimer) {
      clearTimeout(this.auditTimer);
      this.auditTimer = null;
    }
    this.retireAgentWaitNotice();
  }

  // ─── Imported interactive modules — generic board ops (Phase 19) ─────
  // Drives the DYNAMIC tabs declared by imported modules' manifests. All
  // module-agnostic: the agent returns a ModuleBoard, the generic
  // ModuleBoardTab renders it. Mirrors the audit op/sync lifecycle.

  private ensureModuleBoard(moduleId: string): {
    board: ModuleBoard | null;
    pending: { runId: string; startedAt: number; op: string } | null;
    error: string | null;
    pendingSessionId?: string | null;
  } {
    if (!this.moduleBoards[moduleId]) {
      this.moduleBoards[moduleId] = { board: null, pending: null, error: null };
    }
    return this.moduleBoards[moduleId]!;
  }

  /** Fire the tab's primary action: send the declared `op` to the agent
   *  for an imported interactive module. The agent returns a ModuleBoard
   *  via mark_session_done, routed back through handleModuleBoardSync. */
  async runModuleOp(moduleId: string, op: string): Promise<void> {
    const slot = this.ensureModuleBoard(moduleId);
    if (slot.pending) return;
    if (!this.client || this.connectionStatus !== "connected") {
      slot.error =
        "No companion connected. Start `pinta-companion .` in your project to use this module.";
      return;
    }
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    slot.pending = { runId, startedAt, op };
    slot.pendingSessionId = null; // pinned when module.query.created lands
    slot.error = null;
    this.armModuleTimeout(moduleId);
    const settings = $state.snapshot(
      this.modules[moduleId]?.settings ?? {},
    ) as Record<string, string | boolean>;
    const queryComment = JSON.stringify({ op, runId, settings });
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId,
      moduleSettings: settings,
      queryComment,
    });
  }

  cancelModuleOp(moduleId: string): void {
    const slot = this.moduleBoards[moduleId];
    if (!slot?.pending) return;
    this.clearModuleTimeout(moduleId);
    slot.pending = null;
    slot.pendingSessionId = null;
    slot.error = "Cancelled.";
  }

  private armModuleTimeout(moduleId: string): void {
    this.clearModuleTimeout(moduleId);
    this.armAgentWait({
      softMs: ExtensionState.MODULE_OP_TIMEOUT_MS,
      what: "respond",
      setHandle: (t) => this.moduleOpTimers.set(moduleId, t),
      stillPending: () => !!this.moduleBoards[moduleId]?.pending,
      giveUp: () => {
        const slot = this.moduleBoards[moduleId];
        this.moduleOpTimers.delete(moduleId);
        if (!slot?.pending) return;
        slot.pending = null;
        slot.pendingSessionId = null;
        slot.error = ExtensionState.slowWaitGiveUp("respond");
      },
    });
  }

  private clearModuleTimeout(moduleId: string): void {
    const t = this.moduleOpTimers.get(moduleId);
    if (t) {
      clearTimeout(t);
      this.moduleOpTimers.delete(moduleId);
    }
    this.retireAgentWaitNotice();
  }

  /** Routed from onMessage when a session.synced for an imported
   *  interactive module lands. Done → parse the ModuleBoard; error →
   *  surface it. Lenient: requires only groups[] + cards[] arrays. */
  private handleModuleBoardSync(session: Session, moduleId: string): void {
    const slot = this.ensureModuleBoard(moduleId);
    if (session.status === "done") {
      const summary = session.appliedSummary ?? "";
      // Empty "done" (multi-agent race) — keep pending + timer so a real
      // response can still land. Mirrors handleAuditSync.
      if (summary.trim() === "") return;
      this.clearModuleTimeout(moduleId);
      try {
        const payload = JSON.parse(summary) as Partial<ModuleBoard> & {
          [k: string]: unknown;
        };
        if (Array.isArray(payload.groups) && Array.isArray(payload.cards)) {
          slot.board = {
            moduleId,
            generatedAt:
              typeof payload.generatedAt === "number"
                ? payload.generatedAt
                : Date.now(),
            title:
              typeof payload.title === "string" ? payload.title : undefined,
            groups: payload.groups as ModuleBoard["groups"],
            cards: payload.cards as ModuleBoard["cards"],
            featured: Array.isArray(payload.featured)
              ? (payload.featured as string[])
              : undefined,
          };
          void this.saveModuleBoards();
        } else {
          const preview = summary.slice(0, 200);
          slot.error =
            `This module returned an unrecognized response ` +
            `(expected a board with groups + cards). ` +
            `Restart \`/pinta\` so the module's agent.md is loaded.` +
            (preview
              ? ` Agent said: "${preview}${summary.length > 200 ? "…" : ""}"`
              : "");
        }
      } catch (err) {
        slot.error = `Couldn't parse the module response: ${(err as Error).message}`;
      }
      slot.pending = null;
      slot.pendingSessionId = null;
    } else if (session.status === "error") {
      this.clearModuleTimeout(moduleId);
      slot.error = session.errorMessage ?? "The module run failed.";
      slot.pending = null;
      slot.pendingSessionId = null;
    } else if (session.status === "applying") {
      slot.error = null;
    }
  }

  /**
   * On (re)connect, recover any imported-interactive module run whose
   * `session.synced(done)` we may have missed while the socket was down.
   * The companion replays only the *active* session on connect, never the
   * ephemeral module-query sessions, so a multi-minute run that finishes
   * during a WS blip would otherwise spin until MODULE_OP_TIMEOUT_MS.
   *
   * For each slot still `pending` with a pinned ephemeral session id,
   * fetch that session over HTTP and, if it has reached a terminal state,
   * route it through the normal handler (idempotent — same path the live
   * broadcast would have taken). A still-running session is left alone;
   * the timeout safety net still applies. Best-effort: any fetch error
   * leaves the slot pending so a later reconnect (or the timeout) recovers.
   */
  private async reconcileModuleBoards(): Promise<void> {
    const base = this.httpBase();
    if (!base) return;
    // Snapshot the entries up front — handleModuleBoardSync mutates
    // this.moduleBoards as we go.
    const pendingSlots = Object.entries(this.moduleBoards).filter(
      ([, slot]) => slot.pending && slot.pendingSessionId,
    );
    for (const [moduleId, slot] of pendingSlots) {
      const sessionId = slot.pendingSessionId;
      if (!sessionId) continue;
      try {
        const res = await ExtensionState.fetchWithTimeout(
          `${base}/v1/sessions/${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) continue;
        const session = (await res.json()) as Session;
        if (session.status === "done" || session.status === "error") {
          this.handleModuleBoardSync(session, moduleId);
        }
      } catch {
        // Companion unreachable / transient — keep pending; a later
        // reconnect or the module-op timeout will recover it.
      }
    }
  }

  /**
   * On (re)connect — or via the reconcile heartbeat when the socket is
   * half-open and no reconnect ever fires — recover a report run whose
   * `session.synced(done)` we missed. The companion never replays the
   * ephemeral report query session, so a report that finished during a WS
   * blip would otherwise spin until REPORT_TIMEOUT_MS (10 min). Mirrors
   * reconcileModuleBoards: fetch the pinned session over HTTP and, if it
   * reached a terminal state, route it through the normal handler
   * (idempotent — same path the live broadcast would have taken).
   * Best-effort — any fetch error leaves `pending` for a later reconnect /
   * heartbeat / timeout to resolve.
   */
  private async reconcileReport(): Promise<void> {
    const base = this.httpBase();
    if (!base) return;
    const pending = this.report.pending;
    if (!pending || !pending.sessionId) return;
    try {
      const res = await ExtensionState.fetchWithTimeout(
        `${base}/v1/sessions/${encodeURIComponent(pending.sessionId)}`,
      );
      if (!res.ok) return;
      const session = (await res.json()) as Session;
      if (session.status === "done" || session.status === "error") {
        this.handleReportSync(session);
      }
    } catch {
      // Companion unreachable / transient — keep pending; a later
      // reconnect or the report timeout will recover it.
    }
  }

  /** Heartbeat that re-fetches in-flight batch status over HTTP while any
   *  batch is pending. Recovers a HALF-OPEN WebSocket — the companion was
   *  restarted (or the socket silently died) so it never sent a close
   *  frame: the extension still shows "connected", the live done-broadcast
   *  never lands, and no reconnect ever fires the connect-time reconcile,
   *  so the submitted card spins forever. The HTTP poll is a fresh
   *  connection that bypasses the dead socket. Self-stops when idle. */
  private static readonly RECONCILE_HEARTBEAT_MS = 25_000;
  private reconcileHeartbeat: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard so an overlapping heartbeat + connect-time sweep
   *  don't stack concurrent fetch loops. */
  private reconcileRunning = false;
  /** Batch ids the companion 404'd (forgotten / store reset) — skip in the
   *  heartbeat so it doesn't poll a dead session forever. Cleared on a
   *  fresh reconnect so each gets one more chance. */
  private reconciledOrphans = new Set<string>();

  /**
   * On (re)connect, recover any in-flight annotation batch whose
   * `session.synced(applying|done|error)` we missed while the socket was
   * down. The companion replays only the active draft + terminal *module*
   * sessions on connect (ws.ts `selectReconnectReplaySessions`), never
   * plain annotation batches — so a batch the agent finished during a WS
   * blip would otherwise sit "submitted" forever in the tray with a stale
   * "still waiting for an agent" claim notice that never retires. Mirrors
   * reconcileModuleBoards.
   *
   * For each tracked batch, fetch its current session over HTTP; if the
   * server's status is ahead of what we hold, update the tray row in place
   * (idempotent — same shape the live `session.synced` broadcast carries)
   * and retire the claim warning once it leaves "submitted". Best-effort:
   * any fetch error (or a 404 for a session the companion has forgotten)
   * leaves the row as-is for a later reconnect / live broadcast / manual
   * dismiss to resolve.
   */
  private async reconcileInFlightBatches(): Promise<void> {
    const base = this.httpBase();
    if (!base) return;
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      // Snapshot ids up front — the array is mutated as we apply updates and
      // the user may dismiss a row while an await is in flight.
      const ids = this.inFlightBatches.map((b) => b.id);
      for (const id of ids) {
        // A batch the companion already 404'd can't progress through this
        // process; skip it so the heartbeat doesn't poll it forever. A real
        // reconnect clears the orphan set and gives it one more chance.
        if (this.reconciledOrphans.has(id)) continue;
        try {
          const res = await ExtensionState.fetchWithTimeout(
            `${base}/v1/sessions/${encodeURIComponent(id)}`,
          );
          if (!res.ok) {
            // 404 → the companion has no record of this batch (finished and
            // pruned, or a store reset). It can't progress, so retire any
            // stale "still waiting for an agent" notice, stop re-polling it,
            // and leave the tray row so the user still sees it existed and
            // can dismiss it.
            if (res.status === 404) {
              this.reconciledOrphans.add(id);
              this.clearClaimWarning(id);
            }
            continue;
          }
          const session = (await res.json()) as Session;
          const idx = this.inFlightBatches.findIndex((b) => b.id === id);
          if (idx === -1) continue; // dismissed mid-fetch
          // The companion store only moves status forward, so any change is
          // an advance worth applying. Skip a no-op to avoid a needless
          // reactive churn.
          if (session.status === this.inFlightBatches[idx]!.status) continue;
          this.inFlightBatches[idx] = session;
          this.inFlightBatches = [...this.inFlightBatches];
          // Leaving "submitted" retires the stale claim-warning notice —
          // same effect as the live session.synced path's top-of-switch
          // clearClaimWarning(msg.session.id).
          if (session.status !== "submitted") {
            this.clearClaimWarning(id);
          }
        } catch {
          // Companion unreachable / transient — keep the row; a later
          // reconnect or live broadcast recovers it.
        }
      }
    } finally {
      this.reconcileRunning = false;
    }
  }

  /** True while some in-flight annotation batch is still waiting on the
   *  agent (submitted/applying) and the companion hasn't 404'd it. Drives
   *  the reconcile-heartbeat lifecycle — when this goes false the heartbeat
   *  self-stops on its next tick. */
  private hasReconcilableBatches(): boolean {
    return this.inFlightBatches.some(
      (b) =>
        (b.status === "submitted" || b.status === "applying") &&
        !this.reconciledOrphans.has(b.id),
    );
  }

  /** True while any reconcilable run is in flight — an annotation batch
   *  (submitted/applying) OR a report run with a pinned session id. Drives
   *  the reconcile-heartbeat lifecycle so a half-open socket self-heals the
   *  Phase 16 report slot too, not just batches. (Module boards reconcile
   *  on reconnect only; the report slot opts into the heartbeat because a
   *  report can finish long after submit, well inside a half-open window.) */
  private hasReconcilableWork(): boolean {
    return this.hasReconcilableBatches() || !!this.report.pending?.sessionId;
  }

  /** Start the reconcile heartbeat if a batch or report is pending and it
   *  isn't already running. Idempotent. */
  private ensureReconcileHeartbeat(): void {
    if (this.reconcileHeartbeat) return;
    if (!this.hasReconcilableWork()) return;
    this.reconcileHeartbeat = setInterval(() => {
      if (!this.hasReconcilableWork()) {
        this.stopReconcileHeartbeat();
        return;
      }
      void this.reconcileInFlightBatches();
      void this.reconcileReport();
    }, ExtensionState.RECONCILE_HEARTBEAT_MS);
  }

  private stopReconcileHeartbeat(): void {
    if (this.reconcileHeartbeat) {
      clearInterval(this.reconcileHeartbeat);
      this.reconcileHeartbeat = null;
    }
  }

  async loadModuleBoards(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.MODULE_BOARDS_KEY,
      );
      const raw = stored?.[ExtensionState.MODULE_BOARDS_KEY] as
        | Record<string, ModuleBoard>
        | undefined;
      if (raw && typeof raw === "object") {
        for (const [id, board] of Object.entries(raw)) {
          if (
            board &&
            Array.isArray((board as ModuleBoard).groups) &&
            Array.isArray((board as ModuleBoard).cards)
          ) {
            this.moduleBoards[id] = {
              board: board as ModuleBoard,
              pending: null,
              error: null,
            };
          }
        }
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  private async saveModuleBoards(): Promise<void> {
    try {
      const out: Record<string, ModuleBoard> = {};
      for (const [id, slot] of Object.entries(this.moduleBoards)) {
        if (slot.board) out[id] = $state.snapshot(slot.board) as ModuleBoard;
      }
      await chrome.storage?.local?.set({
        [ExtensionState.MODULE_BOARDS_KEY]: out,
      });
    } catch {
      // quota / storage missing — non-fatal
    }
  }

  /** Routed from `onMessage` when a `session.synced` with
   *  `op: "audit"` arrives. Done → applyAuditResult; error → surface
   *  errorMessage. Lenient on the `type` field so an older /pinta
   *  session (started before §7.11 of SKILL.md landed) doesn't brick
   *  the audit UI when it improvises a different type string. */
  private handleAuditSync(session: Session): void {
    if (!this.audit.pending) return;
    if (session.status === "done") {
      const summary = session.appliedSummary ?? "";
      // Ignore an empty "done" (multi-agent race) rather than crashing
      // JSON.parse — keep `pending` + the timeout so a valid audit
      // response can still land. See handleTestPilotSync for rationale.
      if (summary.trim() === "") return;
      this.clearAuditTimeout();
      try {
        const payload = JSON.parse(summary) as {
          type?: string;
          [k: string]: unknown;
        };
        // Accept several `type` aliases the agent might emit. If the
        // type field is missing entirely but the payload has a
        // categories array, accept the shape too — that's the
        // load-bearing field and any reasonable audit response will
        // have it. Surfaces older /pinta sessions that haven't
        // re-loaded the new SKILL.md.
        const AUDIT_TYPE_ALIASES = new Set([
          "audit-flow-run",
          "audit-run",
          "audit-result",
          "audit",
          "auditFlow",
          "audit_flow_run",
        ]);
        const typeIsAuditShaped =
          typeof payload.type === "string" &&
          AUDIT_TYPE_ALIASES.has(payload.type);
        const shapeIsAuditShaped = Array.isArray(payload.categories);
        if (typeIsAuditShaped || shapeIsAuditShaped) {
          this.applyAuditResult(payload);
        } else {
          // Show what the agent actually returned so the user can
          // diagnose without opening DevTools. Cap at 200 chars so
          // long prose replies don't blow out the error banner.
          const preview = summary.slice(0, 200);
          this.audit.error =
            `Agent returned an unrecognized response. ` +
            `Restart \`/pinta\` in your project (the SKILL.md §7.11 audit handler may not have loaded yet). ` +
            (preview ? `Agent said: "${preview}${summary.length > 200 ? "…" : ""}"` : "");
        }
      } catch (err) {
        this.audit.error = `Couldn't parse agent response: ${(err as Error).message}`;
      }
      this.audit.pending = null;
    } else if (session.status === "error") {
      this.clearAuditTimeout();
      this.audit.error = session.errorMessage ?? "Audit run failed.";
      this.audit.pending = null;
    } else if (session.status === "applying") {
      // A claim landed — the agent is now running this audit. The soft
      // "still waiting for an agent" notice already retires via
      // clearClaimWarning (fired at the top of the session.synced switch
      // when the session leaves `submitted`). Defensively clear any early
      // audit.error too; parse / run-failure errors are set on `done` /
      // `error`, which come later.
      this.audit.error = null;
    }
  }

  // ─── Report module (Phase 16) ───────────────────────────────────────
  // Mirrors AuditFlow's op/sync lifecycle: generateReport fires a
  // `module.query.submit` (op:"report-generate"); the agent gathers
  // git + gh/glab + Pinta activity over the range window and returns a
  // ReportRun via mark_session_done, routed back through handleReportSync.
  // The companion relays the queryComment opaquely — no companion change.

  /** Local calendar date as ISO yyyy-mm-dd — a report anchored on
   *  "today" should match the user's wall clock, not UTC. */
  private static todayISO(): string {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }

  /** Persist + apply the user's range preference (Today / This week /
   *  Sprint) so it sticks across panel reloads. */
  setReportRange(range: ReportRange): void {
    this.report.range = range;
    try {
      void chrome.storage?.local?.set({
        [ExtensionState.REPORT_RANGE_KEY]: range,
      });
    } catch {
      // in-memory still drives the next generate this session
    }
  }

  /** Add an extra repo path to combine into the report. Normalizes
   *  (trims + strips a trailing slash) and dedupes. The primary
   *  (companion) project is implicit and must not be added here. */
  addReportProject(path: string): void {
    const p = path.trim().replace(/[\\/]+$/, "");
    if (!p || this.report.projects.includes(p)) return;
    this.report.projects = [...this.report.projects, p];
    this.saveReportProjects();
  }

  removeReportProject(path: string): void {
    this.report.projects = this.report.projects.filter((x) => x !== path);
    this.saveReportProjects();
  }

  private saveReportProjects(): void {
    try {
      void chrome.storage?.local?.set({
        [ExtensionState.REPORT_PROJECTS_KEY]: $state.snapshot(
          this.report.projects,
        ),
      });
    } catch {
      // in-memory still drives the next generate this session
    }
  }

  /** Generate a report for the given range (defaults to the selected
   *  range, anchored on today). No-op if one's already in flight. */
  async generateReport(
    range?: ReportRange,
    anchorDate?: string,
  ): Promise<void> {
    if (this.report.pending) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.report.error =
        "No companion connected. Start `pinta-companion .` in your project to generate a report.";
      return;
    }
    const r = range ?? this.report.range;
    const anchor = anchorDate ?? ExtensionState.todayISO();
    const { since, until } = rangeWindow(r, anchor);
    const runId = crypto.randomUUID();
    this.report.pending = {
      runId,
      startedAt: Date.now(),
      range: r,
      anchorDate: anchor,
      sessionId: null,
    };
    this.report.error = null;
    this.claimNotice = null;
    this.armReportTimeout();
    const queryComment = JSON.stringify({
      op: "report-generate",
      runId,
      range: r,
      anchorDate: anchor,
      since,
      until,
      includeWeekends: false,
      author: null,
      // Extra repos to combine (Phase 16b). Omitted when empty so a
      // single-project report stays lean. The agent runs `git -C <path>`
      // per entry and tags each item's `project`.
      ...(this.report.projects.length > 0
        ? { projects: $state.snapshot(this.report.projects) }
        : {}),
    });
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "report",
      moduleSettings: {},
      queryComment,
    });
  }

  /** User clicked Cancel on a slow report. */
  cancelReport(): void {
    if (!this.report.pending) return;
    this.clearReportTimeout();
    this.report.pending = null;
    this.report.error = "Cancelled.";
  }

  private armReportTimeout(): void {
    this.clearReportTimeout();
    this.armAgentWait({
      softMs: ExtensionState.REPORT_TIMEOUT_MS,
      what: "generate the report",
      setHandle: (t) => {
        this.reportTimer = t;
      },
      stillPending: () => !!this.report.pending,
      giveUp: () => {
        if (!this.report.pending) return;
        this.report.pending = null;
        this.report.error =
          ExtensionState.slowWaitGiveUp("generate the report");
      },
    });
  }

  private clearReportTimeout(): void {
    if (this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    this.retireAgentWaitNotice();
  }

  /** Routed from onMessage when a `report` module session.synced lands.
   *  Done → parse + store the ReportRun; error → surface it; applying →
   *  clear the early error. Mirrors handleAuditSync. */
  private handleReportSync(session: Session): void {
    if (!this.report.pending) return;
    const pending = this.report.pending;
    if (session.status === "done") {
      const summary = session.appliedSummary ?? "";
      // Empty "done" (multi-agent race) — keep pending + timer so a real
      // response can still land. Mirrors handleAuditSync.
      if (summary.trim() === "") return;
      this.clearReportTimeout();
      try {
        const raw = JSON.parse(summary) as unknown;
        const run = parseReportPayload(raw, {
          runId: pending.runId,
          range: pending.range,
          anchorDate: pending.anchorDate,
          generatedAt: Date.now(),
        });
        if (run) {
          this.report.currentRun = run;
          this.report.error = null;
          void this.saveReportRun();
        } else {
          const preview = summary.slice(0, 200);
          this.report.error =
            `Agent returned an unrecognized report response. ` +
            `Restart \`/pinta\` in your project (the SKILL.md report handler may not have loaded yet). ` +
            (preview
              ? `Agent said: "${preview}${summary.length > 200 ? "…" : ""}"`
              : "");
        }
      } catch (err) {
        this.report.error = `Couldn't parse agent response: ${(err as Error).message}`;
      }
      this.report.pending = null;
    } else if (session.status === "error") {
      this.clearReportTimeout();
      this.report.error = session.errorMessage ?? "Report generation failed.";
      this.report.pending = null;
    } else if (session.status === "applying") {
      this.report.error = null;
    }
  }

  private async saveReportRun(): Promise<void> {
    try {
      if (this.report.currentRun) {
        await chrome.storage?.local?.set({
          [ExtensionState.REPORT_KEY]: $state.snapshot(this.report.currentRun),
        });
      } else {
        await chrome.storage?.local?.remove(ExtensionState.REPORT_KEY);
      }
    } catch (err) {
      if (ExtensionState.isQuotaExceeded(err)) {
        this.report.error =
          "Browser storage is full — the report couldn't save. " +
          "Try clearing chat history or older audit results.";
      }
    }
  }

  async loadReportRun(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(ExtensionState.REPORT_KEY);
      const raw = stored?.[ExtensionState.REPORT_KEY] as ReportRun | undefined;
      if (raw && typeof raw === "object" && Array.isArray(raw.days)) {
        this.report.currentRun = raw;
      }
    } catch {
      // storage missing (test env) — defaults fine
    }
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.REPORT_RANGE_KEY,
      );
      const raw = stored?.[ExtensionState.REPORT_RANGE_KEY] as
        | ReportRange
        | undefined;
      if (raw === "daily" || raw === "weekly" || raw === "sprint") {
        this.report.range = raw;
      }
    } catch {
      // defaults stand
    }
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.REPORT_PROJECTS_KEY,
      );
      const raw = stored?.[ExtensionState.REPORT_PROJECTS_KEY] as
        | string[]
        | undefined;
      if (Array.isArray(raw)) {
        this.report.projects = raw.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // defaults stand
    }
  }

  /** Render the current report as clean markdown for the export button.
   *  Single-project reports stay flat; multi-project reports group each
   *  day's items by project (detected inside renderReportMarkdown). */
  exportReportMarkdown(): string {
    if (!this.report.currentRun) return "";
    return renderReportMarkdown(this.report.currentRun);
  }

  private applyAuditResult(payload: { [k: string]: unknown }): void {
    // Accept several legal shapes:
    //   (a) categories: AuditCategoryResult[] — preferred (SKILL.md spec)
    //   (b) checks: AuditCheck[] — older / improvised shape with no
    //       category wrapping. Wrap into a single synthetic "security"
    //       category so the UI renders.
    let categories: AuditCategoryResult[] = [];
    if (Array.isArray(payload.categories)) {
      categories = payload.categories as AuditCategoryResult[];
    } else if (Array.isArray(payload.checks)) {
      // Synthesize a Security category from a flat checks list.
      const checks = payload.checks as AuditCheck[];
      categories = [
        {
          id: "security",
          name: "Security",
          score: computeCategoryScore(checks),
          checks,
        },
      ];
    }
    // Normalize each category — fill in score if missing, ensure
    // name + checks arrays are well-formed. Defensive against agent
    // omissions; the UI assumes these fields are present.
    categories = categories.map((c) => ({
      id: c.id ?? ("security" as AuditCategoryId),
      name: c.name ?? categoryDisplayName(c.id),
      score: typeof c.score === "number" ? c.score : computeCategoryScore(c.checks ?? []),
      checks: Array.isArray(c.checks) ? c.checks : [],
    }));
    // Single-category re-run (⋮ → "Re-run category"): splice the
    // returned category(s) into the existing run by id rather than
    // replacing it, so the untouched cards stay put. Preserve the
    // existing run's id + startedAt so currentRun.runId is stable and
    // AuditFlowTab's default-expansion $effect doesn't collapse every
    // card. overall/rating are recomputed over the full merged set
    // (payload.overall only covers the re-run subset).
    if (this.audit.pending?.partial) {
      const base = this.audit.agentRun;
      const byId = new Map<string, AuditCategoryResult>(
        (base?.categories ?? []).map((c) => [c.id, c]),
      );
      for (const c of categories) byId.set(c.id, c);
      const mergedCats = [...byId.values()];
      const mergedOverall =
        mergedCats.length > 0
          ? Math.round(
              mergedCats.reduce((sum, c) => sum + c.score, 0) /
                mergedCats.length,
            )
          : 0;
      this.audit.agentRun = {
        runId: base?.runId ?? this.audit.pending.runId,
        startedAt: base?.startedAt ?? this.audit.pending.startedAt,
        completedAt: Date.now(),
        categories: mergedCats,
        overall: mergedOverall,
        rating: ratingFromScore(mergedOverall),
      };
      this.recomputeAuditRun();
      this.audit.error = null;
      void this.saveAuditRun();
      return;
    }

    const runId =
      typeof payload.runId === "string"
        ? payload.runId
        : (this.audit.pending?.runId ?? crypto.randomUUID());
    // Compute overall + rating client-side if missing. The agent
    // SHOULD include both per SKILL.md, but a degraded payload
    // shouldn't leave the UI showing 0 / "Unknown".
    const overall =
      typeof payload.overall === "number"
        ? payload.overall
        : categories.length > 0
          ? Math.round(
              categories.reduce((sum, c) => sum + c.score, 0) /
                categories.length,
            )
          : 0;
    const rating =
      typeof payload.rating === "string"
        ? payload.rating
        : ratingFromScore(overall);
    const run: AuditRun = {
      runId,
      startedAt: this.audit.pending?.startedAt ?? Date.now(),
      completedAt: Date.now(),
      categories,
      overall,
      rating,
    };
    this.audit.agentRun = run;
    this.recomputeAuditRun();
    this.audit.error = null;
    void this.saveAuditRun();
  }

  /** Wipe the audit run from in-memory + chrome.storage. The user
   *  clicked Clear results on the AuditFlow tab. Full reset matching
   *  today's "Clear" semantics: drops the agent run, the user overlay,
   *  AND the dispositions. */
  clearAuditRun(): void {
    this.audit.agentRun = null;
    this.audit.overlay = {
      addedCategories: [],
      addedChecks: {},
      edits: {},
      deleted: [],
    };
    this.audit.dispositions = {};
    this.audit.checkChats = {};
    this.audit.filedIssues = {};
    this.audit.pendingCheckChat = {};
    this.audit.pendingFileIssue = {};
    this.recomputeAuditRun();
    this.audit.error = null;
    void this.saveAuditRun();
    void this.saveAuditDispositions();
    void this.saveAuditCheckChats();
    void this.saveAuditFiledIssues();
  }

  // ─── Catalog export / import (Phase 20 — backup & restore) ─────────
  //
  // AuditFlow's catalog (custom categories + checks + edits + hidden
  // ids) lives only in chrome.storage, so a "clear session / cache"
  // wipes it. Exporting it to a `*.pinta-audit.json` file makes the loss
  // recoverable and ports the catalog across projects. CATALOG ONLY —
  // no agent findings, no dispositions — so a re-import is a clean
  // structural restore, not a stale run. See audit-catalog-doc.ts.

  /** Snapshot the user's audit catalog (overlay + selected categories)
   *  into a portable export envelope. Pure read — no state change. */
  exportAuditCatalog(): AuditCatalogExport {
    return composeAuditCatalog(
      $state.snapshot(this.audit.overlay) as AuditOverlay,
      [...this.audit.selectedCategories],
      Date.now(),
    );
  }

  /** Restore an exported audit catalog. "merge" (default) unions it onto
   *  the current overlay — the safe additive restore; "replace" swaps it
   *  in wholesale. Selected categories from the file are unioned into the
   *  picker so restored custom categories are runnable. Recomputes the
   *  merged view + persists. The agent run + dispositions are untouched. */
  importAuditCatalog(
    data: AuditCatalogExport,
    mode: "merge" | "replace" = "merge",
  ): void {
    const incoming = normalizeAuditOverlay(data.overlay);
    this.audit.overlay =
      mode === "replace"
        ? incoming
        : mergeAuditOverlays(
            $state.snapshot(this.audit.overlay) as AuditOverlay,
            incoming,
          );
    this.recomputeAuditRun();
    this.audit.error = null;
    void this.saveAuditRun();
    if (data.selectedCategories?.length) {
      const sel = new Set<AuditCategoryId>([
        ...this.audit.selectedCategories,
        ...data.selectedCategories,
      ]);
      this.setAuditSelectedCategories([...sel]);
    }
  }

  /** Gather everything the global settings bundle carries: the current
   *  Test Pilot catalog (with results) + the audit catalog. Module config
   *  and audit findings are intentionally excluded (see pinta-settings.ts
   *  for the locked scope). */
  exportSettingsBundle(): PintaSettingsBundle {
    const catalogs: TestPilotCatalog[] = [];
    if (this.testPilot.catalog) {
      catalogs.push(
        $state.snapshot(this.testPilot.catalog) as TestPilotCatalog,
      );
    }
    let appVersion: string | undefined;
    try {
      appVersion = chrome.runtime?.getManifest?.().version;
    } catch {
      // manifest unavailable (test env) — version is optional metadata.
    }
    return composeSettingsBundle(
      {
        testPilot: catalogs,
        auditCatalog: this.exportAuditCatalog(),
        appVersion,
      },
      Date.now(),
    );
  }

  /** Restore a global settings bundle. The audit catalog merges; the
   *  Test Pilot catalog is adopted (single-catalog model) and synced to
   *  disk via the normal edit path so it survives the next wipe too. */
  async importSettingsBundle(bundle: PintaSettingsBundle): Promise<void> {
    if (bundle.auditCatalog) {
      this.importAuditCatalog(bundle.auditCatalog, "merge");
    }
    const tp = bundle.testPilot?.[0];
    if (tp) {
      // Anchor disk artifacts to any existing docId so re-import doesn't
      // orphan the prior .pinta/test-docs/{docId}.md file.
      if (this.testPilot.catalog?.docId) tp.docId = this.testPilot.catalog.docId;
      this.testPilot.catalog = tp;
      this.testPilot.pending = null;
      this.testPilot.error = null;
      // saveTestPilot + push structure .md; results sidecar separately.
      // Both no-op gracefully in standalone (no companion → in-memory only).
      this.commitCatalogEdit();
      this.pushResultsToCompanion();
    }
  }

  // ─── "Suggest checks" (Phase 15 "Slice 3") ─────────────────────────
  // The user clicks "Suggest checks" on a category header; the agent
  // inspects the project for that category's theme and proposes
  // additional audit checks NOT already in the list. They render in an
  // inline checklist under the header; ticked rows land as USER- checks
  // via addAuditCheck (the same overlay path as the manual add-check
  // form). Mirrors Test Pilot's requestSectionSuggestions /
  // handleSuggestSync / addCheckedSuggestions trio.
  //
  // Routing key is the category id: op "audit-suggest" with a top-level
  // `categoryId`, handled by handleAuditSuggestSync. Agent handler:
  // SKILL.md §7.11.

  /** Ask the agent for additional audit checks for one category. */
  async requestAuditSuggestions(
    categoryId: string,
    categoryName: string,
  ): Promise<void> {
    if (this.audit.pendingAuditSuggest[categoryId]) return;
    if (!this.client || this.connectionStatus !== "connected") {
      this.audit.error =
        "No companion connected. Start `pinta-companion .` in your project to suggest checks.";
      return;
    }
    // Existing labels for this category, so the agent can avoid dupes.
    const category = this.audit.currentRun?.categories.find(
      (c) => c.id === categoryId,
    );
    const existing = (category?.checks ?? []).map((c) => c.label);
    const queryComment = JSON.stringify({
      op: "audit-suggest",
      runId: crypto.randomUUID(),
      categoryId,
      categoryName,
      existing,
      count: 6,
    });
    this.audit.pendingAuditSuggest[categoryId] = true;
    // Drop any stale prior suggestions so the panel doesn't flash old
    // picks while the new request is in flight.
    delete this.audit.suggestions[categoryId];
    this.audit.error = null;
    this.send({
      type: "module.query.submit",
      url: this.lastUrl ?? "",
      moduleId: "audit-flow",
      moduleSettings: {},
      queryComment,
    });
  }

  /** Handle an audit-suggest session.synced. Parses the agent's
   *  structured suggestion list and stashes it for the inline checklist
   *  keyed by categoryId. Mirrors handleSuggestSync. */
  private handleAuditSuggestSync(session: Session, categoryId: string): void {
    if (session.status === "done") {
      // Empty-"done" guard first — same multi-agent-race hardening as
      // handleAuditSync / handleTestPilotSync. Leave pending + let a
      // real response land.
      if ((session.appliedSummary ?? "").trim() === "") return;
      delete this.audit.pendingAuditSuggest[categoryId];
      let items: {
        label: string;
        description?: string;
        status?: AuditCheckStatus;
      }[] = [];
      try {
        const payload = JSON.parse(session.appliedSummary ?? "") as {
          type?: string;
          suggestions?: {
            label?: string;
            description?: string;
            status?: AuditCheckStatus;
          }[];
        };
        if (Array.isArray(payload.suggestions)) {
          items = payload.suggestions
            .map((s) => ({
              label: (s.label ?? "").trim(),
              description: s.description?.trim() || undefined,
              status: s.status,
            }))
            .filter((s) => s.label.length > 0);
        }
      } catch {
        // Malformed JSON envelope — leave items empty; the
        // "no suggestions" branch below surfaces a retry hint.
        items = [];
      }
      if (items.length === 0) {
        this.audit.error = `No new check suggestions came back for "${categoryId}".`;
        return;
      }
      this.audit.suggestions[categoryId] = items;
    } else if (session.status === "error") {
      delete this.audit.pendingAuditSuggest[categoryId];
      this.audit.error = session.errorMessage ?? "Suggestion request failed.";
    }
  }

  /** Add the ticked suggestions for a category as USER- checks, then
   *  clear the inline panel. */
  addAuditCheckedSuggestions(
    categoryId: string,
    picked: { label: string; description?: string; status?: AuditCheckStatus }[],
  ): void {
    for (const p of picked) {
      this.addAuditCheck(categoryId, {
        label: p.label,
        description: p.description,
        status: p.status,
      });
    }
    delete this.audit.suggestions[categoryId];
  }

  /** Discard the inline suggestion panel without adding anything. */
  dismissAuditSuggestions(categoryId: string): void {
    delete this.audit.suggestions[categoryId];
  }

  // ─── Catalog editing (Phase 15 "Slice 2") ──────────────────────────
  // Each method mutates `this.audit.overlay`, recomputes the derived
  // `currentRun`, and persists. The overlay is durable across re-runs.

  /** Add a user-authored check to a category. Defaults to status
   *  "warn" so it's actionable (shows in progress + gets a disposition).
   *  id is prefixed `USER-` so the UI + merge can distinguish it from
   *  agent findings. */
  addAuditCheck(
    categoryId: string,
    fields: { label: string; description?: string; status?: AuditCheckStatus },
  ): void {
    const check: AuditCheck = {
      id: "USER-" + crypto.randomUUID(),
      category: categoryId as AuditCategoryId,
      status: fields.status ?? "warn",
      label: fields.label,
      description: fields.description,
    };
    const list = this.audit.overlay.addedChecks[categoryId] ?? [];
    this.audit.overlay.addedChecks[categoryId] = [...list, check];
    this.recomputeAuditRun();
    void this.saveAuditRun();
  }

  /** Edit a check's fields. USER- checks (in addedChecks) are edited in
   *  place; agent checks store an override entry in `overlay.edits` so
   *  the edit re-applies after a re-run regenerates the raw check. */
  editAuditCheck(
    checkId: string,
    patch: { label?: string; description?: string; fixHint?: string },
  ): void {
    if (checkId.startsWith("USER-")) {
      for (const [cat, list] of Object.entries(this.audit.overlay.addedChecks)) {
        const idx = list.findIndex((c) => c.id === checkId);
        const target = idx !== -1 ? list[idx] : undefined;
        if (target) {
          const next = [...list];
          next[idx] = {
            ...target,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
            ...(patch.fixHint !== undefined ? { fixHint: patch.fixHint } : {}),
          };
          this.audit.overlay.addedChecks[cat] = next;
          this.recomputeAuditRun();
          void this.saveAuditRun();
          return;
        }
      }
      return;
    }
    this.audit.overlay.edits[checkId] = {
      ...this.audit.overlay.edits[checkId],
      ...patch,
    };
    this.recomputeAuditRun();
    void this.saveAuditRun();
  }

  /** Delete a check. USER- checks are spliced out of addedChecks; agent
   *  checks are pushed to `overlay.deleted` so the merge hides them.
   *  Also clears any disposition + stale edit entry for the id. */
  deleteAuditCheck(checkId: string): void {
    if (checkId.startsWith("USER-")) {
      for (const [cat, list] of Object.entries(this.audit.overlay.addedChecks)) {
        const idx = list.findIndex((c) => c.id === checkId);
        if (idx !== -1) {
          this.audit.overlay.addedChecks[cat] = list.filter(
            (c) => c.id !== checkId,
          );
          break;
        }
      }
    } else if (!this.audit.overlay.deleted.includes(checkId)) {
      this.audit.overlay.deleted.push(checkId);
    }
    delete this.audit.dispositions[checkId];
    delete this.audit.overlay.edits[checkId];
    this.recomputeAuditRun();
    void this.saveAuditRun();
    void this.saveAuditDispositions();
  }

  /** Add a user-authored custom category. id is prefixed
   *  `audit-flow-custom:` so it sorts + renders as a custom audit. */
  addAuditCategory(name: string): void {
    const cat: AuditCategoryResult = {
      id: ("audit-flow-custom:" + crypto.randomUUID()) as AuditCategoryId,
      name,
      score: 100,
      checks: [],
    };
    this.audit.overlay.addedCategories = [
      ...this.audit.overlay.addedCategories,
      cat,
    ];
    this.recomputeAuditRun();
    void this.saveAuditRun();
  }

  /** Rename a custom category in place. Built-in categories keep their
   *  names — no-op when the id isn't a custom one we own. */
  renameAuditCategory(categoryId: string, name: string): void {
    const idx = this.audit.overlay.addedCategories.findIndex(
      (c) => c.id === categoryId,
    );
    const target = idx !== -1 ? this.audit.overlay.addedCategories[idx] : undefined;
    if (!target) return;
    const next = [...this.audit.overlay.addedCategories];
    next[idx] = { ...target, name };
    this.audit.overlay.addedCategories = next;
    this.recomputeAuditRun();
    void this.saveAuditRun();
  }

  /** Delete a category. Custom categories are removed outright (with
   *  their added checks); built-in (agent) categories are pushed to
   *  `overlay.deleted` so the merge hides them. */
  deleteAuditCategory(categoryId: string): void {
    const isCustom = this.audit.overlay.addedCategories.some(
      (c) => c.id === categoryId,
    );
    if (isCustom) {
      this.audit.overlay.addedCategories =
        this.audit.overlay.addedCategories.filter((c) => c.id !== categoryId);
      delete this.audit.overlay.addedChecks[categoryId];
    } else if (!this.audit.overlay.deleted.includes(categoryId)) {
      this.audit.overlay.deleted.push(categoryId);
    }
    this.recomputeAuditRun();
    void this.saveAuditRun();
  }

  /**
   * Fix-with-agent handoff. Composes a Pinta annotation pre-filled
   * from the audit check, drops it into the active draft session,
   * and switches the side-panel active tab to "annotate" so the user
   * can review the prefilled comment before clicking Submit. If the
   * check carries a `suggestedAnnotation`, that wins; otherwise we
   * synthesize a kind:"select" annotation with sourceFile / sourceLine
   * from `where` and a composed comment.
   *
   * Returns the new annotation id on success so the caller can scroll
   * to it / focus its comment. Standalone mode: silently bails (no
   * companion to ship the eventual submit to).
   */
  async handoffAuditCheckToAnnotate(check: AuditCheck): Promise<string | null> {
    if (this.appMode !== "connected") {
      this.audit.error =
        "Fix-with-agent needs a connected companion. Open this project in Claude Code and re-run.";
      return null;
    }
    // Ensure there's a draft session to append to.
    const url = this.lastUrl ?? "";
    if (!this.session) {
      await this.ensureSession(url);
    }
    const id = uid("ann");
    let annotation: Annotation;
    if (check.suggestedAnnotation) {
      // Agent supplied a fully-formed annotation. Re-stamp id +
      // createdAt so the existing draft's per-annotation tracking
      // doesn't collide with whatever id the agent invented.
      annotation = {
        ...check.suggestedAnnotation,
        id,
        createdAt: Date.now(),
        url: check.suggestedAnnotation.url ?? check.where?.url ?? url,
      };
    } else {
      // Synthesize. kind:"select" with a synthetic target carrying
      // sourceFile/sourceLine from the check — the agent's existing
      // §4 (locate source) handles `target.sourceFile` directly even
      // when selector is empty, so this composes cleanly without
      // SKILL.md changes. Comment carries the full check context so
      // the agent has enough to act.
      const composed = composeAuditFixComment(check);
      const target: AnnotationTarget = {
        selector: "",
        outerHTML: "",
        computedStyles: {},
        nearbyText: [],
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
        sourceFile: check.where?.file,
        sourceLine: check.where?.line,
      };
      annotation = {
        id,
        createdAt: Date.now(),
        kind: "select",
        strokes: [],
        color: "#FF3D6E",
        comment: composed,
        targets: [target],
        target,
        url: check.where?.url ?? url,
      };
    }
    await this.addAnnotation(annotation);
    return id;
  }

  // ─── /Phase 15 ──────────────────────────────────────────────────────

  // ─── Phase 18a — claim-warning UX ──────────────────────────────────
  //
  // When a session sits in "submitted" status for more than
  // CLAIM_WARNING_MS without any `/pinta` agent claiming it, surface
  // a recovery hint to the user. Two causes covered:
  //   1. No `/pinta` terminal is running at all.
  //   2. Phase 18a role flags are in use and no terminal accepts
  //      this session's kind.
  // The message routes to the right error slot based on the session's
  // modules so the affected surface (annotation footer / Test Pilot
  // tab / AuditFlow tab / chat sheet) shows the hint where the user
  // is already looking. Different from the per-flow long-timeout
  // (audit 600s etc.) — those handle "agent picked up, then got
  // stuck"; this handles "no agent ever picked up".

  /** Identify the kind of a session from its modules[] so the warning
   *  message can name the right `/pinta --flag` to start. */
  private static sessionRoleKind(
    session: Session,
  ): "annotate" | "test-pilot" | "audit" | "chat" {
    const ids = session.modules?.map((m) => m.id) ?? [];
    if (ids.includes("audit-flow")) return "audit";
    if (ids.includes("test-pilot")) return "test-pilot";
    if (ids.includes("chat")) return "chat";
    return "annotate";
  }

  /** Compose the unclaimed-session hint. References the role flag the
   *  user would set on a `/pinta` terminal to handle this kind. */
  private static composeClaimWarning(
    kind: "annotate" | "test-pilot" | "audit" | "chat",
  ): string {
    const flagHint = {
      annotate:
        "If none is running, start `/pinta` (or `/pinta --annotate`) in this project's Claude Code terminal.",
      "test-pilot":
        "If none is running, start `/pinta --test-pilot` (or `/pinta`, no flag = generalist) in this project's terminal.",
      audit:
        "If none is running, start `/pinta --audit` (or `/pinta`, no flag = generalist) in this project's terminal.",
      chat:
        "If none is running, start `/pinta --chat` (or `/pinta`, no flag = generalist) in this project's terminal.",
    }[kind];
    const secs = ExtensionState.CLAIM_WARNING_MS / 1000;
    const waited =
      secs >= 60
        ? `${Math.round(secs / 60)}min`
        : `${secs}s`;
    // Reassuring, not alarming — a long queue is expected when the agent
    // is busy. Renders as a warning, not an error (see claimNotice).
    return (
      `Still waiting for an agent to pick this up (~${waited}). ` +
      `If your \`/pinta\` terminal is busy this is normal — it'll start once it's free. ` +
      flagHint
    );
  }

  /** Arm a one-shot warning timer for a session that's just entered
   *  "submitted" status. Idempotent — if a timer already exists for
   *  this session.id (e.g. server re-broadcast the same submitted
   *  state after a reconnect), the existing timer keeps ticking
   *  instead of resetting. That way a reconnect mid-wait doesn't
   *  extend the user's silence. */
  private armClaimWarning(session: Session): void {
    if (this.claimWarnings.has(session.id)) return;
    const kind = ExtensionState.sessionRoleKind(session);
    const timer = setTimeout(() => {
      this.claimWarnings.delete(session.id);
      // Only fire if the session is still our concern AND still in
      // submitted state. Re-check from current state to avoid surfacing
      // a stale warning after the user already cancelled / cleared.
      const text = ExtensionState.composeClaimWarning(kind);
      // Route to the soft `claimNotice` (amber warning), never the red
      // error slots — a long queue isn't a failure. Each kind only warns
      // if its surface is still actually waiting.
      const notice = { sessionId: session.id, text };
      switch (kind) {
        case "audit":
          if (this.audit.pending) this.claimNotice = notice;
          break;
        case "test-pilot":
          if (this.testPilot.pending) this.claimNotice = notice;
          break;
        case "chat":
          // Either global pending OR an annotate-batch pending counts
          // as the chat surface being open and waiting.
          if (
            this.chat.pendingGlobal ||
            Object.keys(this.chat.pendingAnnotateBatch).length > 0
          ) {
            this.claimNotice = notice;
          }
          break;
        case "annotate":
        default: {
          // Phase 20 — on submit the session DETACHES into inFlightBatches
          // and `this.session` becomes a fresh draft, so the old
          // `this.session?.id === session.id` check never matched a
          // detached batch — the "still waiting for an agent" notice
          // silently never fired (a submitted card just spun forever).
          // Honor either the live draft OR a still-submitted tray batch.
          const liveDraftWaiting =
            this.session?.id === session.id &&
            this.session.status === "submitted";
          const detachedWaiting = this.inFlightBatches.some(
            (b) => b.id === session.id && b.status === "submitted",
          );
          if (liveDraftWaiting || detachedWaiting) {
            this.claimNotice = notice;
          }
          break;
        }
      }
    }, ExtensionState.CLAIM_WARNING_MS);
    this.claimWarnings.set(session.id, timer);
  }

  /** Cancel a pending claim-warning. Called when the session moves
   *  out of "submitted" (claimed → applying, or completed, or errored).
   *  Also called when the user cancels / clears manually. */
  private clearClaimWarning(sessionId: string): void {
    const timer = this.claimWarnings.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.claimWarnings.delete(sessionId);
    }
    // Retire an already-shown notice once this session is claimed/cleared,
    // but only if it owns the current notice (don't clobber another
    // surface's still-valid hint).
    if (this.claimNotice?.sessionId === sessionId) {
      this.claimNotice = null;
    }
  }

  // ─── /Phase 18a ─────────────────────────────────────────────────────

  /**
   * Shared markdown renderer for a single chat thread. Used by all three
   * chat surfaces' export buttons (global header FAB, Annotate Just
   * Ask, Test Pilot per-row). Format is deliberately readable in any
   * markdown viewer + pandoc-compatible so testers / reviewers can
   * convert to PDF / DOCX without further processing.
   *
   * Image attachments are summarized as `[image: name]` placeholders
   * because the base64 data URLs would balloon the file size + aren't
   * meaningfully readable inline.
   */
  private renderChatMarkdown(
    title: string,
    context: string | null,
    messages: ChatMessage[],
  ): string {
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 10)} at ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    const userCount = messages.filter((m) => m.role === "user").length;
    const agentCount = messages.filter((m) => m.role === "agent").length;
    let out = `# ${title}\n\n`;
    if (context) out += `_Context: ${context}_\n\n`;
    out += `_Exported on ${stamp} — ${userCount} from you, ${agentCount} from the agent._\n\n`;
    if (messages.length === 0) {
      out += `_(empty thread)_\n`;
      return out;
    }
    out += `---\n\n`;
    for (const m of messages) {
      const who = m.role === "user" ? "You" : "Agent";
      const clock = new Date(m.at).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      const meta: string[] = [clock];
      if (m.elapsedMs != null) {
        const s = m.elapsedMs / 1000;
        meta.push(
          s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${(s / 60).toFixed(1)}m`,
        );
      }
      if (m.tokens != null) {
        meta.push(
          m.tokens < 1000 ? `${m.tokens} tok` : `${(m.tokens / 1000).toFixed(1)}k tok`,
        );
      }
      out += `**${who}** · ${meta.join(" · ")}\n`;
      if (m.targetSelector) out += `> Target: \`${m.targetSelector}\`\n\n`;
      const body = (m.text ?? "").trim();
      if (body) out += `${body}\n\n`;
      if (m.images && m.images.length > 0) {
        for (let i = 0; i < m.images.length; i++) {
          const img = m.images[i]!;
          out += `_[image: ${img.name || `attachment-${i + 1}`}]_\n`;
        }
        out += `\n`;
      }
      out += `---\n\n`;
    }
    return out;
  }

  /** Tester-friendly export of the global chat thread. */
  exportGlobalChatMarkdown(): string {
    const ctx = this.selectedCompanion
      ? this.selectedCompanion.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? ""
      : "standalone";
    return this.renderChatMarkdown(
      "Pinta global chat",
      `Pinta · ${ctx}`,
      this.chat.global,
    );
  }

  /** Export an Annotate "Just Ask" thread (per-submit-batch). */
  exportAnnotateChatMarkdown(batchId: string): string {
    const thread = this.chat.annotateBatch[batchId] ?? [];
    return this.renderChatMarkdown(
      "Pinta Annotate chat",
      `Submit batch ${batchId}`,
      thread,
    );
  }

  /** Export the chat thread for a single Test Pilot row. */
  exportTestPilotRowChatMarkdown(testId: string): string {
    const catalog = this.testPilot.catalog;
    if (!catalog) return this.renderChatMarkdown("Pinta Test Pilot chat", null, []);
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          const ctx = `${testId} · ${section.title}${t.test ? ` · ${t.test}` : ""}`;
          return this.renderChatMarkdown(
            `Pinta Test Pilot chat — ${testId}`,
            ctx,
            t.chat ?? [],
          );
        }
      }
    }
    return this.renderChatMarkdown(`Pinta Test Pilot chat — ${testId}`, null, []);
  }

  /** Render a markdown report from the current catalog. */
  exportResults(): string {
    const c = this.testPilot.catalog;
    if (!c) return "# Test Pilot — no catalog loaded\n";
    let pass = 0,
      fail = 0,
      untested = 0;
    for (const s of c.sections) {
      for (const t of s.tests) {
        if (t.status === "pass") pass++;
        else if (t.status === "fail") fail++;
        else untested++;
      }
    }
    const total = pass + fail + untested;
    const today = new Date().toISOString().slice(0, 10);
    const heading = c.title?.trim() || c.filename;
    let out = `# Test Pilot results — ${heading}\n`;
    const metaBits: string[] = [`Run on ${today}`];
    if (c.author?.trim()) metaBits.push(`by ${c.author.trim()}`);
    metaBits.push(
      `${pass}/${total} passed, ${fail} failed, ${untested} untested`,
    );
    out += `_${metaBits.join(", ")}_\n\n`;
    if (c.description?.trim()) out += `${c.description.trim()}\n\n`;
    for (const s of c.sections) {
      out += `## ${s.title}\n\n`;
      out += `| ID | Test | Expected | Result |\n`;
      out += `|----|------|----------|--------|\n`;
      const conversations: { id: string; chat: ChatMessage[] }[] = [];
      for (const t of s.tests) {
        const result =
          t.status === "pass"
            ? "✓ Pass"
            : t.status === "fail"
              ? "✗ Fail"
              : "⚠ Untested";
        const id = t.id.replace(/\|/g, "\\|");
        const test = t.test.replace(/\|/g, "\\|").replace(/\n/g, " ");
        const expected = t.expected.replace(/\|/g, "\\|").replace(/\n/g, " ");
        // Mark rows that have a chat thread with a `[chat]` superscript
        // so readers know to scroll to the per-section Conversations
        // block. Table itself stays one row per test (multi-line
        // markdown would break the table render).
        const hasChat = Array.isArray(t.chat) && t.chat.length > 0;
        const resultCell = hasChat ? `${result} [chat]` : result;
        out += `| ${id} | ${test} | ${expected} | ${resultCell} |\n`;
        if (hasChat) conversations.push({ id: t.id, chat: t.chat! });
      }
      out += `\n`;
      if (conversations.length > 0) {
        // Per-section block lists each row's Q&A as a blockquote with
        // **tester:** / **agent:** prefixes — readable in any markdown
        // renderer, preserves multi-line replies, and survives the
        // pandoc → PDF path that QA reviewers use.
        out += `**Conversations**\n\n`;
        for (const c of conversations) {
          out += `**Conversation — ${c.id}**\n\n`;
          for (const m of c.chat) {
            const lines = m.text.split(/\r?\n/);
            const prefix = m.role === "user" ? "**tester:**" : "**agent:**";
            out += `> ${prefix} ${lines[0]}\n`;
            for (let i = 1; i < lines.length; i++) {
              out += `> ${lines[i]}\n`;
            }
            out += `>\n`;
          }
          out += `\n`;
        }
      }
    }
    return out;
  }

  /**
   * Render the catalog as a "tester sheet" markdown — same shape as
   * `composeTesterSheetMarkdown`, no surrounding state lookups. Result
   * column blank, Help-generated steps embedded per test. Standalone
   * testers (or anyone who reads the file in Word via the .docx
   * companion export) walk through and fill in marks themselves.
   */
  exportTesterSheetMarkdown(): string {
    const c = this.testPilot.catalog;
    if (!c) return "# Test Pilot — no catalog loaded\n";
    return composeTesterSheetMarkdown(c);
  }

  /**
   * Render the catalog as a DOCX byte array. Caller wraps in a Blob +
   * triggers download. Returns `null` when there's no catalog so the
   * UI can skip the download dance.
   */
  exportTesterSheetDocx(): Uint8Array | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    return composeTesterSheetDocx(c);
  }

  /**
   * Render the **results** (sign-off report) as a DOCX byte array — the
   * Word twin of `exportResults()`'s markdown, including Pass/Fail marks
   * and per-row chat threads. Caller wraps in a Blob + triggers
   * download. Returns `null` when there's no catalog.
   */
  exportResultsDocx(): Uint8Array | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    const today = new Date().toISOString().slice(0, 10);
    return composeResultsDocx($state.snapshot(c) as TestPilotCatalog, today);
  }

  clearTestPilot(): void {
    this.clearTestPilotTimeout();
    this.testPilot.catalog = null;
    this.testPilot.pending = null;
    this.testPilot.error = null;
    void this.saveTestPilot();
    // Also wipe the on-disk copy of the spec. UAT docs often contain
    // real credentials / internal URLs — leaving them lying around in
    // .pinta/test-docs/ after the user has cleared the catalog is a
    // surprise leak. Fire-and-forget; companion absence is fine.
    const base = this.httpBase();
    if (base) {
      void ExtensionState.fetchWithTimeout(`${base}/v1/test-docs`, {
        method: "DELETE",
        timeoutMs: 5_000,
      }).catch(() => {
        // best effort — disk cleanup failure isn't actionable in the UI
      });
    }
  }

  // ─── Modules (built-in integrations like GitLab Issues) ─────────────

  private static readonly MODULES_KEY = "pinta-modules";

  /** Pull module enable/settings from chrome.storage.local. */
  async loadModules(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.MODULES_KEY,
      );
      const raw = stored?.[ExtensionState.MODULES_KEY] as
        | typeof this.modules
        | undefined;
      if (raw && typeof raw === "object") {
        this.modules = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  private async saveModules(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.MODULES_KEY]: $state.snapshot(this.modules),
      });
    } catch {
      // ignore — non-fatal, in-memory state still wins
    }
  }

  /** All module specs the UI should render — built-ins plus every
   *  imported module, adapted from its manifest. Built-ins first so the
   *  bundled integrations stay at the top of Settings. */
  allModuleSpecs(): ModuleSpec[] {
    return [
      ...BUILTIN_MODULES,
      ...this.installedModules.map((m) => manifestToSpec(m.manifest)),
    ];
  }

  /** Imported INTERACTIVE modules that declare a tab AND are enabled.
   *  Drives the DYNAMIC side-panel tabs (App.svelte renders one per
   *  entry, in install order). Built-in interactive tabs (Test Pilot /
   *  AuditFlow) leave `tab` undefined and are excluded — they own
   *  hardcoded tabs. "If the plugin doesn't declare a tab, no tab." */
  interactiveTabSpecs(): ModuleSpec[] {
    return this.allModuleSpecs().filter(
      (s) => s.mode === "interactive" && !!s.tab && this.moduleReady(s.id),
    );
  }

  /** Resolve a spec by id across built-in + imported modules. */
  specFor(id: string): ModuleSpec | null {
    return (
      getModuleSpec(id) ??
      this.installedModules
        .map((m) => m.manifest)
        .filter((m) => m.id === id)
        .map(manifestToSpec)[0] ??
      null
    );
  }

  /** Initialize a missing module entry with defaults from its spec. */
  private ensureModuleEntry(spec: ModuleSpec): void {
    if (this.modules[spec.id]) return;
    const settings: Record<string, string | boolean> = {};
    for (const field of spec.settings) {
      if (field.default !== undefined) settings[field.key] = field.default;
    }
    this.modules[spec.id] = { enabled: false, settings };
  }

  setModuleEnabled(id: string, enabled: boolean): void {
    const spec = this.specFor(id);
    if (!spec) return;
    this.ensureModuleEntry(spec);
    this.modules[id]!.enabled = enabled;
    if (!enabled) {
      // Untick it for the current submit too — having a disabled module
      // still queued would be confusing.
      delete this.tickedModules[id];
    }
    void this.saveModules();
  }

  setModuleSetting(
    id: string,
    key: string,
    value: string | boolean,
  ): void {
    const spec = this.specFor(id);
    if (!spec) return;
    this.ensureModuleEntry(spec);
    this.modules[id]!.settings[key] = value;
    void this.saveModules();
    // Flipping `detailed_steps` should make the next test-row open
    // re-fetch fresh steps — otherwise the cached `test.detail` from
    // the previous mode would hide the change from the user.
    if (id === "test-pilot" && key === "detailed_steps") {
      const catalog = this.testPilot.catalog;
      if (catalog) {
        for (const section of catalog.sections) {
          for (const t of section.tests) delete t.detail;
        }
        void this.saveTestPilot();
      }
    }
  }

  /** True iff the module is enabled AND every required setting is filled. */
  moduleReady(id: string): boolean {
    const spec = this.specFor(id);
    const entry = this.modules[id];
    if (!spec || !entry || !entry.enabled) return false;
    return moduleIsConfigured(spec, entry.settings);
  }

  setModuleTicked(id: string, ticked: boolean): void {
    if (ticked) this.tickedModules[id] = true;
    else delete this.tickedModules[id];
  }

  /** Compose the SessionModule[] payload for a submit, picking only
   *  ready + ticked modules. Returns undefined when nothing is active so
   *  the field is omitted from the wire instead of appearing as an
   *  empty array. */
  buildSessionModules(): SessionModule[] | undefined {
    const out: SessionModule[] = [];
    // Built-ins + imported modules. Imported modules are per-submit in
    // v1, so they ride on the same ticked-checkbox path as GitLab Issues.
    for (const spec of this.allModuleSpecs()) {
      if (!this.tickedModules[spec.id]) continue;
      if (!this.moduleReady(spec.id)) continue;
      const settings = this.modules[spec.id]?.settings ?? {};
      out.push({
        id: spec.id,
        // Snapshot strips Svelte 5 reactive proxies before crossing the
        // structuredClone boundary on chrome.runtime / fetch().
        settings: $state.snapshot(settings) as Record<
          string,
          string | boolean
        >,
      });
    }
    return out.length > 0 ? out : undefined;
  }

  /** Reset per-session ticked modules. Called on each new session start
   *  so the user has to re-tick (matches autoApply / includeScreenshot
   *  behavior). */
  resetTickedModules(): void {
    this.tickedModules = {};
  }

  // ─── Imported modules (Phase 19) ────────────────────────────────────

  dismissModuleError(): void {
    this.moduleError = null;
  }

  /** Pull installed third-party modules from the active companion. No-op
   *  in standalone (no companion → no `.pinta/modules/`). Best-effort:
   *  a fetch failure clears the list rather than throwing into the UI. */
  async refreshInstalledModules(): Promise<void> {
    const base = this.httpBase();
    if (!base) {
      this.installedModules = [];
      return;
    }
    try {
      const res = await ExtensionState.fetchWithTimeout(`${base}/v1/modules`, {
        timeoutMs: 8_000,
      });
      if (!res.ok) {
        // Older companion without the /v1/modules route → treat as none.
        this.installedModules = [];
        return;
      }
      const list = (await res.json()) as InstalledModule[];
      this.installedModules = Array.isArray(list) ? list : [];
    } catch {
      // Network blip / companion down — leave whatever we had.
    }
  }

  /**
   * Install an imported module from a parsed `.pinta-module.json` bundle,
   * granting exactly the capabilities the user approved in the consent
   * dialog. Throws on failure so the caller can surface it; also mirrors
   * the message into `moduleError` for the Settings banner.
   */
  async importModule(
    pkg: ModulePackage,
    grantedCapabilities: ModuleCapability[],
  ): Promise<void> {
    const base = this.httpBase();
    if (!base) {
      const msg = "Connect to a project companion before importing a module.";
      this.moduleError = msg;
      throw new Error(msg);
    }
    try {
      const res = await ExtensionState.fetchWithTimeout(`${base}/v1/modules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: pkg, grantedCapabilities }),
        timeoutMs: 10_000,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let detail = text;
        try {
          detail = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // non-JSON body — use raw text
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      this.moduleError = null;
      await this.refreshInstalledModules();
    } catch (err) {
      this.moduleError = `Import failed: ${(err as Error).message}`;
      throw err;
    }
  }

  /** Uninstall an imported module by id, then refresh + tidy local state. */
  async uninstallModule(id: string): Promise<void> {
    const base = this.httpBase();
    if (!base) return;
    try {
      const res = await ExtensionState.fetchWithTimeout(
        `${base}/v1/modules/${encodeURIComponent(id)}`,
        { method: "DELETE", timeoutMs: 8_000 },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      // Drop any local enable/ticked state for the removed module so it
      // doesn't linger in `pinta-modules` storage or a pending submit.
      delete this.modules[id];
      delete this.tickedModules[id];
      void this.saveModules();
      this.moduleError = null;
      await this.refreshInstalledModules();
    } catch (err) {
      this.moduleError = `Uninstall failed: ${(err as Error).message}`;
    }
  }

  // ─── /Modules ───────────────────────────────────────────────────────

  /** Reload imported sessions from IndexedDB. Called on start and after
   *  any add/remove so the History panel stays in sync. */
  async refreshImported(): Promise<void> {
    try {
      this.importedSessions = await getImportedSessions();
    } catch (err) {
      this.lastError = `imported sessions read failed: ${(err as Error).message}`;
    }
  }

  /** Import a `.pinta` share file or a Pinta-exported `.md` markdown
   *  file. Parses + validates, persists to IDB, refreshes the in-memory
   *  list. Routes by file extension; falls back to a JSON sniff if the
   *  extension is missing or wrong. Throws on validation failure so the
   *  caller can toast. */
  async importPintaFile(file: File): Promise<ImportedSession> {
    const text = await file.text();
    const name = file.name.toLowerCase();
    const isMarkdown =
      name.endsWith(".md") ||
      name.endsWith(".markdown") ||
      (!name.endsWith(".pinta") && !text.trimStart().startsWith("{"));
    const imported = isMarkdown ? decodePintaMarkdown(text) : decodePintaFile(text);
    await addImportedSession(imported);
    await this.refreshImported();
    return imported;
  }

  async removeImported(id: string): Promise<void> {
    await removeImportedSession(id).catch((err) => {
      this.lastError = `imported session delete failed: ${(err as Error).message}`;
    });
    if (this.viewingImportedId === id) this.viewingImportedId = null;
    await this.refreshImported();
  }

  /**
   * Wipe both local (companion-side) and imported (IDB-side) session
   * history. The companion preserves the drafting session if one is
   * active, so the user doesn't lose work in flight. Best-effort on each
   * leg — one failure doesn't block the other.
   */
  async clearAllHistory(): Promise<void> {
    const base = this.httpBase();
    if (base) {
      try {
        const res = await ExtensionState.fetchWithTimeout(`${base}/v1/sessions`, {
          method: "DELETE",
          timeoutMs: 8_000,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
      } catch (err) {
        this.lastError = `clear sessions failed: ${(err as Error).message}`;
      }
    }
    try {
      await clearImportedSessions();
      this.viewingImportedId = null;
    } catch (err) {
      this.lastError = `clear imported failed: ${(err as Error).message}`;
    }
    await this.refreshImported();
  }

  /** Open the read-only viewer for an imported session. */
  viewImported(id: string): void {
    if (!this.importedSessions.some((s) => s.id === id)) return;
    this.viewingImportedId = id;
  }

  /**
   * Submit an imported session to the connected companion as a brand-new
   * already-submitted session — the agent picks it up like any other
   * submission and applies the changes. The user's active draft is left
   * alone (no clobber). Connected mode only.
   *
   * Returns the new session id on success so callers can show a toast
   * with a link / pointer; throws on transport failure.
   */
  async sendImportedToAgent(
    id: string,
    opts: { autoApply?: boolean } = {},
  ): Promise<string | null> {
    const imported = this.importedSessions.find((s) => s.id === id);
    if (!imported) return null;
    const base = this.httpBase();
    if (!base) {
      this.lastError =
        "Send to agent requires a connected companion. Switch projects from the picker, or use Fork in standalone mode.";
      return null;
    }
    const now = Date.now();
    const payload: Session = {
      id: crypto.randomUUID(),
      url: this.lastUrl ?? imported.session.url,
      projectRoot: "",
      startedAt: now,
      submittedAt: now,
      // Fresh annotation ids so per-annotation status updates from the
      // agent don't collide with anything in the source-side history.
      annotations: imported.session.annotations.map((a) => ({
        ...a,
        id: uid("ann"),
        status: undefined,
        errorMessage: undefined,
      })),
      fullPageScreenshot: imported.session.fullPageScreenshot,
      status: "submitted",
      // Reuse the existing 'test' producer rather than adding a new
      // enum value — the wire contract stays narrow, and the agent
      // already handles 'test' submissions identically to extension ones.
      producer: "test",
      autoApply: opts.autoApply,
      // Modules ride along with imported sessions too — recipients of a
      // shared `.pinta` may want to file the friend's annotations as
      // GitLab issues against their *own* project. Modules are stripped
      // from share-file exports, so configuration is always the
      // recipient's own.
      modules: this.buildSessionModules(),
    };
    try {
      const res = await ExtensionState.fetchWithTimeout(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 8_000,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
      return payload.id;
    } catch (err) {
      this.lastError = `send to agent failed: ${(err as Error).message}`;
      return null;
    }
  }

  /** Close the read-only viewer. */
  closeImportedViewer(): void {
    this.viewingImportedId = null;
  }

  /**
   * Clone an imported session into a new editable standalone session
   * for the current origin. Annotations get fresh ids so the fork
   * doesn't collide with anything in the source agent's tracking. The
   * fork lands as the active draft for the current URL.
   */
  /**
   * Result of a fork attempt. `would-overwrite` means the active draft
   * has unsaved annotations — the caller must re-invoke with
   * `allowOverwrite: true` (typically after a `window.confirm`) to
   * actually replace it. This guard exists because the cloned session
   * is written through to IndexedDB at the same origin key as the
   * existing draft, irreversibly clobbering it.
   */
  async forkImportedToLocal(
    id: string,
    opts: { allowOverwrite?: boolean } = {},
  ): Promise<"forked" | "would-overwrite" | "no-op"> {
    const imported = this.importedSessions.find((s) => s.id === id);
    if (!imported) return "no-op";
    if (this.appMode !== "standalone" || !this.currentOrigin) {
      this.lastError =
        "fork is only available in standalone mode (no companion selected)";
      return "no-op";
    }
    if (
      !opts.allowOverwrite &&
      this.session &&
      this.session.annotations.length > 0
    ) {
      return "would-overwrite";
    }
    const url = this.lastUrl ?? imported.session.url;
    const cloned: Session = {
      id: crypto.randomUUID(),
      url,
      projectRoot: "",
      startedAt: Date.now(),
      annotations: imported.session.annotations.map((a) => ({
        ...a,
        id: uid("ann"),
        // Drop any agent-set lifecycle so the forked annotations start
        // fresh — they haven't been picked up in this project yet.
        status: undefined,
        errorMessage: undefined,
      })),
      status: "drafting",
      producer: "extension",
    };
    this.session = cloned;
    this.viewingImportedId = null;
    await saveLocal(this.currentOrigin, $state.snapshot(cloned) as Session).catch(
      (err) => {
        this.lastError = `local store write failed: ${(err as Error).message}`;
      },
    );
    return "forked";
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
    this.connectionStatus = "disconnected";
  }

  /**
   * Re-evaluate routing for the current tab URL.
   *
   * Fast-path: if `force` is false (the navigation case) and the active
   * tab still matches the currently-selected companion's URL patterns,
   * skip the port scan entirely. SPAs that route via pushState fire
   * `chrome.tabs.onUpdated` repeatedly during a single user navigation,
   * and re-probing 21 ports on each event was wasted work whenever the
   * destination was still inside the same project.
   *
   * Manual rescan triggers (the "↻ Rescan" button) pass `force = true`
   * so the scan still discovers newly-started companions.
   */
  async rescan(
    activeTabUrl: string | null = this.lastUrl,
    force: boolean = false,
  ): Promise<void> {
    if (
      !force &&
      this.selectedCompanion &&
      activeTabUrl &&
      this.selectedCompanion.urlPatterns.length > 0 &&
      matchAny(activeTabUrl, this.selectedCompanion.urlPatterns)
    ) {
      // Routing context still resolves to the same companion. Update
      // the cached URL so future calls have an accurate baseline, but
      // don't burn the port-scan budget.
      this.lastUrl = activeTabUrl;
      return;
    }

    this.scanning = true;
    try {
      this.companions = await discoverCompanions();

      // Don't pre-wipe the standalone session here. Both follow-up paths
      // handle it themselves: connectTo() nulls `this.session` before the
      // new WS handshake, and hydrateStandalone() is idempotent for the
      // same origin. Pre-wiping caused the session.id $effect in App.svelte
      // (line ~854) to fire a transient `annotated.clear` to the content
      // script every time rescan ran on the same origin — which wiped all
      // on-page pin badges even though nothing about the session had
      // actually changed.

      // Honor the user's explicit "use standalone for this origin"
      // opt-in BEFORE anything else. Skips URL-match auto-routing and
      // the single-companion auto-pick fallback so a tab on a pinned
      // origin doesn't silently snap back to a companion when the
      // user navigates within it.
      const currentOrigin = originOf(activeTabUrl);
      if (currentOrigin && this.standaloneOrigins.has(currentOrigin)) {
        if (this.selectedCompanion) await this.connectTo(null);
        await this.hydrateStandalone(activeTabUrl);
        return;
      }

      const stillSelected = this.selectedCompanion
        ? this.companions.find(
            (c) => c.port === this.selectedCompanion!.port,
          ) ?? null
        : null;

      // The active tab URL is the source of truth for routing — even if
      // our current companion is alive, the user may have switched to a
      // tab that uniquely matches a *different* companion. Follow it.
      const urlMatch = activeTabUrl
        ? findCompanionForUrl(this.companions, activeTabUrl)
        : null;

      if (urlMatch && urlMatch.port !== this.selectedCompanion?.port) {
        // Tab URL points to a specific companion that isn't our current
        // selection. Switch — this is what makes the side panel "follow
        // the tab" between projects.
        await this.connectTo(urlMatch);
      } else if (!stillSelected) {
        // Current companion is gone and the URL doesn't disambiguate —
        // fall back to the auto-pick policy. Returns null if no auto-pick
        // is possible (zero companions, or many with no URL match).
        const next = this.pickCompanion(this.companions, activeTabUrl);
        await this.connectTo(next);
      } else if (
        activeTabUrl &&
        stillSelected.urlPatterns.length > 0 &&
        !matchAny(activeTabUrl, stillSelected.urlPatterns)
      ) {
        // Tab moved to a URL the current project doesn't claim, and no
        // other project claimed it either (urlMatch was null). Stay
        // connected so a multi-page draft survives — the user might be
        // briefly off-route inside the same review (e.g. opened a
        // /pricing page that the project's URL patterns don't list).
        // Each annotation carries its own `url` so attribution stays
        // correct even when added on a non-claimed page. Catch-all
        // companions (no urlPatterns) take this branch implicitly via
        // the predicate above.
      } else if (stillSelected !== this.selectedCompanion) {
        // Stay put but refresh the cached entry (urlPatterns may have
        // changed since last scan).
        this.selectedCompanion = stillSelected;
      }

      // Standalone fallback: routing landed on no companion (either
      // none exist, or none match and there's no auto-pick). Hydrate
      // the local session for the current origin so annotations have a
      // place to land.
      if (!this.selectedCompanion) {
        if (this.client) {
          this.client.stop();
          this.client = null;
          this.connectionStatus = "disconnected";
        }
        await this.hydrateStandalone(activeTabUrl);
      }
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Standalone mode: load (or leave empty for later creation) the session
   * for the current origin. Called from rescan when no companions exist.
   */
  private async hydrateStandalone(activeTabUrl: string | null): Promise<void> {
    const origin = originOf(activeTabUrl);
    if (!origin) {
      // Unsupported URL (chrome://, about:, etc.) — keep state cleared.
      this.session = null;
      this.currentOrigin = null;
      return;
    }
    if (this.currentOrigin === origin && this.session) return;
    this.currentOrigin = origin;
    try {
      const existing = await loadByOrigin(origin);
      this.session = existing ?? null;
    } catch (err) {
      this.lastError = `local store read failed: ${(err as Error).message}`;
      this.session = null;
    }
  }

  /** User picked a project from the dropdown — switch WS to that companion. */
  async select(companion: Companion | null): Promise<void> {
    await this.connectTo(companion);
    if (companion) {
      // User explicitly picked a companion — they want associated mode,
      // not standalone. Clear any pin on the current origin so rescans
      // honor the choice instead of pulling the rug.
      this.unpinOriginFromStandalone(originOf(this.lastUrl));
      try {
        await chrome.storage?.local?.set({ [SELECTED_KEY]: companion.projectRoot });
      } catch {
        // storage perm missing or quota issue — ignore, in-memory state still wins
      }
    }
  }

  /**
   * Auto-pick policy: URL pattern match wins; else, restored preference
   * if it's still running; else, the only companion if there's just one;
   * else, null (user must pick).
   */
  private pickCompanion(
    list: Companion[],
    url: string | null,
  ): Companion | null {
    if (list.length === 0) return null;
    if (url) {
      const match = findCompanionForUrl(list, url);
      if (match) return match;
    }
    if (list.length === 1) return list[0]!;
    return null;
  }

  private async connectTo(companion: Companion | null): Promise<void> {
    if (this.selectedCompanion?.port === companion?.port) return;
    // Switching projects: stale pin badges from the previous companion's
    // session would otherwise linger on the page until the user clicks
    // them. Clear them now so the overlay reflects the new companion's
    // (empty or restored) annotations only.
    const switchingBetweenProjects =
      this.selectedCompanion !== null && companion !== null;
    if (switchingBetweenProjects) await this.clearOverlayBadges();
    this.client?.stop();
    this.client = null;
    this.session = null;
    this.markCreatingSession(false);
    this.selectedCompanion = companion;
    // Re-arm the "missing endpoint" warning so a companion restart on
    // a new build re-probes for the per-author results route instead
    // of staying silent forever after the first 404.
    this.resultsEndpointWarned = false;
    // Swap Test Pilot catalogs to match. Standalone clears state
    // entirely (catalogs are scoped per project — there's nothing to
    // show without one). loadTestPilot handles both branches.
    void this.loadTestPilot(companion);
    // Imported modules live in the companion's `.pinta/modules/` — refresh
    // them on every (re)connect, clear them when going companion-less.
    void this.refreshInstalledModules();
    if (!companion) {
      this.connectionStatus = "disconnected";
      return;
    }
    this.client = new WsClient({
      url: `ws://127.0.0.1:${companion.port}/`,
      onMessage: (msg) => this.onMessage(msg),
      onStatusChange: (status) => {
        this.connectionStatus = status;
        // When the WS disconnects mid-create, the companion will never
        // echo back the session-created response that clears the flag.
        // Drop the flag here so the user can retry instead of being
        // stuck on a no-op spinner.
        if (status === "disconnected" && this.creatingSession) {
          this.markCreatingSession(false);
        }
        // On (re)connect, recover any imported-interactive module run OR
        // in-flight annotation batch whose done broadcast we missed while
        // the socket was down — the companion never replays plain batches
        // on reconnect, so without this they strand "submitted" with a
        // stale claim notice. No-op on a fresh connect (nothing pending).
        if (status === "connected") {
          // A fresh connection — give any previously-404'd orphan one more
          // chance, reconcile now, and (re)start the heartbeat so a later
          // half-open socket still self-heals pending batches over HTTP.
          this.reconciledOrphans.clear();
          void this.reconcileModuleBoards();
          void this.reconcileInFlightBatches();
          void this.reconcileReport();
          this.ensureReconcileHeartbeat();
        }
      },
    });
    this.client.start();
  }

  /**
   * Tell the active tab's content script to drop all pin badges. Used
   * on companion switch so the previous project's badges don't leak
   * into the next project's view.
   */
  private async clearOverlayBadges(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id == null) return;
      await chrome.tabs
        .sendMessage(tab.id, { type: "annotated.clear" })
        .catch(() => {
          // content script not injected on this URL — nothing to clear
        });
    } catch {
      // chrome.tabs missing (test env) — ignore
    }
  }

  /**
   * URL of the HTTP API for the selected companion. Returns null when
   * no companion is selected — callers should guard.
   */
  httpBase(): string | null {
    if (!this.selectedCompanion) return null;
    return `http://127.0.0.1:${this.selectedCompanion.port}`;
  }

  send(msg: ClientMessage): void {
    this.client?.send(msg);
  }

  async ensureSession(url: string): Promise<void> {
    this.lastUrl = url;
    if (this.session || this.creatingSession) return;

    if (this.appMode === "standalone") {
      const origin = originOf(url);
      if (!origin) return;
      this.currentOrigin = origin;
      const existing = await loadByOrigin(origin).catch(() => null);
      if (existing) {
        this.session = existing;
        return;
      }
      const draft = newDraft(url);
      this.session = draft;
      // Snapshot before save — IndexedDB's structuredClone can't handle
      // Svelte 5 reactive proxies that wrap state objects.
      await saveLocal(origin, $state.snapshot(draft) as Session).catch((err) => {
        this.lastError = `local store write failed: ${(err as Error).message}`;
      });
      return;
    }

    if (!this.client) return;
    this.markCreatingSession(true);
    this.send({ type: "session.create", url });
  }

  async addAnnotation(annotation: Annotation): Promise<void> {
    // Adding a new annotation means the user has shifted from "looking
    // at someone else's session" to "working on their own". Close the
    // imported viewer so the annotation list they just contributed to is
    // actually visible — without this, the new card lands in
    // app.session.annotations but the viewer is rendered on top of it.
    if (this.viewingImportedId) this.viewingImportedId = null;
    // Stamp the page URL the annotation was created on so multi-page
    // sessions stay correctly attributed when the user navigates between
    // routes. Skill / GitLab module fall back to `session.url` if absent.
    const stamped: Annotation = {
      ...annotation,
      url: annotation.url ?? this.lastUrl ?? this.session?.url,
    };
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: [...s.annotations, stamped],
      }));
      return;
    }
    this.send({ type: "annotation.add", annotation: stamped });
  }

  async updateAnnotation(id: string, patch: Partial<Annotation>): Promise<void> {
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: s.annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      }));
      return;
    }
    this.send({ type: "annotation.update", id, patch });
  }

  async removeAnnotation(id: string): Promise<void> {
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: s.annotations.filter((a) => a.id !== id),
      }));
      return;
    }
    this.send({ type: "annotation.remove", id });
  }

  submit(screenshot = "", autoApply?: boolean): void {
    // No-op in standalone — the side panel hides Submit there. Defensive
    // guard so a stray call (e.g. from a hotkey) doesn't crash.
    if (this.appMode === "standalone") return;
    const modules = this.buildSessionModules();
    this.send({
      type: "session.submit",
      screenshot,
      autoApply,
      modules,
    });
    // Phase 20 — async batches. Detach the just-submitted session into the
    // in-flight tray and immediately spin up a fresh draft so the user can
    // keep annotating (even after navigating to another page) while the
    // agent applies this one. The companion keeps the submitted session
    // alive — store.submit() does NOT clear `activeId`, and createSession()
    // only echoes back an existing *drafting* active session, so the
    // session.create below mints a brand-new draft rather than resurrecting
    // the one we just sent. The authoritative submitted/applying/done
    // status arrives via session.synced and is routed back here by id.
    const detached = this.session;
    if (detached) {
      detached.status = "submitted";
      detached.submittedAt = Date.now();
      this.inFlightBatches = [...this.inFlightBatches, detached];
      // Keep the reconcile heartbeat alive while this batch is pending, so a
      // half-open WebSocket (no done-broadcast) still self-heals over HTTP.
      this.ensureReconcileHeartbeat();
    }
    this.session = null;
    this.markCreatingSession(true);
    this.send({
      type: "session.create",
      url: this.lastUrl ?? detached?.url ?? "",
    });
  }

  /**
   * Phase 20 — drop a finished (done / error) batch from the in-flight
   * tray. Called by the tray's dismiss (×) button. No companion call —
   * the session already reached a terminal state server-side; this just
   * stops showing it. Also clears any lingering claim-warning timer.
   */
  dismissBatch(id: string): void {
    this.clearClaimWarning(id);
    this.reconciledOrphans.delete(id);
    this.inFlightBatches = this.inFlightBatches.filter((b) => b.id !== id);
    // Nothing left to poll → let the heartbeat go idle. Check the combined
    // predicate so dismissing the last batch doesn't kill a heartbeat a
    // still-pending report run depends on.
    if (!this.hasReconcilableWork()) this.stopReconcileHeartbeat();
  }

  /**
   * Wipe the standalone session for the current origin and start a
   * fresh draft — equivalent of "Cancel and restart" in connected mode.
   * No-op in connected mode (callers should use `cancelAndRestart`).
   */
  async clearStandaloneSession(): Promise<void> {
    if (this.appMode !== "standalone" || !this.currentOrigin) return;
    const url = this.lastUrl ?? "";
    await clearLocal(this.currentOrigin).catch(() => {});
    this.session = null;
    if (url) await this.ensureSession(url);
  }

  /**
   * Apply a pure mutation to the local-mode session and persist. No-op
   * if there's no active session yet (caller should ensureSession first).
   */
  private async mutateLocal(
    fn: (s: Session) => Session,
  ): Promise<void> {
    if (!this.session || !this.currentOrigin) return;
    const next = fn(this.session);
    this.session = next;
    // Snapshot strips Svelte 5 reactive proxies — IndexedDB uses
    // structuredClone internally and chokes on them otherwise.
    await saveLocal(this.currentOrigin, $state.snapshot(next) as Session).catch(
      (err) => {
        this.lastError = `local store write failed: ${(err as Error).message}`;
      },
    );
  }

  /**
   * Cancel the current session and start a fresh one for the same URL.
   */
  async cancelAndRestart(url: string): Promise<void> {
    if (this.appMode === "standalone") {
      await this.clearStandaloneSession();
      return;
    }
    const current = this.session;
    const base = this.httpBase();
    if (current && current.status !== "drafting" && base) {
      try {
        await fetch(
          `${base}/v1/sessions/${encodeURIComponent(current.id)}/status`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "error",
              errorMessage: "canceled by user",
            }),
          },
        );
      } catch (err) {
        this.lastError = `cancel failed: ${(err as Error).message}`;
      }
    }
    this.session = null;
    this.markCreatingSession(true);
    // `force: true` tells the companion to discard any active drafting
    // session before creating a fresh one. Without it the server's
    // drafting-idempotency echoes the old session right back and the
    // annotations the user just cleared silently resurrect.
    this.send({ type: "session.create", url, force: true });
  }

  /**
   * Add a URL pattern to the selected companion's project. Returns the
   * full updated patterns list on success, throws on failure.
   */
  async associateUrl(pattern: string): Promise<string[]> {
    const base = this.httpBase();
    if (!base) throw new Error("no companion selected");
    const res = await ExtensionState.fetchWithTimeout(`${base}/v1/url-patterns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
      timeoutMs: 5_000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let body: { urlPatterns: string[] };
    try {
      body = (await res.json()) as { urlPatterns: string[] };
    } catch {
      throw new Error("companion returned a non-JSON response");
    }
    // Update local cache so the picker reflects the change immediately.
    if (this.selectedCompanion) {
      this.selectedCompanion = {
        ...this.selectedCompanion,
        urlPatterns: body.urlPatterns,
      };
      this.companions = this.companions.map((c) =>
        c.port === this.selectedCompanion!.port ? this.selectedCompanion! : c,
      );
    }
    return body.urlPatterns;
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "module.query.created": {
        // Companion confirmed our interactive-module submit. Pin the
        // session id so the eventual session.synced for that id flows
        // into the right slot instead of stomping the annotation draft.
        // Detail-steps queries are tracked per-testId in pendingDetails
        // and identify themselves by the queryComment op — they don't
        // need to pin a sessionId here. Only doc-parse/doc-generate use
        // the singleton `pending` slot.
        if (
          msg.moduleId === "test-pilot" &&
          this.testPilot.pending &&
          !this.testPilot.pending.sessionId &&
          ExtensionState.queryOp(msg.session) !== "detail-steps" &&
          ExtensionState.queryOp(msg.session) !== "chat"
        ) {
          this.testPilot.pending.sessionId = msg.session.id;
        }
        // Phase 14 — pin the chat module's ephemeral session so the
        // eventual session.synced can be routed back to the right
        // surface slot (global or annotate-batch).
        if (msg.moduleId === "chat") {
          const kind = ExtensionState.queryField(msg.session, "context.kind");
          if (kind === "global") {
            this.rememberChatSession(msg.session.id, { kind: "global" });
          } else if (kind === "annotate-batch") {
            const batchId = ExtensionState.queryField(msg.session, "batchId");
            if (batchId) {
              this.rememberChatSession(msg.session.id, {
                kind: "annotate-batch",
                batchId,
              });
            }
          }
        }
        // Phase 19 — pin the ephemeral session id for imported INTERACTIVE
        // modules so reconcileModuleBoards() can recover a run whose
        // session.synced(done) is missed during a WS blip. Only touch a
        // slot that's actually waiting on this run.
        const importedInteractive = this.installedModules.find(
          (im) =>
            im.manifest.id === msg.moduleId &&
            im.manifest.mode === "interactive" &&
            !!im.manifest.tab,
        );
        if (importedInteractive) {
          const slot = this.moduleBoards[msg.moduleId];
          if (slot?.pending) slot.pendingSessionId = msg.session.id;
        }
        // Phase 16 — pin the report module's ephemeral session id so
        // reconcileReport() can recover a run whose session.synced(done)
        // is missed during a half-open WS blip (mirrors the moduleBoards
        // pin above). Start the heartbeat so the HTTP poll heals it even
        // when no reconnect ever fires.
        if (
          msg.moduleId === "report" &&
          this.report.pending &&
          !this.report.pending.sessionId
        ) {
          this.report.pending.sessionId = msg.session.id;
          this.ensureReconcileHeartbeat();
        }
        break;
      }
      case "session.created":
      case "session.synced": {
        // Phase 18a — claim-warning lifecycle. Arm a 10s warning the
        // moment a session enters "submitted" status; clear it the
        // moment it leaves (claimed → applying, completed, errored).
        // Single insertion point that covers every downstream
        // session kind (annotation / Test Pilot / AuditFlow / Chat)
        // because they all flow through this switch arm. If the
        // warning fires, the message routes to the right error slot
        // via sessionRoleKind based on the session's modules.
        if (msg.session.status === "submitted") {
          this.armClaimWarning(msg.session);
        } else {
          this.clearClaimWarning(msg.session.id);
        }

        // Route Test Pilot query session events away from the regular
        // annotation flow so the draft isn't disturbed. Detect by EITHER
        // the pinned sessionId OR the session.modules payload — the
        // companion's store.submit() notifyChange can broadcast
        // session.synced before the targeted module.query.created ack
        // arrives, leaving pending.sessionId still empty. Without the
        // modules-based fallback, the ephemeral test-pilot session
        // (status: submitted) replaces this.session here, sessionPending
        // flips true, and the page-edge processing pulse never stops
        // because handleTestPilotSync (run on the eventual done event)
        // doesn't touch this.session.status.
        // Phase 14 — chat-module sessions (global + annotate) route
        // through the dedicated handler keyed by sessionId. Done /
        // error get applied; pending stays a no-op. Has to come
        // before the Test Pilot branch because chat sessions have
        // `modules: [{id: "chat"}]`, not "test-pilot".
        // Done / error get applied; intermediate statuses
        // (submitted / applying) are no-ops on the chat slot but
        // MUST still early-return — otherwise the chat session's
        // `modules: [{id: "chat"}]` payload falls through to
        // `this.session = msg.session` below and overwrites the
        // user's annotation draft with the chat's query annotation
        // (the "Agent is thinking…" spinner stuck + a stray query
        // annotation polluting the annotation list, both seen when
        // the binding hadn't pinned yet on the first session.synced).
        const isChatSession =
          msg.session.modules?.some((m) => m.id === "chat") ?? false;
        if (isChatSession) {
          this.handleNonTestPilotChatSync(msg.session);
          return;
        }
        // Phase 15 — AuditFlow sessions (modules: [{id: "audit-flow"}])
        // also bypass the annotation draft. Done / error apply to the
        // audit.* slot via handleAuditSync; intermediate statuses are
        // no-ops here but MUST early-return for the same reason as the
        // chat branch above (would otherwise overwrite the user's
        // active annotation draft with the audit's ephemeral session).
        const isAuditSession =
          msg.session.modules?.some((m) => m.id === "audit-flow") ?? false;
        if (isAuditSession) {
          // Phase 15 "Slice 3" — "Suggest checks" rides the audit-flow
          // module but carries op "audit-suggest" + a top-level
          // categoryId. Route it to the inline suggestion checklist
          // (handleAuditSuggestSync) instead of the audit-run handler.
          // handleAuditSync also early-returns without audit.pending, so
          // this is belt-and-suspenders, but route explicitly.
          const op = ExtensionState.queryOp(msg.session);
          if (op === "audit-suggest") {
            const categoryId = ExtensionState.queryField(
              msg.session,
              "categoryId",
            );
            if (categoryId)
              this.handleAuditSuggestSync(msg.session, categoryId);
            return;
          }
          // Phase 15e — per-finding Discuss (chat) + File issue, routed by
          // checkId via their own pending maps (like Test Pilot's per-row
          // chat). Bypass the singleton audit-run handler.
          if (op === "audit-discuss") {
            const checkId = ExtensionState.queryField(msg.session, "checkId");
            if (checkId) this.handleAuditCheckChatSync(msg.session, checkId);
            return;
          }
          if (op === "audit-file-issue") {
            const checkId = ExtensionState.queryField(msg.session, "checkId");
            if (checkId) this.handleAuditFileIssueSync(msg.session, checkId);
            return;
          }
          this.handleAuditSync(msg.session);
          return;
        }
        // Phase 16 — Report module sessions (modules: [{id: "report"}])
        // bypass the annotation draft, same as the audit / chat branches.
        // Done / error apply to the report.* slot via handleReportSync;
        // intermediate statuses are no-ops but MUST early-return so the
        // ephemeral report session never overwrites the user's draft.
        const isReportSession =
          msg.session.modules?.some((m) => m.id === "report") ?? false;
        if (isReportSession) {
          this.handleReportSync(msg.session);
          return;
        }
        // Phase 19 — imported INTERACTIVE module sessions (a module the
        // user installed whose manifest is interactive + declares a tab).
        // Route the result into the generic board slot keyed by module id.
        // Same early-return discipline as the audit / chat branches so the
        // user's annotation draft is never overwritten by the ephemeral
        // module-query session.
        const importedInteractive = msg.session.modules?.find((m) =>
          this.installedModules.some(
            (im) =>
              im.manifest.id === m.id &&
              im.manifest.mode === "interactive" &&
              !!im.manifest.tab,
          ),
        );
        if (importedInteractive) {
          this.handleModuleBoardSync(msg.session, importedInteractive.id);
          return;
        }
        const isInteractiveModuleSession =
          msg.session.modules?.some((m) => m.id === "test-pilot") ?? false;
        if (isInteractiveModuleSession) {
          // Concurrent detail-steps fetches live in pendingDetails,
          // keyed by testId pulled from the session's query annotation
          // — that's how we tell two parallel ? clicks apart.
          const op = ExtensionState.queryOp(msg.session);
          if (op === "detail-steps") {
            const testId = ExtensionState.queryField(msg.session, "testId");
            if (testId) this.handleDetailSync(msg.session, testId);
            return;
          }
          // Per-row chat sends are also concurrent, routed by testId
          // via pendingChats. Same shape as detail-steps — bypass the
          // singleton `pending` slot entirely.
          if (op === "chat") {
            const testId = ExtensionState.queryField(msg.session, "testId");
            if (testId) {
              this.handleChatSync(msg.session, testId);
              return;
            }
            // Phase 14.7 — section-scoped chat carries `sectionTitle`
            // instead of a testId. Route by title to the section thread.
            const sectionTitle = ExtensionState.queryField(
              msg.session,
              "sectionTitle",
            );
            if (sectionTitle) {
              this.handleSectionChatSync(msg.session, sectionTitle);
              return;
            }
            return;
          }
          // Phase 14.6 — section-level "Suggest Test". Routed by
          // sectionTitle (no testId), result lands in the inline
          // checklist via handleSuggestSync.
          if (op === "suggest-tests") {
            const sectionTitle = ExtensionState.queryField(
              msg.session,
              "sectionTitle",
            );
            if (sectionTitle)
              this.handleSuggestSync(msg.session, sectionTitle);
            return;
          }
        }
        if (
          this.testPilot.pending &&
          (this.testPilot.pending.sessionId === msg.session.id ||
            isInteractiveModuleSession)
        ) {
          if (!this.testPilot.pending.sessionId) {
            this.testPilot.pending.sessionId = msg.session.id;
          }
          this.handleTestPilotSync(msg.session);
          return;
        }
        // Phase 20 — async batches. Route the regular annotation session
        // by id. A session already sitting in the in-flight tray (the user
        // submitted it earlier and has since moved on to a fresh draft)
        // updates its tray row in place — it must NOT clobber the current
        // draft. This is the path that flips each detached batch
        // submitted → applying → done and flows per-annotation status into
        // the tray progress.
        const incoming = msg.session;
        const flightIdx = this.inFlightBatches.findIndex(
          (b) => b.id === incoming.id,
        );
        if (flightIdx !== -1) {
          this.inFlightBatches[flightIdx] = incoming;
          // Reassign so Svelte tracks the array mutation.
          this.inFlightBatches = [...this.inFlightBatches];
          break;
        }
        const previousSessionId = this.session?.id ?? null;
        // A terminal-status (done / error) broadcast for a session that's
        // neither the current draft nor a tracked in-flight batch is stale
        // — e.g. a late echo for a batch the user already dismissed. Ignore
        // it so it can't resurrect as a phantom "done" draft and strand the
        // footer in the all-done state.
        if (
          incoming.id !== previousSessionId &&
          (incoming.status === "done" || incoming.status === "error")
        ) {
          break;
        }
        this.session = incoming;
        this.markCreatingSession(false);
        this.lastError = null;
        // A new session started → drop ticked module checkboxes so the
        // user has to consciously opt in for the next submit. Mirrors
        // how autoApply / includeScreenshot behave per-batch.
        if (incoming.id !== previousSessionId) {
          this.resetTickedModules();
        }
        break;
      }
      case "session.applying":
        if (this.session) this.session.status = "applying";
        break;
      case "session.done":
        if (this.session) {
          this.session.status = "done";
          this.session.appliedSummary = msg.summary;
        }
        break;
      case "error":
        this.lastError = msg.message;
        break;
    }
  }

  /** Pull a field from the first query annotation's JSON comment. The
   *  companion attaches a single `kind: "query"` annotation whose
   *  `comment` is the JSON we sent as `queryComment` — that's our only
   *  channel for correlating per-request data (testId, op) back through
   *  the WebSocket roundtrip. */
  private static queryField(session: Session, field: string): string | null {
    const annot = session.annotations.find((a) => a.kind === "query");
    if (!annot?.comment) return null;
    try {
      const parsed = JSON.parse(annot.comment) as Record<string, unknown>;
      // Support dot paths (e.g. "context.kind") so callers can read
      // nested values from the queryComment without re-parsing.
      const parts = field.split(".");
      let cursor: unknown = parsed;
      for (const part of parts) {
        if (cursor && typeof cursor === "object") {
          cursor = (cursor as Record<string, unknown>)[part];
        } else {
          return null;
        }
      }
      return typeof cursor === "string" ? cursor : null;
    } catch {
      return null;
    }
  }
  private static queryOp(session: Session): string | null {
    return ExtensionState.queryField(session, "op");
  }

  /** Concurrent detail-steps response handler. Routed here when the
   *  session's query annotation says `op: "detail-steps"`. Looks up the
   *  pending entry by testId; if the user already cancelled (entry
   *  absent), the response is silently dropped. */
  private handleDetailSync(session: Session, testId: string): void {
    const entry = this.testPilot.pendingDetails[testId];
    if (!entry) return; // already cancelled / timed out
    if (session.status === "done") {
      const summary = session.appliedSummary ?? "";
      // Ignore an empty "done" (multi-agent race) rather than crashing
      // JSON.parse — keep the pending entry + timer so a valid detail
      // response can still land. See handleTestPilotSync for rationale.
      if (summary.trim() === "") return;
      this.clearDetailTimer(testId);
      try {
        const payload = JSON.parse(summary) as {
          type?: string;
          [k: string]: unknown;
        };
        if (payload.type === "test-pilot-detail") {
          this.applyDetailResult(payload);
        } else {
          this.testPilot.error =
            "Agent returned an unrecognized response. Check the skill version.";
        }
      } catch (err) {
        this.testPilot.error = `Couldn't parse agent response: ${(err as Error).message}`;
      }
      delete this.testPilot.pendingDetails[testId];
    } else if (session.status === "error") {
      this.clearDetailTimer(testId);
      this.testPilot.error =
        session.errorMessage ?? `Test Pilot query failed for ${testId}.`;
      delete this.testPilot.pendingDetails[testId];
    }
  }

  /**
   * Route a Test Pilot query session's lifecycle into the testPilot
   * state slot. The session itself is ephemeral; we only care about
   * the final `status === "done"` payload (or an `error`).
   */
  private handleTestPilotSync(session: Session): void {
    if (!this.testPilot.pending) return;
    if (session.status === "done") {
      const summary = session.appliedSummary ?? "";
      // Ignore an empty "done": a second /pinta terminal (or a
      // generalist agent that completed the session via the generic
      // status path) can mark it done WITHOUT the catalog JSON. Raw
      // JSON.parse("") throws "Unexpected end of JSON input" and would
      // clear `pending`, masking the real catalog that lands right
      // after. Returning here (without clearing the timeout) lets the
      // valid response still apply, or the timeout surface a clearer
      // "is /pinta running?" message. Guards against multi-agent races.
      if (summary.trim() === "") return;
      this.clearTestPilotTimeout();
      try {
        const payload = JSON.parse(summary) as {
          type?: string;
          [k: string]: unknown;
        };
        if (payload.type === "test-pilot-catalog") {
          this.applyCatalogResult(payload);
        } else if (payload.type === "test-pilot-detail") {
          this.applyDetailResult(payload);
        } else {
          this.testPilot.error =
            "Agent returned an unrecognized response. Check the skill version.";
        }
      } catch (err) {
        this.testPilot.error = `Couldn't parse agent response: ${(err as Error).message}`;
      }
      this.testPilot.pending = null;
    } else if (session.status === "error") {
      this.clearTestPilotTimeout();
      this.testPilot.error =
        session.errorMessage ?? "Test Pilot query failed.";
      this.testPilot.pending = null;
    }
  }

  private applyCatalogResult(payload: { [k: string]: unknown }): void {
    // Phase 13 — bail if the user is mid-edit. An incoming catalog
    // payload would otherwise clobber the in-progress text they just
    // typed (inline title / expected / section rename). The pending
    // payload is dropped; the user is asked to commit or cancel and
    // re-trigger Generate.
    if (this.testPilot.editingActive) {
      this.testPilot.error =
        "A catalog update arrived while you were editing. Commit or cancel your edit, then click Generate / Re-import again.";
      this.testPilot.pending = null;
      return;
    }
    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    const newDocId =
      typeof payload.docId === "string" ? payload.docId : crypto.randomUUID();
    // Carry over user-authored metadata when re-importing the same doc
    // so the user's title/author/description survive a Re-import click.
    const prior = this.testPilot.catalog;
    const sameDoc = prior && prior.docId === newDocId;
    const carry = sameDoc
      ? { title: prior.title, author: prior.author, description: prior.description }
      : {};
    // Id-keyed merge so Pass/Fail marks and cached per-row detail steps
    // survive across spec revisions. Same docId AND same test id means
    // the user already ran this scenario — keep their state. Genuinely
    // new ids come in untested; ids that disappear from the new spec
    // are dropped (the test no longer exists). Tradeoff: if the agent
    // ever renumbers an unchanged scenario, marks won't carry — the
    // SKILL.md generate-doc rules call this out and instruct the agent
    // to preserve stable ids during in-place regen.
    const priorById = new Map<string, TestPilotTest>();
    // Phase 14.7 — carry the section-level chat thread across regen,
    // keyed by section title (sections have no stable id). Same policy
    // as the per-row chat carry-over below.
    const priorSectionChatByTitle = new Map<string, ChatMessage[]>();
    if (sameDoc) {
      for (const section of prior.sections) {
        for (const test of section.tests) {
          priorById.set(test.id, test);
        }
        if (section.chat && section.chat.length > 0) {
          priorSectionChatByTitle.set(section.title, section.chat);
        }
      }
    }
    const catalog: TestPilotCatalog = {
      docId: newDocId,
      filename:
        typeof payload.filename === "string"
          ? payload.filename
          : (this.testPilot.pending?.kind === "doc-parse"
              ? this.testPilot.pending.filename
              : this.testPilot.pending?.kind === "doc-generate"
                ? "generated-tests.md"
                : "test-spec.md"),
      importedAt: Date.now(),
      sections: sections.map((s: any) => ({
        title: String(s?.title ?? "Untitled"),
        // Preserve the section-level chat thread across regen of the
        // same doc (keyed by title — see priorSectionChatByTitle).
        chat: priorSectionChatByTitle.get(String(s?.title ?? "Untitled")),
        tests: Array.isArray(s?.tests)
          ? s.tests.map((t: any) => {
              const id = String(t?.id ?? "??");
              const carriedOver = priorById.get(id);
              // Status precedence:
              //   1. Agent payload (the doc-parse handler reads the
              //      Result column from disk — recovers Pass/Fail
              //      across a chrome.storage wipe).
              //   2. In-memory carryover (same docId regen — keeps
              //      marks made since the last write).
              //   3. Default "untested".
              const payloadStatus =
                t?.status === "pass" || t?.status === "fail"
                  ? (t.status as TestPilotStatus)
                  : null;
              return {
                id,
                test: String(t?.test ?? ""),
                expected: String(t?.expected ?? ""),
                status:
                  payloadStatus ??
                  carriedOver?.status ??
                  ("untested" as TestPilotStatus),
                detail: carriedOver?.detail,
                // Preserve the tester's chat thread across re-imports
                // of the same doc — same policy as status / detail.
                // Without this, a Re-import wipes the per-row Q&A
                // history the tester accumulated during the previous
                // run.
                chat: carriedOver?.chat,
              };
            })
          : [],
      })),
      ...carry,
    };
    this.testPilot.catalog = catalog;
    this.testPilot.error = null;
    void this.saveTestPilot();
  }

  /** Reset every test row in the active catalog to `untested` and drop
   *  cached per-row detail. Keeps the catalog structure intact (same
   *  sections, same test ids, same metadata) — the user gets a clean
   *  slate to re-run testing without losing the parsed spec or having
   *  to clear and re-import. Persists immediately. No-op when there's
   *  no catalog loaded. */
  clearTestPilotMarks(): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    for (const section of c.sections) {
      for (const test of section.tests) {
        test.status = "untested";
        test.detail = undefined;
      }
    }
    void this.saveTestPilot();
    // Push to disk so the Result column in the on-disk MD clears too —
    // otherwise the spec file still shows the old marks until the next
    // structural edit re-syncs it. The per-author sidecar also clears
    // so a chrome.storage wipe after this point doesn't resurrect the
    // marks via the recovery path.
    this.pushTestDocToCompanion();
    this.pushResultsToCompanion();
  }

  /** Update the user-authored metadata on the active catalog. Empty
   *  strings are normalized to `undefined` so the UI can fall back to
   *  placeholders. Persists immediately. */
  setTestPilotMeta(patch: {
    title?: string;
    author?: string;
    description?: string;
  }): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    const norm = (v: string | undefined) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim();
      return trimmed === "" ? undefined : trimmed;
    };
    if ("title" in patch) c.title = norm(patch.title);
    if ("author" in patch) c.author = norm(patch.author);
    if ("description" in patch) c.description = norm(patch.description);
    void this.saveTestPilot();
    // Title / author / description change the on-disk spec heading,
    // and an author change picks a new sidecar slug. Push both so the
    // disk view (sign-off artifact + durable per-author results)
    // tracks the in-app metadata.
    this.pushTestDocToCompanion();
    if ("author" in patch) this.pushResultsToCompanion();
  }

  private applyDetailResult(payload: { [k: string]: unknown }): void {
    const testId =
      typeof payload.testId === "string"
        ? payload.testId
        : this.testPilot.pending?.kind === "detail-steps"
          ? this.testPilot.pending.testId
          : null;
    if (!testId) return;
    const steps = Array.isArray(payload.steps)
      ? payload.steps.map((s) => repairReplacementChars(repairMojibake(String(s))))
      : [];
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          t.detail = { steps, askedAt: Date.now() };
          this.testPilot.error = null;
          void this.saveTestPilot();
          // Cache the agent's detail steps to disk too — they're
          // pulled per-row on demand and re-fetching is slow + costs
          // tokens. The per-author sidecar carries them across
          // chrome.storage wipes.
          this.pushResultsToCompanion();
          return;
        }
      }
    }
  }
}

export const app = new ExtensionState();
