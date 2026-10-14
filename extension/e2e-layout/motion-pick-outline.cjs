#!/usr/bin/env node
// Real-extension regression for the one-shot element pick's hover outline.
//
// Report 2026-10-14: Motion pick showed no hover outline on the page —
// "Pick on page" in the Motion tab entered pick mode (the banner said
// "click the element to animate") but the page drew no pink selector
// border / label under the cursor, unlike Annotate and Design Variants.
//
// Unlike the other e2e-layout scripts this one loads the REAL built
// extension (dist/) into a persistent Chromium context: the content
// script is the real one, the shadow host is the real one, and pick mode
// is entered the way the panel does it — a chrome.tabs.sendMessage from
// the extension's own service worker. For BOTH motion-pick and
// variant-pick it asserts that hovering an element draws `.hl.hl--hover`
// over it with the "click to pick for …" label, and that Esc removes the
// outline and sends the `<owner>.pick-cancelled` runtime message.
//
// Loaded extensions need Chromium's new headless mode (channel:
// "chromium"); if that fails to launch the script falls back to headed.
//
//   node e2e-layout/motion-pick-outline.cjs            build + run
//   node e2e-layout/motion-pick-outline.cjs --no-build reuse dist/
//   --shots <dir>                                       screenshots
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
  console.log("[motion-pick-outline] building →", DIST);
  execSync("npm run build", { cwd: EXT, stdio: "inherit" });
}

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>pick fixture</title>
<style>
  body { margin: 0; padding: 40px; font: 16px system-ui; }
  .kpi { display: inline-block; padding: 12px 20px; font-size: 32px; font-weight: 700; }
  ul.grid { display: grid; grid-template-columns: repeat(4, 120px); gap: 12px; list-style: none; padding: 0; margin: 40px 0 0; }
  ul.grid li { height: 60px; background: #eee; }
</style>
<div class="kpi">£128,460</div>
<ul class="grid" style="display:grid">${"<li>card</li>".repeat(8)}</ul>`;

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((_req, resp) => {
      resp.writeHead(200, { "content-type": "text/html" });
      resp.end(FIXTURE);
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

async function launch(userDir) {
  const args = [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`];
  try {
    return await chromium.launchPersistentContext(userDir, { channel: "chromium", headless: true, args });
  } catch (e) {
    console.log("[motion-pick-outline] headless chromium channel failed, falling back to headed:", String(e.message).split("\n")[0]);
    return chromium.launchPersistentContext(userDir, { headless: false, args });
  }
}

