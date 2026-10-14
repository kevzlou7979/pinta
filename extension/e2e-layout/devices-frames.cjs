#!/usr/bin/env node
// Real-Chromium regression for annotating across several devices on the
// Devices canvas (QA audit 2026-10-14). Annotate moves between device frames;
// the panel used to know only the CURRENT frame, so:
//   - deleting / submitting / redoing left previews and pins in the device
//     you'd switched away from, or applied them in the wrong one;
//   - a Mobile annotation's pin was replayed into the iPad frame, and the
//     canvas keep-alive ping replayed every pin every 2s;
//   - a removed device left the panel "connected" to a dead frame;
//   - the screenshot painted every device's marks on one device, and could
//     take the canvas toolbar into the crop;
//   - "other pages", Reload and HMR detection acted on the canvas TAB
//     (replacing / reloading it); manual tasks got the panel's own width.
//
// Three halves:
//   panel   — the real side panel (`?variant=app`) on a canvas tab, playing
//             two device frames (Mobile = frameId 3, iPad = frameId 5).
//   canvas  — the real Devices canvas (`?variant=devices`).
//   overlay — the real content overlay running inside an iframe
//             (`?variant=overlay`), activated the way the canvas does it.
//
//   node e2e-layout/devices-frames.cjs            build + run
//   node e2e-layout/devices-frames.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                   as run.cjs
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
  console.log("[devices-frames] building →", OUT);
  execSync("npx vite build --config e2e-layout/vite.config.ts --logLevel error", {
    cwd: EXT,
    stdio: "inherit",
    env: { ...process.env, E2E_LAYOUT_OUT: OUT },
  });
}

