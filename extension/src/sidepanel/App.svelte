<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type {
    Annotation,
    AnnotationTarget,
    Session,
    SessionManifest,
  } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import { uid } from "../lib/id.js";
  import {
    compositeAnnotations,
    compositeAnnotationsToViewport,
  } from "../lib/composite.js";
  import {
    formatSession,
    formatSessionAsClipboard,
    type ExportFormat,
  } from "../lib/format-clipboard.js";
  import {
    encodePintaFile,
    pintaFilename,
    PintaFileError,
  } from "../lib/pinta-file.js";
  import { zipSync, strToU8 } from "fflate";
  import { theme, toggleTheme } from "../lib/theme.svelte.js";
  import { matchAny, suggestPattern } from "../lib/url-patterns.js";
  import type { Companion } from "../lib/companions.js";
  import StatusPill from "./StatusPill.svelte";
  import AnnotationCard from "./AnnotationCard.svelte";
  import SessionHistory from "./SessionHistory.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import TestPilotTab from "./TestPilotTab.svelte";
  import { BUILTIN_MODULES } from "../lib/modules.js";

  type SidePanelTab = "annotate" | "test-pilot";
  // Active tab in the main panel area. Persists across side-panel
  // re-opens via chrome.storage.local (`pinta-active-tab`). Only the
  // "test-pilot" tab is conditionally rendered — gated on the module
  // being enabled in Settings.
  let activeTab = $state<SidePanelTab>("annotate");

  // Per-tab "busy" indicators. Drive the spinner that replaces the tab
  // icon when work is happening — gives the user a peripheral signal of
  // activity in the OTHER tab while they're focused on this one.
  // Annotate: agent is processing a submitted session.
  // Test Pilot: doc-parse / doc-generate in flight, or any per-row Ask
  // (single or bulk) pending.
  const annotateBusy = $derived(
    app.session?.status === "submitted" ||
      app.session?.status === "applying",
  );
  const testPilotBusy = $derived(
    app.testPilot.pending !== null ||
      Object.keys(app.testPilot.pendingDetails).length > 0,
  );

  type Tool = "select" | "arrow" | "rect" | "circle" | "freehand" | "pin" | "image";
  type ActiveMode = "idle" | "select" | "draw" | "image";

  // SVG paths render reliably across fonts/OSes, follow currentColor in
  // both light + dark mode, and don't depend on unicode glyph coverage.
  const TOOLS: { id: Tool; label: string; svg: string }[] = [
    {
      id: "select",
      label: "Select",
      // Lucide mouse-pointer-2 — solid cursor arrow. fill=currentColor
      // overrides the container's fill="none" so the cursor renders solid.
      svg: '<path d="M4 4l7 17 2.5-7.5L21 11z" fill="currentColor" stroke="currentColor" stroke-width="1"/>',
    },
    {
      id: "arrow",
      label: "Arrow",
      svg: '<path d="M7 17 L17 7"/><path d="M9 7 L17 7 L17 15"/>',
    },
    {
      id: "rect",
      label: "Rect",
      svg: '<rect x="3" y="6" width="18" height="12" rx="1.5"/>',
    },
    {
      id: "freehand",
      label: "Pen",
      svg: '<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    },
    {
      id: "pin",
      label: "Pin",
      svg: '<path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="3"/>',
    },
    {
      id: "image",
      label: "Image",
      // Lucide image-plus — picture frame with a "+" badge so it's
      // clearly an "insert an image" affordance, not a "view image" one.
      svg: '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><path d="m3 16 5-5c.928-.893 2.072-.893 3 0l5 5"/><path d="m14 14 1-1c.928-.893 2.072-.893 3 0l3 3"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><path d="M19 3v4"/><path d="M17 5h4"/>',
    },
  ];

  let pageUrl = $state<string>("");
  let activeTabId = $state<number | null>(null);
  let activeTool = $state<Tool | null>(null);
  let selector = $state("");
  let comment = $state("");
  let capturing = $state(false);
  // Screenshots add ~1.5–2k vision tokens per submit. Off by default; the
  // agent works fine with selector + outerHTML + nearbyText alone for most
  // text/style edits.
  let includeScreenshot = $state(false);
  let copiedAt = $state<number | null>(null);
  let autoReloadEnabled = $state(true);
  let autoApplyEnabled = $state(false);
  let hmrDetected = $state<boolean | null>(null);
  let reloadingAt = $state<number | null>(null);
  let lastHandledSessionId = $state<string | null>(null);
  let lastOverlaySessionId = $state<string | null>(null);

  type IncomingMsg = {
    type?: string;
    annotationId?: string;
    /** Multi-select payload from the content script. */
    targets?: AnnotationTarget[];
    /** Single-select fallback (older content scripts) — promoted to targets[0]. */
    target?: AnnotationTarget;
    groupingMode?: "single-edit" | "per-element";
    comment?: string;
    customCss?: string;
    cssChanges?: Record<string, string>;
    contentChange?: { textBefore: string; textAfter: string };
    images?: import("@pinta/shared").AnnotationImage[];
    viewport?: { scrollY: number; width: number; height: number };
    annotation?: Annotation;
    /** `overlay.ready` carries the active page URL the script just mounted on. */
    url?: string;
    /** `imported.located` — content script reports selector-resolution count. */
    matched?: number;
    total?: number;
  };

  /** Selector-resolution count for the currently-viewed imported session,
   *  reported by the content script after it resolves each annotation's
   *  selector against the live DOM. Null = no report yet (or no imported
   *  session being viewed). */
  let importedLocated = $state<{ matched: number; total: number } | null>(null);

  /**
   * Push every select-mode annotation from the current draft whose
   * stored URL matches `url` to the given tab so the content script
   * can repaint its pin badge. Best-effort; silently no-ops if the
   * content script isn't listening.
   */
  function replayAnnotationsToTab(tabId: number, url: string): void {
    const sessionUrl = app.session?.url ?? "";
    const all = app.session?.annotations ?? [];
    for (const ann of all) {
      if (ann.kind !== "select") continue;
      const annUrl = ann.url ?? sessionUrl;
      if (annUrl !== url) continue;
      chrome.tabs
        .sendMessage(tabId, { type: "annotated.replay", annotation: ann })
        .catch(() => {
          // Content script not (yet) listening — skip.
        });
    }
  }

  let projectMenuOpen = $state(false);
  let associating = $state(false);
  let associatedAt = $state<number | null>(null);
  let associateError = $state<string | null>(null);
  let downloadMenuOpen = $state(false);
  let bundleBusy = $state(false);

  // Export-as-.pinta state — opens a small inline form when the user
  // picks "Share file (.pinta)" from the download menu. Author + accent
  // persist between exports via chrome.storage.local so they don't have
  // to be retyped each time. Title/description default empty per export.
  const PINTA_PREFS_KEY = "pinta-share-prefs";
  const ACCENT_PALETTE = [
    "#FF3D6E", // brand pink
    "#7C3AED", // violet
    "#0EA5E9", // sky
    "#10B981", // emerald
    "#F59E0B", // amber
    "#1F2937", // slate-ink
  ];
  let pintaFormOpen = $state(false);
  let pintaTitle = $state("");
  let pintaAuthor = $state("");
  let pintaDescription = $state("");
  let pintaAccentColor = $state(ACCENT_PALETTE[0]!);
  let importBusy = $state(false);
  let importedSendBusy = $state(false);
  let importedToastAt = $state<number | null>(null);
  let importedToastLabel = $state<string | null>(null);
  let importFileInput: HTMLInputElement | null = $state(null);

  async function loadSharePrefs() {
    try {
      const stored = await chrome.storage?.local?.get(PINTA_PREFS_KEY);
      const prefs = stored?.[PINTA_PREFS_KEY] as
        | { author?: string; accentColor?: string }
        | undefined;
      if (prefs?.author) pintaAuthor = prefs.author;
      if (prefs?.accentColor) pintaAccentColor = prefs.accentColor;
    } catch {
      // storage perm missing or restricted page — defaults are fine
    }
  }
  async function saveSharePrefs() {
    try {
      await chrome.storage?.local?.set({
        [PINTA_PREFS_KEY]: {
          author: pintaAuthor,
          accentColor: pintaAccentColor,
        },
      });
    } catch {
      // ignore — non-fatal
    }
  }

  function openPintaExportForm() {
    if (!annotations.length) return;
    downloadMenuOpen = false;
    if (!pintaTitle) {
      // Suggest a title from the URL host so the form doesn't start blank.
      const url = pageUrl || app.session?.url || "";
      try {
        const u = new URL(url);
        pintaTitle = `${u.hostname} — ${new Date().toLocaleDateString()}`;
      } catch {
        pintaTitle = `Session — ${new Date().toLocaleDateString()}`;
      }
    }
    pintaFormOpen = true;
  }

  function exportAsPinta() {
    const session = app.session;
    if (!session || !annotations.length) return;
    const trimmedTitle = pintaTitle.trim();
    const trimmedAuthor = pintaAuthor.trim();
    if (!trimmedTitle || !trimmedAuthor) return;
    const manifest: SessionManifest = {
      title: trimmedTitle,
      author: trimmedAuthor,
      description: pintaDescription.trim() || undefined,
      accentColor: pintaAccentColor,
      exportedAt: Date.now(),
    };
    // Snapshot strips Svelte 5 reactive proxies so the JSON encoder
    // sees plain objects (matches the local-store save pattern).
    const snapshot = $state.snapshot(session) as Session;
    const blob = encodePintaFile(snapshot, manifest);
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = pintaFilename(manifest, snapshot.url);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objUrl), 0);
    void saveSharePrefs();
    pintaFormOpen = false;
  }

  async function onImportFileChosen(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-importing the same file
    if (!file) return;
    importBusy = true;
    app.lastError = null;
    try {
      const imported = await app.importPintaFile(file);
      // Open the read-only viewer immediately so the user actually sees
      // what they imported — without this, an import in connected mode
      // looks like nothing happened (the imported session lands in
      // History, not in the active draft, and the toast is short-lived).
      app.viewImported(imported.id);
      importedToastLabel = `Imported "${imported.manifest.title}"`;
      importedToastAt = Date.now();
      setTimeout(() => {
        if (importedToastAt && Date.now() - importedToastAt >= 2500) {
          importedToastAt = null;
          importedToastLabel = null;
        }
      }, 2600);
    } catch (err) {
      const msg =
        err instanceof PintaFileError
          ? `Couldn't import: ${err.message}`
          : `Import failed: ${(err as Error).message}`;
      app.lastError = msg;
    } finally {
      importBusy = false;
    }
  }

  // Runtime-message handler is wired here (not inside the async onMount)
  // so the cleanup function returns sync — Svelte's onMount can't return
  // a Promise<cleanup>. The handler doesn't depend on async setup.
  //
  // Origin guard: Chrome only delivers runtime messages from the same
  // extension by default, but this future-proofs against accidentally
  // adding `externally_connectable` to the manifest later.
  const runtimeMessageHandler = (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
  ) => {
    if (sender?.id !== chrome.runtime.id) return;
    const m = msg as IncomingMsg;
    if (m?.type === "overlay.ready" && sender.tab?.id != null) {
      // Content script just mounted (page reload / SPA nav). Push back
      // any select-mode annotations from the current draft that were
      // captured on this URL so their pin badges re-paint.
      const url = m.url ?? "";
      // Adopt the content script's view of the URL as the source of
      // truth for "what page is the user looking at". chrome.tabs API
      // doesn't fire info.url for hash-only changes, so without this
      // the filter mis-classifies annotations as "on another page".
      if (url && sender.tab.id === activeTabId) {
        pageUrl = url;
      }
      replayAnnotationsToTab(sender.tab.id, url);
      return;
    }
    if (m?.type === "imported.located" && typeof m.matched === "number" && typeof m.total === "number") {
      importedLocated = { matched: m.matched, total: m.total };
      return;
    }
    if (m?.type === "annotation.target-selected") {
      // Prefer plural targets[]; fall back to legacy single target.
      // Skip the message if neither is present (no point making an
      // annotation with nothing for the agent to act on).
      const targets =
        m.targets && m.targets.length > 0
          ? m.targets
          : m.target
            ? [m.target]
            : null;
      if (!targets) return;
      const annotation: Annotation = {
        id: m.annotationId ?? uid("ann"),
        createdAt: Date.now(),
        kind: "select",
        strokes: [],
        color: "#FF3D6E",
        comment: (m.comment ?? "").trim(),
        customCss: m.customCss?.trim() || undefined,
        cssChanges:
          m.cssChanges && Object.keys(m.cssChanges).length > 0
            ? m.cssChanges
            : undefined,
        contentChange: m.contentChange,
        images: m.images && m.images.length > 0 ? m.images : undefined,
        targets,
        // Keep `target` populated as the legacy single-target alias for
        // one release (matches the @deprecated note in shared/types.ts)
        // so older companion JSONs round-trip cleanly.
        target: targets[0],
        groupingMode: targets.length > 1 ? (m.groupingMode ?? "single-edit") : undefined,
        viewport: m.viewport ?? snapshotViewport(),
        // Stamp from the content script's location.href — authoritative
        // for SPAs where chrome.tabs.onUpdated misses hash/pushState changes
        // and the side panel's lastUrl can be stale.
        url: m.url,
      };
      app.addAnnotation(annotation);
      activeTool = null;
    } else if (m?.type === "annotation.draw-committed" && m.annotation) {
      app.addAnnotation(m.annotation);
    }
  };

  onMount(async () => {
    chrome.runtime.onMessage.addListener(runtimeMessageHandler);

    void loadSharePrefs();
    // Restore the last-used tab. If Test Pilot was active but the
    // module has since been disabled, fall back to Annotate.
    try {
      const stored = await chrome.storage?.local?.get("pinta-active-tab");
      const raw = stored?.["pinta-active-tab"];
      if (raw === "test-pilot" || raw === "annotate") {
        activeTab = raw;
      }
    } catch {
      // ignore — storage unavailable
    }

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      pageUrl = tab?.url ?? "";
      activeTabId = tab?.id ?? null;
    } catch {
      // not running in extension context (e.g. dev preview)
    }
    // Discover companions + auto-pick by URL pattern. Must follow the
    // tab query so the URL is available for routing.
    await app.start(pageUrl || null);

    // When the active tab changes (user navigates), re-evaluate routing.
    const onTabActivated = async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        pageUrl = tab?.url ?? "";
        activeTabId = tab?.id ?? null;
        await app.rescan(pageUrl || null);
      } catch {
        // ignore — likely transient
      }
    };
    chrome.tabs?.onActivated?.addListener(onTabActivated);
    chrome.tabs?.onUpdated?.addListener((tabId, info) => {
      if (info.url && tabId === activeTabId) onTabActivated();
    });
  });

  onDestroy(() => {
    chrome.runtime.onMessage.removeListener(runtimeMessageHandler);
    app.stop();
  });

  $effect(() => {
    if (!pageUrl || app.session) return;
    // Standalone mode is fire-once (no WS to wait on). Connected mode
    // waits until the WS is up so the companion doesn't miss the create.
    if (app.appMode === "standalone") {
      app.ensureSession(pageUrl);
    } else if (app.connectionStatus === "connected") {
      app.ensureSession(pageUrl);
    }
  });

  // Proactive replay: when the side panel opens AFTER the content
  // script already mounted (so its `overlay.ready` ping was lost),
  // push pin-badge replays as soon as we have a session + active tab.
  // The content script dedupes against `content.annotated` so a
  // double-fire (handshake + this) is safe.
  let lastReplayKey = $state<string>("");
  $effect(() => {
    const tabId = activeTabId;
    const url = pageUrl;
    const sessionId = app.session?.id;
    const annCount = app.session?.annotations.length ?? 0;
    if (tabId == null || !url || !sessionId) return;
    const key = `${tabId}:${url}:${sessionId}:${annCount}`;
    if (key === lastReplayKey) return;
    lastReplayKey = key;
    replayAnnotationsToTab(tabId, url);
  });

  // Dedupe by id at the display layer so a corrupted session (or a
  // double-fire on the runtime-message → WS path) doesn't crash Svelte's
  // keyed-each diffing with `each_key_duplicate`. First-seen wins so
  // ordering is preserved.
  const annotations = $derived.by(() => {
    const raw = app.session?.annotations ?? [];
    const seen = new Set<string>();
    const out: Annotation[] = [];
    for (const a of raw) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    return out;
  });
  // Per-page filtering. Annotations carry their own `url` (set when
  // captured); fall back to session.url for legacy payloads where that
  // field was missing. The list shows only annotations belonging to the
  // page the user is currently looking at — `otherPages` powers the
  // "N on M other pages" chip above the list.
  const annotationsHere = $derived.by(() => {
    const sessionUrl = app.session?.url ?? "";
    const here = pageUrl;
    return annotations.filter(
      (a) => (a.url ?? sessionUrl) === here,
    );
  });
  const otherPages = $derived.by(() => {
    const sessionUrl = app.session?.url ?? "";
    const here = pageUrl;
    const map = new Map<string, Annotation[]>();
    for (const a of annotations) {
      const u = a.url ?? sessionUrl;
      if (u === here) continue;
      if (!map.has(u)) map.set(u, []);
      map.get(u)!.push(a);
    }
    return [...map.entries()];
  });
  const elsewhereCount = $derived(
    otherPages.reduce((n, [, anns]) => n + anns.length, 0),
  );
  let otherPagesExpanded = $state(false);
  /**
   * Pretty-print a URL for the "other pages" chip. Strips the origin
   * when it matches the current page's origin (since the user already
   * knows which app they're in) and shows the path + query so similar
   * routes are still distinguishable.
   */
  function formatOtherPageUrl(u: string): string {
    try {
      const here = new URL(pageUrl || "http://localhost");
      const there = new URL(u);
      if (there.origin === here.origin) {
        // Include the hash so hash-routed SPAs (/#claims/active) are
        // distinguishable in the chip — otherwise every hash route on
        // the same origin renders as just "/".
        return there.pathname + there.search + there.hash;
      }
      return u;
    } catch {
      return u;
    }
  }
  async function openOtherPage(u: string): Promise<void> {
    if (activeTabId == null) return;
    try {
      await chrome.tabs.update(activeTabId, { url: u });
    } catch {
      // Tab gone or URL invalid — silently no-op; the user can navigate manually.
    }
    otherPagesExpanded = false;
  }
  const canSubmit = $derived(
    annotations.length > 0 && app.session?.status === "drafting",
  );
  const canEditAnnotations = $derived(app.session?.status === "drafting");
  // True when there's nothing left for the agent to do. Two paths:
  //   1. Session-level status flipped to done/error by the companion.
  //   2. Session is in flight (submitted/applying), every annotation has
  //      individually settled (✓ or !), but the session-level flip hasn't
  //      arrived. Without this fallback, the footer leaks both
  //      "waiting for agent" AND the per-card ✓s at the same time.
  // Empty drafts are explicitly excluded so `every` on [] doesn't
  // trivially light up the done UI before the user has done anything.
  const allDone = $derived.by(() => {
    const status = app.session?.status;
    if (status === "done" || status === "error") return true;
    if (status !== "submitted" && status !== "applying") return false;
    if (annotations.length === 0) return false;
    return annotations.every(
      (a) => a.status === "done" || a.status === "error",
    );
  });
  // Light up the per-annotation spinner the instant the user submits —
  // don't wait for the agent to flip individual statuses to "applying".
  // Sitting idle between Submit and the first agent edit is bad UX.
  const sessionPending = $derived(
    app.session?.status === "submitted" || app.session?.status === "applying",
  );
  // Drawing-kind annotations carry only stroke coords + comment — no DOM
  // selector, no outerHTML. Without a screenshot the agent has nothing to
  // act on, so we auto-enable capture as soon as one lands in the session
  // and lock the toggle.
  const hasDrawingAnnotation = $derived(
    annotations.some((a) => a.kind !== "select"),
  );
  // True when at least one ticked module needs the screenshot embedded
  // in its output (e.g. GitLab Issues attaches it to every issue body).
  // While true, the screenshot toggle is forced on and locked — the
  // module would otherwise file empty issues missing the visual context
  // the user just spent time capturing.
  const screenshotRequiredByModule = $derived.by(() => {
    for (const spec of BUILTIN_MODULES) {
      if (!spec.recommendsScreenshot) continue;
      if (app.tickedModules[spec.id]) return true;
    }
    return false;
  });
  const screenshotLocked = $derived(
    hasDrawingAnnotation || screenshotRequiredByModule,
  );
  // File-only mode: user ticked a per-submit module (currently
  // gitlab-issues) but did NOT tick Auto-apply. Read as "just file the
  // ticket, don't touch my code without permission." The agent's
  // SKILL.md §5 third branch keys on `session.modules` + autoApply to
  // skip source edits entirely in this case; the button label
  // mirrors that intent client-side so the user isn't surprised at
  // click time.
  const gitlabIssuesTickedAndReady = $derived(
    app.moduleReady("gitlab-issues") && !!app.tickedModules["gitlab-issues"],
  );
  const fileOnlyMode = $derived(
    gitlabIssuesTickedAndReady && !autoApplyEnabled,
  );
  $effect(() => {
    if (screenshotLocked && !includeScreenshot) {
      includeScreenshot = true;
    }
  });

  // Routing-mismatch detection: side panel is connected to a companion
  // but the active tab URL doesn't match any of its URL patterns. Two
  // sub-states matter — patterns are empty (offer to associate) vs.
  // patterns set but none match (warn before submit).
  const matchesSelected = $derived(
    !!app.selectedCompanion &&
      !!pageUrl &&
      app.selectedCompanion.urlPatterns.length > 0 &&
      matchAny(pageUrl, app.selectedCompanion.urlPatterns),
  );
  // Annotations don't bleed across projects. When the active tab URL
  // doesn't match any of the connected companion's patterns, gate the
  // entire annotation UI behind the associate-or-pick prompt.
  // Includes file:// (local docs / static HTML) and any other scheme
  // beyond http(s) — the "scope to project" guarantee should hold
  // regardless of where the page is loaded from. chrome:// and
  // about://-style internal pages get a pass since the content script
  // never injects there anyway.
  const isAssociatable = $derived(
    !!pageUrl &&
      (pageUrl.startsWith("http://") ||
        pageUrl.startsWith("https://") ||
        pageUrl.startsWith("file://")),
  );
  const showAssociatePrompt = $derived(
    !!app.selectedCompanion && isAssociatable && !matchesSelected,
  );

  // Routing ambiguity: when more than one running companion claims the
  // current tab URL, the auto-pick policy is non-deterministic — the
  // user could end up annotating in the "wrong" project without realizing
  // it. Surface this so they know to tighten one project's patterns.
  const matchingCompanionsForUrl = $derived(
    pageUrl
      ? app.companions.filter((c) => matchAny(pageUrl, c.urlPatterns))
      : [],
  );
  const hasRoutingConflict = $derived(matchingCompanionsForUrl.length > 1);

  function shortRoot(path: string): string {
    // Show the trailing path segment (project name) — full path is in title.
    const norm = path.replace(/\\/g, "/");
    const trimmed = norm.replace(/\/$/, "");
    const seg = trimmed.split("/").pop();
    return seg || trimmed;
  }

  async function selectCompanion(c: Companion | null) {
    projectMenuOpen = false;
    await app.select(c);
  }

  async function associateActiveUrl() {
    if (!pageUrl || !app.selectedCompanion || associating) return;
    associating = true;
    associateError = null;
    try {
      await app.associateUrl(suggestPattern(pageUrl));
      associatedAt = Date.now();
      // Clear the success indicator after a couple seconds. The banner
      // will hide itself the moment matchesSelected flips to true, but
      // keep the success badge visible for a beat in case the URL also
      // changed during the request.
      setTimeout(() => {
        if (associatedAt && Date.now() - associatedAt >= 1900) {
          associatedAt = null;
        }
      }, 2000);
    } catch (err) {
      // Surface in two places so the user can't miss it: inline in the
      // banner (next to the button) AND the global error strip below.
      const msg = (err as Error).message;
      associateError = msg;
      app.lastError = `associate failed: ${msg}`;
      // eslint-disable-next-line no-console
      console.error("[pinta] associate failed", err);
    } finally {
      associating = false;
    }
  }

  async function setActive(tool: Tool | null) {
    if (activeTabId == null) return;
    // Image tool is unusual: instead of switching the page into a "wait
    // for input" mode, we kick off a file picker first. The page only
    // enters image-placement mode once the user has actually picked a
    // file — otherwise an accidental click on the Image button would
    // leave a placeholder overlay floating on the page with nothing in
    // it. The runtime message is sent from inside `onImageFilePicked`.
    if (tool === "image") {
      // Always re-fire the picker — re-clicking the active Image tool
      // should let the user pick a different image (instead of being a
      // toggle-off, which is what it was for stroke tools).
      activeTool = "image";
      pickImageFile();
      return;
    }
    const next = tool;
    const mode: ActiveMode =
      next == null ? "idle" : next === "select" ? "select" : "draw";
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "mode.set",
        mode,
        tool: mode === "draw" ? next : undefined,
      });
      activeTool = next;
    } catch (err) {
      const msg = (err as Error).message;
      if (
        /Receiving end does not exist|Could not establish connection/.test(msg)
      ) {
        app.lastError =
          "Pinta isn't injected on this tab yet. Refresh the tab (F5) and try again. " +
          "If it's a chrome:// or new-tab page, navigate to your app first.";
      } else {
        app.lastError = `couldn't reach page: ${msg}`;
      }
    }
  }

  let imageFileInput: HTMLInputElement | undefined = $state();

  function pickImageFile() {
    if (!imageFileInput) return;
    // Reset value so picking the same file twice still fires `change`.
    imageFileInput.value = "";
    imageFileInput.click();
  }

  async function onImageFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || activeTabId == null) {
      activeTool = null;
      return;
    }
    if (!file.type.startsWith("image/")) {
      app.lastError = `not an image: ${file.type || file.name}`;
      activeTool = null;
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      await chrome.tabs.sendMessage(activeTabId, {
        type: "image.place",
        dataUrl,
        mediaType: file.type || "image/png",
        name: file.name,
      });
      // Page is now in image-placement mode — the user drags / resizes
      // the image, types a comment, hits Save in the popover. We don't
      // hold onto activeTool here since the workflow lives on the page.
    } catch (err) {
      app.lastError = `couldn't load image: ${(err as Error).message}`;
      activeTool = null;
    }
  }

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function snapshotViewport() {
    return {
      scrollY: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  function addAnnotationFromForm() {
    if (!selector.trim() || !comment.trim()) return;
    const annotation: Annotation = {
      id: uid("ann"),
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#FF3D6E",
      comment: comment.trim(),
      viewport: snapshotViewport(),
      target: {
        selector: selector.trim(),
        outerHTML: "",
        computedStyles: {},
        nearbyText: [],
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
      },
    };
    app.addAnnotation(annotation);
    selector = "";
    comment = "";
  }

  function removeAnnotation(id: string) {
    app.removeAnnotation(id);
    // Drop the matching pin badge in the content overlay too.
    if (activeTabId != null) {
      chrome.tabs
        .sendMessage(activeTabId, { type: "annotated.remove", annotationId: id })
        .catch(() => {});
    }
  }

  async function clearAllAnnotations() {
    if (!annotations.length) return;
    // Use the full session-reset path so EVERYTHING goes — pin badges,
    // inline DOM mutations, per-entry rect cache, session annotations
    // (across all pages), and the session metadata itself. Standalone
    // mode automatically spawns a fresh session for the current origin
    // so the user can keep annotating without an extra click. The
    // per-annotation `annotated.remove` path used to leave stale
    // entries in content.annotated when annotations were stamped with
    // URLs other than the active tab's — bulk-clear avoids that.
    await cancelSession();
  }

  async function cancelSession() {
    if (!app.session) return;
    // Wipe pin badges in the content overlay before the session resets.
    if (activeTabId != null) {
      chrome.tabs
        .sendMessage(activeTabId, { type: "annotated.clear" })
        .catch(() => {});
    }
    await app.cancelAndRestart(pageUrl || app.session.url);
    activeTool = null;
  }

  // Best-effort HMR detection: probe the page for known dev-mode markers.
  // Returns true if any are present (Vite, Webpack/Next.js, Parcel HMR).
  async function detectHmr(tabId: number): Promise<boolean> {
    try {
      const [first] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const w = window as unknown as Record<string, unknown>;
          if (document.querySelector('script[src*="@vite/client"]')) return true;
          if (document.querySelector('script[src*="vite/dist"]')) return true;
          if (w.__vite_plugin_react_preamble_installed__) return true;
          if (w.__HMR__) return true;
          if (w.webpackHotUpdate || w.__webpack_hmr) return true;
          if (w.__NEXT_HMR_LATENCY_CB || w.__NEXT_DATA__) {
            // __NEXT_DATA__ exists in prod too; only treat as HMR if there
            // is also a websocket-ish error overlay element.
            if (document.querySelector("nextjs-portal, nextjs-build-watcher")) {
              return true;
            }
          }
          if (document.querySelector("vite-error-overlay")) return true;
          if (document.querySelector("[data-svelte-h]") && location.hostname === "localhost") {
            // Heuristic only — Svelte 5 hydration markers + localhost.
            return true;
          }
          return false;
        },
      });
      return !!first?.result;
    } catch {
      return false;
    }
  }

  async function reloadActiveTab() {
    if (activeTabId == null) return;
    reloadingAt = Date.now();
    try {
      await chrome.tabs.reload(activeTabId);
      setTimeout(() => {
        if (reloadingAt && Date.now() - reloadingAt >= 1500) reloadingAt = null;
      }, 1600);
    } catch (err) {
      app.lastError = `reload failed: ${(err as Error).message}`;
      reloadingAt = null;
    }
  }

  // When a session reaches done/error, optionally auto-reload the tab if
  // no HMR was detected. Tracked by session id so we don't re-trigger on
  // re-renders.
  $effect(() => {
    const session = app.session;
    if (!session) return;
    if (session.status !== "done") return;
    if (lastHandledSessionId === session.id) return;
    lastHandledSessionId = session.id;
    if (activeTabId == null) return;

    detectHmr(activeTabId).then((hasHmr) => {
      hmrDetected = hasHmr;
      if (!hasHmr && autoReloadEnabled) reloadActiveTab();
    });
  });

  // Reset on-page badges whenever the session id flips. Covers the
  // drafting → submitted → done → new-draft transition (server creates a
  // fresh session id so the next batch numbers from 1) and any other path
  // that swaps session.id without going through cancelSession's manual
  // clear. Skips the very first non-null assignment so we don't wipe
  // unrelated tabs the moment the side panel boots.
  $effect(() => {
    const id = app.session?.id ?? null;
    if (id === lastOverlaySessionId) return;
    const previous = lastOverlaySessionId;
    lastOverlaySessionId = id;
    if (previous === null) return;
    if (activeTabId == null) return;
    chrome.tabs
      .sendMessage(activeTabId, { type: "annotated.clear" })
      .catch(() => {});
  });

  // Drive the page-edge processing pulse — content script paints a
  // pulsating inset glow while the agent is picking up / applying the
  // session so the user has visible confirmation that something is
  // happening on a foreign machine. Off by default (Settings → Visual
  // feedback). Tracks both `sessionPending` AND whether the user
  // enabled the pulse, so flipping the toggle while a session is in
  // flight starts / stops the glow immediately.
  let lastProcessingPing = $state<string | null>(null);
  $effect(() => {
    const processing = sessionPending && app.pulseSettings.enabled;
    const color = app.pulseSettings.color;
    if (activeTabId == null) return;
    const key = processing ? `on:${color}` : "off";
    if (lastProcessingPing === key) return;
    lastProcessingPing = key;
    chrome.tabs
      .sendMessage(activeTabId, {
        type: processing ? "processing.start" : "processing.end",
        color: processing ? color : undefined,
      })
      .catch(() => {});
  });

  // Push the imported-session overlay (metadata pill + per-annotation
  // halos / badges) to the active tab whenever the user opens or closes
  // the read-only viewer. The content script reads the manifest's
  // accentColor to tint everything in the chosen palette so multiple
  // shared sessions stay visually distinguishable.
  $effect(() => {
    if (activeTabId == null) return;
    const viewing = app.viewingImportedId
      ? app.importedSessions.find((s) => s.id === app.viewingImportedId)
      : null;
    if (viewing) {
      // Reset the located indicator so a stale count from a previous
      // viewer doesn't briefly show while the new one is resolving.
      importedLocated = null;
      chrome.tabs
        .sendMessage(activeTabId, {
          type: "imported.show",
          imported: {
            title: viewing.manifest.title,
            author: viewing.manifest.author,
            accentColor: viewing.manifest.accentColor,
            // Snapshot strips Svelte 5 reactive proxies before crossing
            // the runtime-message boundary (chrome.runtime uses
            // structuredClone internally and chokes on them otherwise).
            annotations: $state.snapshot(viewing.session.annotations),
          },
        })
        .catch(() => {
          // content script not injected on this URL — silently fine,
          // the side-panel cards are still visible
        });
    } else {
      importedLocated = null;
      chrome.tabs
        .sendMessage(activeTabId, { type: "imported.hide" })
        .catch(() => {});
    }
  });

  async function copyToClipboard() {
    if (!annotations.length) return;
    const text = formatSessionAsClipboard({
      url: pageUrl || app.session?.url || "",
      annotations,
    });
    try {
      await navigator.clipboard.writeText(text);
      copiedAt = Date.now();
      setTimeout(() => {
        if (copiedAt && Date.now() - copiedAt >= 2000) copiedAt = null;
      }, 2100);
    } catch (err) {
      app.lastError = `clipboard write failed: ${(err as Error).message}`;
    }
  }

  function downloadAs(format: ExportFormat) {
    if (!annotations.length) return;
    downloadMenuOpen = false;
    const url = pageUrl || app.session?.url || "";
    const text = formatSession({ url, annotations }, format);
    const mime = format === "md" ? "text/markdown" : "text/plain";
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filenameFor(url, format);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after the click handler has had a chance to consume the URL.
    setTimeout(() => URL.revokeObjectURL(objUrl), 0);
  }

  function filenameFor(url: string, format: ExportFormat): string {
    return `${baseFilename(url)}.${format}`;
  }

  function baseFilename(url: string): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    let host = "annotations";
    try {
      const u = new URL(url);
      host = u.hostname || host;
    } catch {
      // url unparsable — fall back to "annotations"
    }
    return `pinta-${host}-${stamp}`;
  }

  function dataUrlToBytes(dataUrl: string): Uint8Array {
    const comma = dataUrl.indexOf(",");
    if (comma === -1) throw new Error("malformed data URL");
    const b64 = dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Bundle export: capture full-page screenshot, composite annotations
   * (with numbered badges) onto it, zip the .md and .png together so
   * an agent can read both with a single drop into Claude / Cursor / etc.
   * Standalone-mode equivalent of the connected-mode Submit flow.
   */
  async function downloadBundle(format: ExportFormat) {
    if (!annotations.length || activeTabId == null || bundleBusy) return;
    downloadMenuOpen = false;
    bundleBusy = true;
    app.lastError = null;
    try {
      // Lift the toolbar/highlight off the page before capture so the
      // screenshot is clean. Same trick the connected-mode submit uses.
      try {
        await chrome.tabs.sendMessage(activeTabId, {
          type: "mode.set",
          mode: "idle",
        });
      } catch {
        // content script may not be present (e.g. chrome:// page); fail soft
      }
      activeTool = null;

      const resp = (await chrome.runtime.sendMessage({
        type: "capture.full-page",
        tabId: activeTabId,
      })) as {
        ok: boolean;
        capture?: {
          dataUrl: string;
          slices?: Array<{ dataUrl: string; offsetY: number }>;
          viewportWidth?: number;
          viewportHeight?: number;
        };
        error?: string;
      };
      if (!resp?.ok || !resp.capture) {
        throw new Error(resp?.error ?? "capture failed");
      }

      const url = pageUrl || app.session?.url || "";
      const base = baseFilename(url);
      const docName = `${base}.${format}`;
      const slices = resp.capture.slices ?? [];
      const vw = resp.capture.viewportWidth ?? window.innerWidth;
      const vh = resp.capture.viewportHeight ?? window.innerHeight;

      // One composited PNG per scroll section so fixed/sticky elements
      // appear once each (in their own viewport) instead of stacking
      // vertically as they would in a stitched full-page image.
      const screenshotEntries: Record<string, Uint8Array> = {};
      const screenshotNames: string[] = [];
      if (slices.length > 0) {
        for (let i = 0; i < slices.length; i++) {
          const slice = slices[i]!;
          const composited = await compositeAnnotationsToViewport(
            slice.dataUrl,
            annotations,
            { offsetY: slice.offsetY, width: vw, height: vh },
          );
          const name =
            slices.length === 1
              ? `${base}.png`
              : `${base}-section${String(i + 1).padStart(2, "0")}.png`;
          screenshotEntries[name] = dataUrlToBytes(composited);
          screenshotNames.push(name);
        }
      } else {
        // Background didn't return slices (older bundle?). Fall back to
        // the stitched image.
        const composited = await compositeAnnotations(
          resp.capture.dataUrl,
          annotations,
        );
        const name = `${base}.png`;
        screenshotEntries[name] = dataUrlToBytes(composited);
        screenshotNames.push(name);
      }

      const text = formatSession({ url, annotations }, format, {
        screenshotFilenames: screenshotNames,
      });

      const zipped = zipSync({
        [docName]: strToU8(text),
        ...screenshotEntries,
      });

      const blob = new Blob([zipped as BlobPart], { type: "application/zip" });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = `${base}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 0);
    } catch (err) {
      app.lastError = `bundle export failed: ${(err as Error).message}`;
    } finally {
      bundleBusy = false;
    }
  }

  async function submit() {
    if (capturing || activeTabId == null) return;
    capturing = true;
    app.lastError = null;
    try {
      // Take element selection / drawing modes off the page so the screenshot
      // doesn't include the active toolbar/highlight.
      try {
        await chrome.tabs.sendMessage(activeTabId, {
          type: "mode.set",
          mode: "idle",
        });
      } catch {
        // content script may not be present (e.g. chrome:// page); fail soft
      }
      activeTool = null;

      if (!includeScreenshot) {
        // Text-only mode — let the agent work from selector + outerHTML
        // + nearbyText alone. Cheaper and faster.
        app.submit("", autoApplyEnabled);
        return;
      }

      const resp = (await chrome.runtime.sendMessage({
        type: "capture.full-page",
        tabId: activeTabId,
      })) as { ok: boolean; capture?: { dataUrl: string }; error?: string };

      if (!resp?.ok || !resp.capture) {
        throw new Error(resp?.error ?? "capture failed");
      }

      const composited = await compositeAnnotations(
        resp.capture.dataUrl,
        annotations,
      );
      app.submit(composited, autoApplyEnabled);
    } catch (err) {
      app.lastError = `screenshot failed: ${(err as Error).message}`;
    } finally {
      capturing = false;
    }
  }
</script>

<div class="flex flex-col h-full">
  <header
    class="px-4 py-3 border-b border-ink-200 bg-white dark:border-night-line dark:bg-night-card flex items-center justify-between"
  >
    <div class="flex items-center gap-2 min-w-0">
      <img src="/icons/icon-32.png" alt="" width="24" height="24" />
      <div class="min-w-0 relative">
        <h1 class="font-semibold text-sm dark:text-night-text">Pinta</h1>
        {#if app.selectedCompanion}
          <button
            type="button"
            class="flex items-center gap-1 text-xs text-ink-600 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light max-w-[200px] truncate"
            title={app.selectedCompanion.projectRoot}
            onclick={() => (projectMenuOpen = !projectMenuOpen)}
            aria-haspopup="listbox"
            aria-expanded={projectMenuOpen}
          >
            <span class="truncate font-medium">{shortRoot(app.selectedCompanion.projectRoot)}</span>
            <span class="text-ink-400 dark:text-night-mute">:{app.selectedCompanion.port}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        {:else if app.appMode === "discovering"}
          <p class="text-xs text-ink-500 dark:text-night-dim">scanning…</p>
        {:else}
          <!-- Standalone: maybe alone, maybe with companions registered but
               none matching this URL. Pill is primary; project picker is
               a secondary escape hatch only when there's something to pick. -->
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800/50 rounded-full px-1.5 py-0.5" title="Annotations stay in this browser. Use Copy or Download to share with an agent.">
              Standalone
            </span>
            {#if app.companions.length > 0}
              <button
                type="button"
                class="text-[11px] text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light flex items-center gap-0.5"
                onclick={() => (projectMenuOpen = !projectMenuOpen)}
                aria-haspopup="listbox"
                aria-expanded={projectMenuOpen}
                title="Switch to a registered project (sends annotations to its agent)"
              >
                or pick project ({app.companions.length})
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            {/if}
          </div>
        {/if}

        {#if projectMenuOpen}
          <div
            class="absolute left-0 top-full mt-1 w-[280px] z-30 rounded-md border border-ink-300 bg-white shadow-lg dark:border-night-line dark:bg-night-alt"
            role="listbox"
          >
            {#if app.companions.length === 0}
              <div class="p-3 text-xs text-ink-600 dark:text-night-dim">
                <p class="mb-2">No companion is running.</p>
                <p class="mb-2">Start one in your project root:</p>
                <code class="block bg-ink-100 dark:bg-night-card px-2 py-1.5 rounded font-mono text-[11px]">npx pinta-companion .</code>
              </div>
            {:else}
              {#if hasRoutingConflict}
                <div class="border-b border-amber-300 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/40 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200 leading-snug">
                  <span class="font-semibold">{matchingCompanionsForUrl.length} projects</span>
                  match this URL — auto-routing is ambiguous.
                  Tighten one project's URL patterns to disambiguate.
                </div>
              {/if}
              <ul class="max-h-[280px] overflow-y-auto py-1">
                {#each app.companions as c (c.port)}
                  {@const conflicts = hasRoutingConflict && matchingCompanionsForUrl.some((m) => m.port === c.port)}
                  <li>
                    <button
                      type="button"
                      class={[
                        "w-full text-left px-3 py-2 text-xs flex items-start gap-2 hover:bg-ink-50 dark:hover:bg-night-line",
                        app.selectedCompanion?.port === c.port
                          ? "bg-ink-50 dark:bg-night-line"
                          : "",
                      ].join(" ")}
                      onclick={() => selectCompanion(c)}
                    >
                      <span
                        class={[
                          "mt-1 w-1.5 h-1.5 rounded-full shrink-0",
                          app.selectedCompanion?.port === c.port
                            ? "bg-brand-pink"
                            : "bg-ink-300 dark:bg-night-line2",
                        ].join(" ")}
                      ></span>
                      <span class="flex-1 min-w-0">
                        <span class="block font-medium text-ink-900 dark:text-night-text truncate" title={c.projectRoot}>
                          {shortRoot(c.projectRoot)}
                          {#if conflicts}
                            <span class="ml-1 inline-block align-middle text-amber-600 dark:text-amber-400" title="Also matches the current URL — routing conflict">⚠</span>
                          {/if}
                        </span>
                        <span class="block text-[10px] text-ink-500 dark:text-night-mute truncate">
                          port {c.port}
                          {#if c.urlPatterns.length}· {c.urlPatterns.length} pattern{c.urlPatterns.length > 1 ? "s" : ""}{/if}
                        </span>
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="border-t border-ink-200 dark:border-night-line p-2">
              <button
                type="button"
                class="w-full text-[11px] text-ink-600 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light flex items-center justify-center gap-1 py-1"
                onclick={() => app.rescan(pageUrl || null, true)}
                disabled={app.scanning}
              >
                {app.scanning ? "scanning…" : "↻ Rescan"}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      <!-- History + Settings live in the header so every module
           (Annotate, Test Pilot, …) shares the same access point. -->
      <SessionHistory />
      <button
        type="button"
        class="w-7 h-7 inline-flex items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 transition-colors"
        onclick={() => (app.viewingSettings = !app.viewingSettings)}
        title="Pinta settings — modules, integrations"
        aria-label="Open settings"
        aria-pressed={app.viewingSettings}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button
        type="button"
        class="w-7 h-7 inline-flex items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 transition-colors"
        onclick={toggleTheme}
        aria-label={theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme.value === "dark" ? "Light mode" : "Dark mode"}
      >
        {#if theme.value === "dark"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
        {:else}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        {/if}
      </button>
      {#if app.appMode !== "standalone"}
        <StatusPill status={app.connectionStatus} />
      {/if}
    </div>
  </header>

  <main class="flex-1 overflow-y-auto p-4 space-y-4">
    {#if showAssociatePrompt && app.selectedCompanion}
      {@const sel = app.selectedCompanion}
      {@const suggestedPattern = suggestPattern(pageUrl)}
      <div class="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/40 p-3 text-xs text-amber-900 dark:text-amber-200 space-y-2.5">
        <div class="flex items-start gap-2">
          <svg class="shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
          <div class="flex-1">
            <p class="font-semibold">
              {#if sel.urlPatterns.length === 0}
                No URL patterns set for {shortRoot(sel.projectRoot)}
              {:else}
                URL doesn't match any of {shortRoot(sel.projectRoot)}'s patterns
              {/if}
            </p>
            <p class="leading-snug mt-0.5 text-amber-800 dark:text-amber-300">
              Annotations are <strong>paused</strong> — Pinta keeps them
              scoped per project. Save the pattern to route this tab to
              <strong>{shortRoot(sel.projectRoot)}</strong>, or pick a
              different project below.
            </p>
          </div>
        </div>

        <div class="space-y-1">
          <div class="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400 font-semibold">Pattern</div>
          <code class="block bg-white/70 dark:bg-black/30 border border-amber-200 dark:border-amber-800/50 px-2 py-1.5 rounded font-mono text-[11px] text-amber-900 dark:text-amber-100 break-all">
            {suggestedPattern}
          </code>
        </div>

        <button
          type="button"
          class={[
            "w-full rounded-md text-white text-xs font-medium py-2 transition-colors disabled:opacity-60 inline-flex items-center justify-center gap-1.5",
            associatedAt
              ? "bg-emerald-600 hover:bg-emerald-700"
              : "bg-amber-600 hover:bg-amber-700",
          ].join(" ")}
          onclick={associateActiveUrl}
          disabled={associating || !!associatedAt}
        >
          {#if associating}
            <svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            Saving…
          {:else if associatedAt}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            Saved — auto-routing this URL next time
          {:else}
            Save pattern to .pinta.json
          {/if}
        </button>

        {#if associateError}
          <p class="text-[11px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 rounded px-2 py-1.5">
            <strong>Couldn't save:</strong> {associateError}
            <button
              type="button"
              class="ml-1 underline underline-offset-2"
              onclick={() => (associateError = null)}
            >
              dismiss
            </button>
          </p>
        {/if}

        <!-- "Or use standalone" escape hatch — for tabs the user
             genuinely doesn't want associated with any project
             (deployed staging URLs, GitHub Pages, third-party docs).
             Pins the origin so subsequent rescans don't snap back to
             the only running companion. Clears as soon as the user
             explicitly picks a project from the picker.

             Styled as a full-width outlined button so it reads as a
             real action alongside the primary "Save pattern" button,
             not a small dismissable link. -->
        <div class="pt-1 space-y-2">
          <div class="relative flex items-center">
            <span class="flex-1 border-t border-amber-200/70 dark:border-amber-800/40"></span>
            <span class="px-2 text-[10px] uppercase tracking-wider font-semibold text-amber-700 dark:text-amber-400">or</span>
            <span class="flex-1 border-t border-amber-200/70 dark:border-amber-800/40"></span>
          </div>
          <button
            type="button"
            class="w-full inline-flex items-center justify-center gap-1.5 rounded-md border-2 border-amber-500 dark:border-amber-500/70 bg-transparent hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-xs font-semibold py-2 transition-colors"
            onclick={() => app.pinCurrentUrlToStandalone()}
            title="Annotate this site without associating it with any project. The session lives in IndexedDB; copy / download replace Submit."
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2v20" />
              <path d="m17 5-5-3-5 3" />
              <rect x="3" y="9" width="18" height="12" rx="2" />
            </svg>
            Use standalone for this site
          </button>

          {#if app.companions.length > 1 && !associatedAt}
            <button
              type="button"
              class="block mx-auto text-[11px] underline underline-offset-2 hover:no-underline text-amber-800 dark:text-amber-300"
              onclick={() => (projectMenuOpen = true)}
            >
              Or pick a different project →
            </button>
          {/if}
        </div>
      </div>
    {/if}

    {#if !app.viewingSettings && !app.viewingImportedId && !showAssociatePrompt && app.moduleReady("test-pilot")}
      <nav class="sticky -top-4 z-20 bg-ink-50 dark:bg-night-bg flex items-center gap-1 border-b border-ink-200 dark:border-night-line -mx-4 px-4 pt-4 mb-1">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors"
          class:border-brand-pink={activeTab === "annotate"}
          class:text-brand-pink={activeTab === "annotate"}
          class:dark:text-brand-pink-light={activeTab === "annotate"}
          class:border-transparent={activeTab !== "annotate"}
          class:text-ink-500={activeTab !== "annotate"}
          class:dark:text-night-mute={activeTab !== "annotate"}
          onclick={() => {
            activeTab = "annotate";
            void chrome.storage?.local?.set({ "pinta-active-tab": "annotate" });
          }}
        >
          {#if annotateBusy}
            <!-- Spinner replaces the pencil while the agent is
                 processing a submitted/applying session. -->
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-label="Working on submitted session">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          {:else}
            <!-- Pencil/edit glyph — matches the "mark up the page" mode -->
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          {/if}
          Annotate
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors"
          class:border-brand-pink={activeTab === "test-pilot"}
          class:text-brand-pink={activeTab === "test-pilot"}
          class:dark:text-brand-pink-light={activeTab === "test-pilot"}
          class:border-transparent={activeTab !== "test-pilot"}
          class:text-ink-500={activeTab !== "test-pilot"}
          class:dark:text-night-mute={activeTab !== "test-pilot"}
          onclick={() => {
            activeTab = "test-pilot";
            void chrome.storage?.local?.set({ "pinta-active-tab": "test-pilot" });
          }}
        >
          {#if testPilotBusy}
            <!-- Spinner replaces the flask while a doc-parse,
                 doc-generate, or per-row Ask is in flight. -->
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-label="Test Pilot working">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          {:else}
            <!-- Flask glyph — same visual identity as the Test Pilot
                 section headers, so the tab reads as "the chemistry-set
                 tab" at a glance. -->
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 3h6" />
              <path d="M10 3v6.5L4.4 18.7A1.6 1.6 0 0 0 5.8 21h12.4a1.6 1.6 0 0 0 1.4-2.3L14 9.5V3" />
              <path d="M7.5 14.5h9" opacity="0.55" />
            </svg>
          {/if}
          Test Pilot
        </button>
      </nav>
    {/if}

    {#if app.viewingSettings}
      <SettingsPanel />
    {:else if !app.viewingImportedId && !showAssociatePrompt && activeTab === "test-pilot" && app.moduleReady("test-pilot")}
      <TestPilotTab />
    {:else if app.viewingImportedId}
      {@const imp = app.importedSessions.find((s) => s.id === app.viewingImportedId)}
      {#if imp}
        <section class="space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text truncate" title={imp.manifest.title}>
                {imp.manifest.title}
              </h2>
              <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                <span
                  class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-white text-[10px] font-medium"
                  style="background-color: {imp.manifest.accentColor};"
                >
                  Imported · {imp.manifest.author}
                </span>
                <span class="text-[10px] text-ink-500 dark:text-night-mute">
                  Imported view
                </span>
              </div>
              {#if imp.manifest.description}
                <p class="mt-1 text-[12px] text-ink-700 dark:text-night-dim italic">
                  "{imp.manifest.description}"
                </p>
              {/if}
              <p class="mt-1 text-[11px] text-ink-500 dark:text-night-mute font-mono truncate" title={imp.session.url}>
                {imp.session.url}
              </p>
            </div>
            <button
              type="button"
              class="shrink-0 text-ink-500 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text text-lg leading-none px-1"
              onclick={() => app.closeImportedViewer()}
              aria-label="Close viewer"
              title="Close"
            >
              ✕
            </button>
          </div>
          <div class="flex items-center justify-between gap-2 pt-1">
            <h3 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
              Annotations ({imp.session.annotations.length})
            </h3>
            {#if importedLocated && importedLocated.total > 0}
              {@const allLocated = importedLocated.matched === importedLocated.total}
              <span
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border"
                class:border-emerald-300={allLocated}
                class:bg-emerald-50={allLocated}
                class:text-emerald-800={allLocated}
                class:dark:border-emerald-800={allLocated}
                class:dark:bg-emerald-950={allLocated}
                class:dark:text-emerald-200={allLocated}
                class:border-amber-300={!allLocated}
                class:bg-amber-50={!allLocated}
                class:text-amber-800={!allLocated}
                class:dark:border-amber-800={!allLocated}
                class:dark:bg-amber-950={!allLocated}
                class:dark:text-amber-200={!allLocated}
                title={allLocated
                  ? "Every annotation's selector resolved on the current page."
                  : "Some selectors didn't match — you may be on a different route or the DOM has changed since the export."}
              >
                {importedLocated.matched} of {importedLocated.total} located
              </span>
            {/if}
          </div>
          {#if imp.session.annotations.length === 0}
            <p class="text-xs text-ink-500 dark:text-night-dim italic">
              This session has no annotations.
            </p>
          {:else}
            <ul class="space-y-2">
              {#each imp.session.annotations as a, i (`${a.id}:${i}`)}
                <AnnotationCard
                  annotation={a}
                  canEdit={false}
                  accentColorOverride={imp.manifest.accentColor}
                  index={i + 1}
                  onremove={() => {}}
                  onsave={() => {}}
                />
              {/each}
            </ul>
          {/if}
          {#if imp.session.fullPageScreenshot}
            <details class="mt-2">
              <summary class="text-xs text-ink-600 dark:text-night-dim cursor-pointer">
                Show full-page screenshot
              </summary>
              <img
                src={imp.session.fullPageScreenshot}
                alt="Full-page screenshot from imported session"
                class="mt-2 w-full rounded border border-ink-200 dark:border-night-line"
              />
            </details>
          {/if}
        </section>
      {:else}
        <p class="text-xs text-ink-500 dark:text-night-dim italic">
          Imported session not found.
          <button
            type="button"
            class="ml-1 underline underline-offset-2"
            onclick={() => app.closeImportedViewer()}
          >
            close
          </button>
        </p>
      {/if}
    {:else if !showAssociatePrompt}
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
          Tool
        </h2>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 text-[11px] font-medium h-7 px-2.5 transition-colors disabled:opacity-50"
            onclick={() => importFileInput?.click()}
            disabled={importBusy}
            title="Import a .pinta or .md file shared by a teammate"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>{importBusy ? "Importing…" : "Import"}</span>
          </button>
        </div>
      </div>
      <input
        bind:this={importFileInput}
        type="file"
        accept=".pinta,.md,.markdown,application/json,text/markdown"
        class="hidden"
        onchange={onImportFileChosen}
      />
      {#if importedToastAt && importedToastLabel}
        <div
          class="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-200 text-[11px] px-2.5 py-1.5"
          role="status"
        >
          {importedToastLabel} — see History.
        </div>
      {/if}
      <input
        bind:this={imageFileInput}
        type="file"
        accept="image/*"
        class="hidden"
        onchange={onImageFilePicked}
        aria-hidden="true"
      />
      <div class="grid grid-cols-6 gap-1">
        {#each TOOLS as t (t.id)}
          <button
            type="button"
            class={[
              "rounded-md border py-2 text-sm flex flex-col items-center gap-0.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
              activeTool === t.id
                ? "bg-brand-pink text-white border-brand-pink shadow-inner ring-2 ring-brand-pink/30 dark:ring-brand-pink/50"
                : "bg-white text-ink-700 border-ink-300 hover:bg-brand-cream hover:border-brand-pink/40 dark:bg-night-card dark:text-night-text dark:border-night-line dark:hover:bg-night-line dark:hover:border-night-line2",
            ].join(" ")}
            disabled={activeTabId == null || sessionPending || allDone}
            onclick={() => setActive(activeTool === t.id ? null : t.id)}
            title={t.label}
            aria-pressed={activeTool === t.id}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true">{@html t.svg}</svg>
            <span class="text-[10px]">{t.label}</span>
          </button>
        {/each}
      </div>
      {#if activeTool}
        <p class="text-[11px] text-ink-500 dark:text-night-dim">
          {#if activeTool === "select"}
            Hover the page → click an element → type a comment.
          {:else}
            Drag on the page to draw → type a comment.
          {/if}
          Press Esc to cancel.
        </p>
      {/if}
    </section>

    <details class="rounded-md border border-ink-200 bg-white dark:border-night-line dark:bg-night-card">
      <summary class="px-3 py-2 text-xs text-ink-600 dark:text-night-dim cursor-pointer">
        Add by CSS selector instead
      </summary>
      <div class="p-3 pt-0 space-y-2">
        <input
          type="text"
          placeholder="CSS selector (e.g. .submit-btn)"
          class="w-full rounded-md border border-ink-300 bg-white text-ink-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute disabled:opacity-50"
          bind:value={selector}
          disabled={sessionPending || allDone}
        />
        <textarea
          placeholder="What do you want changed?"
          rows={3}
          class="w-full rounded-md border border-ink-300 bg-white text-ink-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute disabled:opacity-50"
          bind:value={comment}
          disabled={sessionPending || allDone}
        ></textarea>
        <button
          type="button"
          class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
          disabled={!selector.trim() || !comment.trim() || sessionPending || allDone}
          onclick={addAnnotationFromForm}
        >
          Add annotation
        </button>
      </div>
    </details>

    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <h2 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
          Annotations ({annotationsHere.length}{annotations.length !== annotationsHere.length ? ` / ${annotations.length}` : ""})
        </h2>
        {#if canEditAnnotations && annotations.length > 0}
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-transparent text-ink-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50 dark:border-night-line dark:text-night-dim dark:hover:text-red-400 dark:hover:border-red-900 dark:hover:bg-red-950/30 text-[11px] font-medium px-2 py-1 transition-colors"
            onclick={clearAllAnnotations}
            aria-label="Clear all annotations"
            title="Remove every annotation in this batch"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Clear
          </button>
        {/if}
      </div>
      {#if otherPages.length > 0}
        <div class="rounded-md border border-ink-200 dark:border-night-line bg-ink-50/70 dark:bg-night-alt/40">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-ink-700 dark:text-night-dim hover:bg-ink-100/70 dark:hover:bg-night-line/40 rounded-md"
            onclick={() => (otherPagesExpanded = !otherPagesExpanded)}
            aria-expanded={otherPagesExpanded}
          >
            <span class="flex items-center gap-1.5 min-w-0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <span class="truncate">
                {elsewhereCount} on {otherPages.length} other {otherPages.length === 1 ? "page" : "pages"}
              </span>
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class:rotate-180={otherPagesExpanded}><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {#if otherPagesExpanded}
            <ul class="px-2 pb-2 pt-0.5 space-y-1">
              {#each otherPages as [u, anns] (u)}
                <li class="flex items-center gap-2 text-[11px] text-ink-700 dark:text-night-dim">
                  <span class="flex-1 min-w-0 truncate font-mono" title={u}>{formatOtherPageUrl(u)}</span>
                  <span class="shrink-0 text-ink-500 dark:text-night-mute tabular-nums">{anns.length}</span>
                  <button
                    type="button"
                    class="shrink-0 px-1.5 py-0.5 rounded border border-ink-200 dark:border-night-line text-ink-700 dark:text-night-dim hover:bg-ink-100 dark:hover:bg-night-line/60"
                    onclick={() => openOtherPage(u)}
                    aria-label="Open {u}"
                    title="Navigate this tab to {u}"
                  >
                    Open
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
      {#if annotationsHere.length === 0}
        <p class="text-xs text-ink-500 dark:text-night-dim italic">
          {annotations.length === 0
            ? "No annotations yet. Pick a tool above."
            : "No annotations on this page. Use the chip above to jump to siblings, or annotate something here."}
        </p>
      {:else}
        <ul class="space-y-2">
          {#each annotationsHere as annotation, i (`${annotation.id}:${i}`)}
            <AnnotationCard
              {annotation}
              canEdit={canEditAnnotations}
              pending={sessionPending && annotation.status !== "done" && annotation.status !== "error"}
              onremove={() => removeAnnotation(annotation.id)}
              onsave={(comment) =>
                app.updateAnnotation(annotation.id, { comment })}
            />
          {/each}
        </ul>
      {/if}
    </section>
    {/if}

    {#if app.lastError}
      <div
        class="flex items-start gap-2 text-xs text-red-600 border border-red-200 bg-red-50 dark:text-red-300 dark:border-red-900/40 dark:bg-red-950/40 rounded-md p-2"
      >
        <p class="flex-1 min-w-0 break-words">{app.lastError}</p>
        <button
          type="button"
          class="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 leading-none px-1"
          onclick={() => (app.lastError = null)}
          aria-label="Dismiss error"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    {/if}

  </main>

  <footer
    class="border-t border-ink-200 p-3 bg-white dark:border-night-line dark:bg-night-card space-y-2"
    class:hidden={showAssociatePrompt ||
      app.viewingSettings ||
      (activeTab === "test-pilot" &&
        app.moduleReady("test-pilot") &&
        !app.viewingImportedId)}
  >
    {#if app.viewingImportedId}
      {@const impFooter = app.importedSessions.find((s) => s.id === app.viewingImportedId)}
      {#if impFooter}
        {#if app.appMode === "connected"}
          <label
            class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim cursor-pointer select-none"
          >
            <input
              type="checkbox"
              class="mt-0.5 accent-brand-pink"
              bind:checked={autoApplyEnabled}
            />
            <span class="flex-1 leading-snug">
              Auto-apply (no agent confirmation)
              <span class="block text-[11px] text-ink-500 dark:text-night-mute">
                Skip the agent's "reply 'go' to apply" step. Plan is still shown
                briefly. Off by default — turn on for fast iteration.
              </span>
            </span>
          </label>
        {/if}
        <div class="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            class="flex-1 min-w-[140px] rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            disabled={app.appMode !== "connected" || impFooter.session.annotations.length === 0 || importedSendBusy}
            title={app.appMode === "connected" ? "Submit these annotations to your agent as a new session — your active draft is left alone" : "Connect to a companion to send to an agent"}
            onclick={async () => {
              if (app.appMode !== "connected") return;
              importedSendBusy = true;
              const newId = await app.sendImportedToAgent(impFooter.id, {
                autoApply: autoApplyEnabled,
              });
              importedSendBusy = false;
              if (newId) {
                importedToastLabel = "Submitted to agent";
                importedToastAt = Date.now();
                setTimeout(() => {
                  if (importedToastAt && Date.now() - importedToastAt >= 2500) {
                    importedToastAt = null;
                    importedToastLabel = null;
                  }
                }, 2600);
                app.closeImportedViewer();
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            {importedSendBusy ? "Sending…" : "Send to agent"}
          </button>
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 py-2 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text disabled:opacity-50"
            disabled={impFooter.session.annotations.length === 0}
            title="Copy these annotations as markdown — paste into claude.ai web, ChatGPT, or another agent"
            onclick={async () => {
              try {
                const text = formatSessionAsClipboard({
                  url: impFooter.session.url,
                  annotations: impFooter.session.annotations,
                });
                await navigator.clipboard.writeText(text);
                copiedAt = Date.now();
                setTimeout(() => {
                  if (copiedAt && Date.now() - copiedAt >= 2000) copiedAt = null;
                }, 2100);
              } catch (err) {
                app.lastError = `clipboard write failed: ${(err as Error).message}`;
              }
            }}
          >
            {copiedAt ? "✓" : "Copy"}
          </button>
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 py-2 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text disabled:opacity-50"
            disabled={app.appMode !== "standalone"}
            title={app.appMode === "standalone" ? "Clone these annotations into your editable session for this URL (replaces current draft)" : "Forking is only available in standalone mode — use Send to agent instead"}
            onclick={async () => {
              const result = await app.forkImportedToLocal(impFooter.id);
              if (result === "would-overwrite") {
                const ok = confirm(
                  "Forking will replace your current draft annotations on this URL. " +
                    "Continue and lose the current draft?",
                );
                if (!ok) return;
                await app.forkImportedToLocal(impFooter.id, { allowOverwrite: true });
              }
            }}
          >
            Fork
          </button>
        </div>
      {/if}
    {:else if pintaFormOpen}
      <div class="rounded-md border border-ink-300 bg-ink-50 dark:border-night-line dark:bg-night-alt p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-ink-700 dark:text-night-text">Share session as .pinta</span>
          <button
            type="button"
            class="text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text text-xs"
            onclick={() => (pintaFormOpen = false)}
            aria-label="Cancel export"
          >
            ✕
          </button>
        </div>
        <label class="block text-[11px] text-ink-600 dark:text-night-dim">
          Title
          <input
            type="text"
            bind:value={pintaTitle}
            class="mt-0.5 w-full rounded border border-ink-300 bg-white text-ink-900 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-card dark:text-night-text"
            placeholder="Header redesign — round 2"
          />
        </label>
        <label class="block text-[11px] text-ink-600 dark:text-night-dim">
          Author
          <input
            type="text"
            bind:value={pintaAuthor}
            class="mt-0.5 w-full rounded border border-ink-300 bg-white text-ink-900 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-card dark:text-night-text"
            placeholder="Your name"
          />
        </label>
        <label class="block text-[11px] text-ink-600 dark:text-night-dim">
          Description (optional)
          <textarea
            rows={2}
            bind:value={pintaDescription}
            class="mt-0.5 w-full rounded border border-ink-300 bg-white text-ink-900 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-card dark:text-night-text"
            placeholder="Spacing tweaks on hero & nav"
          ></textarea>
        </label>
        <div class="text-[11px] text-ink-600 dark:text-night-dim">
          <span>Accent color</span>
          <div class="flex items-center gap-1.5 mt-1 flex-wrap">
            {#each ACCENT_PALETTE as swatch}
              <button
                type="button"
                class="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                class:border-ink-900={pintaAccentColor === swatch}
                class:dark:border-white={pintaAccentColor === swatch}
                class:border-transparent={pintaAccentColor !== swatch}
                style="background-color: {swatch};"
                aria-label="Use {swatch}"
                aria-pressed={pintaAccentColor === swatch}
                onclick={() => (pintaAccentColor = swatch)}
              ></button>
            {/each}
            <input
              type="color"
              bind:value={pintaAccentColor}
              class="w-5 h-5 rounded border border-ink-300 dark:border-night-line cursor-pointer"
              aria-label="Custom color"
              title="Custom color"
            />
          </div>
        </div>
        <button
          type="button"
          class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-1.5 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
          disabled={!pintaTitle.trim() || !pintaAuthor.trim()}
          onclick={exportAsPinta}
        >
          Download .pinta
        </button>
      </div>
    {/if}
    {#if !app.viewingImportedId}
    {#if app.appMode === "connected" && !allDone && app.session?.status === "drafting"}
      <label
        class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim cursor-pointer select-none"
      >
        <input
          type="checkbox"
          class="mt-0.5 accent-brand-pink"
          bind:checked={autoApplyEnabled}
        />
        <span class="flex-1 leading-snug">
          Auto-apply (no agent confirmation)
          <span class="block text-[11px] text-ink-500 dark:text-night-mute">
            Skip the agent's "reply 'go' to apply" step. Plan is still shown
            briefly. Off by default — turn on for fast iteration.
          </span>
        </span>
      </label>
      <label
        class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim select-none"
        class:cursor-pointer={!screenshotLocked}
        class:cursor-not-allowed={screenshotLocked}
      >
        <input
          type="checkbox"
          class="mt-0.5 accent-brand-pink"
          bind:checked={includeScreenshot}
          disabled={screenshotLocked}
        />
        <span class="flex-1 leading-snug">
          Include full-page screenshot
          {#if screenshotLocked}
            <span class="text-brand-pink dark:text-brand-pink-light font-medium">(required)</span>
          {/if}
          <span class="block text-[11px] text-ink-500 dark:text-night-mute">
            {#if hasDrawingAnnotation}
              A drawing is in this batch — the agent has no DOM target for
              freehand / arrow / circle / rect / pin annotations, so the
              screenshot is the only context it has.
            {:else if screenshotRequiredByModule}
              Required because a module below needs the screenshot embedded
              in its output (e.g. GitLab issues attach it to every body).
              Untick the module to unlock this.
            {:else}
              Adds visual context for the agent. ~1.5–2k extra vision tokens
              per submit. Off by default — selectors + nearby text are usually
              enough.
            {/if}
          </span>
        </span>
      </label>
      {#each BUILTIN_MODULES.filter((m) => m.mode === "per-submit") as moduleSpec (moduleSpec.id)}
        {@const moduleReady = app.moduleReady(moduleSpec.id)}
        {@const ticked = !!app.tickedModules[moduleSpec.id]}
        {#if moduleReady}
          <label
            class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim cursor-pointer select-none"
          >
            <input
              type="checkbox"
              class="mt-0.5 accent-brand-pink"
              checked={ticked}
              onchange={(e) =>
                app.setModuleTicked(
                  moduleSpec.id,
                  (e.currentTarget as HTMLInputElement).checked,
                )}
            />
            <span class="flex-1 leading-snug">
              <span class="inline-flex items-center gap-1.5 flex-wrap">
                {moduleSpec.sessionCheckboxLabel}
                {#if ticked}
                  <span class="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800/50 rounded-full px-1.5 py-0.5" title="This module will run on the next submit">
                    Will run
                  </span>
                {/if}
              </span>
              <span class="block text-[11px] text-ink-500 dark:text-night-mute">
                {moduleSpec.sessionCheckboxHint}
              </span>
            </span>
          </label>
        {/if}
      {/each}
    {/if}

    {#snippet downloadDropdown()}
      <div class="relative">
        <button
          type="button"
          class="h-full rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text inline-flex items-center gap-1"
          title="Download annotations as a file an agent can read"
          onclick={() => (downloadMenuOpen = !downloadMenuOpen)}
          aria-haspopup="menu"
          aria-expanded={downloadMenuOpen}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        {#if downloadMenuOpen}
          <div
            class="absolute right-0 bottom-full mb-1 w-56 z-30 rounded-md border border-ink-300 bg-white shadow-lg dark:border-night-line dark:bg-night-alt overflow-hidden"
            role="menu"
          >
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-xs text-ink-800 dark:text-night-text hover:bg-ink-50 dark:hover:bg-night-line disabled:opacity-50"
              disabled={bundleBusy}
              onclick={() => downloadBundle("md")}
            >
              <span class="font-medium">
                {bundleBusy ? "Capturing screenshot…" : "Markdown + screenshot"}
              </span>
              <span class="block text-[10px] text-ink-500 dark:text-night-mute">.zip — most context for agents</span>
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-xs text-ink-800 dark:text-night-text hover:bg-ink-50 dark:hover:bg-night-line border-t border-ink-200 dark:border-night-line"
              onclick={() => downloadAs("md")}
            >
              <span class="font-medium">Markdown</span>
              <span class="block text-[10px] text-ink-500 dark:text-night-mute">.md — text only</span>
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-xs text-ink-800 dark:text-night-text hover:bg-ink-50 dark:hover:bg-night-line border-t border-ink-200 dark:border-night-line"
              onclick={() => downloadAs("txt")}
            >
              <span class="font-medium">Plain text</span>
              <span class="block text-[10px] text-ink-500 dark:text-night-mute">.txt — text only</span>
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-xs text-ink-800 dark:text-night-text hover:bg-ink-50 dark:hover:bg-night-line border-t border-ink-200 dark:border-night-line"
              onclick={openPintaExportForm}
            >
              <span class="font-medium">Share file (.pinta)</span>
              <span class="block text-[10px] text-ink-500 dark:text-night-mute">re-importable by a teammate</span>
            </button>
          </div>
        {/if}
      </div>
    {/snippet}

    <div class="flex gap-2">
      {#if app.appMode === "standalone"}
        <button
          type="button"
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          disabled={annotations.length === 0}
          onclick={copyToClipboard}
          title="Copy annotations as markdown to share or paste into an AI tool"
        >
          {#if copiedAt}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            Copied
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy to clipboard
          {/if}
        </button>
        {#if annotations.length > 0}
          {@render downloadDropdown()}
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text"
            title="Clear all annotations and start fresh"
            onclick={cancelSession}
            aria-label="Clear annotations"
          >
            ✕
          </button>
        {/if}
      {:else if allDone}
        <button
          type="button"
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light inline-flex items-center justify-center gap-1.5"
          onclick={cancelSession}
        >
          {#if app.session?.status === "error"}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Start a new batch (some failed)
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Annotate again — start a new batch
          {/if}
        </button>
        <button
          type="button"
          class="rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-700 dark:text-night-text text-sm font-medium px-3 hover:bg-ink-50 dark:hover:bg-night-line disabled:opacity-50"
          title={hmrDetected
            ? "HMR detected — page should already be updated. Click to reload anyway."
            : "Reload the page to see the changes"}
          onclick={reloadActiveTab}
          disabled={reloadingAt !== null || activeTabId == null}
          aria-label="Reload page"
        >
          {reloadingAt ? "↻…" : "↻"}
        </button>
      {:else if app.session?.status === "submitted" || app.session?.status === "applying"}
        <div
          class="w-full rounded-md bg-brand-pink/85 text-white text-sm font-medium py-2 inline-flex items-center justify-center gap-1.5 cursor-default select-none"
          role="status"
        >
          <span
            class="inline-block w-3 h-3 rounded-full border-2 border-white/70 border-t-transparent animate-spin"
            aria-hidden="true"
          ></span>
          {#if capturing}
            Capturing screenshot…
          {:else if app.session?.status === "submitted"}
            Submitted — waiting for agent
          {:else}
            Agent is applying changes…
          {/if}
        </div>
      {:else}
        <button
          type="button"
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
          disabled={!canSubmit || capturing}
          onclick={submit}
        >
          {#if capturing}
            Capturing screenshot…
          {:else if fileOnlyMode}
            File issues
          {:else}
            Send to agent
          {/if}
        </button>
        {#if app.session?.status === "drafting" && annotations.length > 0}
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text"
            title="Copy annotations as markdown — paste into claude.ai web, ChatGPT, or another agent"
            onclick={copyToClipboard}
            aria-label="Copy to clipboard"
          >
            {copiedAt ? "✓" : "Copy"}
          </button>
          {@render downloadDropdown()}
        {/if}
      {/if}
    </div>
    {#if app.appMode === "standalone" && annotations.length === 0}
      <p class="text-[11px] text-ink-500 dark:text-night-mute text-center">
        Add annotations with the tools above. Hit Copy to share them anywhere.
      </p>
    {:else if fileOnlyMode && app.session?.status === "drafting" && annotations.length > 0}
      <p class="text-[11px] text-ink-500 dark:text-night-mute text-center leading-snug">
        Issues only — source code stays untouched. Tick <strong>Auto-apply</strong> to also patch the code.
      </p>
    {:else if app.session?.status === "submitted"}
      <p class="text-[11px] text-ink-500 dark:text-night-mute text-center">
        The agent will pick this up shortly.
      </p>
    {:else if app.session?.status === "applying"}
      <p class="text-[11px] text-ink-500 dark:text-night-mute text-center">
        Watch the cards above — each annotation flips to ✓ as the agent finishes it.
      </p>
    {:else if allDone}
      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-1.5 text-[11px] text-ink-600 dark:text-night-dim cursor-pointer select-none">
          <input
            type="checkbox"
            class="accent-brand-pink"
            bind:checked={autoReloadEnabled}
          />
          Auto-reload when not using HMR
        </label>
        {#if hmrDetected === true}
          <span class="text-[11px] text-emerald-600 dark:text-emerald-400">HMR detected ✓</span>
        {:else if hmrDetected === false}
          <span class="text-[11px] text-ink-500 dark:text-night-mute">No HMR detected</span>
        {/if}
      </div>
    {/if}
    {/if}
  </footer>
</div>
