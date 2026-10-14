#!/usr/bin/env node
// Real-Chromium regression for the page-edge processing pulse.
//
// Report (2026-10-14): with the pulse switched on in Settings, the page
// never glowed — not while annotating, auditing, generating a report or
// generating variants. The side panel only watched the live draft's
// status; a sent batch detaches into the Submitted tray at once, and
// module runs never touch the draft, so nothing ever told the page to
// pulse.
//
// This mounts the whole side panel (`?variant=app`) on a stub tab and reads
// the messages it sends to the page: `processing.start` (with the chosen
// colour) while anything waits on the agent, `processing.end` when the last
// wait clears.
//
//   node e2e-layout/processing-pulse.cjs            build + run
//   node e2e-layout/processing-pulse.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                     as run.cjs
"use strict";

const { execSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EXT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : d;
};
const OUT = opt("--out", process.env.E2E_LAYOUT_OUT || path.join(os.tmpdir(), "pinta-e2e-layout-dist"));
const SHOTS = opt("--shots", path.join(path.dirname(OUT), "e2e-layout-shots"));

function loadFrom(candidates, what) {
  for (const c of candidates) {
    try {
      return require(c);
    } catch {}
  }
  throw new Error(`${what} not found (tried ${candidates.join(", ")})`);
}
const { chromium } = loadFrom(["C:/rnd/puwersa/node_modules/playwright", "playwright", "@playwright/test"], "Playwright");

