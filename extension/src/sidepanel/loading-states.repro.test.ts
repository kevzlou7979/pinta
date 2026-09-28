// Tester (paint-loader-empty-states, items 1 + 2): mounts the full App
// (chrome stubbed, companion offline) and walks every module tab in
// connected mode — each tab's EMPTY view must render the shared
// EmptyState shell and each tab's in-flight `pending` must render the
// shared LoadingState (a polite status live region wrapping a PaintLoader).
// No `animate-spin` may survive anywhere, in any state.
import { describe, it, expect, vi } from "vitest";

const store: Record<string, unknown> = {};
const ev = () => ({ addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) });
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (k: any) => (typeof k === "string" ? { [k]: store[k] } : {})),
      set: vi.fn(async (o: any) => Object.assign(store, o)),
      remove: vi.fn(async () => {}),
    },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: ev(),
  },
  runtime: {
    onMessage: ev(), sendMessage: vi.fn(async () => ({})),
    connect: vi.fn(() => ({ onMessage: ev(), onDisconnect: ev(), postMessage: vi.fn(), disconnect: vi.fn() })),
    getManifest: () => ({ version: "0.9.0" }), getURL: (p: string) => p, id: "t",
  },
  tabs: { onActivated: ev(), onUpdated: ev(), onRemoved: ev(), query: vi.fn(async () => []), sendMessage: vi.fn(async () => ({})) },
  windows: { onFocusChanged: ev(), WINDOW_ID_NONE: -1 },
  notifications: { create: vi.fn(), onClicked: ev(), onClosed: ev(), clear: vi.fn() },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  permissions: { contains: vi.fn(async () => false) },
  commands: { onCommand: ev() },
};
globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;

const LOADING = '.pinta-loading-state[role="status"][aria-live="polite"]';

type TabCase = {
  id: string;
  label: string;
  /** Substring expected in the empty view's EmptyState title. */
  emptyTitle: string;
  /** Tabs whose empty view IS a form (Design Variants compose card) render
   *  no EmptyState — `mountText` is the substring that proves the tab
   *  mounted, and the EmptyState checks are skipped. (Fixer F11) */
  mountText?: string;
  /** Tab-level titles keep the heading level the old markup had (F5). */
  heading?: "h2" | "h3";
  /** Bespoke onboarding layout (left-aligned, no centred icon chip). */
  noIconChip?: boolean;
  /** Substring expected in the LoadingState while pending. */
  loadingTitle?: string;
  pend?: (app: any) => void;
  reset?: (app: any) => void;
};

