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
  import AnnotationCard from "./AnnotationCard.svelte";
  import SessionHistory from "./SessionHistory.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import TestPilotTab from "./TestPilotTab.svelte";
  import AuditFlowTab from "./AuditFlowTab.svelte";
  import ReportTab from "./ReportTab.svelte";
  import ModuleBoardTab from "./ModuleBoardTab.svelte";
  import ChatSheet from "./ChatSheet.svelte";

  // Phase 14 chat surfaces owned by App.svelte (Test Pilot tier owns
  // its own sheet inside TestPilotTab.svelte):
  // - globalChatOpen — global "Ask Pinta" FAB → ChatSheet with context.kind = "global"
  // - annotateJustAsk — Annotate submit footer checkbox; when ticked,
  //   Submit re-labels to "Ask agent" and opens the chat with
  //   context.kind = "annotate-batch" instead of submitting source edits.
  // - annotateChatOpen — sheet open-state for the Annotate surface.
  let globalChatOpen = $state(false);
  let annotateJustAsk = $state(false);
  let annotateChatOpen = $state(false);

  /**
   * "Just Ask" click handler. Auto-composes a prompt from the
   * annotation comments + sends it through the chat module's
   * annotate-batch context so the agent answers immediately when
   * the sheet opens, instead of forcing the user to retype their
   * intent. The annotations themselves (selector, kind, url) ride
   * along in `sendAnnotateChatMessage`'s context payload, so the
   * agent has the full structural picture; this prompt is the
   * user-visible first message in the thread.
   */
  /** Trigger a browser download for a chat-thread markdown export.
   *  Shared by the global + Annotate chat sheets so they hand off the
   *  rendered MD without re-implementing the anchor-click dance.
   *  Test Pilot per-row chats use TestPilotTab's own copy of this. */
  function downloadChatBlob(md: string, filename: string): void {
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function askAgentWithBatch() {
    if (!app.session?.id) return;
    const batchId = app.session.id;
    const annotations = app.session.annotations;
    if (annotations.length === 0) return;

    annotateChatOpen = true;

    // Truncate long selectors so the chat bubble's chip stays readable.
    // Full selector + outerHTML still ride in the per-annotation context.
    const shortSelector = (sel: string | undefined): string => {
      if (!sel) return "drawing";
      return sel.length > 48 ? `${sel.slice(0, 45)}…` : sel;
    };
    const labelled = annotations
      .map((a) => {
        const comment = a.comment?.trim();
        if (!comment) return null;
        const sel = shortSelector(
          a.targets?.[0]?.selector ?? a.target?.selector,
        );
        return { annotation: a, comment, sel };
      })
      .filter((x): x is { annotation: typeof annotations[number]; comment: string; sel: string } => !!x);

    // No commented annotations — fall back to a single generic ask
    // about the batch as a whole.
    if (labelled.length === 0) {
      const prompt = `I have ${annotations.length} annotation${annotations.length === 1 ? "" : "s"} on this page. What can you tell me about ${annotations.length === 1 ? "it" : "them"}?`;
      void app.sendAnnotateChatMessage(batchId, prompt);
      return;
    }

    // Sequential per-annotation flow: one user bubble at a time, each
    // followed by its own focused agent reply. We await each ask and
    // poll until its pending flag clears (handleNonTestPilotChatSync
    // resets it when the reply lands or errors) before moving on. That
    // ordering is what makes the chat read as "lazy-loaded" — bubbles
    // and answers materialise one pair at a time, in selector order.
    for (const { annotation, comment, sel } of labelled) {
      if (app.connectionStatus !== "connected") break;
      // Stop the chain on the first error so the user isn't bombarded
      // with retries against a wedged agent.
      if (app.chat.error) break;
      await app.sendAnnotateChatMessageForAnnotation(
        batchId,
        annotation,
        comment,
        sel,
      );
      // 50ms cadence — see TestPilotTab `askAllInSection` for the same
      // rationale. Cheap reactive read; cuts the per-annotation idle
      // wait that adds up across a 5+ row batch.
      while (app.chat.pendingAnnotateBatch[batchId]) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  // Built-in tab ids plus any imported interactive module id (those tabs
  // are declared by the module manifest, so the id is dynamic — hence the
  // open `(string & {})` arm). "If the plugin doesn't declare a tab, it
  // never appears here."
  type SidePanelTab =
    | "annotate"
    | "test-pilot"
    | "audit-flow"
    | "report"
    | (string & {});
  // Active tab in the main panel area. Persists across side-panel
  // re-opens via chrome.storage.local (`pinta-active-tab`). The
  // "test-pilot" / "audit-flow" tabs and every imported interactive tab
  // are conditionally rendered — gated on the module being enabled.
  let activeTab = $state<SidePanelTab>("annotate");

  // Per-tab "busy" indicators. Drive the spinner that replaces the tab
  // icon when work is happening — gives the user a peripheral signal of
  // activity in the OTHER tab while they're focused on this one.
  // Annotate: agent is processing a submitted session.
  // Test Pilot: doc-parse / doc-generate in flight, or any per-row Ask
  // (single or bulk) pending.
  const annotateBusy = $derived(
    app.session?.status === "submitted" ||
      app.session?.status === "applying" ||
      // Phase 20 — a detached batch still applying in the background also
      // keeps the tab spinner alive, even though the current draft is idle.
      app.inFlightBatches.some(
        (b) => b.status === "submitted" || b.status === "applying",
      ),
  );
  const testPilotBusy = $derived(
    app.testPilot.pending !== null ||
      Object.keys(app.testPilot.pendingDetails).length > 0,
  );
  // AuditFlow tab busy state — spinner replaces the shield icon while
  // a run is in flight. Single-flight per session for v1.
  const auditFlowBusy = $derived(app.audit.pending !== null);
  // Report tab busy state — spinner replaces the doc glyph while the
  // agent is gathering tasks.
  const reportBusy = $derived(app.report.pending !== null);

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
  // Default ON — most users want the agent to apply edits without a
  // confirmation round-trip. Untick per-submit to just file/draft instead.
  let autoApplyEnabled = $state(true);
  let hmrDetected = $state<boolean | null>(null);
  let reloadingAt = $state<number | null>(null);
  let lastHandledSessionId = $state<string | null>(null);
  let lastOverlaySessionId = $state<string | null>(null);

  // Collapsible submit-options block. The auto-apply / screenshot /
  // Just Ask / per-submit module checkboxes can fill 4-5 lines of
  // panel real estate even when the user has set them once and
  // doesn't want to revisit. Toggle hides the cluster and shows a
  // compact summary chip row instead. State persists to
  // chrome.storage so the preference sticks across panel reopens.
  const FOOTER_COLLAPSED_KEY = "pinta-footer-options-collapsed";
  let footerOptionsCollapsed = $state(false);

  async function loadFooterCollapsedPref() {
    try {
      const stored = await chrome.storage?.local?.get(FOOTER_COLLAPSED_KEY);
      const raw = stored?.[FOOTER_COLLAPSED_KEY];
      if (raw === true) footerOptionsCollapsed = true;
    } catch {
      // storage unavailable — defaults are fine
    }
  }

  function toggleFooterOptions() {
    footerOptionsCollapsed = !footerOptionsCollapsed;
    try {
      void chrome.storage?.local?.set({
        [FOOTER_COLLAPSED_KEY]: footerOptionsCollapsed,
      });
    } catch {
      // ignore — in-memory state still wins this session
    }
  }

  // Summary chip labels for the collapsed state — only show options
  // the user has actually opted into. Empty list = empty header
  // (header still shows so the toggle is reachable; the summary just
  // reads as "no options set").
  const footerActiveSummary = $derived.by(() => {
    const parts: string[] = [];
    if (autoApplyEnabled) parts.push("Auto-apply");
    if (includeScreenshot) parts.push("Screenshot");
    if (annotateJustAsk) parts.push("Just Ask");
    for (const m of app.allModuleSpecs()) {
      if (m.mode !== "per-submit") continue;
      if (app.moduleReady(m.id) && app.tickedModules[m.id]) {
        parts.push(m.name);
      }
    }
    return parts;
  });

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
    /** `mode.changed` — content script broadcasts its active mode so the
     *  toolbar pressed-state mirrors hotkey + Esc-driven changes on the
     *  page. `tool` is only carried when mode === "draw". */
    mode?: ActiveMode;
    tool?: Tool;
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
  // SUBMITTED-tray ⋮ kebab (Cancel / Reload / Commit / Commit & push /
  // Clear done) — collapses the tray header actions into one menu.
  let trayMenuOpen = $state(false);
  // Separate open-state for the Annotate list-header export popover, so
  // its dropdown toggles independently of the footer's downloadDropdown
  // (both render the shared `downloadMenuItems` snippet).
  let annHeaderDownloadOpen = $state(false);
  let bundleBusy = $state(false);

  // Header overflow menu (⋮) — collapses chat / history / settings /
  // theme into one dropdown. `historyOpen` drives the embedded
  // SessionHistory popover (trigger hidden, anchored to the ⋮ button);
  // `historyCount` mirrors its session count back for the menu badge.
  let headerMenuOpen = $state(false);
  let headerMenuBtn = $state<HTMLButtonElement>();
  let historyOpen = $state(false);
  let historyCount = $state(0);

  // Extension version, shown next to the title. Read once from the
  // manifest; tolerate a missing chrome.runtime (non-extension preview).
  const appVersion = (() => {
    try {
      return chrome.runtime?.getManifest?.().version ?? "";
    } catch {
      return ""; // not running as an extension — badge just hides.
    }
  })();

  // Connection dot beside the title — colour + label per mode/status.
  // Standalone is intentional local-only, so it reads neutral grey
  // rather than "offline" red. Mirrors StatusPill's colour map.
  const statusDot = $derived.by(() => {
    if (app.appMode === "standalone")
      return { cls: "bg-ink-400 dark:bg-night-mute", label: "Standalone — local only" };
    switch (app.connectionStatus) {
      case "connected":
        return { cls: "bg-emerald-500", label: "Connected" };
      case "connecting":
        return { cls: "bg-amber-400 animate-pulse", label: "Connecting…" };
      default:
        return { cls: "bg-red-500", label: "Offline" };
    }
  });

  // Close a popover when the user presses outside it. Attach to the
  // element that wraps BOTH the trigger and the panel, so clicking the
  // trigger (to toggle) isn't treated as an outside press. Capture-phase
  // pointerdown so it fires before the item buttons' own click handlers.
  function clickOutside(node: HTMLElement, onOutside: () => void) {
    function handle(e: PointerEvent) {
      if (!node.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("pointerdown", handle, true);
    return {
      destroy() {
        document.removeEventListener("pointerdown", handle, true);
      },
    };
  }

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
    if (m?.type === "mode.changed" && sender.tab?.id === activeTabId) {
      // Sync toolbar pressed-state with the content script's actual mode.
      // Hotkeys (Alt+S / Alt+P / Alt+X) and Esc-driven exits change mode
      // on the page without going through `setActive`, so without this
      // mirror the toolbar would lie about what's active.
      if (m.mode === "select") activeTool = "select";
      else if (m.mode === "image") activeTool = "image";
      else if (m.mode === "draw") activeTool = (m.tool as Tool | undefined) ?? activeTool;
      else activeTool = null;
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
    void loadFooterCollapsedPref();
    // Restore the last-used tab. Built-in ids (annotate / test-pilot /
    // audit-flow) AND any imported interactive tab id restore directly;
    // if that module has since been disabled the conditional render
    // below falls back to Annotate via the final {:else}.
    try {
      const stored = await chrome.storage?.local?.get("pinta-active-tab");
      const raw = stored?.["pinta-active-tab"];
      if (typeof raw === "string" && raw) {
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
  // Phase 20 — async batches. Tray rows for batches the user submitted
  // earlier that are still applying (or just finished). Oldest first, so
  // the tray reads in submit order. Each row carries its own progress
  // (done / total annotations) and a short page label so the user can
  // tell which page that batch was about while annotating elsewhere.
  function shortPagePath(url: string): string {
    try {
      const u = new URL(url);
      const path = (u.pathname + u.hash).replace(/\/$/, "");
      return path.length > 28 ? "…" + path.slice(-27) : path || "/";
    } catch {
      return url.length > 28 ? "…" + url.slice(-27) : url;
    }
  }
  // Active (still being processed) batches rank above terminal ones; within
  // each rank the freshest submission floats to the top. So an unprocessed
  // batch always sits directly beneath the live draft, and a just-finished
  // one sinks below anything the agent is still working on.
  const batchRank = (status: string) =>
    status === "done" || status === "error" ? 1 : 0;
  // Flat, stacked list of every submitted-batch annotation — no per-batch
  // grouping. Each item carries its parent batch status so the card can
  // show the right pending/done state. Ordered active-first, newest-first.
  const inFlightAnnotations = $derived.by(() =>
    [...app.inFlightBatches]
      .sort(
        (a, b) =>
          batchRank(a.status) - batchRank(b.status) ||
          (b.submittedAt ?? 0) - (a.submittedAt ?? 0),
      )
      .flatMap((b) =>
        b.annotations.map((annotation) => ({
          annotation,
          batchStatus: b.status,
        })),
      ),
  );
  const anyBatchDone = $derived(
    app.inFlightBatches.some((b) => b.status === "done"),
  );
  // A batch still in "submitted" hasn't been claimed by any agent yet —
  // if no `/pinta` is running it sits here spinning forever. Surface a
  // Cancel escape hatch for exactly those (an "applying" batch is being
  // worked on, so it's left alone).
  const anyBatchWaiting = $derived(
    app.inFlightBatches.some((b) => b.status === "submitted"),
  );
  // Drop every unclaimed (still-"submitted") batch from the tray. Local
  // only — there's no session.cancel wire; the orphaned companion session
  // is harmless (a late agent claim just yields an ignored stale echo).
  function cancelWaitingBatches(): void {
    for (const id of app.inFlightBatches
      .filter((b) => b.status === "submitted")
      .map((b) => b.id)) {
      app.dismissBatch(id);
    }
  }
  // Clear the WHOLE tray — every batch regardless of status (processing,
  // done, or errored). Local only (no session.cancel wire); a still-running
  // agent keeps working but its row is removed. Snapshot ids first.
  function clearAllBatches(): void {
    for (const id of app.inFlightBatches.map((b) => b.id)) {
      app.dismissBatch(id);
    }
  }
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
    for (const spec of app.allModuleSpecs()) {
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
        afterSubmit();
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
      afterSubmit();
    } catch (err) {
      app.lastError = `screenshot failed: ${(err as Error).message}`;
    } finally {
      capturing = false;
    }
  }

  // Phase 20 — async batches. The submitted batch has detached into the
  // in-flight tray and a fresh draft is spinning up, so wipe the page's
  // pin badges: they belonged to the batch the agent now owns, and leaving
  // them on-screen would mix with pins the user adds to the new draft.
  function afterSubmit() {
    if (activeTabId != null) {
      chrome.tabs
        .sendMessage(activeTabId, { type: "annotated.clear" })
        .catch(() => {});
    }
  }
</script>

<!-- Small info icon with the option's description as a hover tooltip.
     Used in Submit options so each row stays a single tidy line. -->
{#snippet infoTip(text: string)}
  <span
    class="inline-flex items-center justify-center shrink-0 text-ink-400 dark:text-night-mute hover:text-ink-600 dark:hover:text-night-text cursor-help align-text-bottom"
    title={text}
    aria-label={text}
    role="img"
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
  </span>
{/snippet}

<!-- Shared annotation export menu items — top-level so both the footer
     `downloadDropdown` (opens upward) and the Annotate list-header
     segmented group's export popover (opens downward) can render it. -->
{#snippet downloadMenuItems()}
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
{/snippet}

<div class="flex flex-col h-full overflow-hidden">
  <header
    class="shrink-0 px-4 py-3 border-b border-ink-200 bg-white dark:border-night-line dark:bg-night-card flex items-center justify-between"
  >
    <div class="flex items-center gap-2 min-w-0">
      <img src="/icons/icon-32.png" alt="" width="24" height="24" />
      <div class="min-w-0 relative" use:clickOutside={() => (projectMenuOpen = false)}>
        <div class="flex items-center gap-1.5">
          <h1 class="font-semibold text-sm dark:text-night-text">Pinta</h1>
          {#if appVersion}
            <span class="text-[10px] font-medium text-ink-400 dark:text-night-mute tabular-nums" title="Pinta v{appVersion}">{appVersion}</span>
          {/if}
          <span
            class="w-2 h-2 rounded-full shrink-0 {statusDot.cls}"
            title={statusDot.label}
            aria-label={statusDot.label}
          ></span>
        </div>
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
    <!-- Header right-side actions — a quick Settings gear (so Settings is
         one click from any tab) next to the ⋮ overflow dropdown (history /
         settings / theme + connection status). -->
    <div class="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        class={[
          "w-7 h-7 inline-flex items-center justify-center rounded-full border transition-colors",
          app.viewingSettings
            ? "border-brand-pink text-brand-pink bg-brand-pink/5 dark:border-brand-pink-light dark:text-brand-pink-light"
            : "border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2",
        ].join(" ")}
        onclick={() => (app.viewingSettings = !app.viewingSettings)}
        aria-pressed={app.viewingSettings}
        aria-label="Settings"
        title="Settings"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <div class="relative" use:clickOutside={() => (headerMenuOpen = false)}>
      <button
        bind:this={headerMenuBtn}
        type="button"
        class="relative w-7 h-7 inline-flex items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 transition-colors"
        onclick={() => (headerMenuOpen = !headerMenuOpen)}
        aria-haspopup="menu"
        aria-expanded={headerMenuOpen}
        aria-label="Menu"
        title="Menu"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
        {#if historyCount > 0}
          <span class="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 inline-flex items-center justify-center rounded-full bg-brand-pink text-white text-[9px] font-semibold leading-none dark:bg-brand-pink-light dark:text-night-bg" aria-hidden="true">
            {historyCount > 99 ? "99+" : historyCount}
          </span>
        {/if}
      </button>

      {#if headerMenuOpen}
        <div
          class="absolute right-0 top-full mt-1 z-30 w-52 rounded-md border border-ink-200 bg-white shadow-lg dark:border-night-line dark:bg-night-card py-1"
          role="menu"
        >
          <button
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
            role="menuitem"
            onclick={() => { historyOpen = true; headerMenuOpen = false; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
            Session history
            {#if historyCount > 0}
              <span class="ml-auto min-w-[16px] h-4 px-1 inline-flex items-center justify-center rounded-full bg-brand-pink text-white text-[9px] font-semibold leading-none dark:bg-brand-pink-light dark:text-night-bg">
                {historyCount > 99 ? "99+" : historyCount}
              </span>
            {/if}
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] {app.viewingSettings ? 'text-brand-pink dark:text-brand-pink-light font-medium' : 'text-ink-700 dark:text-night-dim'} hover:bg-ink-50 dark:hover:bg-night-alt"
            role="menuitemcheckbox"
            aria-checked={app.viewingSettings}
            onclick={() => { app.viewingSettings = !app.viewingSettings; headerMenuOpen = false; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Settings
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
            role="menuitem"
            onclick={toggleTheme}
          >
            {#if theme.value === "dark"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
              Light mode
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              Dark mode
            {/if}
          </button>
          <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
          <div class="px-3 py-1.5 flex items-center gap-2 text-[11px] text-ink-500 dark:text-night-mute">
            <span class="w-2 h-2 rounded-full shrink-0 {statusDot.cls}"></span>
            {statusDot.label}
          </div>
        </div>
      {/if}

      <!-- Rich session-history popover, controlled from the menu item
           above. Trigger hidden; positions under the ⋮ button. -->
      <SessionHistory
        bind:open={historyOpen}
        bind:count={historyCount}
        anchorEl={headerMenuBtn}
        showTrigger={false}
      />
      </div>
    </div>
  </header>

  <!-- Panel body wrapper — `relative` is the positioning ancestor for
       the ChatSheet overlays so they clip to the body area instead of
       the full iframe. Keeps the App header (logo / project / icons)
       visible and interactive while a chat sheet is open.
       `min-h-0` lets <main>'s overflow-y-auto shrink properly inside
       this flex column. -->
  <div class="flex-1 relative flex flex-col min-h-0">

  <main class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
    <!-- Soft "still waiting for an agent" notice (Phase 18a). A long queue
         isn't a failure, so it's an amber warning, not a red error —
         dismissible like every banner. Shown across tabs since the waiting
         session belongs to whichever surface the user just submitted. -->
    {#if app.claimNotice}
      <div
        class="flex items-start gap-2 text-xs text-amber-800 border border-amber-300 bg-amber-50 dark:text-amber-200 dark:border-amber-700/40 dark:bg-amber-950/40 rounded-md p-2"
        role="status"
      >
        <svg class="shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p class="flex-1 min-w-0 break-words">{app.claimNotice.text}</p>
        <button
          type="button"
          class="shrink-0 text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 leading-none px-1"
          onclick={() => (app.claimNotice = null)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    {/if}
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

    {#if !app.viewingSettings && !app.viewingImportedId && !showAssociatePrompt && (app.moduleReady("test-pilot") || app.moduleReady("audit-flow") || app.moduleReady("report") || app.interactiveTabSpecs().length > 0)}
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
        {#if app.moduleReady("test-pilot")}
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
        {/if}
        {#if app.moduleReady("audit-flow")}
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors"
            class:border-brand-pink={activeTab === "audit-flow"}
            class:text-brand-pink={activeTab === "audit-flow"}
            class:dark:text-brand-pink-light={activeTab === "audit-flow"}
            class:border-transparent={activeTab !== "audit-flow"}
            class:text-ink-500={activeTab !== "audit-flow"}
            class:dark:text-night-mute={activeTab !== "audit-flow"}
            onclick={() => {
              activeTab = "audit-flow";
              void chrome.storage?.local?.set({ "pinta-active-tab": "audit-flow" });
            }}
          >
            {#if auditFlowBusy}
              <!-- Spinner while an audit run is in flight. -->
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-label="AuditFlow running">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            {:else}
              <!-- Shield-check glyph — reads as "audit / security check"
                   at a glance. Matches the icon style used elsewhere in
                   the tab nav (single-stroke, currentColor, 13×13). -->
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <polyline points="9 12 11 14 15 10"/>
              </svg>
            {/if}
            AuditFlow
          </button>
        {/if}
        {#if app.moduleReady("report")}
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors"
            class:border-brand-pink={activeTab === "report"}
            class:text-brand-pink={activeTab === "report"}
            class:dark:text-brand-pink-light={activeTab === "report"}
            class:border-transparent={activeTab !== "report"}
            class:text-ink-500={activeTab !== "report"}
            class:dark:text-night-mute={activeTab !== "report"}
            onclick={() => {
              activeTab = "report";
              void chrome.storage?.local?.set({ "pinta-active-tab": "report" });
            }}
          >
            {#if reportBusy}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-label="Report generating">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            {:else}
              <!-- Document-with-lines glyph — reads as "report / summary". -->
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="8" y1="13" x2="16" y2="13"/>
                <line x1="8" y1="17" x2="16" y2="17"/>
              </svg>
            {/if}
            Report
          </button>
        {/if}
        <!-- Phase 19 — DYNAMIC tabs: one per imported interactive module
             that declares a `tab` in its manifest. Nothing is hardcoded;
             id / label / icon all come from the plugin. -->
        {#each app.interactiveTabSpecs() as s (s.id)}
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors"
            class:border-brand-pink={activeTab === s.id}
            class:text-brand-pink={activeTab === s.id}
            class:dark:text-brand-pink-light={activeTab === s.id}
            class:border-transparent={activeTab !== s.id}
            class:text-ink-500={activeTab !== s.id}
            class:dark:text-night-mute={activeTab !== s.id}
            onclick={() => {
              activeTab = s.id;
              void chrome.storage?.local?.set({ "pinta-active-tab": s.id });
            }}
            title={s.tab?.name}
          >
            {#if app.moduleBoards[s.id]?.pending}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-label={`${s.tab?.name} working`}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            {:else if s.tab?.icon}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d={s.tab.icon} />
              </svg>
            {:else}
              <!-- default board/kanban glyph when the plugin ships no icon -->
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="5" height="18" rx="1"/><rect x="9.5" y="3" width="5" height="11" rx="1"/><rect x="16" y="3" width="5" height="14" rx="1"/>
              </svg>
            {/if}
            {s.tab?.name}
          </button>
        {/each}
      </nav>
    {/if}

    {#if app.viewingSettings}
      <SettingsPanel />
    {:else if !app.viewingImportedId && !showAssociatePrompt && activeTab === "test-pilot" && app.moduleReady("test-pilot")}
      <TestPilotTab />
    {:else if !app.viewingImportedId && !showAssociatePrompt && activeTab === "audit-flow" && app.moduleReady("audit-flow")}
      <AuditFlowTab
        onSwitchToAnnotate={() => {
          activeTab = "annotate";
          void chrome.storage?.local?.set({ "pinta-active-tab": "annotate" });
        }}
      />
    {:else if !app.viewingImportedId && !showAssociatePrompt && activeTab === "report" && app.moduleReady("report")}
      <ReportTab />
    {:else if !app.viewingImportedId && !showAssociatePrompt && app.interactiveTabSpecs().some((s) => s.id === activeTab)}
      <!-- Phase 19 — generic renderer for an imported interactive tab. -->
      <ModuleBoardTab
        spec={app.interactiveTabSpecs().find((s) => s.id === activeTab)!}
      />
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
            class="inline-flex items-center justify-center w-8 h-8 rounded-md border border-ink-200 bg-white text-ink-700 hover:text-brand-pink hover:bg-ink-50 dark:border-night-line dark:bg-night-card dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:bg-night-alt transition-colors disabled:opacity-50"
            onclick={() => importFileInput?.click()}
            disabled={importBusy}
            title={importBusy ? "Importing…" : "Import a .pinta or .md file shared by a teammate"}
            aria-label="Import a .pinta or .md file shared by a teammate"
          >
            {#if importBusy}
              <svg class="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {/if}
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
          <!-- Header action group — Copy · Export · Clear, mirroring Test
               Pilot's segmented icon toolbar. Icon-only; labels live in
               title + aria-label. Export reuses the shared
               `downloadMenuItems` snippet (popover opens downward here). -->
          <div class="inline-flex items-center shrink-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card divide-x divide-ink-200 dark:divide-night-line">
            <button
              type="button"
              class="inline-flex items-center justify-center w-8 h-8 rounded-l-md text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-50 dark:hover:bg-night-alt"
              onclick={copyToClipboard}
              title="Copy annotations as markdown — paste into claude.ai web, ChatGPT, or another agent"
              aria-label="Copy annotations to clipboard"
            >
              {#if copiedAt}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              {:else}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {/if}
            </button>
            <div class="relative" use:clickOutside={() => (annHeaderDownloadOpen = false)}>
              <button
                type="button"
                class="inline-flex items-center justify-center gap-0.5 w-9 h-8 text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-50 dark:hover:bg-night-alt"
                onclick={() => (annHeaderDownloadOpen = !annHeaderDownloadOpen)}
                title="Download annotations as a file an agent can read"
                aria-haspopup="menu"
                aria-expanded={annHeaderDownloadOpen}
                aria-label="Export annotations"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              {#if annHeaderDownloadOpen}
                <div
                  class="absolute right-0 top-full mt-1 w-56 z-30 rounded-md border border-ink-300 bg-white shadow-lg dark:border-night-line dark:bg-night-alt overflow-hidden"
                  role="menu"
                >
                  {@render downloadMenuItems()}
                </div>
              {/if}
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center w-8 h-8 rounded-r-md text-ink-700 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 hover:bg-ink-50 dark:hover:bg-night-alt"
              onclick={clearAllAnnotations}
              aria-label="Clear all annotations"
              title="Remove every annotation in this batch"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
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

    <!-- Phase 20 — submitted annotations, in-content. Annotations the user
         already sent that the agent is still applying (or just finished),
         stacked below the live draft as their original read-only cards — no
         per-batch grouping, just one continuous list ordered active-first.
         Each card shows its own status (spinner → ✓ / ✕). The live draft
         above stays fully editable while earlier work lands. Connected only. -->
    {#if app.appMode === "connected" && inFlightAnnotations.length > 0}
      <section class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
            Submitted ({inFlightAnnotations.length})
          </h2>
          {#if app.inFlightBatches.length > 0}
            <!-- All tray actions live behind one ⋮ kebab to keep the header
                 tidy: Cancel waiting / Reload / Commit / Commit & push /
                 Clear (always available so processing-only trays can be
                 cleared too). -->
            <div class="relative shrink-0" use:clickOutside={() => (trayMenuOpen = false)}>
              <button
                type="button"
                class="w-7 h-7 inline-flex items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-card dark:text-night-dim dark:hover:text-brand-pink-light transition-colors"
                onclick={() => (trayMenuOpen = !trayMenuOpen)}
                aria-haspopup="menu"
                aria-expanded={trayMenuOpen}
                aria-label="Submitted actions"
                title="Actions"
              >
                {#if app.commit.pending}
                  <svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                {:else}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
                {/if}
              </button>
              {#if trayMenuOpen}
                <div class="absolute right-0 top-full mt-1 z-30 w-52 rounded-md border border-ink-200 bg-white shadow-lg dark:border-night-line dark:bg-night-card py-1" role="menu">
                  {#if anyBatchWaiting}
                    <button
                      type="button"
                      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                      role="menuitem"
                      onclick={() => { cancelWaitingBatches(); trayMenuOpen = false; }}
                      title="No agent has picked this up — cancel the waiting submission(s)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                      Cancel waiting
                    </button>
                  {/if}
                  {#if anyBatchDone}
                    <button
                      type="button"
                      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-50"
                      role="menuitem"
                      onclick={() => { reloadActiveTab(); trayMenuOpen = false; }}
                      disabled={reloadingAt !== null || activeTabId == null}
                      title="Reload the page to see the applied changes"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
                      Reload page
                    </button>
                    <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-50"
                      role="menuitem"
                      onclick={() => { void app.commitAppliedBatches(false); trayMenuOpen = false; }}
                      disabled={app.commit.pending !== null}
                      title="Agent commits the files it applied (auto message from your annotations)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>
                      Commit
                    </button>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-50"
                      role="menuitem"
                      onclick={() => { void app.commitAppliedBatches(true); trayMenuOpen = false; }}
                      disabled={app.commit.pending !== null}
                      title="Commit the applied files, then push to the remote"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/><polyline points="16 5 19 8 16 11"/></svg>
                      Commit &amp; push
                    </button>
                  {/if}
                  <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                    role="menuitem"
                    onclick={() => { clearAllBatches(); trayMenuOpen = false; }}
                    title="Clear every submitted annotation from this list — processing and done"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6"/></svg>
                    Clear
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
        {#if app.commit.pending}
          <p class="text-[11px] text-ink-500 dark:text-night-mute inline-flex items-center gap-1.5">
            <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {app.commit.pending === "commit-push" ? "Committing & pushing applied changes…" : "Committing applied changes…"}
          </p>
        {:else if app.commit.result}
          <div class="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/30 p-2 text-[11px] text-emerald-700 dark:text-emerald-300 leading-snug">
            <span class="flex-1 min-w-0 break-words">✓ {app.commit.result}</span>
            <button type="button" class="shrink-0 text-emerald-600 hover:text-emerald-800 dark:hover:text-emerald-200 leading-none px-1" onclick={() => (app.commit.result = null)} aria-label="Dismiss" title="Dismiss">✕</button>
          </div>
        {/if}
        {#if app.commit.error}
          <div class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11px] text-red-700 dark:text-red-300 leading-snug">
            <span class="flex-1 min-w-0 break-words">{app.commit.error}</span>
            <button type="button" class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1" onclick={() => (app.commit.error = null)} aria-label="Dismiss" title="Dismiss">✕</button>
          </div>
        {/if}
        <ul class="space-y-2" aria-label="Submitted annotations">
          {#each inFlightAnnotations as item, i (`${item.annotation.id}:${i}`)}
            <AnnotationCard
              annotation={item.annotation}
              canEdit={false}
              pending={(item.batchStatus === "submitted" || item.batchStatus === "applying") && item.annotation.status !== "done" && item.annotation.status !== "error"}
              onremove={() => {}}
              onsave={() => {}}
            />
          {/each}
        </ul>
      </section>
    {/if}
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
    class="shrink-0 border-t border-ink-200 p-3 bg-white dark:border-night-line dark:bg-night-card space-y-2"
    class:hidden={showAssociatePrompt ||
      app.viewingSettings ||
      (activeTab !== "annotate" && !app.viewingImportedId)}
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
      <!-- Collapsible "Submit options" header. Toggle button rotates a
           chevron and (when collapsed) renders summary chips for the
           options that are currently set. State persists to
           chrome.storage so the user's "I'm done configuring these"
           preference sticks across panel reopens. -->
      <button
        type="button"
        class="w-full flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text transition-colors px-0.5 py-1"
        onclick={toggleFooterOptions}
        aria-expanded={!footerOptionsCollapsed}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="transition-transform shrink-0" class:rotate-90={!footerOptionsCollapsed} aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="shrink-0">Submit options</span>
        {#if footerOptionsCollapsed && footerActiveSummary.length > 0}
          <span class="flex items-center gap-1 flex-wrap normal-case tracking-normal font-normal text-[10px] text-ink-600 dark:text-night-dim">
            {#each footerActiveSummary as part, i (i)}
              <span class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-brand-pink/10 dark:bg-brand-pink/20 text-brand-pink dark:text-brand-pink-light border border-brand-pink/30">
                {part}
              </span>
            {/each}
          </span>
        {:else if footerOptionsCollapsed}
          <span class="normal-case tracking-normal font-normal text-[10px] text-ink-400 dark:text-night-mute italic">none set</span>
        {/if}
      </button>
      {#if !footerOptionsCollapsed}
      <label
        class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim cursor-pointer select-none"
      >
        <input
          type="checkbox"
          class="mt-0.5 accent-brand-pink"
          bind:checked={autoApplyEnabled}
        />
        <span class="flex-1 leading-snug inline-flex items-center gap-1.5">
          Auto-apply (no agent confirmation)
          {@render infoTip("Skip the agent's \"reply 'go' to apply\" step. Plan is still shown briefly. Off by default — turn on for fast iteration.")}
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
        <span class="flex-1 leading-snug inline-flex items-center gap-1.5">
          Include full-page screenshot
          {#if screenshotLocked}
            <span class="text-brand-pink dark:text-brand-pink-light font-medium">(required)</span>
          {/if}
          {@render infoTip(
            hasDrawingAnnotation
              ? "A drawing is in this batch — the agent has no DOM target for freehand / arrow / circle / rect / pin annotations, so the screenshot is the only context it has."
              : screenshotRequiredByModule
                ? "Required because a module below needs the screenshot embedded in its output (e.g. GitLab issues attach it to every body). Untick the module to unlock this."
                : "Adds visual context for the agent. ~1.5–2k extra vision tokens per submit. Off by default — selectors + nearby text are usually enough.",
          )}
        </span>
      </label>
      {#if app.moduleReady("chat")}
        <!-- Phase 14 — "Just Ask" footer checkbox. When ticked, the
             Submit button re-labels to "Ask agent" and opens the
             chat sheet with this batch as context instead of
             submitting source edits. User can pivot back to a real
             submit at any time by unticking. -->
        <label class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim cursor-pointer select-none">
          <input
            type="checkbox"
            class="mt-0.5 accent-brand-pink"
            bind:checked={annotateJustAsk}
          />
          <span class="flex-1 leading-snug">
            <span class="inline-flex items-center gap-1.5 flex-wrap">
              💬 Just Ask
              {@render infoTip("Don't touch source files — discuss this batch with the agent first. Submit re-labels to \"Ask agent\" and opens the chat. Untick to go back to the normal source-edit flow.")}
              {#if annotateJustAsk}
                <span class="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold text-brand-pink dark:text-brand-pink-light bg-brand-pink/10 dark:bg-brand-pink-light/10 border border-brand-pink/40 dark:border-brand-pink-light/40 rounded-full px-1.5 py-0.5">
                  Chat only
                </span>
              {/if}
            </span>
          </span>
        </label>
      {/if}
      {#each app.allModuleSpecs().filter((m) => m.mode === "per-submit") as moduleSpec (moduleSpec.id)}
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
                {@render infoTip(moduleSpec.sessionCheckboxHint)}
                {#if ticked}
                  <span class="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800/50 rounded-full px-1.5 py-0.5" title="This module will run on the next submit">
                    Will run
                  </span>
                {/if}
              </span>
            </span>
          </label>
        {/if}
      {/each}
      {/if}
    {/if}

    {#snippet downloadDropdown()}
      <div class="relative" use:clickOutside={() => (downloadMenuOpen = false)}>
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
            {@render downloadMenuItems()}
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
          onclick={annotateJustAsk ? askAgentWithBatch : submit}
        >
          {#if capturing}
            Capturing screenshot…
          {:else if annotateJustAsk}
            💬 Ask agent
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

    <!-- Phase 14 — Global chat sheet. Single thread, no surface
         context; agent answers FAQ-style asks about Pinta itself.
         Mounted inside the panel-body wrapper (not <main>) so the
         absolute-positioned overlay clips to body bounds and leaves
         the App header visible above. -->
    {#if app.moduleReady("chat")}
      <ChatSheet
        open={globalChatOpen}
        contextHeader="Quick ask"
        contextLabel="Pinta"
        contextSubLabel={app.selectedCompanion ? app.selectedCompanion.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? "" : "standalone"}
        messages={app.chat.global}
        pending={app.chat.pendingGlobal}
        error={app.chat.error}
        placeholder="Ask the agent about this app…"
        greeting={`Hi — I can help you with Pinta itself${app.selectedCompanion ? ` while you're working on ${app.selectedCompanion.projectRoot.split(/[\\/]/).filter(Boolean).pop()}` : ""}. Ask anything: settings, shortcuts, how a feature works. You can also paste a screenshot of what you're looking at.`}
        quickPrompts={[
          { label: "How do I use Pinta?", prompt: "How do I use Pinta? Give me a quick tour of the main features." },
          { label: "Change a shortcut", prompt: "How do I change a keyboard shortcut in Pinta?" },
          { label: "What's Test Pilot?", prompt: "What is Test Pilot and when should I use it?" },
        ]}
        imagesEnabled={true}
        onClear={() => app.clearGlobalChat()}
        onExport={() => downloadChatBlob(
          app.exportGlobalChatMarkdown(),
          `pinta-global-chat-${new Date().toISOString().slice(0, 10)}.md`,
        )}
        onClose={() => (globalChatOpen = false)}
        onSend={(prompt, images) => void app.sendGlobalChatMessage(prompt, images)}
      />
    {/if}

    <!-- Phase 14 — Annotate "Just Ask" chat sheet. Per-draft-session
         thread keyed by the current session id. Surface context
         carries the annotation list + screenshot path so the agent
         can reason about the batch without editing source files. -->
    {#if app.moduleReady("chat") && app.session?.id}
      {@const batchId = app.session.id}
      {@const annCount = app.session.annotations.length}
      <ChatSheet
        open={annotateChatOpen}
        contextHeader="Talking about"
        contextLabel="{annCount} annotation{annCount === 1 ? '' : 's'}"
        contextSubLabel={pageUrl ? new URL(pageUrl).pathname : ""}
        messages={app.chat.annotateBatch[batchId] ?? []}
        pending={!!app.chat.pendingAnnotateBatch[batchId]}
        error={app.chat.error}
        placeholder="Ask the agent about this batch…"
        greeting={`I can review your ${annCount} annotation${annCount === 1 ? "" : "s"} before you commit. Ask anything — I'll explain what I'd change, flag risky edits, or suggest a better approach. No source edits until you Submit.`}
        quickPrompts={[
          { label: "Is this change safe?", prompt: "Look at the annotations in this batch and tell me if any of them are risky to apply. Flag anything that could break a flow, regress a test, or affect more than the obvious file." },
          { label: "Better selector?", prompt: "For each annotation with a selector, suggest whether there's a more robust selector I could use (less brittle to DOM changes). Be specific." },
          { label: "What files would this touch?", prompt: "Based on the selectors + nearby text in these annotations, list every source file you'd need to edit to apply the batch. Group by file." },
        ]}
        onClear={() => app.clearAnnotateChat(batchId)}
        onExport={() => downloadChatBlob(
          app.exportAnnotateChatMarkdown(batchId),
          `pinta-annotate-chat-${batchId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`,
        )}
        redactionSummary={app.chat.annotateRedactions[batchId]}
        imagesEnabled={true}
        onClose={() => (annotateChatOpen = false)}
        onSend={(prompt, images) => void app.sendAnnotateChatMessage(batchId, prompt, images)}
      />
    {/if}

    <!-- Global "Ask Pinta" FAB — floats bottom-right of the panel body so
         the agent Q&A is reachable from every module/tab instead of being
         buried in the header ⋮ menu. Hidden while the global sheet is open
         (the sheet covers this corner). When the Annotate footer is visible
         it sits higher (bottom-20) so it clears the pinned "Send to agent"
         button; otherwise it drops to the panel's bottom-right corner. -->
    {#if app.moduleReady("chat") && !globalChatOpen}
      {@const footerVisible =
        !showAssociatePrompt &&
        !app.viewingSettings &&
        (activeTab === "annotate" || !!app.viewingImportedId)}
      <button
        type="button"
        class="absolute {footerVisible ? 'bottom-20' : 'bottom-5'} right-5 z-20 w-12 h-12 inline-flex items-center justify-center rounded-full bg-brand-pink text-white shadow-lg hover:bg-brand-magenta dark:bg-brand-pink-light dark:text-night-bg dark:hover:bg-brand-pink transition-colors"
        onclick={() => (globalChatOpen = true)}
        aria-label="Ask Pinta"
        title="Ask Pinta"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg>
      </button>
    {/if}
  </div>
</div>
