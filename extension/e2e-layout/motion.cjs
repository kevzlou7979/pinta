#!/usr/bin/env node
// Real-Chromium regression for the Motion module (Phase 25).
//
// Two halves, both with no companion and no real content script:
//
//   A) The panel (`?variant=motion` — the whole side panel with Motion
//      on). Every message the panel sends to "the tab" lands in
//      window.__tabMessages (index.html's chrome.tabs stub); the page's
//      replies (motion.picked / rehearse-ready / tick / finished /
//      rehearse-failed) are delivered through the panel's own
//      chrome.runtime.onMessage listener with a sender.tab.id. Guards the
//      pick → rank → rehearse → scrub / speed / loop state machine, the
//      auto re-arm on token + reduced changes, the leave-tab cleanup, the
//      error banner, and the "other tab" sender gate.
//
//   B) The runner (`?variant=motion-runner`): src/content/motion-run.ts
//      on a fixture DOM, in real Chromium — jsdom has no Element.animate.
//      Guards timeline length, play / reverse / seek / setRate / stop,
//      the stagger clamp + per-child delays, count-up text + aria-hidden
//      restore, and the reduced-motion plan.
//
//   node e2e-layout/motion.cjs            build + run
//   node e2e-layout/motion.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>           as run.cjs
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
  console.log("[motion] building →", OUT);
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