const TABS: TabCase[] = [
  {
    id: "test-pilot", label: "Test Pilot", emptyTitle: "Build your test catalog", heading: "h2", noIconChip: true, loadingTitle: "Generating tests",
    pend: (app) => { app.testPilot.pending = { kind: "doc-generate", sessionId: "s1", startedAt: Date.now() }; },
    reset: (app) => { app.testPilot.pending = null; },
  },
  {
    id: "audit-flow", label: "AuditFlow", emptyTitle: "Run your first audit", heading: "h3", loadingTitle: "Starting audit",
    pend: (app) => { app.audit.pending = { runId: "r1", startedAt: Date.now() }; },
    reset: (app) => { app.audit.pending = null; },
  },
  {
    id: "report", label: "Report", emptyTitle: "No report yet", loadingTitle: "Generating report",
    pend: (app) => { app.report.pending = { runId: "r1", startedAt: Date.now(), range: "weekly", anchorDate: "2026-09-25", since: "2026-09-21", until: "2026-09-25", sessionId: null }; },
    reset: (app) => { app.report.pending = null; },
  },
  {
    id: "design-variants", label: "Variants", emptyTitle: "", mountText: "Generate",
    pend: (app) => { app.variants.pending = { runId: "r1", startedAt: Date.now(), op: "variants-generate", sessionId: null }; },
    reset: (app) => { app.variants.pending = null; },
  },
  {
    id: "code-review", label: "Review", emptyTitle: "Play your changes as a review deck", loadingTitle: "Dealing the cards",
    pend: (app) => { app.review.pending = { runId: "r1", startedAt: Date.now(), op: "review-gather", sessionId: null }; },
    reset: (app) => { app.review.pending = null; },
  },
  { id: "devices", label: "Devices", emptyTitle: "Preview on real device sizes", heading: "h2" },
];

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Tabs are lazy (`{#await import(...)}`) — poll until `pred` holds. */
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const { flushSync, tick } = await import("svelte");
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    flushSync(); await tick();
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("every tab: shared EmptyState when empty, shared LoadingState when pending, zero animate-spin", () => {
  it("walks Annotate + all module tabs in connected mode", async () => {
    const { mount, flushSync, tick } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    const { default: App } = await import("./App.svelte");
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(App, { target });
    await new Promise((r) => setTimeout(r, 300));

    const noSpin = (where: string) =>
      expect(document.querySelector(".animate-spin"), `animate-spin leaked in ${where}`).toBeNull();

    app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: [] } as any;
    for (const id of ["test-pilot", "audit-flow", "report", "design-variants", "code-review", "devices", "chat"]) app.setModuleEnabled(id, true);
    flushSync(); await tick();
    expect(app.appMode).toBe("connected");

    // Annotate home — the reference EmptyState.
    const home = target.querySelector(".pinta-empty-state");
    expect(home, "Annotate home EmptyState").toBeTruthy();
    expect(norm(home!.textContent)).toContain("Start annotating");
    expect(home!.querySelector('[aria-hidden="true"].rounded-full'), "home icon chip").toBeTruthy();
    expect(target.querySelector(LOADING)).toBeNull();
    noSpin("annotate empty");

    const tabButton = (label: string) =>
      [...target.querySelectorAll<HTMLButtonElement>("main nav button")].find((b) => norm(b.textContent) === label);
    const nav = target.querySelector("main nav");
    expect(nav, "tab nav rendered once modules are ready").toBeTruthy();

    const failures: string[] = [];
    for (const t of TABS) {
      const btn = tabButton(t.label);
      if (!btn) { failures.push(`${t.id}: no tab button labelled "${t.label}"`); continue; }
      btn.click();
      // Lazy tab: wait for the module chunk to mount (an EmptyState or any
      // tab-owned section appears), otherwise report it as a failure.
      const mounted = t.mountText
        ? await waitFor(() => norm(target.textContent).includes(t.mountText!))
        : await waitFor(() => [...target.querySelectorAll(".pinta-empty-state")].some((e) => norm(e.textContent).includes(t.emptyTitle)));
      if (!mounted) failures.push(`${t.id}: tab did not mount within 8s after click`);

      // EMPTY view.
      const empties = [...target.querySelectorAll(".pinta-empty-state")];
      const hit = t.mountText ? null : empties.find((e) => norm(e.textContent).includes(t.emptyTitle));
      if (t.mountText) {
        // The form IS the empty state — no compact "nothing yet" under it (F11).
        if (empties.length) failures.push(`${t.id} empty: unexpected EmptyState(s): ${empties.map((e) => norm(e.textContent).slice(0, 40)).join(" | ")}`);
      } else if (!hit) failures.push(`${t.id} empty: no EmptyState titled "${t.emptyTitle}" (found: ${empties.map((e) => norm(e.querySelector("h2, h3, p")?.textContent)).join(" | ") || "none"})`);
      else {
        if (!t.noIconChip && !hit.querySelector('[aria-hidden="true"].rounded-full')) failures.push(`${t.id} empty: EmptyState has no icon chip`);
        const titleEl = hit.querySelector("h2, h3, p");
        const want = t.heading ?? "p";
        if (titleEl?.tagName.toLowerCase() !== want) failures.push(`${t.id} empty: title is <${titleEl?.tagName.toLowerCase()}>, expected <${want}> (F5)`);
      }
      if (target.querySelector(LOADING)) failures.push(`${t.id} empty: LoadingState shown with nothing pending`);
      if (document.querySelector(".animate-spin")) failures.push(`${t.id} empty: animate-spin present`);

      // PENDING view.
      if (t.pend) {
        t.pend(app);
        await waitFor(() => !!target.querySelector(LOADING), 2000);
        const ls = target.querySelector(LOADING);
        if (!ls) failures.push(`${t.id} pending: no LoadingState [role=status][aria-live=polite]`);
        else {
          if (t.loadingTitle && !norm(ls.textContent).includes(t.loadingTitle)) failures.push(`${t.id} pending: LoadingState title missing "${t.loadingTitle}" (got "${norm(ls.textContent).slice(0, 80)}")`);
          const fan = ls.querySelector(".pinta-paint-loader");
          if (!fan) failures.push(`${t.id} pending: LoadingState has no PaintLoader`);
          else if (fan.getAttribute("role")) failures.push(`${t.id} pending: inner fan is a second status region`);
          if (ls.querySelectorAll('[role="status"]').length) failures.push(`${t.id} pending: nested role=status inside LoadingState`);
        }
        // The tab button swaps its glyph for a DECORATIVE xs fan while busy
        // and carries the wait in its own title (F1 / F4).
        const busyBtn = tabButton(t.label);
        const tabFan = busyBtn?.querySelector('.pinta-paint-loader[data-size="xs"]');
        if (!tabFan) failures.push(`${t.id} pending: tab button has no xs fan while busy`);
        else if (tabFan.getAttribute("role")) failures.push(`${t.id} pending: tab fan is a live region (must be decorative)`);
        if (!busyBtn?.title) failures.push(`${t.id} pending: tab button has no busy title`);
        // Exactly one live region for this wait: the LoadingState.
        const statuses = [...target.querySelectorAll('[role="status"]')];
        if (statuses.length !== 1) failures.push(`${t.id} pending: ${statuses.length} [role=status] regions (expected 1): ${statuses.map((n) => n.className.toString().slice(0, 30)).join(" | ")}`);
        if (document.querySelector(".animate-spin")) failures.push(`${t.id} pending: animate-spin present`);
        t.reset!(app);
        flushSync(); await tick();
        if (target.querySelector(LOADING)) failures.push(`${t.id} reset: LoadingState lingers after pending cleared`);
      }
    }

    // Test Pilot doc-parse variant carries the filename.
    tabButton("Test Pilot")!.click();
    await waitFor(() => [...target.querySelectorAll(".pinta-empty-state")].some((e) => norm(e.textContent).includes("Build your test catalog")));
    app.testPilot.pending = { kind: "doc-parse", sessionId: "", filename: "spec.md" };
    await waitFor(() => !!target.querySelector(LOADING), 2000);
    const parse = target.querySelector(LOADING);
    if (!parse) failures.push("test-pilot doc-parse: no LoadingState");
    else if (!norm(parse.textContent).includes("Parsing spec.md")) failures.push(`test-pilot doc-parse: title missing filename (got "${norm(parse.textContent).slice(0, 60)}")`);
    app.testPilot.pending = null; flushSync(); await tick();

    // Session history empty state (compact) — via the history toggle when present.
    const histBtn = [...target.querySelectorAll<HTMLButtonElement>("button")].find((b) => /history/i.test(b.getAttribute("aria-label") ?? b.getAttribute("title") ?? ""));
    if (histBtn) {
      histBtn.click(); flushSync(); await tick();
      const hist = [...target.querySelectorAll(".pinta-empty-state")].find((e) => norm(e.textContent).includes("No sessions yet"));
      if (!hist) failures.push("session history: no compact EmptyState 'No sessions yet'");
      else if (hist.getAttribute("data-compact") !== "true") failures.push("session history: EmptyState not compact");
      noSpin("session history");
      histBtn.click(); flushSync(); await tick();
    }

    // Global chat typing indicator — the bubble is the ONE status region
    // (sm fan inside is decorative), xs mono fan on Send is decorative.
    tabButton("Annotate")?.click(); flushSync(); await tick();
    const fab = target.querySelector<HTMLButtonElement>('button[aria-label="Ask Pinta"]');
    if (fab) {
      fab.click();
      await waitFor(() => !!target.querySelector('button[aria-label="Send message"]'), 8000);
      app.chat.global = [{ id: "m1", role: "user", text: "How do I use Pinta?", at: Date.now() }] as any;
      app.chat.pendingGlobal = true;
      await waitFor(() => !!target.querySelector('.pinta-paint-loader[data-size="sm"]'), 2000);
      const bubbleFan = target.querySelector('.pinta-paint-loader[data-size="sm"]');
      if (!bubbleFan) failures.push("chat pending: no sm fan in typing bubble");
      else {
        if (bubbleFan.getAttribute("role")) failures.push("chat pending: bubble fan is its own live region");
        const bubble = bubbleFan.closest('[role="status"]');
        if (!bubble) failures.push("chat pending: typing bubble is not a status region");
        else if (bubble.getAttribute("aria-live") !== "polite") failures.push("chat pending: typing bubble not aria-live=polite");
      }
      const send = target.querySelector('button[aria-label="Send message"]');
      const sendFan = send?.querySelector(".pinta-paint-loader");
      if (send && !sendFan) failures.push("chat pending: Send button has no xs fan");
      if (sendFan && sendFan.getAttribute("data-tone") !== "mono") failures.push("chat pending: Send fan on a pink button must be tone=mono");
      if (sendFan && sendFan.getAttribute("role")) failures.push("chat pending: Send fan must be decorative");
      const chatStatuses = target.querySelectorAll('[role="status"]').length;
      if (chatStatuses !== 1) failures.push(`chat pending: ${chatStatuses} [role=status] regions (expected 1)`);
      if (document.querySelector(".animate-spin")) failures.push("chat pending: animate-spin present");
      app.chat.pendingGlobal = false; flushSync(); await tick();
    } else failures.push("chat: Ask Pinta FAB not rendered in connected mode");

    console.log(failures.length ? "FAILURES:\n" + failures.join("\n") : "all tabs OK");
    expect(failures).toEqual([]);
  }, 30000);

  it("standalone Test Pilot shows the tester-import EmptyState with its CTA", async () => {
    const { flushSync, tick } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    app.selectedCompanion = null as any;
    flushSync(); await tick();
    await new Promise((r) => setTimeout(r, 50));
    flushSync();
    const tp = [...document.querySelectorAll<HTMLButtonElement>("main nav button")].find((b) => norm(b.textContent) === "Test Pilot");
    if (!tp) {
      // Standalone hides the nav unless a module is ready; Test Pilot is
      // standalone-capable, so its tab should still be reachable.
      console.log("standalone: nav buttons =", [...document.querySelectorAll("main nav button")].map((b) => norm(b.textContent)));
    }
    expect(tp, "Test Pilot tab in standalone").toBeTruthy();
    tp!.click();
    await waitFor(() => [...document.querySelectorAll(".pinta-empty-state")].some((e) => norm(e.textContent).includes("Import tester sheet")));
    const empty = [...document.querySelectorAll(".pinta-empty-state")].find((e) => norm(e.textContent).includes("Walk through a tester sheet"));
    expect(empty, "standalone Test Pilot EmptyState").toBeTruthy();
    expect(norm(empty!.textContent)).toContain("Import tester sheet");
    expect(empty!.querySelector("h2")?.textContent, "standalone title keeps its h2 (F5)").toBe("Walk through a tester sheet");
    expect(empty!.querySelector('[aria-hidden="true"].rounded-full svg'), "stroke icon, not the emoji chip (F11)").toBeTruthy();
    expect(norm(empty!.textContent)).not.toContain("🛫");
    expect(document.querySelector(".animate-spin")).toBeNull();
  }, 30000);
});
