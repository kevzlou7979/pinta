#!/usr/bin/env node
// Real-extension regression: a Motion rehearsal never follows the user to
// another tab.
//
// Report 2026-10-15 (screenshot of GitLab pipelines "pulsing"): "Avoid
// Pinta from animating the screen when we are not in the website, right
// now all my tabs is pulsing." Every Motion send resolved the ACTIVE tab
// at send time, so with the Motion tab open a hover preview, the loop or
// a token re-arm injected the content script into whatever tab the user
// had switched to and ran `motion.rehearse` there; a generic selector
// (`ul.grid`) matched that page's rows and they animated.
//
// Like motion-pick-outline.cjs this loads the REAL built extension
// (dist/) into a persistent Chromium context, and — the part that
// matters here — the REAL side panel (src/sidepanel/index.html opened as
// a tab of its own, with chrome.tabs.query patched in that page to report
// whichever tab the script says is active, since the panel's own tab
// would otherwise be the active one). Two local pages: A (KPI + grid) is
// where the element is picked; B (a `ul.grid` of table-like rows + a
// `div.kpi`) is a page the picked selector WOULD match. After the pick on
// A the script activates B and hovers a pattern row in the panel; B must
// never run a Web Animation, A's rehearsal must have been stopped, and
// the panel must show the "Picked on another tab" notice. The content
// script is declared for <all_urls> in the manifest, so "no injection
// into B" is asserted as "no animation on B".
//
// Needs a fresh extension/dist — run `npm run build` first (or drop
// --no-build). Loaded extensions need Chromium's new headless mode
// (channel: "chromium"); if that fails to launch it falls back to headed.
//
//   node e2e-layout/motion-tab-pin.cjs            build + run
//   node e2e-layout/motion-tab-pin.cjs --no-build reuse dist/
//   --shots <dir>                                  screenshots
"use strict";

const { execSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EXT = path.resolve(__dirname, "..");
const DIST = path.join(EXT, "dist");
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : d;
};
const SHOTS = opt("--shots", path.join(os.tmpdir(), "e2e-layout-shots"));

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
  console.log("[motion-tab-pin] building →", DIST);
  execSync("npm run build", { cwd: EXT, stdio: "inherit" });
}

const PAGE_A = `<!doctype html><meta charset="utf-8"><title>page A — the app</title>
<style>
  body { margin: 0; padding: 40px; font: 16px system-ui; }
  .kpi { display: inline-block; padding: 12px 20px; font-size: 32px; font-weight: 700; }
  ul.grid { display: grid; grid-template-columns: repeat(4, 120px); gap: 12px; list-style: none; padding: 0; margin: 40px 0 0; }
  ul.grid li { height: 60px; background: #eee; }
</style>
<div class="kpi">£128,460</div>
<ul class="grid" style="display:grid">${"<li>card</li>".repeat(8)}</ul>`;

// B is "GitLab": a list of rows that the same generic selector matches.
const PAGE_B = `<!doctype html><meta charset="utf-8"><title>page B — pipelines</title>
<style>
  body { margin: 0; padding: 24px; font: 14px system-ui; }
  .kpi { font-size: 24px; font-weight: 600; margin-bottom: 16px; }
  ul.grid { display: grid; grid-template-columns: 1fr; list-style: none; padding: 0; margin: 0; border: 1px solid #ddd; }
  ul.grid li { display: grid; grid-template-columns: 120px 1fr 160px; padding: 10px 12px; border-bottom: 1px solid #eee; }
</style>
<div class="kpi">42 pipelines</div>
<ul class="grid" style="display:grid">${Array.from({ length: 10 }, (_, i) => `<li><span>#${1000 + i}</span><span>main · deploy</span><span>passed</span></li>`).join("")}</ul>`;

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      resp.writeHead(200, { "content-type": "text/html" });
      resp.end(req.url.startsWith("/b") ? PAGE_B : PAGE_A);
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

