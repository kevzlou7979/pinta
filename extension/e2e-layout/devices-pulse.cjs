#!/usr/bin/env node
// Real-Chromium regression for the processing pulse on the Devices canvas.
//
// Report (2026-10-14): annotating several devices on the canvas, only the
// last device glowed while the agent worked. The side panel sent the pulse
// to the annotating frame only, and every other frame's Pinta overlay is
// hidden — so no other device could ever glow.
//
// Two halves:
//   canvas — mounts the real Devices canvas (`?variant=devices`) and plays
//            the panel / service worker: every device frame must glow.
//   panel  — mounts the real side panel (`?variant=app`) on a canvas tab:
//            it must tell the canvas (chrome.runtime), not a frame.
//
//   node e2e-layout/devices-pulse.cjs            build + run
//   node e2e-layout/devices-pulse.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                  as run.cjs
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
  console.log("[devices-pulse] building →", OUT);
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
      if (p === "/app.html") {
        // Stands in for the user's app inside each device frame.
        resp.writeHead(200, { "content-type": "text/html" });
        return void resp.end("<!doctype html><title>app</title><body style='margin:0;font:16px sans-serif'><h1>The app</h1></body>");
      }
      if (p.endsWith("/")) p += "index.html";
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return void resp.writeHead(404).end();
      resp.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(resp);
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

const CANVAS_TAB = 7;
const EXT_ROOT = "chrome-extension://pinta-e2e-layout/";
const PINK = "#EC4899";