// The tab the panel believes it is driving.
const TAB = 7;
const PAGE_URL = "http://localhost:5173/dashboard";
const target = (selector, outerHTML, over) => ({
  selector,
  outerHTML,
  computedStyles: {},
  nearbyText: [],
  boundingRect: { x: 0, y: 0, width: 120, height: 40 },
  ...over,
});
const KPI = target("div.kpi", '<div class="kpi">£128,460</div>');
const GRID = target("ul.grid", "<ul style=\"display:grid\"><li>a</li><li>b</li><li>c</li><li>d</li></ul>", {
  computedStyles: { display: "grid" },
});
const DEST = target("section.detail", "<section class=\"detail\"><h2>Detail</h2></section>");

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
    // ======================================================================
    // A) The panel
    // ======================================================================
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    await page.addInitScript(
      ({ TAB, PAGE_URL }) => {
        window.__tabs = [{ id: TAB, url: PAGE_URL, active: true, windowId: 1 }];
      },
      { TAB, PAGE_URL },
    );
    await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=motion`);
    await page.waitForFunction(() => window.__harnessVariant === "motion" && !!window.__app);
    // adoptTab() runs in onMount after a storage read — wait for it so
    // the panel's own activeTabId is TAB before the sender gate is tested.
    await page.waitForFunction(
      () => (window.__runtimeSent || []).some((r) => r.msg && r.msg.type === "ensure-content-script"),
      null,
      { timeout: 5000 },
    ).catch(() => {});

    // Messages the panel sent to the tab, after a given seq.
    const sentAfter = (seq, type) =>
      page.evaluate(
        ({ seq, type }) => (window.__tabMessages || []).filter((m) => m.seq > seq && (!type || m.msg.type === type)).map((m) => ({ seq: m.seq, tabId: m.tabId, msg: m.msg })),
        { seq, type },
      );
    const mark = () => page.evaluate(() => window.__seq || 0);
    const last = (list) => (list.length ? list[list.length - 1] : null);
    // The page talks back through the panel's chrome.runtime.onMessage
    // listener. `tabId` defaults to the panel's active tab.
    // Rehearsal replies carry the `seq` of the motion.rehearse they answer
    // (F3); unless a step says otherwise they answer the latest one.
    const fromPage = (msg, tabId = TAB) =>
      page.evaluate(
        ({ msg, tabId }) => {
          if (/^motion\.(rehearse-ready|rehearse-failed|tick|finished)$/.test(msg.type) && msg.seq === undefined) {
            msg = { ...msg, seq: window.__app.motion.seq };
          }
          for (const l of window.__runtimeListeners || []) l(msg, { id: chrome.runtime.id, tab: { id: tabId } });
        },
        { msg, tabId },
      );
    const motion = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__app.motion)));
    const settle = (ms = 60) => page.waitForTimeout(ms);
    const nav = page.locator("nav");
    const motionTab = nav.getByRole("button", { name: "Motion", exact: true });
    const annotateTab = nav.getByRole("button", { name: "Annotate", exact: true });
    const patternRow = (name) => page.getByRole("button", { name: new RegExp("^" + name + "\\b") });

    console.log("\n[motion] 1 · the tab is gated on the module");
    await motionTab.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok(await motionTab.isVisible(), "the Motion tab shows with the module enabled");
    await page.evaluate(() => window.__app.setModuleEnabled("motion", false));
    await settle();
    ok((await motionTab.count()) === 0, "it disappears when the module is disabled");
    await page.evaluate(() => window.__app.setModuleEnabled("motion", true));
    await motionTab.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await motionTab.click();
    const pickBtn = page.getByRole("button", { name: "Pick on page", exact: true });
    await pickBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok(await pickBtn.isVisible(), '"Pick on page" is there');
    ok(await page.getByText("Nothing picked yet").isVisible(), "the empty state explains what picking does");
    ok(await page.getByText("Patterns", { exact: true }).isVisible(), 'the catalog header reads "Patterns" before a pick');
    await page.screenshot({ path: path.join(SHOTS, "motion-empty.png"), fullPage: true });

    console.log("\n[motion] 2 · start + cancel a pick");
    let seq = await mark();
    await pickBtn.click();
    await page.waitForFunction(() => window.__app.motion.picking === "start", null, { timeout: 3000 }).catch(() => {});
    let sent = await sentAfter(seq, "motion.pick-element");
    ok(sent.length === 1 && sent[0].tabId === TAB, `motion.pick-element goes to tab ${TAB} once (${sent.length})`);
    ok((await motion()).picking === "start", 'picking === "start"');
    ok(await page.getByText("Click the element to animate.").isVisible(), 'the prompt reads "Click the element to animate."');
    const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
    ok(await cancelBtn.isVisible(), "a Cancel button is offered");
    seq = await mark();
    await cancelBtn.click();
    await settle();
    sent = await sentAfter(seq, "motion.pick-cancel");
    ok(sent.length === 1, `Cancel sends motion.pick-cancel (${sent.length})`);
    ok((await motion()).picking === null, "picking is cleared");
    ok(await pickBtn.isVisible(), '"Pick on page" is back');

    console.log("\n[motion] 3 · pick a figure → Count up suggested first");
    await pickBtn.click();
    await page.waitForFunction(() => window.__app.motion.picking === "start", null, { timeout: 3000 }).catch(() => {});
    await fromPage({ type: "motion.picked", target: KPI });
    await settle();
    let m = await motion();
    ok(m.pickedTarget && m.pickedTarget.selector === "div.kpi", "pickedTarget is set");
    ok(m.picking === null, "picking is cleared by the pick");
    ok(m.patternId === "count-up", `Count up is auto-selected (${m.patternId})`);
    ok(await page.getByText("Suggested for this element").isVisible(), 'the catalog header reads "Suggested for this element"');
    const suggestedBefore = await page.locator('button[aria-pressed]').filter({ hasText: /Count up|Rise in|Fade in/ }).count();
    const showAll = page.getByRole("button", { name: /^Show all patterns/ });
    ok(await showAll.isVisible(), '"Show all patterns" toggle is offered');
    await showAll.click();
    await settle();
    ok(await page.getByRole("button", { name: /^Hide patterns/ }).isVisible(), 'it flips to "Hide patterns"');
    ok(await patternRow("Container transform").isVisible(), "the hidden rest of the catalog is now listed");
    ok(suggestedBefore >= 3, `the suggested list held Count up, Rise in, Fade (${suggestedBefore})`);
    await page.screenshot({ path: path.join(SHOTS, "motion-picked-kpi.png"), fullPage: true });

    console.log("\n[motion] 4 · re-pick a grid → Stagger takes over");
    await page.getByRole("button", { name: "re-pick", exact: true }).click();
    await page.waitForFunction(() => window.__app.motion.picking === "start", null, { timeout: 3000 }).catch(() => {});
    await fromPage({ type: "motion.picked", target: GRID });
    await settle();
    m = await motion();
    ok(m.patternId === "stagger", `patternId became "stagger" (${m.patternId})`);
    ok(m.destTarget === null, "destTarget is cleared");
    ok(m.pickedTarget && m.pickedTarget.selector === "ul.grid", "pickedTarget is the grid");
    ok(await page.getByLabel("Stagger step").isVisible(), "the stagger step slider is visible");

    console.log("\n[motion] 5 · a two-target pattern asks for a destination");
    await patternRow("Container transform").click();
    await settle();
    m = await motion();
    ok(m.patternId === "container-transform", `container-transform selected (${m.patternId})`);
    ok(await page.getByText("Destination", { exact: true }).isVisible(), "a Destination section appears");
    const destBtn = page.getByRole("button", { name: /^Click what it opens into/ });
    ok(await destBtn.isVisible(), 'it offers "Click what it opens into"');
    // Copy per F23: no phase ids in the panel.
    ok(await page.getByText("Preview for this pattern is coming soon", { exact: false }).isVisible(), "Rehearse shows the not-rehearsable note");
    ok((await page.getByRole("button", { name: "Play", exact: true }).count()) === 0, "no Play button for a blocked pattern");
    seq = await mark();
    await destBtn.click();
    await page.waitForFunction(() => window.__app.motion.picking === "end", null, { timeout: 3000 }).catch(() => {});
    ok((await motion()).picking === "end", 'picking === "end"');
    ok((await sentAfter(seq, "motion.pick-element")).length === 1, "the destination pick also sends motion.pick-element");
    ok(await page.getByText("Click what it opens into.", { exact: true }).isVisible(), 'the prompt reads "Click what it opens into."');
    await fromPage({ type: "motion.picked", target: DEST });
    await settle();
    m = await motion();
    ok(m.destTarget && m.destTarget.selector === "section.detail", "destTarget is set");
    ok(m.pickedTarget && m.pickedTarget.selector === "ul.grid", "pickedTarget is untouched");
    ok(m.patternId === "container-transform", "the pattern survives the destination pick");

    console.log("\n[motion] 6 · Play arms a rehearsal, the page answers, it plays");
    await patternRow("Fade in / out").click();
    await settle();
    m = await motion();
    ok(m.patternId === "fade" && m.rehearsing === false, "fade selected, nothing rehearsing");
    seq = await mark();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    const reh = last(sent);
    ok(sent.length === 1, `Play with nothing armed sends ONE motion.rehearse (${sent.length})`);
    ok(!!reh && reh.msg.selector === "ul.grid" && reh.msg.patternId === "fade", "it names the picked selector and pattern");
    ok(!!reh && typeof reh.msg.seq === "number" && reh.msg.seq === (await motion()).seq, `it carries the panel's seq (${reh && reh.msg.seq})`);
    ok(!!reh && JSON.stringify(reh.msg.overrides) === "{}" && reh.msg.reduced === false && typeof reh.msg.staggerStep === "number", "overrides {}, reduced false, staggerStep a number");
    const sysPlain = await page.evaluate(() => {
      const m = (window.__tabMessages || []).filter((x) => x.msg.type === "motion.rehearse").at(-1);
      if (!m) return { plain: false, equal: false };
      let plain = true;
      try {
        structuredClone(m.msg);
      } catch {
        plain = false;
      }
      const sys = m.msg.system;
      return {
        plain: plain && Object.getPrototypeOf(sys) === Object.prototype,
        equal: JSON.stringify(JSON.parse(JSON.stringify(sys))) === JSON.stringify(sys) && sys.name === window.__app.motion.system.name && sys.durations.base === 150,
      };
    });
    ok(sysPlain.plain, "the system rides as a plain object (structuredClone-able, no Svelte proxy)");
    ok(sysPlain.equal, "and JSON round-trips equal to the panel's system");
    ok((await motion()).playing === true, "playing is pre-set while the page arms");
    ok((await sentAfter(seq, "motion.play")).length === 0, "no motion.play before the page is ready");
    seq = await mark();
    await fromPage({ type: "motion.rehearse-ready", total: 150, childCount: 0, stagger: null, reduced: false });
    await settle(150);
    m = await motion();
    ok(m.rehearsing === true && m.total === 150, `rehearsing with total 150 (${m.rehearsing}, ${m.total})`);
    sent = await sentAfter(seq, "motion.play");
    ok(sent.length === 1 && sent[0].msg.rate === 1, `motion.play rate 1 follows the ready (${sent.length})`);
    ok(await page.getByRole("button", { name: "Playing…" }).isVisible(), 'the button reads "Playing…"');
    await fromPage({ type: "motion.tick", position: 80, running: true });
    await settle();
    ok((await motion()).position === 80, "a tick moves position to 80");
    ok(await page.getByText("80 / 150 ms").isVisible(), 'the readout shows "80 / 150 ms"');
    await fromPage({ type: "motion.finished" });
    await settle();
    ok((await motion()).playing === false, "finished → playing false");
    await fromPage({ type: "motion.tick", position: 150, running: false });
    await settle();
    ok(await page.getByRole("button", { name: "Replay", exact: true }).isVisible(), 'at the end the primary button reads "Replay"');
    seq = await mark();
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await settle(100);
    sent = await sentAfter(seq, "motion.play");
    ok(sent.length === 1 && sent[0].msg.from === undefined, `Replay sends motion.play from the start (${sent.length}, from ${sent[0] && sent[0].msg.from})`);
    await fromPage({ type: "motion.tick", position: 20, running: false });
    await page.screenshot({ path: path.join(SHOTS, "motion-rehearsing.png"), fullPage: true });

    console.log("\n[motion] 7 · scrub");
    const scrub = page.getByLabel("Scrub transition");
    ok(await scrub.isEnabled(), "the scrub bar is enabled while rehearsing");
    seq = await mark();
    await scrub.evaluate((el) => {
      el.value = "60";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(100);
    sent = await sentAfter(seq, "motion.seek");
    ok(sent.length === 1 && sent[0].msg.ms === 60, `scrub sends motion.seek ms 60 (${sent.length})`);
    m = await motion();
    ok(m.playing === false && m.position === 60, `playing false, position 60 (${m.playing}, ${m.position})`);
    // Lead decision F19: Play resumes from scrub; Reverse is secondary.
    ok(await page.getByRole("button", { name: "Play", exact: true }).isVisible(), 'the primary button still reads "Play"');
    const reverseBtn = page.getByRole("button", { name: "Reverse", exact: true });
    ok(await reverseBtn.isEnabled(), 'a secondary "Reverse" button is enabled while rehearsing');
    seq = await mark();
    await page.evaluate(() => window.__app.playMotion());
    await settle(100);
    sent = await sentAfter(seq, "motion.play");
    ok(sent.length === 1 && sent[0].msg.rate === 1 && sent[0].msg.from === 60, `Play from mid-way sends motion.play from 60 (${sent.length}, from ${sent[0] && sent[0].msg.from})`);
    ok((await sentAfter(seq, "motion.rehearse")).length === 0, "and does not re-arm");
    ok(await page.getByRole("button", { name: "Playing…" }).isDisabled(), "the primary button is disabled while playing");
    await fromPage({ type: "motion.tick", position: 90, running: false });
    await settle();
    seq = await mark();
    await reverseBtn.click();
    await settle(100);
    sent = await sentAfter(seq, "motion.reverse");
    ok(sent.length === 1 && sent[0].msg.rate === 1, `Reverse sends motion.reverse (${sent.length})`);
    await fromPage({ type: "motion.tick", position: 90, running: false });

    console.log("\n[motion] 8 · speed");
    seq = await mark();
    await page.getByRole("button", { name: "0.25×", exact: true }).click();
    await settle(100);
    sent = await sentAfter(seq, "motion.rate");
    ok(sent.length === 1 && sent[0].msg.rate === 0.25, `0.25× sends motion.rate 0.25 (${sent.length})`);
    ok((await motion()).speed === 0.25, "speed is 0.25");
    seq = await mark();
    await page.evaluate(() => window.__app.playMotion());
    await settle(100);
    const sp = last(await sentAfter(seq));
    ok(!!sp && /^motion\.(play|reverse)$/.test(sp.msg.type) && sp.msg.rate === 0.25, `the next play carries rate 0.25 (${sp && sp.msg.type} ${sp && sp.msg.rate})`);

    console.log("\n[motion] 9 · loop");
    await page.evaluate(() => {
      window.__app.motion.loop = true;
    });
    seq = await mark();
    await fromPage({ type: "motion.finished" });
    await settle(750);
    sent = (await sentAfter(seq)).filter((x) => /^motion\.(play|reverse)$/.test(x.msg.type));
    ok(sent.length === 1, `loop replays ~500ms after finished (${sent.map((x) => x.msg.type).join(",") || "nothing"})`);
    seq = await mark();
    await page.evaluate(() => {
      window.__app.motion.loop = true;
      window.__app.onMotionFinished(window.__app.motion.seq);
      window.__app.motion.loop = false;
    });
    await settle(750);
    sent = (await sentAfter(seq)).filter((x) => /^motion\.(play|reverse)$/.test(x.msg.type));
    ok(sent.length === 0, `loop switched off before the timer → nothing sent (${sent.length})`);
    ok(!(await page.getByRole("checkbox", { name: "Loop" }).isChecked()), "the Loop checkbox reflects loop=false");

    console.log("\n[motion] 10 · a token change re-arms");
    seq = await mark();
    await page.getByLabel("Duration token").selectOption("morph");
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.overrides && sent[0].msg.overrides.duration === "morph", `a new motion.rehearse carries overrides.duration "morph" (${sent.length})`);
    ok((await motion()).durationToken === "morph", "durationToken is morph");

    console.log("\n[motion] 11 · reduced re-arms");
    const reducedBox = page.getByRole("checkbox", { name: "Preview the reduced-motion fallback" });
    seq = await mark();
    await page.evaluate(() => window.__app.setMotionReduced(true));
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.reduced === true, `a new motion.rehearse carries reduced true (${sent.length})`);
    ok(await reducedBox.isChecked(), "the checkbox reflects it");
    seq = await mark();
    await reducedBox.uncheck();
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.reduced === false, "unticking it re-arms with reduced false");

    console.log("\n[motion] 12 · leaving the tab cleans up");
    ok((await motion()).rehearsing === true, "still rehearsing before the switch");
    seq = await mark();
    await annotateTab.click();
    await settle(150);
    sent = await sentAfter(seq, "motion.stop");
    ok(sent.length === 1, `leaving sends motion.stop (${sent.length})`);
    m = await motion();
    ok(m.rehearsing === false && m.playing === false && m.position === 0, "rehearsing / playing / position reset");
    await motionTab.click();
    await page.getByRole("button", { name: "re-pick", exact: true }).click();
    await page.waitForFunction(() => window.__app.motion.picking === "start", null, { timeout: 3000 }).catch(() => {});
    seq = await mark();
    await annotateTab.click();
    await settle(150);
    sent = await sentAfter(seq, "motion.pick-cancel");
    ok(sent.length === 1, `leaving mid-pick sends motion.pick-cancel (${sent.length})`);
    ok((await motion()).picking === null, "picking is cleared");
    await motionTab.click();
    await settle();

    console.log("\n[motion] 13 · the error banner");
    await fromPage({ type: "motion.rehearse-failed", reason: "not-found" });
    await settle();
    const banner = page.getByText("That element isn't on the page any more — pick it again.");
    ok(await banner.isVisible(), 'not-found → "That element isn\'t on the page any more — pick it again."');
    const dismiss = page.getByRole("button", { name: "Dismiss error" });
    ok(await dismiss.isVisible(), "the banner has a ✕");
    await dismiss.click();
    await settle();
    ok((await banner.count()) === 0 && (await motion()).error === null, "✕ clears it");
    await fromPage({ type: "motion.rehearse-failed", reason: "no-number" });
    await settle();
    ok(await page.getByText("Count up needs an element whose text contains a number.").isVisible(), 'no-number → "Count up needs an element whose text contains a number."');
    await page.screenshot({ path: path.join(SHOTS, "motion-error.png"), fullPage: true });
    await dismiss.click();

    console.log("\n[motion] 14 · messages from another tab are ignored");
    const before = await motion();
    await fromPage({ type: "motion.rehearse-ready", total: 999, childCount: 9, stagger: null, reduced: false }, 999);
    await fromPage({ type: "motion.picked", target: KPI }, 999);
    await fromPage({ type: "motion.rehearse-failed", reason: "not-found" }, 999);
    await fromPage({ type: "motion.tick", position: 999, running: true }, 999);
    await settle();
    const after = await motion();
    ok(after.rehearsing === before.rehearsing && after.total === before.total, "rehearse-ready from tab 999 changes nothing");
    ok(after.pickedTarget.selector === before.pickedTarget.selector && after.patternId === before.patternId, "motion.picked from tab 999 changes nothing");
    ok(after.error === null && after.position === before.position, "failed / tick from tab 999 change nothing");
    await fromPage({ type: "motion.rehearse-ready", total: 321, childCount: 0, stagger: null, reduced: false });
    await settle();
    ok((await motion()).total === 321, `the same message from tab ${TAB} is applied (control)`);

    console.log("\n[motion] 15 · replies for a superseded rehearse are ignored (F3)");
    const stale = (await motion()).seq - 1;
    await fromPage({ type: "motion.rehearse-ready", seq: stale, total: 777, childCount: 0, stagger: null, reduced: false });
    await fromPage({ type: "motion.tick", seq: stale, position: 777, running: true });
    await fromPage({ type: "motion.rehearse-failed", seq: stale, reason: "not-found" });
    await settle();
    m = await motion();
    ok(m.total === 321 && m.position !== 777 && m.error === null, `ready / tick / failed with seq ${stale} change nothing (total ${m.total})`);
    await fromPage({ type: "motion.rehearse-failed", reason: "not-found" });
    await settle();
    m = await motion();
    ok(m.rehearsing === false && m.total === 0 && m.position === 0 && !!m.error, "a current failure clears rehearsing, total and position (F18)");
    await page.getByRole("button", { name: "Dismiss error" }).click();

    await page.close();
    await context.close();

    // ======================================================================
    // B) The runner, in real Chromium
    // ======================================================================
    console.log("\n[motion] runner · fixture");
    const rctx = await browser.newContext({ viewport: { width: 600, height: 600 } });
    const rp = await rctx.newPage();
    rp.on("pageerror", (e) => failures.push("runner pageerror: " + e.message.slice(0, 200)));
    await rp.goto(`http://127.0.0.1:${srv.address().port}/?variant=motion-runner`);
    await rp.waitForFunction(() => window.__harnessVariant === "motion-runner" && !!window.__motion);
    await rp.evaluate(() => {
      document.getElementById("app").innerHTML =
        '<p id="n">£128,460</p>' +
        '<p id="n2" aria-hidden="false">42 items</p>' +
        '<p id="plain">no digits here</p>' +
        '<ul id="g">' + Array.from({ length: 8 }, (_, i) => `<li>item ${i + 1}</li>`).join("") + "</ul>" +
        '<div id="box">box</div>';
      // Handles are kept on window.__h so one step can build and a later
      // step can drive the same one.
      window.__h = {};
      window.__plan = (id, ctx, overrides) => {
        const { buildPlan, getPattern, DEFAULT_MOTION_SYSTEM } = window.__motion;
        return buildPlan(getPattern(id), DEFAULT_MOTION_SYSTEM, ctx || {}, overrides);
      };
      // onFinish is armed as soon as the handle exists, so a run that
      // finishes before the driver's next round-trip is still seen.
      window.__done = {};
      window.__run = (key, id, sel, ctx, overrides) => {
        const el = document.querySelector(sel);
        const plan = window.__plan(id, ctx, overrides);
        const h = window.__motion.runPlan(plan, el);
        window.__h[key] = h;
        window.__done[key] = new Promise((res) => h.onFinish(() => res(true)));
        return { total: h.total, plan };
      };
      window.__finished = (key) => window.__done[key];
      // Start on a fresh frame — a message handler may land mid-frame, and
      // the first rAF timestamp then precedes performance.now(); the
      // stress step below covers that case on purpose.
      window.__nextFrame = (fn) => new Promise((res) => requestAnimationFrame(() => { fn(); res(); }));
    });
    const opacity = (sel) => rp.evaluate((s) => getComputedStyle(document.querySelector(s)).opacity, sel);
    const r = (fn, arg) => rp.evaluate(fn, arg);

    console.log("\n[motion] runner 1 · fade on #box");
    let res = await r(() => window.__run("fade", "fade", "#box"));
    ok(res.total === 150, `handle.total === 150 (${res.total})`);
    ok(await r(() => document.getElementById("box").getAnimations().length === 1), "one animation is attached, paused");
    ok(await r(() => (window.__h.fade.play(1), window.__h.fade.running())), "play(1) → running() true");
    ok(await Promise.race([r(() => window.__finished("fade")), rp.waitForTimeout(2000).then(() => false)]), "onFinish fires");
    ok((await opacity("#box")) === "1", `after finish computed opacity is "1" (${await opacity("#box")})`);
    ok(!(await r(() => window.__h.fade.running())), "running() is false once it has finished");
    ok(await r(() => (window.__h.fade.stop(), document.getElementById("box").getAnimations().length === 0)), "stop() leaves no animations on #box");

    console.log("\n[motion] runner 2 · stagger on #g (8 children, step 140)");
    res = await r(() => window.__run("stag", "stagger", "#g", { childCount: window.__motion.childCountFor(document.getElementById("g")), staggerStep: 140 }));
    ok(res.plan.stagger && res.plan.stagger.clamped === true, `plan.stagger.clamped is true (requested ${res.plan.stagger && res.plan.stagger.requested}, step ${res.plan.stagger && res.plan.stagger.step})`);
    ok(res.total <= 900 && res.total > 300, `handle.total ≤ 900 (${res.total})`);
    const lis = () => r(() => Array.from(document.querySelectorAll("#g > li")).map((li) => getComputedStyle(li).opacity));
    await r(() => window.__h.stag.seek(window.__h.stag.total));
    let ops = await lis();
    ok(ops.length === 8 && ops.every((o) => o === "1"), `seek(total) → every li opacity 1 (${ops.join(",")})`);
    await r(() => window.__h.stag.seek(0));
    ops = await lis();
    ok(ops.length === 8 && ops.every((o) => o === "0"), `seek(0) → every li opacity 0 (${ops.join(",")})`);
    const delays = await r(() => Array.from(document.querySelectorAll("#g > li")).map((li) => li.getAnimations()[0].effect.getComputedTiming().delay));
    ok(delays.length === 8 && delays.every((d, i) => i === 0 || d > delays[i - 1]), `the 8 children have strictly increasing delays (${delays.map((d) => Math.round(d)).join(",")})`);
    ok(Math.round(delays[7] + 300) === res.total, "the last child's delay + duration is the timeline length");
    await r(() => window.__h.stag.stop());
    ok(await r(() => Array.from(document.querySelectorAll("#g > li")).every((li) => li.getAnimations().length === 0)), "stop() cancels every child animation");

    console.log("\n[motion] runner 3 · count-up on #n");
    res = await r(() => window.__run("cnt", "count-up", "#n"));
    ok(res.total === 1100, `handle.total === 1100 (${res.total})`);
    const text = (sel) => r((s) => document.querySelector(s).textContent, sel);
    const aria = (sel) => r((s) => document.querySelector(s).getAttribute("aria-hidden"), sel);
    ok((await text("#n")) === "£128,460", `resting text is still "£128,460" before play ("${await text("#n")}")`);
    await r(() => window.__h.cnt.seek(550));
    const mid = await text("#n");
    const midVal = Number(mid.replace(/[^\d.]/g, ""));
    ok(/^£\d{1,3}(,\d{3})+$/.test(mid) && midVal > 0 && midVal < 128460, `seek(550) shows a formatted value strictly between £0 and £128,460 ("${mid}")`);
    ok((await aria("#n")) === null, "aria-hidden is NOT set after a seek");
    const playStart = Date.now();
    ok(await r(() => window.__nextFrame(() => window.__h.cnt.play(1)).then(() => document.getElementById("n").getAttribute("aria-hidden") === "true")), 'during play aria-hidden="true"');
    ok(await r(() => window.__h.cnt.running()), "running() true during play");
    ok(await Promise.race([r(() => window.__finished("cnt")), rp.waitForTimeout(3000).then(() => false)]), "onFinish fires");
    const playTook = Date.now() - playStart;
    ok(playTook >= 900, `the 1100ms count actually ran (finished after ${playTook}ms)`);
    ok((await text("#n")) === "£128,460", `after finish text === "£128,460" ("${await text("#n")}")`);
    ok((await aria("#n")) === null, "after finish aria-hidden is removed");
    ok(!(await r(() => window.__h.cnt.running())), "running() is false once it has finished");
    await r(() => {
      window.__h.cnt.seek(200);
      window.__h.cnt.stop();
    });
    ok((await text("#n")) === "£128,460" && (await aria("#n")) === null, `stop() restores the text exactly ("${await text("#n")}")`);
    res = await r(() => window.__run("cnt2", "count-up", "#n2"));
    ok(res.total === 1100, "a second figure (with aria-hidden=\"false\" already) arms");
    await r(() => window.__h.cnt2.play(1));
    ok((await aria("#n2")) === "true", 'it is aria-hidden="true" while running');
    await r(() => window.__h.cnt2.stop());
    ok((await aria("#n2")) === "false" && (await text("#n2")) === "42 items", `stop() restores the pre-existing aria-hidden="false" ("${await aria("#n2")}")`);

    console.log("\n[motion] runner 3b · count-up started mid-frame (20 × 120ms, play and reverse)");
    // A message handler lands at an arbitrary point in the frame, so the
    // first rAF timestamp can precede the performance.now() taken in
    // start(). The run must still cover its whole duration in both
    // directions rather than ending on that first frame.
    const stress = await r(async () => {
      const el = document.getElementById("n");
      const out = { play: [], reverse: [] };
      for (const dir of ["play", "reverse"]) {
        for (let i = 0; i < 10; i++) {
          const h = window.__motion.runPlan(window.__plan("count-up", {}, { duration: "fast" }), el);
          const t0 = performance.now();
          let dt = null;
          const done = new Promise((res) => h.onFinish(() => { dt = performance.now() - t0; res(); }));
          await new Promise((res) => setTimeout(res, i * 3));
          h[dir](1);
          await Promise.race([done, new Promise((res) => setTimeout(res, 1500))]);
          out[dir].push({ ms: dt == null ? null : Math.round(dt), text: el.textContent });
          h.stop();
        }
      }
      return out;
    });
    const instant = (runs) => runs.filter((x) => x.ms != null && x.ms < 50);
    const never = (runs) => runs.filter((x) => x.ms == null);
    ok(never(stress.play).length === 0 && never(stress.reverse).length === 0, "every 120ms run reports finished within 1.5s");
    ok(instant(stress.play).length === 0, `no forward run ends on its first frame (${instant(stress.play).length}/10 did: ${instant(stress.play).map((x) => `${x.ms}ms→${x.text}`).join(" ")})`);
    ok(instant(stress.reverse).length === 0, `no reverse run ends on its first frame (${instant(stress.reverse).length}/10 did: ${instant(stress.reverse).map((x) => `${x.ms}ms→${x.text}`).join(" ")})`);
    ok(stress.play.every((x) => x.text === "£128,460") && stress.reverse.every((x) => x.text === "£0"), "forward runs end on £128,460 and reverse runs on £0");

    console.log("\n[motion] runner 4 · count-up with no number, or with markup under the figure");
    res = await r(() => window.__run("none", "count-up", "#plain"));
    ok(res.total === 0, `runPlan returns total 0 (${res.total})`);
    ok((await text("#plain")) === "no digits here", "and leaves the text alone");
    const rich = await r(() => {
      const p = document.createElement("p");
      p.id = "rich";
      p.innerHTML = '<span class="cur">£</span><strong>128,460</strong>';
      document.getElementById("app").appendChild(p);
      const h = window.__motion.runPlan(window.__plan("count-up"), p);
      h.play(1);
      h.stop();
      return { total: h.total, html: p.innerHTML };
    });
    ok(rich.total === 0 && rich.html === '<span class="cur">£</span><strong>128,460</strong>', `a figure with child markup is refused and left intact (F1) (${rich.total}; ${rich.html})`);

    console.log("\n[motion] runner 4b · play(rate, from) resumes mid-way (F19)");
    const resumed = await r(() => {
      const h = window.__motion.runPlan(window.__plan("fade"), document.getElementById("box"));
      h.play(1, 75);
      const t = h.currentTime();
      const running = h.running();
      h.stop();
      return { t, running };
    });
    ok(resumed.running && resumed.t >= 75 && resumed.t < 150, `play(1, 75) runs from ~75ms (${Math.round(resumed.t)})`);

    console.log("\n[motion] runner 5 · reverse(1) on fade ends at 0");
    res = await r(() => window.__run("rev", "fade", "#box"));
    await r(() => window.__h.rev.reverse(1));
    ok(await r(() => window.__h.rev.running()), "reverse(1) → running() true");
    ok(await r(() => document.getElementById("box").getAnimations()[0].playbackRate === -1), "playbackRate is -1");
    ok(await Promise.race([r(() => window.__finished("rev")), rp.waitForTimeout(2000).then(() => false)]), "onFinish fires");
    ok((await opacity("#box")) === "0", `after a reverse run computed opacity is "0" (${await opacity("#box")})`);
    await r(() => window.__h.rev.stop());

    console.log("\n[motion] runner 6 · setRate keeps the sign");
    res = await r(() => window.__run("rate", "fade", "#box", undefined));
    const rate = await r(() => {
      const h = window.__h.rate;
      h.reverse(1);
      h.setRate(2);
      const a = document.getElementById("box").getAnimations()[0];
      const v = a.playbackRate;
      h.stop();
      return v;
    });
    ok(rate === -2, `reverse then setRate(2) → playbackRate -2 (${rate})`);
    const fwd = await r(() => {
      const h = window.__motion.runPlan(window.__plan("fade"), document.getElementById("box"));
      h.play(1);
      h.setRate(0.25);
      const v = document.getElementById("box").getAnimations()[0].playbackRate;
      h.stop();
      return v;
    });
    ok(fwd === 0.25, `play then setRate(0.25) → playbackRate 0.25 (${fwd})`);

    console.log("\n[motion] runner 7 · stop() twice, play() after stop()");
    const twice = await r(() => {
      const h = window.__motion.runPlan(window.__plan("fade"), document.getElementById("box"));
      h.play(1);
      try {
        h.stop();
        h.stop();
      } catch (e) {
        return "threw: " + e.message;
      }
      h.play(1);
      return { anims: document.getElementById("box").getAnimations().length, running: h.running() };
    });
    ok(typeof twice === "object", `stop() twice does not throw (${typeof twice === "string" ? twice : "ok"})`);
    ok(typeof twice === "object" && twice.anims === 0 && twice.running === false, "play() after stop() is a no-op");
    const twiceCount = await r(() => {
      const h = window.__motion.runPlan(window.__plan("count-up"), document.getElementById("n"));
      h.play(1);
      try {
        h.stop();
        h.stop();
      } catch (e) {
        return "threw: " + e.message;
      }
      h.play(1);
      return { text: document.getElementById("n").textContent, running: h.running(), aria: document.getElementById("n").getAttribute("aria-hidden") };
    });
    ok(typeof twiceCount === "object" && twiceCount.running === false && twiceCount.text === "£128,460" && twiceCount.aria === null, `count-up: stop() twice + play() after stop() leave the figure untouched (${JSON.stringify(twiceCount)})`);

    console.log("\n[motion] runner 8 · reduced plan");
    const red = await r(() => window.__plan("stagger", { childCount: 8, staggerStep: 140, reduced: true }));
    ok(red.reduced === true && red.total === 120, `reduced stagger total === 120 (${red.total})`);
    ok(red.steps.length === 1 && Object.keys(red.steps[0].keyframes).join() === "opacity", `keyframes are opacity-only (${red.steps.map((s) => Object.keys(s.keyframes).join("+")).join("|")})`);
    ok(red.steps[0].node === "child" && !red.stagger, "it still binds the children, with no stagger block");
    res = await r(() => {
      const h = window.__motion.runPlan(window.__plan("stagger", { childCount: 8, staggerStep: 140, reduced: true }), document.getElementById("g"));
      const delays = Array.from(document.querySelectorAll("#g > li")).map((li) => li.getAnimations()[0].effect.getComputedTiming().delay);
      const total = h.total;
      h.stop();
      return { total, delays };
    });
    ok(res.total === 120 && res.delays.every((d) => d === 0), `running it: total 120, no per-child delay (${res.total}; ${res.delays.join(",")})`);
    await rp.screenshot({ path: path.join(SHOTS, "motion-runner.png") });

    await rp.close();
    await rctx.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[motion] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[motion] crashed:", e);
  process.exit(2);
});