function build() {
  console.log("[processing-pulse] building →", OUT);
  execSync("npx vite build --config e2e-layout/vite.config.ts --logLevel error", {
    cwd: EXT,
    stdio: "inherit",
    env: { ...process.env, E2E_LAYOUT_OUT: OUT },
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
function serve(root) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return void resp.writeHead(404).end();
      resp.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(resp);
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

const TAB = { id: 7, windowId: 1, active: true, url: "http://localhost:5173/components/wizard" };
const OTHER_TAB = { id: 9, windowId: 1, active: true, url: "http://localhost:5173/other" };
const PINK = "#EC4899";
const session = (id, status) => ({ id, url: TAB.url, projectRoot: "C:/proj", startedAt: 1, submittedAt: 2, producer: "extension", status, annotations: [] });

(async () => {
  if (!argv.includes("--no-build")) build();
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve(OUT);
  const browser = await chromium.launch();
  const failures = [];
  const ok = (cond, msg) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) failures.push(msg);
  };
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 760 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    // The panel adopts its tab from chrome.tabs.query on mount.
    await page.addInitScript((tab) => {
      window.__tabs = [tab];
    }, TAB);
    await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=app`);
    await page.waitForFunction(() => window.__harnessVariant === "app" && !!window.__app);

    // Connected, an idle draft, the pulse switched on in pink.
    await page.evaluate(
      ({ draft, color }) => {
        const app = window.__app;
        // The pattern must match the tab, or the panel shows its "no URL
        // patterns" prompt in place of the send footer.
        app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: ["http://localhost:5173/*"] };
        app.connectionStatus = "connected";
        app.client = { send: () => {} };
        app.session = draft;
        app.setPulseColor(color);
        app.setPulseEnabled(true);
      },
      { draft: session("draft-1", "drafting"), color: PINK },
    );
    // Pulse messages the panel sent to a tab since the last call.
    let seen = 0;
    const pulses = async () => {
      await page.waitForTimeout(150);
      const all = await page.evaluate(() => (window.__tabMessages || []).filter((m) => m.msg && (m.msg.type === "processing.start" || m.msg.type === "processing.end")));
      const fresh = all.slice(seen);
      seen = all.length;
      return fresh;
    };
    const last = (list) => list.at(-1) ?? null;
    const isStart = (m, tabId = TAB.id) => !!m && m.tabId === tabId && m.msg.type === "processing.start" && m.msg.color === PINK;
    const isEnd = (m, tabId = TAB.id) => !!m && m.tabId === tabId && m.msg.type === "processing.end";
    const set = (fn, arg) => page.evaluate(fn, arg);

    console.log("\n[processing-pulse] idle");
    ok((await pulses()).length === 0, "the page is sent nothing while nothing is in flight");

    console.log("\n[processing-pulse] annotating: a sent batch sits in the tray, the draft is idle");
    await set((b) => (window.__app.inFlightBatches = [b]), session("batch-1", "submitted"));
    ok(isStart(last(await pulses())), "the page is told to pulse, in the chosen colour");
    await set((b) => (window.__app.inFlightBatches = [b]), session("batch-1", "applying"));
    ok((await pulses()).length === 0, "still pulsing while the agent applies — no repeat message");
    await set((b) => (window.__app.inFlightBatches = [b]), session("batch-1", "done"));
    ok(isEnd(last(await pulses())), "the pulse ends when the batch is done");

    console.log("\n[processing-pulse] module runs");
    const runs = [
      ["an AuditFlow run", (on) => (window.__app.audit.pending = on ? { runId: "r", startedAt: 1 } : null)],
      ["a Report run", (on) => (window.__app.report.pending = on ? { runId: "r", startedAt: 1 } : null)],
      ["a Design Variants generate", (on) => (window.__app.variants.pending = on ? { runId: "r", startedAt: 1, op: "variants-generate", sessionId: null } : null)],
      ["a Test Pilot doc op", (on) => (window.__app.testPilot.pending = on ? { kind: "doc-generate", startedAt: 1 } : null)],
      ["a Code Review gather", (on) => (window.__app.review.pending = on ? { runId: "r", startedAt: 1 } : null)],
      ["a global chat question", (on) => (window.__app.chat.pendingGlobal = on)],
    ];
    for (const [name, toggle] of runs) {
      await set(toggle, true);
      const started = isStart(last(await pulses()));
      await set(toggle, false);
      const ended = isEnd(last(await pulses()));
      ok(started && ended, `${name} pulses, then stops`);
    }

    console.log("\n[processing-pulse] two waits overlap");
    await set(() => {
      window.__app.audit.pending = { runId: "r", startedAt: 1 };
      window.__app.report.pending = { runId: "r", startedAt: 1 };
    });
    ok(isStart(last(await pulses())), "pulses once for both");
    await set(() => (window.__app.audit.pending = null));
    ok((await pulses()).length === 0, "keeps pulsing while the second run is still going");

    console.log("\n[processing-pulse] the page reloads mid-run");
    await set((tab) => {
      for (const l of window.__runtimeListeners || []) l({ type: "overlay.ready", url: tab.url }, { id: "pinta-e2e-layout", tab: { id: tab.id }, frameId: 0, url: tab.url }, () => {});
    }, TAB);
    ok(isStart(last(await pulses())), "the fresh page is told to pulse again");

    console.log("\n[processing-pulse] the pulse setting");
    await set(() => window.__app.setPulseEnabled(false));
    ok(isEnd(last(await pulses())), "switching the pulse off stops it mid-run");
    await set(() => window.__app.setPulseEnabled(true));
    ok(isStart(last(await pulses())), "switching it back on resumes it");

    console.log("\n[processing-pulse] sending another batch with a screenshot, mid-run");
    await set((a) => {
      window.__app.session = { ...window.__app.session, annotations: [a] };
      window.__app.submitOptions.includeScreenshot = true;
      window.__runtimeSent = [];
    }, { id: "ann-1", createdAt: 1, kind: "select", color: "#ec4899", comment: "tighten this", url: "", target: { selector: "#hero", outerHTML: "<div></div>", computedStyles: {}, nearbyText: [], boundingRect: { x: 0, y: 0, width: 10, height: 10 } } });
    await pulses();
    await page.getByRole("button", { name: "Send to agent", exact: true }).click();
    await page.waitForFunction(() => (window.__runtimeSent || []).some((m) => m.msg && m.msg.type === "capture.full-page"), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const around = await pulses();
    const capture = await page.evaluate(() => (window.__runtimeSent || []).find((m) => m.msg && m.msg.type === "capture.full-page")?.seq ?? null);
    const endBefore = around.find((m) => isEnd(m));
    ok(capture != null, "the screenshot was requested");
    ok(!!endBefore && capture != null && endBefore.seq < capture, "the glow is taken off the page before the screenshot");
    ok(isStart(last(around)) && capture != null && last(around).seq > capture, "and comes back once the screenshot is over");
    // The stub has no screenshot to give, so the send stops there and the
    // draft is still a draft.
    ok(await page.evaluate(() => window.__app.session.status === "drafting"), "the draft was not sent without its screenshot");
    await set(() => {
      window.__app.session = { ...window.__app.session, annotations: [] };
      window.__app.submitOptions.includeScreenshot = false;
      window.__app.lastError = null;
    });

    console.log("\n[processing-pulse] the companion goes away mid-run");
    const companion = await page.evaluate(() => {
      const c = window.__app.selectedCompanion;
      window.__app.selectedCompanion = null;
      return c;
    });
    ok(isEnd(last(await pulses())), "the pulse ends — nothing can be progressing");
    await set((c) => (window.__app.selectedCompanion = c), companion);
    ok(isStart(last(await pulses())), "and resumes when it is back");

    console.log("\n[processing-pulse] the user switches tabs mid-run");
    await set((tab) => {
      window.__tabs = [tab];
      for (const l of window.__tabActivatedListeners || []) l({ tabId: tab.id, windowId: tab.windowId });
    }, OTHER_TAB);
    await page.waitForTimeout(400);
    const moved = await pulses();
    ok(moved.some((m) => isEnd(m, TAB.id)), "the tab left behind stops pulsing");
    ok(isStart(last(moved), OTHER_TAB.id), "the tab the panel is on now pulses");

    console.log("\n[processing-pulse] the last run finishes");
    await set(() => (window.__app.report.pending = null));
    ok(isEnd(last(await pulses()), OTHER_TAB.id), "the pulse ends");

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[processing-pulse] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[processing-pulse] crashed:", e);
  process.exit(2);
});