const SLOW_MS = 3500;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
function serve(root) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const page = (html) => {
        resp.writeHead(200, { "content-type": "text/html" });
        resp.end(html);
      };
      // Stands in for the user's app inside each device frame.
      if (p === "/app.html") return void page("<!doctype html><title>app</title><body style='margin:0'><h1>The app</h1></body>");
      // A cold dev server: the page takes SLOW_MS to arrive.
      if (p === "/slow.html") return void setTimeout(() => page("<!doctype html><title>slow</title><h1>Slow app</h1>"), SLOW_MS);
      // One device frame running the real overlay.
      if (p === "/frame-host.html") {
        return void page("<!doctype html><body style='margin:0'><iframe id='f' src='/?variant=overlay' style='width:402px;height:700px;border:0'></iframe></body>");
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
const APP_URL = "http://localhost:5173/";
const MOBILE = 3;
const IPAD = 5;

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
  // Deliver a chrome.runtime message to a page's listeners, as Chrome would.
  const deliver = (target, msg, sender = { id: "pinta-e2e-layout" }) =>
    target.evaluate(
      ({ m, s }) => {
        let reply;
        for (const l of window.__runtimeListeners || []) l(m, s, (r) => (reply = r));
        return reply;
      },
      { m: msg, s: sender },
    );
  const fromFrame = (frameId) => ({ id: "pinta-e2e-layout", tab: { id: CANVAS_TAB }, frameId, url: APP_URL });
  const sel = (id, width, extra = {}) => ({
    id,
    createdAt: 1,
    kind: "select",
    strokes: [],
    color: "#FF3D6E",
    comment: id,
    url: APP_URL,
    viewport: { scrollY: 0, width, height: 800 },
    target: { selector: `#${id}`, outerHTML: "<div></div>", computedStyles: {}, nearbyText: [], boundingRect: { x: 10, y: 10, width: 80, height: 30 } },
    targets: [{ selector: `#${id}`, outerHTML: "<div></div>", computedStyles: {}, nearbyText: [], boundingRect: { x: 10, y: 10, width: 80, height: 30 } }],
    ...extra,
  });

  try {
    // ── panel half ───────────────────────────────────────────────────────
    {
      const canvasUrl = `${EXT_ROOT}src/devices/index.html?url=${encodeURIComponent(APP_URL)}`;
      const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
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
      await page.evaluate((url) => {
        const app = window.__app;
        app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: ["http://localhost:5173/*"] };
        app.connectionStatus = "connected";
        app.session = { id: "draft-1", url, projectRoot: "C:/proj", startedAt: 3, producer: "extension", status: "drafting", annotations: [] };
        app.client = {
          send: (m) => {
            if (m.type === "annotation.add") app.session = { ...app.session, annotations: [...app.session.annotations, m.annotation] };
            if (m.type === "annotation.remove") app.session = { ...app.session, annotations: app.session.annotations.filter((a) => a.id !== m.id) };
          },
        };
      }, APP_URL);
      const msgs = (type) =>
        page.evaluate((t) => (window.__tabMessages || []).filter((m) => m.msg && m.msg.type === t), type);
      const runtime = (type) =>
        page.evaluate((t) => (window.__runtimeSent || []).map((m) => m.msg).filter((m) => m && m.type === t), type);
      const reset = () => page.evaluate(() => { window.__tabMessages = []; window.__runtimeSent = []; window.__tabActions = []; });
      const connected = () => page.getByText("Device frame connected").isVisible();
      const ready = (frameId, width, extra = {}) =>
        deliver(page, { type: "overlay.ready", url: APP_URL, previewActive: false, width, ...extra }, fromFrame(frameId));

      console.log("\n[devices-frames] panel: annotate in Mobile, then switch Annotate to the iPad");
      await ready(MOBILE, 402);
      await page.waitForTimeout(150);
      ok(await connected(), "the Mobile frame is connected");
      await deliver(
        page,
        {
          type: "annotation.target-selected",
          annotationId: "ann-m",
          targets: sel("ann-m", 402).targets,
          comment: "make it pink",
          cssChanges: { color: "pink" },
          viewport: { scrollY: 0, width: 402, height: 874 },
          url: APP_URL,
        },
        fromFrame(MOBILE),
      );
      await page.waitForTimeout(150);
      const made = await page.evaluate(() => window.__app.session.annotations.find((a) => a.id === "ann-m"));
      ok(!!made && made.viewport && made.viewport.width === 402, "the annotation keeps the Mobile frame's width");
      await deliver(page, { type: "frame.inactive" }, fromFrame(MOBILE));
      await ready(IPAD, 820);
      await page.waitForTimeout(150);
      ok(await connected(), "the iPad frame is connected");

      console.log("\n[devices-frames] panel: delete the card (finding 1)");
      await reset();
      await page.getByRole("button", { name: "Remove annotation" }).first().click();
      await page.waitForTimeout(150);
      const removes = (await msgs("annotated.remove")).filter((m) => m.msg.annotationId === "ann-m").map((m) => m.frameId).sort();
      ok(removes.includes(MOBILE) && removes.includes(IPAD), `remove reaches every device frame, not just the iPad (${removes.join(",")})`);
      ok(removes.includes(undefined), "and goes tab-wide too, for frames this panel never heard from");

      console.log("\n[devices-frames] panel: undo, then redo (finding 1)");
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(150);
      await reset();
      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(200);
      const reapplies = (await msgs("annotated.reapply")).map((m) => m.frameId);
      ok(reapplies.length === 1 && reapplies[0] === MOBILE, `redo re-applies the preview in Mobile only, never the iPad (${reapplies.join(",") || "none"})`);

      console.log("\n[devices-frames] panel: pins replay per device (findings 3, 4)");
      // Reset BEFORE the session changes: adding annotations replays pins
      // too (the session / count effect), and that replay must also keep
      // to the iPad's own width.
      await reset();
      await page.evaluate((anns) => {
        window.__app.session = { ...window.__app.session, annotations: [...window.__app.session.annotations, ...anns] };
      }, [sel("ann-pad", 820), sel("ann-mob2", 402)]);
      await page.waitForTimeout(150);
      let replays = (await msgs("annotated.replay")).map((m) => `${m.frameId}:${m.msg.annotation.id}`);
      ok(replays.length > 0 && replays.every((r) => r === `${IPAD}:ann-pad`), `adding annotations replays only the iPad pin into the iPad (${replays.join(",") || "none"})`);
      await reset();
      await ready(IPAD, 820);
      await page.waitForTimeout(150);
      replays = (await msgs("annotated.replay")).map((m) => `${m.frameId}:${m.msg.annotation.id}`);
      ok(replays.length === 1 && replays[0] === `${IPAD}:ann-pad`, `the iPad frame gets only the iPad pin (${replays.join(",")})`);
      await reset();
      for (let i = 0; i < 3; i++) await ready(IPAD, 820, { ping: true });
      await page.waitForTimeout(150);
      ok((await msgs("annotated.replay")).length === 0, "the canvas keep-alive ping replays nothing");
      ok((await runtime("devices.processing")).length === 0, "and re-sends no pulse");
      await ready(IPAD, 820);
      await page.waitForTimeout(150);
      ok((await msgs("annotated.replay")).length === 1, "a real reload of the frame still replays its pin");
      await reset();
      await ready(MOBILE, 402, { ping: true });
      await page.waitForTimeout(150);
      replays = (await msgs("annotated.replay")).map((m) => `${m.frameId}:${m.msg.annotation.id}`).sort();
      ok(replays.join(",") === `${MOBILE}:ann-m,${MOBILE}:ann-mob2`, `a ping from a frame the panel hadn't adopted yet replays that device's pins (${replays.join(",")})`);

      console.log("\n[devices-frames] panel: an imported session follows Annotate (finding 6)");
      await ready(IPAD, 820);
      await reset();
      await page.evaluate(() => {
        const app = window.__app;
        app.importedSessions = [
          {
            id: "imp-1",
            importedAt: 1,
            manifest: { title: "Shared review", author: "QA", accentColor: "#14b8a6", exportedAt: 1 },
            session: { id: "s-imp", url: "http://localhost:5173/", projectRoot: "C:/proj", startedAt: 1, producer: "extension", status: "done", annotations: [] },
          },
        ];
        app.viewingImportedId = "imp-1";
      });
      await page.waitForTimeout(200);
      ok((await msgs("imported.show")).some((m) => m.frameId === IPAD), "the overlay is shown in the iPad frame");
      await reset();
      await ready(MOBILE, 402);
      await page.waitForTimeout(150);
      ok((await msgs("imported.show")).some((m) => m.frameId === MOBILE), "switching Annotate to Mobile re-sends it there");
      await page.evaluate(() => (window.__app.viewingImportedId = null));
      await page.waitForTimeout(150);

      console.log("\n[devices-frames] panel: \"on other pages\" (finding 8)");
      await page.evaluate((a) => {
        window.__app.session = { ...window.__app.session, annotations: [...window.__app.session.annotations, a] };
      }, sel("ann-cart", 402, { url: "http://localhost:5173/cart" }));
      await reset();
      await page.getByRole("button", { name: /on 1 other page/ }).click();
      await page.getByRole("button", { name: "Open http://localhost:5173/cart" }).click();
      await page.waitForTimeout(150);
      const opens = await runtime("devices.open-url");
      ok(opens.some((m) => m.tabId === CANVAS_TAB && m.url === "http://localhost:5173/cart"), "the canvas is asked to show the page");
      ok((await page.evaluate(() => window.__tabActions || [])).length === 0, "the canvas tab itself is never navigated");
      // Every device reloads to the page under a new frame id, so the panel
      // must stop claiming the old one (else the next tool click fails once).
      ok(!(await connected()), "the panel waits for the reloaded device instead of using its old frame");

      console.log("\n[devices-frames] panel: a manual task gets the device's width (finding 10)");
      await page.evaluate((url) => {
        window.__tabReply = (tabId, msg) =>
          msg.type === "frame.viewport" ? { scrollY: 0, width: 402, height: 874, url } : {};
      }, APP_URL);
      await page.getByText("Add a task (no element needed)").click();
      const box = page.getByPlaceholder(/Describe a task/);
      await box.fill("Check the header");
      await page.getByRole("button", { name: "Add task" }).click();
      await page.waitForTimeout(200);
      let note = await page.evaluate(() => window.__app.session.annotations.filter((a) => a.kind === "note").at(-1));
      ok(!!note && note.viewport && note.viewport.width === 402, `the task is tagged with the device width, not the panel's (${note && note.viewport && note.viewport.width})`);
      await page.evaluate(() => (window.__tabReply = undefined));
      await box.fill("Another task");
      await page.getByRole("button", { name: "Add task" }).click();
      await page.waitForTimeout(200);
      note = await page.evaluate(() => window.__app.session.annotations.filter((a) => a.kind === "note").at(-1));
      ok(!!note && note.comment === "Another task" && note.viewport === undefined, "no answer from the page = no viewport (never the panel's 420px)");

      console.log("\n[devices-frames] panel: leave the canvas and come back (round 3: frames kept per tab)");
      const switchTo = async (tab) => {
        await page.evaluate((t) => {
          window.__tabs = [t];
          for (const l of window.__tabActivatedListeners || []) l({ tabId: t.id, windowId: 1 });
        }, tab);
        await page.waitForTimeout(400);
      };
      const canvasTab = { id: CANVAS_TAB, windowId: 1, active: true, url: `${EXT_ROOT}src/devices/index.html?url=${encodeURIComponent(APP_URL)}` };
      // A Free Transform made in Mobile: two ops merged into one card.
      await ready(MOBILE, 402);
      await deliver(page, { type: "transform.state", on: true }, fromFrame(MOBILE));
      for (const id of ["ann-t1", "ann-t2"]) {
        await deliver(page, { type: "annotation.target-selected", annotationId: id, targets: sel(id, 402).targets, comment: id, cssChanges: { color: "red" }, viewport: { scrollY: 0, width: 402, height: 874 }, url: APP_URL }, fromFrame(MOBILE));
      }
      await page.waitForTimeout(150);
      await deliver(page, { type: "transform.state", on: false }, fromFrame(MOBILE));
      await page.waitForTimeout(300);
      const mergedId = await page.evaluate(() => (window.__app.session.annotations.find((a) => /^Free transform/.test(a.comment)) || {}).id);
      ok(!!mergedId, "the two ops merged into one card");
      await deliver(page, { type: "frame.inactive" }, fromFrame(MOBILE));
      await ready(IPAD, 820);
      await switchTo({ id: 9, windowId: 1, active: true, url: "http://localhost:5173/other" });
      await switchTo(canvasTab);
      await ready(IPAD, 820, { ping: true });
      await page.waitForTimeout(150);
      await reset();
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(200);
      const gone = (await msgs("annotated.remove")).filter((m) => m.msg.annotationId === mergedId).map((m) => m.frameId);
      ok(gone.includes(MOBILE), `after leaving and coming back, undo still reaches Mobile (${gone.join(",")})`);
      await reset();
      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(200);
      let again = (await msgs("annotated.reapply")).filter((m) => m.msg.annotation.id === mergedId).map((m) => m.frameId);
      ok(again.length === 1 && again[0] === MOBILE, `and redo re-applies the merged transform in Mobile (${again.join(",") || "none"})`);

      console.log("\n[devices-frames] panel: redo after the source frame navigated (round 3)");
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(150);
      await deliver(page, { type: "frame.inactive" }, fromFrame(IPAD));
      await ready(MOBILE, 402, { url: "http://localhost:5173/cart" });
      await deliver(page, { type: "frame.inactive" }, fromFrame(MOBILE));
      await ready(IPAD, 820);
      await reset();
      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(200);
      again = (await msgs("annotated.reapply")).filter((m) => m.msg.annotation.id === mergedId);
      ok(again.length === 0, "Mobile now shows another page and the iPad is another device: nothing is re-applied");

      console.log("\n[devices-frames] panel: redo with no record of the frame (round 3)");
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(150);
      // The canvas reloaded: every record is gone; Mobile re-announces.
      await deliver(page, { type: "devices.canvas-ready", tabId: CANVAS_TAB });
      await ready(MOBILE, 402);
      await reset();
      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(200);
      again = (await msgs("annotated.reapply")).filter((m) => m.msg.annotation.id === mergedId).map((m) => m.frameId);
      ok(again.length === 1 && again[0] === MOBILE, `it goes to the annotating frame when that is the same device and page (${again.join(",") || "none"})`);
      await deliver(page, { type: "frame.inactive" }, fromFrame(MOBILE));
      await ready(IPAD, 820);
      // Leave the canvas knowing both frames again, as before this section.
      await ready(MOBILE, 402);
      await deliver(page, { type: "frame.inactive" }, fromFrame(MOBILE));
      await ready(IPAD, 820);

      console.log("\n[devices-frames] panel: Send to agent from the canvas (findings 1, 7)");
      await page.evaluate((url) => {
        const c = document.createElement("canvas");
        c.width = 402;
        c.height = 874;
        const shot = c.toDataURL("image/jpeg");
        window.__app.submitOptions.includeScreenshot = true;
        window.__tabReply = (tabId, msg) =>
          msg.type === "frame.viewport" ? { scrollY: 0, width: 402, height: 874, url } : {};
        window.__runtimeReply = (msg) =>
          msg.type === "capture.device-frame" ? { ok: true, capture: { dataUrl: shot, width: 402, height: 874, clipped: true } } : {};
      }, APP_URL);
      await reset();
      await page.getByRole("button", { name: "Send to agent" }).click();
      await page.getByTestId("device-shot-notice").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      ok(await page.getByTestId("device-shot-notice").isVisible(), "a cut-off device shot says so");
      await page
        .waitForFunction(() => (window.__tabMessages || []).some((m) => m.msg && m.msg.type === "annotated.clear"), null, { timeout: 5000 })
        .catch(() => {});
      const lastError = await page.evaluate(() => window.__app.lastError);
      if (lastError) console.log("  (lastError:", lastError, ")");
      const clears = (await msgs("annotated.clear")).map((m) => m.frameId).sort();
      ok(clears.includes(MOBILE) && clears.includes(IPAD), `after Send every device frame is cleared (${clears.join(",")})`);
      await page.screenshot({ path: path.join(SHOTS, "devices-frames-notice.png") });
      await page.evaluate(() => { window.__runtimeReply = undefined; });

      console.log("\n[devices-frames] panel: a finished batch (finding 9)");
      await ready(IPAD, 820);
      await page.waitForTimeout(100);
      await reset();
      await page.evaluate(() => {
        window.__tabReply = (tabId, msg) => (msg.type === "frame.hmr" ? { hmr: false } : {});
        window.__app.setAutoReload(true);
        window.__app.session = { ...window.__app.session, id: "done-1", status: "done", annotations: [] };
      });
      await page.waitForTimeout(300);
      ok((await msgs("frame.hmr")).length > 0, "HMR is asked of the device frame");
      ok((await runtime("devices.refresh-all")).some((m) => m.tabId === CANVAS_TAB), "no HMR: the canvas is asked to reload its devices");
      ok(!(await page.evaluate(() => window.__tabActions || [])).some((a) => a.op === "reload"), "the canvas tab is never reloaded");
      ok(!(await connected()), "the reloaded frames' old ids are dropped (the next tool click waits for the new one)");
      await reset();
      await page.evaluate(() => {
        window.__tabReply = (tabId, msg) => (msg.type === "frame.hmr" ? { hmr: true } : {});
        window.__app.session = { ...window.__app.session, id: "done-2", status: "done" };
      });
      await page.waitForTimeout(300);
      ok((await runtime("devices.refresh-all")).length === 0, "with HMR nothing is reloaded");
      await reset();
      await page.evaluate(() => {
        window.__tabReply = undefined; // no device answers
        window.__app.session = { ...window.__app.session, id: "done-3", status: "done" };
      });
      await page.waitForTimeout(300);
      ok((await runtime("devices.refresh-all")).length === 0, "no device answering = unknown: no reload on a guess");
      await page.evaluate(() => {
        window.__tabReply = undefined;
        window.__app.setAutoReload(false);
        window.__app.session = { ...window.__app.session, id: "draft-2", status: "drafting", annotations: [] };
      });

      console.log("\n[devices-frames] panel: the annotating device goes away (finding 5)");
      await ready(IPAD, 820);
      await page.waitForTimeout(100);
      await deliver(page, { type: "devices.annotate-frame", tabId: CANVAS_TAB, annotating: false });
      await page.waitForTimeout(100);
      ok(!(await connected()), "the canvas saying nothing annotates ends \"connected\"");
      await ready(IPAD, 820);
      await page.waitForTimeout(100);
      await deliver(page, { type: "devices.annotate-frame", tabId: 42, annotating: false });
      await page.waitForTimeout(100);
      ok(await connected(), "another canvas tab's message is ignored");
      // The frame was reloaded / removed: Chrome rejects frame-targeted sends.
      await page.evaluate((dead) => {
        window.__tabReply = (tabId, msg, frameId) => {
          if (frameId === dead) throw new Error("Could not establish connection. Receiving end does not exist.");
          return {};
        };
      }, IPAD);
      // Any send to the frame will do — adding a task asks it for its viewport.
      await page.getByPlaceholder(/Describe a task/).fill("Probe the frame");
      await page.getByRole("button", { name: "Add task" }).click();
      await page.waitForTimeout(200);
      ok(!(await connected()), "a send that finds the frame gone ends \"connected\"");
      await page.evaluate(() => (window.__tabReply = undefined));
      await ready(IPAD, 820);
      await page.waitForTimeout(100);
      ok(await connected(), "the next announcement reconnects");
      await deliver(page, { type: "devices.canvas-ready", tabId: CANVAS_TAB });
      await page.waitForTimeout(100);
      ok(!(await connected()), "a reloaded canvas drops every old frame");
      await context.close();
    }

    // ── normal tab (round 3) ─────────────────────────────────────────────
    // The canvas fixes must leave an ordinary tab exactly as it was.
    {
      const NORMAL_TAB = 9;
      const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
      const page = await context.newPage();
      page.on("pageerror", (e) => failures.push("normal-tab pageerror: " + e.message.slice(0, 200)));
      await page.addInitScript((tab) => {
        window.__tabs = [tab];
      }, { id: NORMAL_TAB, windowId: 1, active: true, url: APP_URL });
      await page.goto(`${base}/?variant=app`);
      await page.waitForFunction(() => window.__harnessVariant === "app" && !!window.__app);
      await page.evaluate(({ url, anns }) => {
        const app = window.__app;
        app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: ["http://localhost:5173/*"] };
        app.connectionStatus = "connected";
        app.session = { id: "draft-n", url, projectRoot: "C:/proj", startedAt: 3, producer: "extension", status: "drafting", annotations: anns };
        app.client = {
          send: (m) => {
            if (m.type === "annotation.add") app.session = { ...app.session, annotations: [...app.session.annotations, m.annotation] };
            if (m.type === "annotation.remove") app.session = { ...app.session, annotations: app.session.annotations.filter((a) => a.id !== m.id) };
          },
        };
      }, { url: APP_URL, anns: [sel("ann-a", 1280), sel("ann-b", 1280), sel("ann-c", 1280, { url: "http://localhost:5173/cart" })] });
      await page.waitForTimeout(300);
      const msgs = (type) =>
        page.evaluate((t) => (window.__tabMessages || []).filter((m) => m.msg && m.msg.type === t), type);
      const reset = () => page.evaluate(() => { window.__tabMessages = []; window.__runtimeSent = []; window.__tabActions = []; });

      console.log("\n[devices-frames] normal tab: remove and Clear all");
      await reset();
      await page.getByRole("button", { name: "Remove annotation" }).first().click();
      await page.waitForTimeout(150);
      let sent = await msgs("annotated.remove");
      ok(sent.length === 1 && sent[0].tabId === NORMAL_TAB && sent[0].frameId === undefined, `remove is one tab-wide message (${sent.length})`);
      await reset();
      await page.getByRole("button", { name: "Clear all annotations" }).click();
      await page.waitForTimeout(200);
      sent = await msgs("annotated.clear");
      // Clear all also restarts the session, whose id flip clears once more
      // (as it always has) — every clear is still a plain tab-wide send.
      ok(sent.length >= 1 && sent.every((m) => m.tabId === NORMAL_TAB && m.frameId === undefined), `Clear all goes tab-wide only (${sent.length})`);
      await page.evaluate((url) => {
        window.__app.session = { id: "draft-n2", url, projectRoot: "C:/proj", startedAt: 4, producer: "extension", status: "drafting", annotations: [] };
      }, APP_URL);

      console.log("\n[devices-frames] normal tab: \"Open\" another page");
      await page.evaluate((a) => {
        window.__app.session = { ...window.__app.session, annotations: [...window.__app.session.annotations, ...a] };
      }, [sel("ann-d", 1280), sel("ann-e", 1280, { url: "http://localhost:5173/cart" })]);
      await reset();
      await page.getByRole("button", { name: /on 1 other page/ }).click();
      await page.getByRole("button", { name: "Open http://localhost:5173/cart" }).click();
      await page.waitForTimeout(150);
      const acts = await page.evaluate(() => window.__tabActions || []);
      ok(acts.some((a) => a.op === "update" && a.tabId === NORMAL_TAB && a.props.url === "http://localhost:5173/cart"), "the tab navigates (tabs.update)");
      ok(!(await page.evaluate(() => (window.__runtimeSent || []).some((m) => m.msg && m.msg.type === "devices.open-url"))), "no canvas message");

      console.log("\n[devices-frames] normal tab: a manual task");
      await page.evaluate((url) => {
        window.__tabReply = (tabId, msg) => (msg.type === "frame.viewport" ? { scrollY: 0, width: 1280, height: 800, url } : {});
      }, APP_URL);
      await page.getByText("Add a task (no element needed)").click();
      await page.getByPlaceholder(/Describe a task/).fill("Tidy the footer");
      await page.getByRole("button", { name: "Add task" }).click();
      await page.waitForTimeout(200);
      const note = await page.evaluate(() => window.__app.session.annotations.filter((a) => a.kind === "note").at(-1));
      ok(!!note && note.viewport && note.viewport.width === 1280, `the task takes the page's width (${note && note.viewport && note.viewport.width})`);

      console.log("\n[devices-frames] normal tab: a finished batch without HMR");
      await reset();
      await page.evaluate(() => {
        window.__tabReply = undefined;
        window.__app.setAutoReload(true);
        window.__app.session = { ...window.__app.session, id: "done-n", status: "done", annotations: [] };
      });
      await page.waitForTimeout(400);
      const acts2 = await page.evaluate(() => window.__tabActions || []);
      ok(acts2.some((a) => a.op === "reload" && a.tabId === NORMAL_TAB), "the tab reloads (tabs.reload)");
      ok(!(await page.evaluate(() => (window.__runtimeSent || []).some((m) => m.msg && m.msg.type === "devices.refresh-all"))), "no canvas message");
      await context.close();
    }

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
      await page.evaluate((url) => {
        const d = window.__devices;
        d.addFrame("ipad-air");
        d.setUrl(url);
      }, `${base}/app.html`);
      await page.waitForFunction(() => window.__devices.state.frames.length >= 2 && window.__devices.tabId === 7, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      const sentOf = (type) =>
        page.evaluate((t) => (window.__runtimeSent || []).map((m) => m.msg).filter((m) => m && m.type === t), type);

      console.log("\n[devices-frames] canvas: removing the annotating device (finding 5)");
      await page.evaluate(() => {
        const d = window.__devices;
        window.__runtimeSent = [];
        d.setAnnotateFrame(d.state.frames.at(-1).id);
        d.removeFrame(d.state.frames.at(-1).id);
      });
      let told = await sentOf("devices.annotate-frame");
      ok(told.some((m) => m.tabId === CANVAS_TAB && m.annotating === false), "the panel is told nothing annotates any more");

      console.log("\n[devices-frames] canvas: a typed custom size (round 3)");
      await page.evaluate(() => window.__devices.addCustomFrame(480, 800));
      await page.waitForTimeout(200);
      const label = await page.evaluate(() =>
        [...document.querySelectorAll('select[aria-label="Device model"] option[disabled]')].map((o) => o.textContent.trim()),
      );
      ok(label.some((t) => /480×800 \(custom size\)/.test(t)) && !label.some((t) => /removed/.test(t)), `its model picker says "custom size", not "removed" (${label.join(" | ")})`);
      await page.evaluate(() => window.__devices.removeFrame(window.__devices.state.frames.at(-1).id));

      console.log("\n[devices-frames] canvas: the screenshot crop (finding 7)");
      const rect = await page.evaluate(async () => {
        const d = window.__devices;
        const [a, b] = d.state.frames;
        d.setAnnotateFrame(a.id);
        d.bringToFront(b.id);
        const r = await d.annotateFrameRect();
        const main = document.querySelector("main").getBoundingClientRect();
        const header = document.querySelector("header").getBoundingClientRect();
        return { r, mainTop: main.top, headerBottom: header.bottom, front: d.frontId, id: a.id };
      });
      ok(!!rect.r && !!rect.r.visible, "the canvas reports its visible scroll surface");
      ok(rect.r && rect.r.visible && Math.abs(rect.r.visible.y - rect.mainTop) < 1 && rect.r.visible.y >= rect.headerBottom - 1, `which starts below the toolbar (${rect.r && rect.r.visible && rect.r.visible.y} ≥ ${rect.headerBottom})`);
      ok(rect.front === rect.id, "the annotating device is raised above any frame over it");

      console.log("\n[devices-frames] canvas: the panel's open-page / reload requests (findings 8, 9)");
      const nonces = () => page.evaluate(() => window.__devices.state.frames.map((f) => f.nonce));
      const before = await nonces();
      await deliver(page, { type: "devices.refresh-all", tabId: CANVAS_TAB });
      const after = await nonces();
      ok(after.every((n, i) => n === before[i] + 1), "Reload refreshes every device");
      ok(await page.evaluate(() => !!window.__devices.annotateFrameId), "and keeps the device you annotate in");
      await deliver(page, { type: "devices.open-url", tabId: CANVAS_TAB, url: `${base}/app.html#cart` });
      ok((await page.evaluate(() => window.__devices.state.url)) === `${base}/app.html#cart`, "\"Open\" points the devices at that page");
      // Sync off, a device wandered elsewhere; "Open" on the canvas's own URL
      // must still bring every device back (round 3).
      const back = await page.evaluate(async (url) => {
        const d = window.__devices;
        const f = d.state.frames[0];
        d.frameSrc[f.id] = url.replace("#cart", "#elsewhere");
        const n = d.state.frames.map((x) => x.nonce);
        return { n, id: f.id };
      }, `${base}/app.html#cart`);
      await deliver(page, { type: "devices.open-url", tabId: CANVAS_TAB, url: `${base}/app.html#cart` });
      const reopened = await page.evaluate((id) => ({ src: window.__devices.srcFor(id), n: window.__devices.state.frames.map((x) => x.nonce) }), back.id);
      ok(reopened.src === `${base}/app.html#cart` && reopened.n.every((v, i) => v === back.n[i] + 1), "\"Open\" on the URL already shown reloads every device onto it");
      await deliver(page, { type: "devices.open-url", tabId: CANVAS_TAB, url: `${base}/evil.html` }, { id: "pinta-e2e-layout", tab: { id: CANVAS_TAB }, frameId: 3 });
      ok((await page.evaluate(() => window.__devices.state.url)) === `${base}/app.html#cart`, "a content script can't navigate the canvas");

      console.log("\n[devices-frames] canvas: a slow dev server (finding 11)");
      await page.evaluate((url) => {
        const d = window.__devices;
        d.setAnnotateFrame(null);
        d.setUrl(url);
        d.setAnnotateFrame(d.state.frames[0].id);
        window.__n0 = d.state.frames[0].nonce;
      }, `${base}/slow.html`);
      await page.waitForTimeout(3000);
      let st = await page.evaluate(() => ({ n: window.__devices.state.frames[0].nonce - window.__n0, err: window.__devices.error, on: !!window.__devices.annotateFrameId }));
      ok(st.n === 0 && !st.err && st.on, `still loading after 3s: not reloaded mid-load (${st.n} reloads)`);
      await page
        .waitForFunction(() => window.__devices.state.frames[0].nonce - window.__n0 >= 1, null, { timeout: SLOW_MS + 2500 + 4000 })
        .catch(() => {});
      st = await page.evaluate(() => ({ n: window.__devices.state.frames[0].nonce - window.__n0, on: !!window.__devices.annotateFrameId }));
      ok(st.n === 1 && st.on, `no answer 2.5s after it loaded: reloaded once (${st.n})`);
      await context.close();
    }

    // ── overlay half ─────────────────────────────────────────────────────
    {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      // Every frame: the harness origin plays the extension origin, so the
      // host page's activation ping passes the overlay's origin check.
      await context.addInitScript(() => {
        window.__extRoot = location.origin + "/";
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => failures.push("overlay pageerror: " + e.message.slice(0, 200)));
      await page.goto(`${base}/frame-host.html`);
      let frame = null;
      for (let i = 0; i < 50 && !frame; i++) {
        frame = page.frames().find((f) => /variant=overlay/.test(f.url())) || null;
        if (!frame) await page.waitForTimeout(100);
      }
      await frame.waitForFunction(() => window.__harnessVariant === "overlay", null, { timeout: 8000 });
      await page.waitForTimeout(200);
      const post = (on) =>
        page.evaluate((o) => document.getElementById("f").contentWindow.postMessage({ type: "pinta-annotate", on: o, token: "dev-1" }, "*"), on);
      const sent = (type) =>
        frame.evaluate((t) => (window.__runtimeSent || []).map((m) => m.msg).filter((m) => m && m.type === t), type);
      const color = () => frame.evaluate(() => document.getElementById("buy") && getComputedStyle(document.getElementById("buy")).color);

      console.log("\n[devices-frames] overlay: activation and the keep-alive (findings 3, 4)");
      await post(true);
      await page.waitForTimeout(300);
      let readies = await sent("overlay.ready");
      ok(readies.length >= 1 && readies[0].width === 402 && !readies[0].ping, `activation announces the frame with its width (${readies[0] && readies[0].width})`);
      await frame.evaluate(() => (window.__runtimeSent = []));
      await post(true);
      await page.waitForTimeout(200);
      readies = await sent("overlay.ready");
      ok(readies.length === 1 && readies[0].ping === true, "the keep-alive reply is marked as a ping");

      console.log("\n[devices-frames] overlay: hot-reload probe (finding 9)");
      let hmr = await deliver(frame, { type: "frame.hmr" });
      ok(hmr && hmr.hmr === false, "a plain page reports no HMR");
      await frame.evaluate(() => {
        const s = document.createElement("script");
        s.type = "text/plain";
        s.src = "/@vite/client";
        document.head.appendChild(s);
      });
      hmr = await deliver(frame, { type: "frame.hmr" });
      ok(hmr && hmr.hmr === true, "a Vite page reports HMR");

      console.log("\n[devices-frames] overlay: cleanup reaches an inactive device (finding 1)");
      const ann = { id: "a1", kind: "select", strokes: [], color: "#FF3D6E", comment: "", url: undefined, cssChanges: { color: "rgb(255, 0, 0)" }, targets: [{ selector: "#buy", outerHTML: "", computedStyles: {}, nearbyText: [], boundingRect: { x: 0, y: 0, width: 0, height: 0 } }] };
      await deliver(frame, { type: "annotated.reapply", annotation: ann });
      ok((await color()) === "rgb(255, 0, 0)", "the preview is on (active)");
      await post(false);
      await page.waitForTimeout(200);
      await deliver(frame, { type: "annotated.remove", annotationId: "a1" });
      ok((await color()) === "rgb(0, 0, 0)", "annotated.remove rolls it back in an inactive frame");
      await deliver(frame, { type: "annotated.reapply", annotation: ann });
      ok((await color()) === "rgb(255, 0, 0)", "a redo addressed to this frame re-applies it");
      await deliver(frame, { type: "annotated.clear" });
      ok((await color()) === "rgb(0, 0, 0)", "annotated.clear rolls it back in an inactive frame");
      await frame.evaluate(() => (window.__runtimeSent = []));
      await deliver(frame, { type: "mode.set", mode: "select" });
      await page.waitForTimeout(100);
      ok(!(await sent("mode.changed")).some((m) => m.mode === "select"), "anything else is still ignored while inactive");

      console.log("\n[devices-frames] overlay: switching away drops what this device shows (finding 6)");
      await post(true);
      await page.waitForTimeout(200);
      await deliver(frame, {
        type: "imported.show",
        imported: { title: "Shared review", author: "QA", accentColor: "#14b8a6", annotations: [] },
      });
      await deliver(frame, {
        type: "variants.preview",
        variantId: "v1",
        label: "B",
        target: { selector: "#buy", outerHTML: '<button id="buy">Buy now</button>', computedStyles: {}, nearbyText: ["Buy now"], boundingRect: { x: 0, y: 0, width: 0, height: 0 } },
        previewHtml: "<button>Variant B</button>",
      });
      await page.waitForTimeout(600);
      const pill = () => frame.evaluate(() => !!document.querySelector("pinta-overlay-host").shadowRoot.querySelector(".imported-pill__title"));
      const buyIn = () => frame.evaluate(() => !!document.getElementById("buy") && document.getElementById("buy").isConnected);
      ok(await pill(), "the imported overlay shows");
      ok(!(await buyIn()), "the variant preview replaced the element");
      await frame.evaluate(() => (window.__runtimeSent = []));
      await post(false);
      await page.waitForTimeout(400);
      ok(!(await pill()), "deactivating drops the imported overlay");
      ok(await buyIn(), "and restores the variant preview");
      ok((await sent("variants.preview-restored")).some((m) => m.variantId === "v1"), "telling the panel, so its card stops saying \"Previewing\"");
      await context.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[devices-frames] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[devices-frames] crashed:", e);
  process.exit(2);
});