(async () => {
  if (!argv.includes("--no-build")) build();
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve(OUT);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const failures = [];
  const ok = (cond, msg) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) failures.push(msg);
  };
  // Deliver a chrome.runtime message to the page's listeners, as Chrome would.
  const deliver = (page, msg) =>
    page.evaluate((m) => {
      for (const l of window.__runtimeListeners || []) l(m, { id: "pinta-e2e-layout" }, () => {});
    }, msg);
  try {
    // ── canvas half ──────────────────────────────────────────────────────
    {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await context.newPage();
      page.on("pageerror", (e) => failures.push("canvas pageerror: " + e.message.slice(0, 200)));
      await page.addInitScript((tabId) => {
        window.__currentTab = { id: tabId };
      }, CANVAS_TAB);
      await page.goto(`${base}/?variant=devices`);
      await page.waitForFunction(() => window.__harnessVariant === "devices" && !!window.__devices);
      // Three devices showing the app; the iPad Air is the one annotating.
      await page.evaluate((url) => {
        const d = window.__devices;
        d.addFrame("ipad-air");
        d.setUrl(url);
      }, `${base}/app.html`);
      await page.waitForFunction(() => window.__devices.state.frames.length === 3, null, { timeout: 5000 }).catch(() => {});
      await page.evaluate(() => {
        const d = window.__devices;
        const air = d.state.frames.at(-1).id;
        d.annotateFrameId = air;
        d.annotateReadyId = air;
      });
      await page.waitForTimeout(300);
      const sent = await page.evaluate(() => (window.__runtimeSent || []).map((m) => m.msg));
      ok(sent.some((m) => m && m.type === "panel.query"), "on load the canvas asks whether the panel is open");
      ok(sent.some((m) => m && m.type === "devices.canvas-ready" && m.tabId === 7), "and tells the panel it is ready, with its tab id");

      const glows = () => page.getByTestId("device-pulse");
      ok((await glows().count()) === 0, "nothing glows before any work");

      console.log("\n[devices-pulse] canvas: the agent starts working");
      await deliver(page, { type: "panel.state", open: true });
      await deliver(page, { type: "devices.processing", tabId: CANVAS_TAB, on: true, color: PINK });
      await page.waitForTimeout(150);
      const frames = await page.evaluate(() => window.__devices.state.frames.length);
      ok((await glows().count()) === frames && frames === 3, `every device glows, not just the annotating one (${await glows().count()} of ${frames})`);
      const look = await glows().first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { anim: cs.animationName, pe: cs.pointerEvents, pos: cs.position, shadow: cs.boxShadow };
      });
      ok(look.anim === "pinta-device-pulse" && look.pe === "none" && look.pos === "absolute", `it pulses and lets clicks through (${look.anim}, ${look.pe})`);
      ok(/236,\s*72,\s*153/.test(look.shadow), "in the chosen colour");
      // The glow sits over the device screen, sized to it.
      const fit = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="device-pulse"]')].every((g) => {
          const a = g.getBoundingClientRect();
          const b = g.parentElement.getBoundingClientRect();
          return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
        }),
      );
      ok(fit, "each glow covers its device screen exactly");
      await page.screenshot({ path: path.join(SHOTS, "devices-pulse-all.png") });

      console.log("\n[devices-pulse] canvas: messages for another tab");
      await deliver(page, { type: "devices.processing", tabId: 99, on: false });
      await page.waitForTimeout(100);
      ok((await glows().count()) === 3, "a pulse message for another canvas tab is ignored");

      console.log("\n[devices-pulse] canvas: the side panel closes mid-run");
      await deliver(page, { type: "panel.state", open: false });
      await page.waitForTimeout(100);
      ok((await glows().count()) === 0, "the glow goes — a closed panel can never end it");
      await deliver(page, { type: "panel.state", open: true });
      await page.waitForTimeout(100);
      ok((await glows().count()) === 3, "and comes back when the panel reopens");

      console.log("\n[devices-pulse] canvas: a device is added mid-run");
      await page.evaluate(() => window.__devices.addFrame("ipad-mini"));
      await page.waitForTimeout(200);
      ok((await glows().count()) === 4, `the new device glows too (${await glows().count()})`);

      console.log("\n[devices-pulse] canvas: the work ends");
      await deliver(page, { type: "devices.processing", tabId: CANVAS_TAB, on: false });
      await page.waitForTimeout(100);
      ok((await glows().count()) === 0, "no device glows");
      await context.close();
    }

    // ── panel half ───────────────────────────────────────────────────────
    {
      const canvasUrl = `${EXT_ROOT}src/devices/index.html?url=${encodeURIComponent("http://localhost:5173/")}`;
      const context = await browser.newContext({ viewport: { width: 420, height: 760 } });
      const page = await context.newPage();
      page.on("pageerror", (e) => failures.push("panel pageerror: " + e.message.slice(0, 200)));
      await page.addInitScript(
        ({ root, tab }) => {
          window.__extRoot = root;
          window.__tabs = [tab];
        },
        { root: EXT_ROOT, tab: { id: CANVAS_TAB, windowId: 1, active: true, url: canvasUrl } },
      );
      await page.goto(`${base}/?variant=app`);
      await page.waitForFunction(() => window.__harnessVariant === "app" && !!window.__app);
      await page.evaluate((color) => {
        const app = window.__app;
        app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: ["http://localhost:5173/*"] };
        app.connectionStatus = "connected";
        app.client = { send: () => {} };
        app.setPulseColor(color);
        app.setPulseEnabled(true);
        window.__runtimeSent = [];
        window.__tabMessages = [];
      }, PINK);
      const pulseMsgs = () =>
        page.evaluate(() => ({
          runtime: (window.__runtimeSent || []).map((m) => m.msg).filter((m) => m && m.type === "devices.processing"),
          tabs: (window.__tabMessages || []).filter((m) => m.msg && /^processing\./.test(m.msg.type)),
        }));

      console.log("\n[devices-pulse] panel: a batch is sent from the canvas");
      await page.evaluate(() => {
        window.__app.inFlightBatches = [{ id: "b1", url: "http://localhost:5173/", projectRoot: "C:/proj", startedAt: 1, submittedAt: 2, producer: "extension", status: "applying", annotations: [] }];
      });
      await page.waitForTimeout(200);
      let m = await pulseMsgs();
      ok(m.runtime.some((x) => x.tabId === CANVAS_TAB && x.on === true && x.color === PINK), "the canvas is told to glow, with its tab id and colour");
      ok(m.tabs.length === 0, "no frame is sent a page pulse (it would light one device only)");

      console.log("\n[devices-pulse] panel: the canvas reloads mid-run");
      await page.evaluate(() => (window.__runtimeSent = []));
      await deliver(page, { type: "devices.canvas-ready", tabId: CANVAS_TAB });
      await page.waitForTimeout(150);
      m = await pulseMsgs();
      ok(m.runtime.some((x) => x.tabId === CANVAS_TAB && x.on === true), "the fresh canvas is told to glow again");
      await page.evaluate(() => (window.__runtimeSent = []));
      await deliver(page, { type: "devices.canvas-ready", tabId: 42 });
      await page.waitForTimeout(150);
      ok((await pulseMsgs()).runtime.length === 0, "a canvas in another tab is not");

      console.log("\n[devices-pulse] panel: the user switches to a normal tab");
      await page.evaluate(() => {
        window.__runtimeSent = [];
        window.__tabs = [{ id: 9, windowId: 1, active: true, url: "http://localhost:5173/other" }];
        for (const l of window.__tabActivatedListeners || []) l({ tabId: 9, windowId: 1 });
      });
      await page.waitForTimeout(400);
      m = await pulseMsgs();
      ok(m.runtime.some((x) => x.tabId === CANVAS_TAB && x.on === false), "the canvas left behind stops glowing");
      ok(m.tabs.some((x) => x.tabId === 9 && x.msg.type === "processing.start"), "the normal tab gets the page glow");

      console.log("\n[devices-pulse] panel: the work ends");
      await page.evaluate(() => {
        window.__app.inFlightBatches = [];
        window.__tabMessages = [];
      });
      await page.waitForTimeout(200);
      ok((await pulseMsgs()).tabs.some((x) => x.tabId === 9 && x.msg.type === "processing.end"), "the pulse ends");
      await context.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[devices-pulse] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[devices-pulse] crashed:", e);
  process.exit(2);
});