async function launch(userDir) {
  const args = [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`];
  try {
    return await chromium.launchPersistentContext(userDir, { channel: "chromium", headless: true, args });
  } catch (e) {
    console.log("[motion-tab-pin] headless chromium channel failed, falling back to headed:", String(e.message).split("\n")[0]);
    return chromium.launchPersistentContext(userDir, { headless: false, args });
  }
}

(async () => {
  if (!argv.includes("--no-build")) build();
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error("dist/manifest.json missing — run without --no-build");
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const ORIGIN = `http://127.0.0.1:${srv.address().port}`;
  const URL_A = `${ORIGIN}/a`;
  const URL_B = `${ORIGIN}/b`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinta-tab-pin-"));
  const context = await launch(userDir);
  const failures = [];
  const ok = (cond, msg) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) failures.push(msg);
  };
  try {
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    const extId = new URL(sw.url()).host;
    // Motion on, and the panel opens straight onto the Motion tab.
    await sw.evaluate(() =>
      chrome.storage.local.set({
        "pinta-modules": { motion: { enabled: true, settings: {} } },
        "pinta-active-tab": "motion",
      }),
    );
    const tabIdFor = (url) =>
      sw.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab) throw new Error("tab not found: " + url);
        return tab.id;
      }, url + "*");
    const activate = (id) => sw.evaluate((id) => chrome.tabs.update(id, { active: true }), id);
    const animations = (page) => page.evaluate(() => document.getAnimations().length);
    // Poll `page` for up to `ms`: resolves the max animation count seen.
    const maxAnimations = async (page, ms) => {
      let max = 0;
      const end = Date.now() + ms;
      while (Date.now() < end) {
        max = Math.max(max, await animations(page));
        await page.waitForTimeout(50);
      }
      return max;
    };

    const pageB = await context.newPage();
    await pageB.goto(URL_B);
    const pageA = await context.newPage();
    await pageA.goto(URL_A);
    await pageA.waitForSelector("pinta-overlay-host", { state: "attached", timeout: 15000 });
    await pageB.waitForSelector("pinta-overlay-host", { state: "attached", timeout: 15000 });
    const A = await tabIdFor(URL_A);
    const B = await tabIdFor(URL_B);
    pageA.on("pageerror", (e) => failures.push("A pageerror: " + e.message.slice(0, 200)));
    pageB.on("pageerror", (e) => failures.push("B pageerror: " + e.message.slice(0, 200)));

    // The real side panel as a page of its own. Its chrome.tabs.query is
    // patched to report window.__activeTab as the active tab — otherwise
    // the panel's own tab would be "active".
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.addInitScript((a) => {
      window.__activeTab = a;
      try {
        const orig = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (q) => {
          if (q && q.active && window.__activeTab != null) return [await chrome.tabs.get(window.__activeTab)];
          return orig(q);
        };
        window.__queryPatched = true;
      } catch (e) {
        window.__queryPatched = String(e && e.message);
      }
    }, A);
    panel.on("pageerror", (e) => failures.push("panel pageerror: " + e.message.slice(0, 200)));
    await activate(A);
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
    const patched = await panel.evaluate(() => window.__queryPatched);
    ok(patched === true, `the panel's chrome.tabs.query is patched to report tab A as active (${patched})`);
    const motionTab = panel.locator("nav").getByRole("button", { name: "Motion", exact: true });
    await motionTab.waitFor({ state: "visible", timeout: 15000 });
    await motionTab.click();
    const card = panel.getByText("Click the element to animate.", { exact: true });
    ok(await card.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false), "the Motion tab opens in pick mode");

    console.log("\n[motion-tab-pin] pick the grid on A → it plays on A");
    // Hover the gap between two cards so the <ul> itself is the target.
    const grid = pageA.locator("ul.grid");
    const outline = pageA.locator("pinta-overlay-host .hl.hl--hover");
    const gb = await grid.boundingBox();
    await pageA.mouse.move(gb.x + 120 + 6, gb.y + 30);
    let drawn = await outline.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
    if (!drawn) {
      await pageA.mouse.move(gb.x + 120 + 7, gb.y + 31);
      drawn = await outline.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
    }
    ok(drawn, "A is in pick mode (the hover outline is drawn)");
    await pageA.mouse.click(gb.x + 120 + 6, gb.y + 30);
    const staggerRow = panel.getByRole("button", { name: /^Stagger\b/ });
    ok(await staggerRow.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false), "the panel keeps Stagger for the grid");
    let played = 0;
    for (let i = 0; i < 40 && !played; i++) {
      played = await animations(pageA);
      if (!played) await pageA.waitForTimeout(50);
    }
    ok(played > 0, `the pick auto-plays on A (${played} animations)`);
    ok((await animations(pageB)) === 0, "B is untouched by the pick");
    await panel.screenshot({ path: path.join(SHOTS, "motion-tab-pin-picked.png") });

    console.log("\n[motion-tab-pin] switch to B → A stops, B never animates, the panel is inert");
    await panel.evaluate((b) => (window.__activeTab = b), B);
    await activate(B);
    await panel.waitForTimeout(600);
    ok((await animations(pageA)) === 0, "A's rehearsal was stopped on the switch");
    const notice = panel.getByText("Picked on another tab. Switch back to it, or pick here.", { exact: true });
    ok(await notice.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false), 'the panel reads "Picked on another tab. Switch back to it, or pick here."');
    ok(await panel.getByRole("button", { name: "Pick here", exact: true }).isVisible(), 'with a "Pick here" link');
    // A hover preview — pre-fix this sent motion.rehearse to B.
    const riseRow = panel.getByRole("button", { name: /^Rise in\b/ });
    await riseRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const rb = await riseRow.boundingBox();
    await panel.mouse.move(rb.x + rb.width / 2, rb.y + 12);
    await panel.mouse.move(rb.x + rb.width / 2 + 2, rb.y + 13);
    const maxB = await maxAnimations(pageB, 1500);
    ok(maxB === 0, `hovering Rise in while on B runs no Web Animation on B (max ${maxB})`);
    ok((await animations(pageA)) === 0, "and none on A either");
    await panel.mouse.move(5, 5);
    // Clicking a row (keep + play) must be just as inert.
    await panel.getByRole("button", { name: /^Fade in \/ out\b/ }).click();
    const maxB2 = await maxAnimations(pageB, 800);
    ok(maxB2 === 0 && (await animations(pageA)) === 0, `clicking a row while on B animates nothing anywhere (B ${maxB2})`);
    await panel.screenshot({ path: path.join(SHOTS, "motion-tab-pin-away.png") });
    await pageB.screenshot({ path: path.join(SHOTS, "motion-tab-pin-page-b.png") });

    console.log("\n[motion-tab-pin] back on A → the panel plays on A again");
    await panel.evaluate((a) => (window.__activeTab = a), A);
    await activate(A);
    await panel.waitForTimeout(400);
    ok((await notice.count()) === 0, "the notice is gone");
    await panel.getByRole("button", { name: /^Rise in\b/ }).click();
    let again = 0;
    for (let i = 0; i < 40 && !again; i++) {
      again = await animations(pageA);
      if (!again) await pageA.waitForTimeout(50);
    }
    ok(again > 0, `a row click plays on A again (${again} animations)`);
    ok((await animations(pageB)) === 0, "B still has none");
  } finally {
    await context.close().catch(() => {});
    srv.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  console.log(`\n[motion-tab-pin] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[motion-tab-pin] crashed:", e);
  process.exit(2);
});