(async () => {
  if (!argv.includes("--no-build")) build();
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error("dist/manifest.json missing — run without --no-build");
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const PAGE_URL = `http://127.0.0.1:${srv.address().port}/`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinta-pick-outline-"));
  const context = await launch(userDir);
  const failures = [];
  const ok = (cond, msg) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) failures.push(msg);
  };
  try {
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    // Observe what the content script sends back (pick-cancelled) from the
    // extension side — the SW hears every chrome.runtime.sendMessage.
    await sw.evaluate(() => {
      self.__seen = [];
      chrome.runtime.onMessage.addListener((m) => {
        self.__seen.push(m && m.type);
      });
    });
    const seen = () => sw.evaluate(() => self.__seen.slice());

    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    await page.goto(PAGE_URL);
    await page.waitForSelector("pinta-overlay-host", { state: "attached", timeout: 15000 });

    // Enter a pick mode the way the panel does: chrome.tabs.sendMessage from
    // the extension. Retried until the content script's listener is up.
    const sendToTab = async (type) =>
      sw.evaluate(
        async ({ url, type }) => {
          const [tab] = await chrome.tabs.query({ url });
          if (!tab) throw new Error("fixture tab not found");
          const deadline = Date.now() + 10000;
          let lastErr = null;
          while (Date.now() < deadline) {
            try {
              await chrome.tabs.sendMessage(tab.id, { type });
              return tab.id;
            } catch (e) {
              lastErr = String(e && e.message);
              await new Promise((r) => setTimeout(r, 150));
            }
          }
          throw new Error("content script never answered: " + lastErr);
        },
        { url: PAGE_URL + "*", type },
      );

    const outline = page.locator("pinta-overlay-host .hl.hl--hover");
    const label = page.locator("pinta-overlay-host .label");
    const kpi = page.locator(".kpi");
    const card = page.locator("ul.grid li").nth(5);

    for (const [owner, pickMsg, word] of [
      ["motion", "motion.pick-element", "motion"],
      ["variants", "variants.pick-element", "variants"],
    ]) {
      console.log(`\n[motion-pick-outline] ${owner} · ${pickMsg}`);
      await page.mouse.move(5, 5);
      await sendToTab(pickMsg);

      const kb = await kpi.boundingBox();
      await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
      let visible = await outline.isVisible().catch(() => false);
      if (!visible) {
        // One more nudge — the first mousemove after a mode flip may land
        // before the effect's listener is attached.
        await page.mouse.move(kb.x + kb.width / 2 + 1, kb.y + kb.height / 2 + 1);
        visible = await outline.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
      }
      ok(visible, `hovering the KPI draws .hl.hl--hover`);
      // .hl is 2px-bordered (content-box) and tweens top/left/size over
      // 80ms, so compare settled boxes with a ±6px slack.
      const near = (a, b) => Math.abs(a - b) <= 6;
      const settled = async (want) => {
        let b = null;
        for (let i = 0; i < 20; i++) {
          // count() first — boundingBox() auto-waits 30s when nothing matches.
          b = (await outline.count()) ? await outline.boundingBox().catch(() => null) : null;
          if (b && near(b.x, want.x) && near(b.y, want.y) && near(b.width, want.width)) break;
          await page.waitForTimeout(50);
        }
        return b;
      };
      const ob = visible ? await settled(kb) : null;
      ok(
        !!ob && ob.width > 0 && ob.height > 0 && near(ob.x, kb.x) && near(ob.y, kb.y) && near(ob.width, kb.width) && near(ob.height, kb.height),
        `outline box matches the KPI box (${ob ? [ob.x, ob.y, ob.width, ob.height].map(Math.round).join(",") : "none"} vs ${[kb.x, kb.y, kb.width, kb.height].map(Math.round).join(",")})`,
      );
      const text = visible && (await label.count()) ? (await label.first().textContent().catch(() => "")) || "" : "";
      ok(text.includes("div.kpi") && text.includes(`click to pick for ${word}`) && text.includes("Esc cancels"), `label reads "${text.trim()}"`);

      // The outline follows the cursor to a grid card.
      const cb = await card.boundingBox();
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      const ob2 = await settled(cb);
      ok(!!ob2 && near(ob2.x, cb.x) && near(ob2.y, cb.y) && near(ob2.width, cb.width), `outline follows the cursor to a card (${ob2 ? [ob2.x, ob2.y, ob2.width].map(Math.round).join(",") : "none"})`);
      await page.screenshot({ path: path.join(SHOTS, `pick-outline-${owner}.png`) });

      // Esc leaves pick mode: outline gone, cancel sent.
      const before = (await seen()).length;
      await page.keyboard.press("Escape");
      const gone = await outline.waitFor({ state: "detached", timeout: 2000 }).then(() => true, () => false);
      ok(gone, "Esc removes the outline");
      await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
      await page.waitForTimeout(150);
      ok((await outline.count()) === 0, "after Esc, hovering draws nothing (mode is idle)");
      let msgs = [];
      for (let i = 0; i < 20 && !msgs.includes(`${owner}.pick-cancelled`); i++) {
        await page.waitForTimeout(100);
        msgs = (await seen()).slice(before);
      }
      ok(msgs.includes(`${owner}.pick-cancelled`), `Esc sends ${owner}.pick-cancelled (saw: ${msgs.join(", ") || "nothing"})`);
    }
  } finally {
    await context.close().catch(() => {});
    srv.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  console.log(`\n[motion-pick-outline] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[motion-pick-outline] crashed:", e);
  process.exit(2);
});
