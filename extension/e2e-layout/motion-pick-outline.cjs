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
// over it, and that Esc removes the outline and sends the
// `<owner>.pick-cancelled` runtime message.
//
// Option A (2026-10-14): the motion label names the top REHEARSABLE
// suggestion for the hovered element — "div.kpi · Count up · click to
// animate", "ul.grid · Stagger · click to animate", and a plain prose
// section falls back to "Rise in". The variants label is unchanged
// ("… · click to pick for variants · Esc cancels"). Needs a fresh
// extension/dist — run `npm run build` first (or drop --no-build).
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
  section.prose { margin-top: 40px; padding: 24px; border: 1px solid #ddd; }
  section.prose p { margin: 0 0 8px; }
</style>
<div class="kpi">£128,460</div>
<ul class="grid" style="display:grid">${"<li>card</li>".repeat(8)}</ul>
<section class="prose"><p>Claims are reviewed within two working days of being lodged.</p><p>Anything that needs a second look goes to the senior adjuster.</p></section>`;

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
    const sendToTab = async (type, extra = {}) =>
      sw.evaluate(
        async ({ url, type, extra }) => {
          const [tab] = await chrome.tabs.query({ url });
          if (!tab) throw new Error("fixture tab not found");
          const deadline = Date.now() + 10000;
          let lastErr = null;
          while (Date.now() < deadline) {
            try {
              await chrome.tabs.sendMessage(tab.id, { type, ...extra });
              return tab.id;
            } catch (e) {
              lastErr = String(e && e.message);
              await new Promise((r) => setTimeout(r, 150));
            }
          }
          throw new Error("content script never answered: " + lastErr);
        },
        { url: PAGE_URL + "*", type, extra },
      );

    const outline = page.locator("pinta-overlay-host .hl.hl--hover");
    const label = page.locator("pinta-overlay-host .label");
    const kpi = page.locator(".kpi");
    const grid = page.locator("ul.grid");
    const prose = page.locator("section.prose");
    const card = page.locator("ul.grid li").nth(5);
    // The label's suggestion comes from a lazy import of the motion
    // catalog that starts when pick mode is entered — give it a moment.
    const labelWith = async (needle) => {
      let text = "";
      for (let i = 0; i < 30; i++) {
        text = (await label.count()) ? (await label.first().textContent().catch(() => "")) || "" : "";
        if (text.includes(needle)) break;
        await page.waitForTimeout(100);
      }
      return text.replace(/\s+/g, " ").trim();
    };

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
      if (owner === "motion") {
        // Option A: the label names the top rehearsable suggestion.
        const text = await labelWith("click to animate");
        ok(text.includes("div.kpi · Count up · click to animate"), `KPI label reads "div.kpi · Count up · click to animate" ("${text}")`);
        ok(!text.includes("click to pick for motion") && !text.includes("Esc cancels"), "the old \"click to pick for motion · Esc cancels\" copy is gone from the motion label");

        // A grid: hover the gap between two cards so the <ul> itself is
        // the element under the cursor (gap 12px, cards 120px wide).
        const gb = await grid.boundingBox();
        await page.mouse.move(gb.x + 120 + 6, gb.y + 30);
        const gridText = await labelWith("Stagger");
        ok(gridText.includes("ul.grid · Stagger · click to animate"), `grid label reads "ul.grid · Stagger · click to animate" ("${gridText}")`);
        const gbo = await settled(gb);
        ok(!!gbo && near(gbo.x, gb.x) && near(gbo.width, gb.width), `and the outline is the grid's own box (${gbo ? [gbo.x, gbo.y, gbo.width].map(Math.round).join(",") : "none"})`);

        // Plain prose: nothing scores, so the fallback is the first
        // rehearsable of the rest — Rise in — never a two-target one.
        const pb = await prose.boundingBox();
        await page.mouse.move(pb.x + pb.width / 2, pb.y + 8); // the section's padding, not a <p>
        const proseText = await labelWith("Rise in");
        ok(proseText.includes("section.prose · Rise in · click to animate"), `prose label falls back to "section.prose · Rise in · click to animate" ("${proseText}")`);
        ok(!/Container transform|Forward and backward/.test(proseText), "it never suggests a two-target transition");
      } else {
        const text = visible && (await label.count()) ? (await label.first().textContent().catch(() => "")) || "" : "";
        ok(text.includes("div.kpi") && text.includes(`click to pick for ${word}`) && text.includes("Esc cancels"), `variants label is unchanged: "${text.trim()}"`);
        ok(!text.includes("click to animate") && !text.includes("Count up"), "no motion suggestion leaks into the variants label");
      }

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

    // F16: the END pick (destination) carries role "end" — no suggestion,
    // the label says what the click sets, and the toast matches.
    console.log('\n[motion-pick-outline] motion · end pick (role "end")');
    await page.mouse.move(5, 5);
    await sendToTab("motion.pick-element", { role: "end" });
    const kb2 = await kpi.boundingBox();
    await page.mouse.move(kb2.x + kb2.width / 2, kb2.y + kb2.height / 2);
    let vis2 = await outline.isVisible().catch(() => false);
    if (!vis2) {
      await page.mouse.move(kb2.x + kb2.width / 2 + 1, kb2.y + kb2.height / 2 + 1);
      vis2 = await outline.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
    }
    ok(vis2, "end pick: hovering the KPI draws .hl.hl--hover");
    const endText = await labelWith("opens into this");
    ok(endText === "div.kpi · opens into this · click to set", `end-pick label reads "div.kpi · opens into this · click to set" ("${endText}")`);
    ok(!endText.includes("click to animate") && !endText.includes("Count up"), 'no suggestion / "click to animate" in the end-pick label');
    const status = page.locator("pinta-overlay-host .status");
    const toastText = async () => ((await status.count()) ? (await status.first().textContent().catch(() => "")) || "" : "").replace(/\s+/g, " ").trim();
    const toast = await toastText();
    ok(toast === "Motion · click what it opens into · Esc to cancel", `the toast reads "Motion · click what it opens into · Esc to cancel" ("${toast}")`);
    await page.screenshot({ path: path.join(SHOTS, "pick-outline-motion-end.png") });
    const beforeEnd = (await seen()).length;
    await page.keyboard.press("Escape");
    ok(await outline.waitFor({ state: "detached", timeout: 2000 }).then(() => true, () => false), "Esc removes the end-pick outline");
    let endMsgs = [];
    for (let i = 0; i < 20 && !endMsgs.includes("motion.pick-cancelled"); i++) {
      await page.waitForTimeout(100);
      endMsgs = (await seen()).slice(beforeEnd);
    }
    ok(endMsgs.includes("motion.pick-cancelled"), `Esc sends motion.pick-cancelled (saw: ${endMsgs.join(", ") || "nothing"})`);
    // A start pick after an end pick is back to the suggestion form.
    await page.mouse.move(5, 5);
    await sendToTab("motion.pick-element", { role: "start" });
    await page.mouse.move(kb2.x + kb2.width / 2, kb2.y + kb2.height / 2);
    const againText = await labelWith("click to animate");
    ok(againText.includes("div.kpi · Count up · click to animate"), `a later start pick is back to the suggestion label ("${againText}")`);
    const toast2 = await toastText();
    ok(toast2 === "Motion · click the element to animate · Esc to cancel", `and the toast is back to "Motion · click the element to animate · Esc to cancel" ("${toast2}")`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
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
