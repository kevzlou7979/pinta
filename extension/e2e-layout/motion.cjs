#!/usr/bin/env node
// Real-Chromium regression for the Motion module (Phase 25).
//
// Two halves, both with no companion and no real content script:
//
//   A) The panel (`?variant=motion` — the whole side panel with Motion
//      on). Every message the panel sends to "the tab" lands in
//      window.__tabMessages (index.html's chrome.tabs stub); the page's
//      replies (motion.picked / pick-cancelled / rehearse-ready / tick /
//      finished / rehearse-failed) are delivered through the panel's own
//      chrome.runtime.onMessage listener with a sender.tab.id. Guards the
//      "Option A then D" flow: the tab arms pick mode on mount, a pick
//      keeps the first REHEARSABLE suggestion and auto-plays it, rows are
//      the controls (click = keep + play, hover / focus ≥120ms = preview
//      without changing the kept pattern, leave = stop), two-target rows
//      go straight to the destination pick, the stagger chips, the
//      collapsed Tune disclosure and every control in it, the seq guard
//      after a stop, the leave-tab cleanup (one stop, one pick-cancel),
//      the error banner, and the "other tab" sender gate. The earlier
//      "Lead decision F19" (Play resumes from scrub, Reverse secondary) is
//      superseded by Option A: there is no Play button at all.
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
// A card link ranks Container transform first (85) — which cannot
// rehearse — so the kept pattern must be the first REHEARSABLE one.
const CARD = target("a.claim-card", '<a class="claim-card" href="/claims/1"><h3>Claim 1</h3><p>Open</p></a>');
const DEST = target("section.detail", "<section class=\"detail\"><h2>Detail</h2></section>");
const ROW_NAMES = /^(Container transform|Forward and backward|Lateral|Top level|Enter and exit|Skeleton loaders|Count up|Stagger|Rise in|Fade in \/ out)\b/;

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
    // A) The panel — Option A ("pick and it plays") then D ("hover to try")
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
    const ids = (list) => list.map((x) => x.msg.patternId).join(",") || "none";
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
    // Rows preview on hover (D1), so the pointer is parked off the list
    // after every click — a row re-rendered under a resting pointer must
    // not be mistaken for a hover.
    const park = async () => {
      await page.mouse.move(5, 5);
      await settle();
    };
    const click = async (loc) => {
      await loc.click();
      await park();
    };
    const waitPicking = (role) =>
      page.waitForFunction((r) => window.__app.motion.picking === r, role, { timeout: 3000 }).catch(() => {});
    const nav = page.locator("nav");
    const motionTab = nav.getByRole("button", { name: "Motion", exact: true });
    const annotateTab = nav.getByRole("button", { name: "Annotate", exact: true });
    const patternRow = (name) => page.getByRole("button", { name: new RegExp("^" + name + "\\b") });
    const keptRows = () => page.getByRole("button", { name: ROW_NAMES, pressed: true });
    const rowNames = async () => (await page.getByRole("button", { name: ROW_NAMES }).allInnerTexts()).map((t) => t.replace(/^[▶\s]+/, "").split("\n")[0].trim());
    const pickLink = page.getByRole("button", { name: "Pick on page", exact: true });
    const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
    const rePick = page.getByRole("button", { name: "re-pick", exact: true });
    const playBtn = page.getByRole("button", { name: "Play", exact: true });
    const tune = page.locator("details").filter({ hasText: "Tune · reverse, speed, scrub, loop, trigger, tokens, note" });
    const tuneOpen = () => tune.evaluate((d) => d.open).catch(() => null);
    const applyBtn = page.getByRole("button", { name: "Apply with agent", exact: true });

    console.log("\n[motion] 1 · the tab is gated on the module");
    await motionTab.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok(await motionTab.isVisible(), "the Motion tab shows with the module enabled");
    await page.evaluate(() => window.__app.setModuleEnabled("motion", false));
    await settle();
    ok((await motionTab.count()) === 0, "it disappears when the module is disabled");
    await page.evaluate(() => window.__app.setModuleEnabled("motion", true));
    await motionTab.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});

    console.log("\n[motion] 2 · opening the tab arms pick mode (A1)");
    let seq = await mark();
    await click(motionTab);
    await waitPicking("start");
    let sent = await sentAfter(seq, "motion.pick-element");
    ok(sent.length === 1 && sent[0].tabId === TAB, `mounting the tab sends motion.pick-element to tab ${TAB} once, unasked (${sent.length})`);
    ok((await motion()).picking === "start", 'picking === "start" before anything is clicked');
    ok(await page.getByText("Click the element to animate.", { exact: true }).isVisible(), 'the card reads "Click the element to animate."');
    ok(await page.getByText("Esc leaves pick mode.", { exact: true }).isVisible(), 'its hint reads "Esc leaves pick mode."');
    ok(await cancelBtn.isVisible(), "a Cancel link is offered while armed");
    ok((await pickLink.count()) === 0, 'no "Pick on page" while armed');
    ok((await playBtn.count()) === 0, "no Play button anywhere");
    ok((await page.getByText("Nothing picked yet").count()) === 0, 'the old "Nothing picked yet" copy is gone');
    ok((await page.getByText("Patterns", { exact: true }).count()) === 0, 'no "Patterns" heading before a pick — the card is the whole body');
    await page.screenshot({ path: path.join(SHOTS, "motion-empty.png"), fullPage: true });

    console.log("\n[motion] 3 · Esc / Cancel → pick mode off, the link re-arms");
    seq = await mark();
    await fromPage({ type: "motion.pick-cancelled" }); // Esc on the page
    await settle();
    ok((await motion()).picking === null, "Esc on the page clears picking");
    ok(await page.getByText("Pick mode is off.", { exact: true }).isVisible(), 'the card now reads "Pick mode is off."');
    ok(await page.getByText("Click the element to animate.", { exact: true }).isVisible(), "the title still says what a click does");
    ok(await pickLink.isVisible(), 'a "Pick on page" text link is offered');
    ok((await cancelBtn.count()) === 0, "Cancel is gone");
    ok((await sentAfter(seq, "motion.pick-cancel")).length === 0, "a page-side Esc is not echoed back as motion.pick-cancel");
    seq = await mark();
    await click(pickLink);
    await waitPicking("start");
    sent = await sentAfter(seq, "motion.pick-element");
    ok(sent.length === 1 && (await motion()).picking === "start", `the link re-arms: motion.pick-element sent, picking "start" (${sent.length})`);
    ok(await page.getByText("Esc leaves pick mode.", { exact: true }).isVisible(), 'the hint is back to "Esc leaves pick mode."');
    seq = await mark();
    await click(cancelBtn);
    await settle();
    sent = await sentAfter(seq, "motion.pick-cancel");
    ok(sent.length === 1 && sent[0].tabId === TAB, `Cancel sends motion.pick-cancel once (${sent.length})`);
    ok((await motion()).picking === null && (await page.getByText("Pick mode is off.", { exact: true }).isVisible()), 'Cancel → picking null, "Pick mode is off."');
    await click(pickLink);
    await waitPicking("start");

    console.log("\n[motion] 4 · pick a figure → Count up is kept and plays by itself (A2, A3)");
    seq = await mark();
    await fromPage({ type: "motion.picked", target: KPI });
    await settle(150);
    let m = await motion();
    ok(m.pickedTarget && m.pickedTarget.selector === "div.kpi" && m.picking === null, "pickedTarget is the figure, picking is cleared");
    ok(m.patternId === "count-up", `patternId is "count-up" (${m.patternId})`);
    sent = await sentAfter(seq, "motion.rehearse");
    let reh = last(sent);
    ok(sent.length === 1 && !!reh && reh.msg.patternId === "count-up" && reh.msg.selector === "div.kpi", `the pick itself sends ONE motion.rehearse for count-up on div.kpi (${ids(sent)})`);
    ok(!!reh && reh.msg.seq === m.seq && JSON.stringify(reh.msg.overrides) === "{}" && reh.msg.reduced === false && reh.msg.staggerStep === 60, `it carries seq ${m.seq}, overrides {}, reduced false, staggerStep 60`);
    ok(m.playing === true, "playing is pre-set so the ready auto-plays");
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
    ok((await playBtn.count()) === 0, "still no Play button");
    ok(await page.getByText("Try another", { exact: true }).isVisible(), 'the heading reads "Try another" once a pattern is kept');
    ok((await page.getByText("Suggested for this element").count()) === 0, '"Suggested for this element" is not shown while one is kept');
    ok(await page.getByText("Hover to try · click to keep").isVisible(), '"Hover to try · click to keep" sits on the heading line');
    ok(await page.getByText("Hover to try · click to keep").evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 10.5), "and is at least 10.5px (F21)");
    ok(await page.getByText("Trying patterns costs nothing. Apply (coming soon) writes named tokens into your source and always adds a reduced-motion fallback.").isVisible(), "the Apply footer copy (F23)");
    ok(await page.getByText("div.kpi", { exact: true }).isVisible() && (await rePick.count()) === 1 && (await page.getByRole("button", { name: "Clear target" }).count()) === 1, "the target chip shows div.kpi with re-pick and ✕");
    const countRow = patternRow("Count up");
    ok((await countRow.getAttribute("aria-pressed")) === "true", "the Count up row is aria-pressed");
    ok(await countRow.evaluate((b) => { const id = b.getAttribute("aria-labelledby"); return !!id && document.getElementById(id)?.textContent.trim() === "Count up"; }), "the row's accessible name is its title alone via aria-labelledby (F26)");
    ok(await countRow.locator("..").evaluate((d) => d.classList.contains("bg-brand-pink/5") && getComputedStyle(d).backgroundColor !== "rgba(0, 0, 0, 0)"), "the kept row carries the pink tint (F7)");
    ok((await keptRows().count()) === 1, `exactly one pattern row is pressed (${await keptRows().count()})`);
    let names = await rowNames();
    ok(names.slice(0, 3).join("|") === "Count up|Rise in|Fade in / out", `suggested rows are Count up, Rise in, Fade in / out in that order (${names.join("|")})`);
    const showAll = page.getByRole("button", { name: /^Show all patterns \(\d+\)$/ });
    ok(await showAll.isVisible() && (await showAll.textContent()).trim() === "Show all patterns (7)", `"Show all patterns (7)" is offered (${(await showAll.textContent().catch(() => "")).trim()})`);
    await click(showAll);
    ok(await page.getByRole("button", { name: "Hide patterns (7)", exact: true }).isVisible(), 'it flips to "Hide patterns (7)"');
    ok(await patternRow("Container transform").isVisible() && await patternRow("Lateral").isVisible(), "the rest of the catalog is now listed");
    ok((await tune.count()) === 1 && (await tuneOpen()) === false, "the Tune disclosure is collapsed by default");
    ok((await motion()).tuneOpen === false, "app.motion.tuneOpen is false");
    ok(!(await page.getByRole("button", { name: "Reverse", exact: true }).isVisible()) && !(await page.getByLabel("Scrub transition").isVisible()) && !(await page.getByLabel("Duration token").isVisible()), "Reverse / scrub / tokens are not visible until Tune opens");
    seq = await mark();
    await fromPage({ type: "motion.rehearse-ready", total: 1100, childCount: 0, stagger: null, reduced: false });
    await settle(150);
    m = await motion();
    ok(m.rehearsing === true && m.total === 1100, `rehearsing with total 1100 (${m.rehearsing}, ${m.total})`);
    sent = await sentAfter(seq, "motion.play");
    ok(sent.length === 1 && sent[0].msg.rate === 1, `motion.play rate 1 follows the ready (${sent.length})`);
    await fromPage({ type: "motion.tick", position: 640, running: true });
    await settle();
    ok(await countRow.getByText(/Playing\s*·\s*640 \/ 1100 ms/).isVisible(), 'the kept row\'s meta reads "Playing · 640 / 1100 ms"');
    await fromPage({ type: "motion.finished" });
    await fromPage({ type: "motion.tick", position: 1100, running: false });
    await settle();
    ok((await motion()).playing === false && (await countRow.getByText(/Played\s*·\s*1100 ms/).isVisible()), 'finished → "Played · 1100 ms" (F19: not "Paused · 1100 / 1100 ms")');
    ok((await countRow.getByText(/Paused/).count()) === 0, '"Paused" is for a run stopped mid-way only');
    ok((await page.getByRole("button", { name: "Replay", exact: true }).count()) === 0, "no Replay button either");
    seq = await mark();
    await click(countRow);
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && last(sent).msg.patternId === "count-up", `clicking the kept row re-arms and replays it (${ids(sent)})`);
    ok((await motion()).patternId === "count-up" && (await motion()).playing === true, "it stays kept, playing pre-set");
    await fromPage({ type: "motion.rehearse-ready", total: 1100, childCount: 0, stagger: null, reduced: false });
    await settle(100);
    await page.screenshot({ path: path.join(SHOTS, "motion-picked-kpi.png"), fullPage: true });

    console.log("\n[motion] 5 · re-pick a grid → Stagger takes over with tight / base / loose chips (A5)");
    seq = await mark();
    await click(rePick);
    await waitPicking("start");
    ok((await motion()).picking === "start" && (await sentAfter(seq, "motion.pick-element")).length === 1, "re-pick arms a start pick");
    ok(await page.getByText("Click the element to animate.", { exact: true }).isVisible() && (await page.getByText("Esc cancels.", { exact: true }).isVisible()), 'the chip turns into "Click the element to animate." / "Esc cancels."');
    seq = await mark();
    await fromPage({ type: "motion.picked", target: GRID });
    await settle(150);
    m = await motion();
    ok(m.patternId === "stagger", `a suggested pattern follows the new element: patternId "stagger" (${m.patternId})`);
    ok(m.destTarget === null && m.pickedTarget && m.pickedTarget.selector === "ul.grid", "destTarget cleared, pickedTarget is the grid");
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && last(sent).msg.patternId === "stagger" && last(sent).msg.selector === "ul.grid" && last(sent).msg.staggerStep === 60, `Stagger auto-plays at base 60 (${ids(sent)}, step ${last(sent) && last(sent).msg.staggerStep})`);
    const stepGroup = page.getByRole("group", { name: "Stagger step" });
    ok(await stepGroup.isVisible(), 'a "Stagger step" group sits inside the kept Stagger row');
    ok((await page.locator('input[type="range"][aria-label="Stagger step"]').count()) === 0, "the stagger slider is gone");
    const chips = (await stepGroup.getByRole("button").allTextContents()).map((t) => t.trim());
    ok(chips.join("|") === "tight · 40ms|base · 60ms|loose · 90ms", `chips read tight · 40ms / base · 60ms / loose · 90ms (${chips.join("|")})`);
    ok(await stepGroup.getByRole("button", { name: "base · 60ms", pressed: true }).isVisible(), "base is pressed");
    await fromPage({ type: "motion.rehearse-ready", total: 720, childCount: 8, stagger: { step: 60, requested: 60, clamped: false }, reduced: false });
    await settle(100);
    ok(await page.getByText("8 children", { exact: true }).isVisible(), '"8 children" shows beside the chips');
    ok((await page.getByText(/Stagger shortened/).count()) === 0, "no clamp note when the step was not clamped");
    seq = await mark();
    await click(stepGroup.getByRole("button", { name: "loose · 90ms" }));
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && last(sent).msg.staggerStep === 90 && last(sent).msg.patternId === "stagger", `loose sends ONE motion.rehearse with staggerStep 90 (${sent.length}, step ${last(sent) && last(sent).msg.staggerStep})`);
    ok((await motion()).staggerStep === 90 && (await stepGroup.getByRole("button", { name: "loose · 90ms", pressed: true }).isVisible()), "staggerStep 90, loose pressed");
    await fromPage({ type: "motion.rehearse-ready", total: 900, childCount: 8, stagger: { step: 85.7, requested: 90, clamped: true }, reduced: false });
    await settle(100);
    const clampNote = (await page.getByText(/Stagger shortened/).allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    ok(clampNote.length === 1 && clampNote[0] === "Stagger shortened to 86ms so all 8 land within 900ms.", `a clamped ready shows "Stagger shortened to 86ms so all 8 land within 900ms." (F25) (${JSON.stringify(clampNote)})`);
    ok((await motion()).staggerClamped === true && (await motion()).effectiveStep === 86, "staggerClamped true, effectiveStep 86");
    await page.screenshot({ path: path.join(SHOTS, "motion-stagger-chips.png"), fullPage: true });

    console.log("\n[motion] 6 · a card keeps the first REHEARSABLE suggestion; Container transform asks for a destination (A2, A3)");
    await click(rePick);
    await waitPicking("start");
    seq = await mark();
    await fromPage({ type: "motion.picked", target: CARD });
    await settle(150);
    m = await motion();
    ok(m.patternId === "rise-in", `a card keeps Rise in — the first rehearsable — not Container transform (${m.patternId})`);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && last(sent).msg.patternId === "rise-in" && last(sent).msg.selector === "a.claim-card", `and Rise in auto-plays on a.claim-card (${ids(sent)})`);
    names = await rowNames();
    ok(names.slice(0, 4).join("|") === "Rise in|Container transform|Forward and backward|Fade in / out", `the kept Rise in sits above the heading; Container transform still heads "Try another" (F13) (${names.slice(0, 4).join("|")})`);
    ok(await page.getByText("Try another", { exact: true }).evaluate((h) => {
      // Pattern rows only — the toolbar / Tune chips carry aria-pressed too.
      const rows = [...h.closest("section").querySelectorAll("button[aria-labelledby^='motion-row-']")];
      const kept = rows.find((b) => b.getAttribute("aria-pressed") === "true");
      const after = rows.filter((b) => h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return !!kept && !!(kept.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) && !after.includes(kept) && after.length === rows.length - 1;
    }), "the kept row is the only row above the heading; every alternative is below it (F13)");
    const ctRow = patternRow("Container transform");
    ok(await ctRow.getByText(/needs a destination · 500 ms · standard/).isVisible(), 'its meta reads "needs a destination · 500 ms · standard"');
    ok((await ctRow.getAttribute("aria-pressed")) === "false", "it is not the kept row");
    await fromPage({ type: "motion.rehearse-ready", total: 300, childCount: 0, stagger: null, reduced: false });
    await settle(100);
    seq = await mark();
    await click(ctRow);
    await waitPicking("end");
    m = await motion();
    ok(m.patternId === "container-transform", `clicking it keeps it (${m.patternId})`);
    ok(m.picking === "end", `and goes straight to the destination pick (picking "${m.picking}")`);
    sent = await sentAfter(seq, "motion.pick-element");
    ok(sent.length === 1 && sent[0].msg.role === "end", `motion.pick-element is sent for the destination with role "end" (F16) (${sent.length}, ${sent[0] && sent[0].msg.role})`);
    ok((await sentAfter(seq, "motion.rehearse")).length === 0, "nothing is rehearsed for a two-target pattern");
    ok((await sentAfter(seq, "motion.stop")).length >= 1 && (await motion()).rehearsing === false, "the Rise in rehearsal is stopped");
    ok(await ctRow.locator("..").getByText(/Click what it opens into\.\s*Esc cancels\./).isVisible(), 'the row reads "Click what it opens into." + "Esc cancels."');
    ok((await page.getByText("Click the element to animate.").count()) === 0, "the start chip stays a chip during the end pick");
    ok(await applyBtn.isDisabled(), "Apply stays disabled");
    seq = await mark();
    await fromPage({ type: "motion.picked", target: DEST });
    await settle();
    m = await motion();
    ok(m.destTarget && m.destTarget.selector === "section.detail" && m.pickedTarget.selector === "a.claim-card" && m.patternId === "container-transform" && m.picking === null, "destTarget set, start target and pattern untouched");
    const destLine = await page.evaluate(() => {
      const d = document.querySelector('[title="section.detail"]');
      return d ? d.parentElement.textContent.replace(/\s+/g, " ").trim() : null;
    });
    ok(destLine === "→ section.detail re-pick ✕", `the destination line shows "→ section.detail" only — the start label is not repeated (F18) ("${destLine}")`);
    ok((await rePick.count()) === 1 && (await page.getByRole("button", { name: "Re-pick destination", exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Clear destination" }).count()) === 1, 'the destination has its own "Re-pick destination" and ✕ (F8: not a second "re-pick")');
    ok((await ctRow.locator("..").getByText(/Used when the agent applies it|coming soon/).count()) === 0, "the coming-soon note is not repeated in the row (F22)");
    ok((await sentAfter(seq, "motion.rehearse")).length === 0 && (await applyBtn.isDisabled()), "still no rehearse; Apply still disabled");
    await click(page.getByRole("button", { name: "Clear destination" }));
    ok((await motion()).destTarget === null && (await page.getByRole("button", { name: "Click what it opens into", exact: true }).isVisible()), '✕ clears the destination and offers "Click what it opens into" again');
    await click(page.getByRole("button", { name: "Click what it opens into", exact: true }));
    await waitPicking("end");
    ok((await motion()).picking === "end", "the button restarts the end pick");
    await fromPage({ type: "motion.picked", target: DEST });
    await settle();
    await click(tune.locator("summary"));
    ok((await tuneOpen()) === true && (await motion()).tuneOpen === true, "Tune opens (app.motion.tuneOpen true)");
    ok(await tune.getByText("Preview for this pattern is coming soon — you can still pick the destination and add a note.").isVisible(), "Tune shows the not-rehearsable note for Container transform");
    ok((await page.getByRole("button", { name: "Reverse", exact: true }).count()) === 0 && (await page.getByLabel("Scrub transition").count()) === 0, "no Reverse / scrub for a blocked pattern");
    await click(tune.locator("summary"));
    ok((await tuneOpen()) === false && (await motion()).tuneOpen === false, "Tune closes again (tuneOpen false)");
    await page.screenshot({ path: path.join(SHOTS, "motion-destination.png"), fullPage: true });

    console.log("\n[motion] 7 · an explicit Show-all choice survives a re-pick; auto-plays only if rehearsable");
    seq = await mark();
    await click(patternRow("Lateral"));
    await settle(150);
    m = await motion();
    sent = await sentAfter(seq, "motion.rehearse");
    ok(m.patternId === "lateral" && sent.length === 1 && last(sent).msg.patternId === "lateral", `clicking Lateral (off-list for a card) keeps + rehearses it (${m.patternId}; ${ids(sent)})`);
    await click(rePick.first());
    await waitPicking("start");
    seq = await mark();
    await fromPage({ type: "motion.picked", target: KPI });
    await settle(150);
    m = await motion();
    ok(m.patternId === "lateral", `re-picking the figure keeps the explicit Lateral choice (${m.patternId})`);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && last(sent).msg.patternId === "lateral" && last(sent).msg.selector === "div.kpi", `and auto-plays it on the new element (${ids(sent)})`);
    seq = await mark();
    await click(patternRow("Forward and backward"));
    await waitPicking("end");
    ok((await motion()).patternId === "forward-backward" && (await motion()).picking === "end", "Forward and backward (off-list) is kept, end pick starts");
    await click(rePick.first());
    await waitPicking("start");
    seq = await mark();
    await fromPage({ type: "motion.picked", target: GRID });
    await settle(150);
    m = await motion();
    ok(m.patternId === "forward-backward" && m.pickedTarget.selector === "ul.grid", `re-picking the grid keeps Forward and backward (${m.patternId})`);
    ok((await sentAfter(seq, "motion.rehearse")).length === 0, "but nothing auto-plays — it can't rehearse");
    ok(m.rehearsing === false && m.playing === false, "rehearsing / playing stay false");
    // Probe: start its destination pick, then keep a one-target row.
    await click(page.getByRole("button", { name: "Click what it opens into", exact: true }));
    await waitPicking("end");
    seq = await mark();
    await click(patternRow("Lateral"));
    await settle(150);
    m = await motion();
    ok(m.patternId === "lateral" && (await sentAfter(seq, "motion.rehearse")).length === 1, "a one-target row clicked mid end-pick is kept + rehearsed");
    ok(m.picking === null && (await sentAfter(seq, "motion.pick-cancel")).length === 1, `and the pending end pick is cancelled first — picking null, one motion.pick-cancel (F10) (${m.picking})`);
    ok(m.destTarget === null, "no destination lingers on a one-target pattern (F10)");

    console.log("\n[motion] 8 · a row click = select + rehearse (A3)");
    seq = await mark();
    await click(patternRow("Fade in / out"));
    await settle(150);
    m = await motion();
    ok(m.patternId === "fade" && m.picking === null, `Fade in / out is kept (${m.patternId})`);
    sent = await sentAfter(seq);
    const stopIdx = sent.findIndex((x) => x.msg.type === "motion.stop");
    const rehIdx = sent.findIndex((x) => x.msg.type === "motion.rehearse");
    ok(stopIdx >= 0 && rehIdx > stopIdx, `the old rehearsal is stopped before the new arm (${sent.map((x) => x.msg.type).join(",")})`);
    sent = sent.filter((x) => x.msg.type === "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.patternId === "fade" && sent[0].msg.selector === "ul.grid", `ONE motion.rehearse for fade on ul.grid (${ids(sent)})`);
    ok((await keptRows().count()) === 1 && (await patternRow("Fade in / out").getAttribute("aria-pressed")) === "true", "the Fade row is the only pressed row");
    ok(await page.getByText("Try another", { exact: true }).isVisible(), 'heading still "Try another"');
    seq = await mark();
    await fromPage({ type: "motion.rehearse-ready", total: 150, childCount: 0, stagger: null, reduced: false });
    await settle(150);
    ok((await motion()).rehearsing === true && (await sentAfter(seq, "motion.play")).length === 1, "ready → rehearsing, motion.play follows");
    await fromPage({ type: "motion.tick", position: 80, running: true });
    await settle();
    ok(await patternRow("Fade in / out").getByText(/Playing\s*·\s*80 \/ 150 ms/).isVisible(), 'the Fade row reads "Playing · 80 / 150 ms"');
    await fromPage({ type: "motion.finished" });
    await fromPage({ type: "motion.tick", position: 150, running: false });
    await settle();

    console.log("\n[motion] 9 · Tune: collapsed, then every control present and wired (A4)");
    ok((await tuneOpen()) === false, "Tune is still collapsed");
    ok(!(await page.getByRole("button", { name: "Reverse", exact: true }).isVisible()), "Reverse is hidden while collapsed");
    await click(tune.locator("summary"));
    ok((await tuneOpen()) === true, "Tune opens");
    const reverseBtn = page.getByRole("button", { name: "Reverse", exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });
    const loopBox = page.getByRole("checkbox", { name: "Loop" });
    const speedGroup = page.getByRole("group", { name: "Playback speed" });
    const scrub = page.getByLabel("Scrub transition");
    const reducedBox = page.getByRole("checkbox", { name: "Preview the reduced-motion fallback" });
    const noteInput = page.getByLabel("Note for the agent");
    ok(await reverseBtn.isVisible() && await resetBtn.isVisible() && await loopBox.isVisible(), "Reverse, Reset, Loop are inside Tune");
    ok((await speedGroup.getByRole("button").allTextContents()).map((t) => t.trim()).join("|") === "1×|0.5×|0.25×", "speeds 1× · 0.5× · 0.25×");
    ok(await scrub.isVisible() && await scrub.isEnabled(), "the scrub bar is there and enabled while rehearsing");
    ok(await page.getByRole("group", { name: "Trigger" }).isVisible() && (await page.getByRole("button", { name: "On enter viewport", pressed: true }).count()) === 1, 'trigger chips with "On enter viewport" pressed');
    ok(await page.getByLabel("Duration token").isVisible() && await page.getByLabel("Easing token").isVisible(), "token selects are there");
    ok(await reducedBox.isVisible() && await noteInput.isVisible(), "reduced-motion checkbox + note input are there");
    await page.screenshot({ path: path.join(SHOTS, "motion-tune-open.png"), fullPage: true });
    // scrub → motion.seek
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
    ok(await patternRow("Fade in / out").getByText(/Paused\s*·\s*60 \/ 150 ms/).isVisible(), 'the kept row reads "Paused · 60 / 150 ms"');
    // Reverse (F19 superseded by Option A: no Play button; Reverse lives in Tune)
    ok(await reverseBtn.isEnabled(), "Reverse is enabled while paused");
    seq = await mark();
    await click(reverseBtn);
    await settle(100);
    sent = await sentAfter(seq, "motion.reverse");
    ok(sent.length === 1 && sent[0].msg.rate === 1, `Reverse sends motion.reverse rate 1 (${sent.length})`);
    ok((await motion()).playing === true && (await reverseBtn.isDisabled()), "playing → Reverse disabled while running");
    await fromPage({ type: "motion.tick", position: 0, running: false });
    await settle();
    // speed → motion.rate
    seq = await mark();
    await click(speedGroup.getByRole("button", { name: "0.25×", exact: true }));
    await settle(100);
    sent = await sentAfter(seq, "motion.rate");
    ok(sent.length === 1 && sent[0].msg.rate === 0.25 && (await motion()).speed === 0.25, `0.25× sends motion.rate 0.25 (${sent.length})`);
    seq = await mark();
    await click(reverseBtn);
    await settle(100);
    ok((last(await sentAfter(seq, "motion.reverse")) || { msg: {} }).msg.rate === 0.25, "the next run carries rate 0.25");
    await fromPage({ type: "motion.tick", position: 0, running: false });
    // trigger chip
    await click(page.getByRole("button", { name: "On mount", exact: true }));
    ok((await motion()).trigger === "mount" && (await page.getByRole("button", { name: "On mount", pressed: true }).count()) === 1, 'the "On mount" chip sets trigger "mount"');
    // token → new rehearse with overrides
    seq = await mark();
    await page.getByLabel("Duration token").selectOption("morph");
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.overrides && sent[0].msg.overrides.duration === "morph" && sent[0].msg.patternId === "fade", `a duration token change re-arms with overrides.duration "morph" (${sent.length})`);
    ok((await motion()).durationToken === "morph", "durationToken is morph");
    await fromPage({ type: "motion.rehearse-ready", total: 500, childCount: 0, stagger: null, reduced: false });
    await settle(100);
    seq = await mark();
    await page.getByLabel("Easing token").selectOption("linear");
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.overrides.easing === "linear" && sent[0].msg.overrides.duration === "morph", `an easing change re-arms with overrides {duration morph, easing linear} (${sent.length})`);
    await fromPage({ type: "motion.rehearse-ready", total: 500, childCount: 0, stagger: null, reduced: false });
    await settle(100);
    // reduced → new rehearse
    seq = await mark();
    await reducedBox.check();
    await park();
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.reduced === true && (await reducedBox.isChecked()), `ticking reduced re-arms with reduced true (${sent.length})`);
    await fromPage({ type: "motion.rehearse-ready", total: 120, childCount: 0, stagger: null, reduced: true });
    await settle(100);
    seq = await mark();
    await reducedBox.uncheck();
    await park();
    await settle(150);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].msg.reduced === false, "unticking it re-arms with reduced false");
    await fromPage({ type: "motion.rehearse-ready", total: 500, childCount: 0, stagger: null, reduced: false });
    await settle(100);
    // note
    await noteInput.fill("Feels snatched at quarter speed");
    await park();
    ok((await motion()).note === "Feels snatched at quarter speed", "the note is bound to app.motion.note");
    // loop
    await loopBox.check();
    await park();
    ok((await motion()).loop === true, "Loop checkbox sets loop");
    seq = await mark();
    await fromPage({ type: "motion.tick", position: 500, running: false });
    await fromPage({ type: "motion.finished" });
    await settle(750);
    sent = (await sentAfter(seq)).filter((x) => /^motion\.(play|reverse)$/.test(x.msg.type));
    ok(sent.length === 1 && sent[0].msg.type === "motion.reverse" && sent[0].msg.rate === 0.25, `loop alternates ~500ms after finished (${sent.map((x) => x.msg.type).join(",") || "nothing"})`);
    await loopBox.uncheck();
    await park();
    seq = await mark();
    await fromPage({ type: "motion.finished" });
    await settle(750);
    ok((await sentAfter(seq)).filter((x) => /^motion\.(play|reverse)$/.test(x.msg.type)).length === 0, "loop off → finished sends nothing");
    // Reset → motion.stop, seq bumped, a late ready for the old seq is ignored
    const seqBeforeStop = (await motion()).seq;
    seq = await mark();
    await click(resetBtn);
    await settle(100);
    sent = await sentAfter(seq, "motion.stop");
    m = await motion();
    ok(sent.length === 1 && m.rehearsing === false && m.position === 0 && m.total === 0, `Reset sends motion.stop, rehearsing false (${sent.length})`);
    ok(m.seq === seqBeforeStop + 1, `a stop retires the live seq: ${seqBeforeStop} → ${m.seq}`);
    await fromPage({ type: "motion.rehearse-ready", seq: seqBeforeStop, total: 500, childCount: 0, stagger: null, reduced: false });
    await settle();
    ok((await motion()).rehearsing === false, "a late ready carrying the stopped seq does NOT flip rehearsing back on");
    ok(await reverseBtn.isDisabled() && await resetBtn.isDisabled() && await scrub.isDisabled(), "Reverse / Reset / scrub are disabled with nothing live");
    const restingMeta = (await patternRow("Fade in / out").locator("span.font-mono").textContent()).replace(/\s+/g, " ").trim();
    ok(restingMeta === "500 ms · linear", `the kept row's resting meta is the RESOLVED timing — Tune's morph / linear, not the pattern defaults (F11) ("${restingMeta}")`);
    await click(tune.locator("summary"));
    ok((await tuneOpen()) === false, "Tune closed for the hover steps");

    console.log("\n[motion] 10 · hover to try (D1)");
    const riseRow = patternRow("Rise in");
    const fadeRow = patternRow("Fade in / out");
    const stagRow = patternRow("Stagger");
    // The tab bar is sticky inside <main>: a row that is "in view" can
    // still sit under it, so centre the row before resting the pointer.
    const hoverRow = async (row, ms) => {
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle();
      const b = await row.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + 12);
      await page.waitForTimeout(ms);
    };
    seq = await mark();
    await hoverRow(riseRow, 250);
    sent = await sentAfter(seq, "motion.rehearse");
    m = await motion();
    ok(sent.length === 1 && last(sent).msg.patternId === "rise-in" && last(sent).msg.selector === "ul.grid", `resting on Rise in ≥120ms sends motion.rehearse for rise-in (${ids(sent)})`);
    ok(JSON.stringify(last(sent) && last(sent).msg.overrides) === "{}", "a preview uses the row's own tokens (overrides {})");
    ok(m.previewingId === "rise-in", `previewingId is "rise-in" (${m.previewingId})`);
    ok(m.patternId === "fade", `the kept patternId is unchanged: "${m.patternId}"`);
    ok((await riseRow.getAttribute("aria-pressed")) === "false" && (await fadeRow.getAttribute("aria-pressed")) === "true", "Fade stays the pressed row");
    await fromPage({ type: "motion.rehearse-ready", total: 300, childCount: 0, stagger: null, reduced: false });
    await fromPage({ type: "motion.tick", position: 180, running: true });
    await settle();
    ok(await riseRow.getByText(/Previewing on page\s*·\s*180 \/ 300 ms/).isVisible(), 'the Rise in row reads "Previewing on page · 180 / 300 ms"');
    ok(!(await fadeRow.getByText(/Previewing|Playing|Paused/).isVisible()), "the kept row keeps its resting meta during a preview");
    await page.screenshot({ path: path.join(SHOTS, "motion-hover-preview.png"), fullPage: true });
    seq = await mark();
    await park();
    await settle(200);
    sent = await sentAfter(seq);
    m = await motion();
    // F15 (Lead): leave = stop, then ONE re-arm of the KEPT id (autoPlay
    // off), then a seek to total once the page is ready — never a
    // rehearse for the hovered id.
    ok(sent.filter((x) => x.msg.type === "motion.stop").length === 1, `leaving the row sends motion.stop (${sent.map((x) => x.msg.type).join(",") || "nothing"})`);
    ok(ids(sent.filter((x) => x.msg.type === "motion.rehearse")) === "fade", `then ONE motion.rehearse for the KEPT id, fade (F15) (${ids(sent.filter((x) => x.msg.type === "motion.rehearse"))})`);
    ok(sent.filter((x) => x.msg.type === "motion.rehearse" && x.msg.patternId === "rise-in").length === 0, "and zero rehearse for the hovered Rise in");
    ok(sent.findIndex((x) => x.msg.type === "motion.stop") < sent.findIndex((x) => x.msg.type === "motion.rehearse"), "stop lands before the re-arm");
    ok(m.previewingId === null && m.rehearsing === false && m.playing === false, "previewingId null, nothing live until the page answers, not playing");
    ok(await riseRow.getByText(/300 ms · decelerate/).isVisible(), 'the Rise in row is back to "300 ms · decelerate"');
    seq = await mark();
    await fromPage({ type: "motion.rehearse-ready", total: 150, childCount: 0, stagger: null, reduced: false });
    await settle(100);
    sent = await sentAfter(seq);
    m = await motion();
    ok(sent.map((x) => x.msg.type).join(",") === "motion.seek" && sent[0].msg.ms === 150, `the ready for the re-arm sends motion.seek to total (150) and no play (${sent.map((x) => x.msg.type).join(",") || "nothing"})`);
    ok(m.rehearsing === true && m.playing === false && m.position === 150, `the kept pattern sits at its END state: rehearsing, position 150 (${m.rehearsing}, ${m.position})`);
    ok(await fadeRow.getByText(/Played\s*·\s*150 ms/).isVisible(), 'the kept row reads "Played · 150 ms"');
    await click(tune.locator("summary"));
    ok(await page.getByRole("button", { name: "Reverse", exact: true }).isEnabled() && await page.getByRole("button", { name: "Reset", exact: true }).isEnabled() && await page.getByLabel("Scrub transition").isEnabled(), "Tune's Reverse / Reset / scrub are live again after the leave");
    await click(tune.locator("summary"));
    // shorter than the debounce
    seq = await mark();
    await hoverRow(stagRow, 40);
    await park();
    await settle(250);
    ok((await sentAfter(seq)).length === 0, `a 40ms sweep across Stagger sends nothing (${(await sentAfter(seq)).map((x) => x.msg.type).join(",") || "nothing"})`);
    // the kept row and a two-target row never preview
    seq = await mark();
    await hoverRow(fadeRow, 250);
    await park();
    ok((await sentAfter(seq)).length === 0, "hovering the kept row sends nothing");
    seq = await mark();
    await hoverRow(patternRow("Container transform"), 250);
    await park();
    ok((await sentAfter(seq)).length === 0 && (await motion()).previewingId === null, "hovering a two-target row sends nothing");
    // keyboard: focus previews, Enter keeps
    seq = await mark();
    await riseRow.focus();
    await settle(250);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && last(sent).msg.patternId === "rise-in" && (await motion()).previewingId === "rise-in" && (await motion()).patternId === "fade", `focusing Rise in previews it the same way (${ids(sent)})`);
    seq = await mark();
    await page.keyboard.press("Enter");
    await settle(150);
    m = await motion();
    sent = await sentAfter(seq, "motion.rehearse");
    ok(m.patternId === "rise-in" && m.previewingId === null, `Enter keeps it: patternId "${m.patternId}", previewingId ${m.previewingId}`);
    ok(sent.length === 1 && last(sent).msg.patternId === "rise-in", `Enter re-arms the now-kept Rise in (${ids(sent)})`);
    ok((await riseRow.getAttribute("aria-pressed")) === "true" && (await keptRows().count()) === 1, "Rise in is the one pressed row");
    seq = await mark();
    await fadeRow.focus();
    await settle(250);
    sent = await sentAfter(seq);
    ok(sent.filter((x) => x.msg.type === "motion.stop").length === 0, "blurring the kept row sends no stop (nothing was previewing)");
    ok(sent.filter((x) => x.msg.type === "motion.rehearse").length === 1 && last(sent.filter((x) => x.msg.type === "motion.rehearse")).msg.patternId === "fade", "and focusing Fade previews Fade");
    await page.keyboard.press("Tab");
    await settle(150);
    ok((await motion()).previewingId === null && (await sentAfter(seq, "motion.stop")).length === 1, "tabbing away stops the preview");
    ok(ids(await sentAfter(seq, "motion.rehearse")) === "fade,rise-in", `… and re-arms the kept Rise in once, never Fade again (F15) (${ids(await sentAfter(seq, "motion.rehearse"))})`);
    // mouse: hover then click keeps
    seq = await mark();
    await hoverRow(stagRow, 250);
    ok((await motion()).previewingId === "stagger", "hovering Stagger previews it");
    await click(stagRow);
    await settle(150);
    m = await motion();
    sent = await sentAfter(seq, "motion.rehearse");
    ok(m.patternId === "stagger" && m.previewingId === null && sent.length === 2 && ids(sent) === "stagger,stagger", `click keeps the hovered row (${m.patternId}; ${ids(sent)})`);
    ok(await page.getByRole("group", { name: "Stagger step" }).isVisible(), "the stagger chips appear in the kept row");
    await fromPage({ type: "motion.rehearse-ready", total: 540, childCount: 4, stagger: { step: 90, requested: 90, clamped: false }, reduced: false });
    await settle(100);

    console.log("\n[motion] 11 · leaving the tab cleans up, once");
    ok((await motion()).rehearsing === true, "still rehearsing before the switch");
    seq = await mark();
    await click(annotateTab);
    await settle(150);
    sent = await sentAfter(seq);
    ok(sent.filter((x) => x.msg.type === "motion.stop").length === 1, `leaving sends motion.stop once (${sent.map((x) => x.msg.type).join(",")})`);
    ok(sent.filter((x) => x.msg.type === "motion.pick-cancel").length === 0, "no pick-cancel when nothing was picking");
    m = await motion();
    ok(m.rehearsing === false && m.playing === false && m.position === 0, "rehearsing / playing / position reset");
    seq = await mark();
    await click(motionTab);
    await settle(300);
    ok((await sentAfter(seq, "motion.pick-element")).length === 0 && (await motion()).picking === null, "coming back with a target kept does NOT re-arm pick mode");
    ok(await patternRow("Stagger").isVisible() && (await motion()).patternId === "stagger", "the kept selection is still there");
    await click(rePick.first());
    await waitPicking("start");
    seq = await mark();
    await click(annotateTab);
    await settle(200);
    sent = await sentAfter(seq);
    ok(sent.filter((x) => x.msg.type === "motion.pick-cancel").length === 1, `leaving mid-pick sends motion.pick-cancel exactly once — App effect + onDestroy don't double up (${sent.map((x) => x.msg.type).join(",")})`);
    ok((await motion()).picking === null, "picking is cleared");
    await click(motionTab);
    await settle(300);
    ok((await motion()).picking === null, "and stays cleared on return");
    // Wipe the target: the tab must re-arm on the next mount.
    seq = await mark();
    await click(page.getByRole("button", { name: "Clear target" }));
    await waitPicking("start");
    ok((await motion()).pickedTarget === null && (await motion()).picking === "start" && (await sentAfter(seq, "motion.pick-element")).length === 1 && (await page.getByText("Esc leaves pick mode.", { exact: true }).isVisible()), '✕ on the chip clears the target AND re-arms pick mode — same as opening the tab (F20)');
    ok((await sentAfter(seq, "motion.pick-element"))[0].msg.role === "start", 'motion.pick-element carries role "start" (F16)');
    await click(annotateTab);
    seq = await mark();
    await click(motionTab);
    await waitPicking("start");
    ok((await sentAfter(seq, "motion.pick-element")).length === 1 && (await motion()).picking === "start", "with nothing kept, re-opening the tab arms pick mode again");
    await fromPage({ type: "motion.picked", target: KPI });
    await settle(150);
    ok((await motion()).patternId === "count-up", "picked the figure again for the error steps");
    await park();

    console.log("\n[motion] 12 · the error banner");
    await fromPage({ type: "motion.rehearse-failed", reason: "not-found" });
    await settle();
    const banner = page.getByText("That element isn't on the page any more — pick it again.");
    ok(await banner.isVisible(), 'not-found → "That element isn\'t on the page any more — pick it again."');
    const dismiss = page.getByRole("button", { name: "Dismiss error" });
    ok(await dismiss.isVisible(), "the banner has a ✕");
    await click(dismiss);
    ok((await banner.count()) === 0 && (await motion()).error === null, "✕ clears it");
    await click(countRow);
    await settle(150);
    await fromPage({ type: "motion.rehearse-failed", reason: "no-number" });
    await settle();
    ok(await page.getByText("Count up needs an element whose text contains a number.").isVisible(), 'no-number → "Count up needs an element whose text contains a number."');
    await page.screenshot({ path: path.join(SHOTS, "motion-error.png"), fullPage: true });
    await click(dismiss);
    await click(countRow);
    await settle(150);
    await fromPage({ type: "motion.rehearse-failed", reason: "unsupported" });
    await settle();
    ok(await page.getByText("That element can't be animated — for Count up, pick the element that holds just the number.").isVisible(), 'unsupported → "That element can\'t be animated — for Count up, pick the element that holds just the number."');
    await click(dismiss);
    await click(countRow);
    await settle(150);
    await fromPage({ type: "motion.rehearse-ready", total: 1100, childCount: 0, stagger: null, reduced: false });
    await settle(100);

    console.log("\n[motion] 13 · messages from another tab are ignored");
    const before = await motion();
    await fromPage({ type: "motion.rehearse-ready", total: 999, childCount: 9, stagger: null, reduced: false }, 999);
    await fromPage({ type: "motion.picked", target: GRID }, 999);
    await fromPage({ type: "motion.pick-cancelled" }, 999);
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

    console.log("\n[motion] 14 · replies for a superseded rehearse are ignored (F3)");
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
    await click(page.getByRole("button", { name: "Dismiss error" }));

    // Report 2026-10-15 ("all my tabs is pulsing"): every send resolved the
    // ACTIVE tab at send time, so with the Motion tab open a hover preview,
    // the loop or a token re-arm injected + animated whatever tab the user
    // had switched to (a generic selector matched GitLab's rows). The
    // rehearsal tab is now pinned on the pick; away from it Motion is inert.
    console.log("\n[motion] 15 · the rehearsal tab is pinned — away from it, nothing is sent anywhere");
    const OTHER = 9;
    const switchTab = (id) =>
      page.evaluate(
        ({ id, TAB, PAGE_URL }) => {
          window.__tabs = [{ id, url: id === TAB ? PAGE_URL : "https://gitlab.example/pipelines", active: true, windowId: 1 }];
          for (const l of window.__tabActivatedListeners || []) l({ tabId: id, windowId: 1 });
        },
        { id, TAB, PAGE_URL },
      );
    const isMotion = (x) => x.msg.type.startsWith("motion.");
    const toTab = (list, id) => list.filter((x) => x.tabId === id && isMotion(x));
    const motionSent = async (from) => (await sentAfter(from)).filter(isMotion);
    const typesOf = (list) => list.map((x) => x.msg.type).join(",") || "nothing";
    const soFar = await page.evaluate(() => (window.__tabMessages || []).filter((x) => /^motion\./.test(x.msg.type)).map((x) => x.tabId));
    ok(soFar.length > 0 && soFar.every((t) => t === TAB), `every motion.* message so far went to tab ${TAB} (tabs seen: ${[...new Set(soFar)].join(",")})`);
    m = await motion();
    ok(m.tabId === TAB, `motion.tabId is pinned to ${TAB} by the pick (${m.tabId})`);
    ok(m.away === false, `away is false while tab ${TAB} is active (${m.away})`);
    await click(countRow);
    await settle(150);
    await fromPage({ type: "motion.rehearse-ready", total: 1100, childCount: 0, stagger: null, reduced: false });
    await settle();
    ok((await motion()).rehearsing === true, "a rehearsal is live before the browser tab changes");
    seq = await mark();
    await switchTab(OTHER);
    await settle(300);
    sent = await motionSent(seq);
    ok(toTab(sent, TAB).filter((x) => x.msg.type === "motion.stop").length === 1, `switching to tab ${OTHER} sends motion.stop once, to the PINNED tab ${TAB} (${typesOf(toTab(sent, TAB))})`);
    ok(toTab(sent, OTHER).length === 0, `and nothing at all to tab ${OTHER} (${typesOf(toTab(sent, OTHER))})`);
    m = await motion();
    ok(m.away === true && m.tabId === TAB, `away is true, the pin is still ${TAB} (${m.away}, ${m.tabId})`);
    ok(m.rehearsing === false && m.playing === false, "nothing is live on the page");
    ok(m.pickedTarget && m.pickedTarget.selector === "div.kpi" && m.patternId === "count-up", "the target and the kept pattern survive the switch");
    const notice = page.getByText("Picked on another tab. Switch back to it, or pick here.", { exact: true });
    const pickHere = page.getByRole("button", { name: "Pick here", exact: true });
    ok(await notice.isVisible(), 'the tab reads "Picked on another tab. Switch back to it, or pick here."');
    ok(await pickHere.isVisible(), 'with a "Pick here" link');
    ok((await page.getByText("Click the element to animate.", { exact: true }).count()) === 0, "the instruction card is replaced, not stacked");
    await page.screenshot({ path: path.join(SHOTS, "motion-away.png"), fullPage: true });
    // F2: injection is the other half of the report — a hover / loop /
    // re-arm while away must not even ask the background to put the
    // content script into tab 9. (The panel's own ensure-on-activate for
    // the Annotate overlay fires INSIDE switchTab, before this mark.)
    const injectsTo = (from, id) =>
      page.evaluate(
        ({ from, id }) => (window.__runtimeSent || []).filter((r) => r.seq > from && r.msg && r.msg.type === "ensure-content-script" && r.msg.tabId === id),
        { from, id },
      );
    const awayMark = await mark();
    seq = await mark();
    await hoverRow(riseRow, 300);
    sent = await motionSent(seq);
    ok(sent.length === 0, `hovering Rise in while away sends nothing to any tab (${typesOf(sent)} → ${sent.map((x) => x.tabId).join(",")})`);
    ok((await motion()).previewingId === null, "and nothing is marked as previewing");
    await park();
    await page.evaluate(() => {
      window.__app.motion.loop = true;
      window.__app.motion.rehearsing = true; // as if a loop were mid-flight
      window.__app.onMotionFinished(window.__app.motion.seq);
    });
    await settle(700);
    sent = await motionSent(seq);
    ok(sent.length === 0, `loop on + motion.finished while away sends nothing after 600ms (${typesOf(sent)})`);
    const baseline = await motion();
    await page.evaluate(() => {
      window.__app.motion.loop = false;
      window.__app.motion.rehearsing = false;
      window.__app.setMotionToken("duration", "morph");
      window.__app.setMotionStaggerStep(90);
      window.__app.setMotionReduced(true);
      void window.__app.playMotion();
      void window.__app.reverseMotion();
      void window.__app.seekMotion(10);
      window.__app.setMotionSpeed(0.5);
      void window.__app.rehearseMotion(true);
      void window.__app.previewMotionPattern("rise-in");
    });
    await settle(200);
    sent = await motionSent(seq);
    ok(sent.length === 0, `token / stagger / reduced / play / reverse / seek / speed / rehearse / preview while away send nothing (${typesOf(sent)})`);
    m = await motion();
    ok(
      m.rehearsing === false && m.previewingId === null && m.playing === false && m.speed === baseline.speed && m.durationToken === baseline.durationToken && m.staggerStep === baseline.staggerStep && m.reduced === baseline.reduced && m.position === 0,
      `and change nothing (inert, not queued) (speed ${m.speed}, duration ${m.durationToken}, step ${m.staggerStep}, reduced ${m.reduced})`,
    );
    ok((await injectsTo(awayMark, OTHER)).length === 0, `no content-script injection (ensure-content-script) into tab ${OTHER} while away (F2)`);
    await fromPage({ type: "motion.rehearse-ready", total: 999, childCount: 9, stagger: null, reduced: false }, OTHER);
    await settle();
    ok((await motion()).rehearsing === false && (await motion()).total === 0, `a motion.rehearse-ready from tab ${OTHER} is ignored`);
    seq = await mark();
    await switchTab(TAB);
    await settle(200);
    m = await motion();
    ok(m.away === false && m.tabId === TAB, `back on tab ${TAB}: away is false, the pin unchanged (${m.away}, ${m.tabId})`);
    ok((await notice.count()) === 0 && (await pickHere.count()) === 0, "the notice is gone");
    ok((await motionSent(seq)).length === 0, "returning sends nothing by itself");
    await hoverRow(riseRow, 300);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].tabId === TAB && sent[0].msg.patternId === "rise-in", `hovering Rise in previews on tab ${TAB} again (${ids(sent)} → ${sent.map((x) => x.tabId).join(",")})`);
    await park();
    await settle(200);
    await click(rePick.first());
    await waitPicking("start");
    seq = await mark();
    await switchTab(OTHER);
    await settle(300);
    sent = await motionSent(seq);
    ok(toTab(sent, TAB).filter((x) => x.msg.type === "motion.pick-cancel").length === 1, `switching away mid-pick sends motion.pick-cancel once, to ${TAB} (${typesOf(toTab(sent, TAB))})`);
    ok(toTab(sent, OTHER).length === 0, `and still nothing to ${OTHER}`);
    m = await motion();
    ok(m.picking === null && m.away === true, `picking is cleared and away is true (${m.picking}, ${m.away})`);
    const awayMark2 = await mark();
    ok((await injectsTo(awayMark2, OTHER)).length === 0, `still no injection into tab ${OTHER} before "Pick here" (F2)`);
    seq = await mark();
    const pickHereMark = seq;
    await click(pickHere);
    await waitPicking("start");
    sent = await motionSent(seq);
    m = await motion();
    ok(m.tabId === null && m.away === false && m.pickedTarget === null && m.patternId === null, `"Pick here" clears the pin and the target (${m.tabId}, ${m.away})`);
    ok(toTab(sent, OTHER).filter((x) => x.msg.type === "motion.pick-element").length === 1 && m.picking === "start", `and arms pick mode on the ACTIVE tab ${OTHER} (${typesOf(toTab(sent, OTHER))})`);
    ok(sent.filter((x) => x.msg.type === "motion.stop").every((x) => x.tabId === TAB), `its stop (if any) went to the old pin ${TAB}, not ${OTHER}`);
    // F2: in the whole run so far tab 9 was addressed exactly once — by
    // "Pick here" — and only from then on may the script be put there.
    const pickElementsTo9 = await page.evaluate((id) => (window.__tabMessages || []).filter((x) => x.tabId === id && x.msg.type === "motion.pick-element").length, OTHER);
    ok(pickElementsTo9 === 1, `tab ${OTHER} has received exactly ONE motion.pick-element so far — "Pick here" (${pickElementsTo9})`);
    ok((await injectsTo(awayMark2, OTHER)).every((r) => r.seq > pickHereMark), `any injection into tab ${OTHER} came only after "Pick here" (F2)`);

    // F6 (lead decision): leaving the tab an UNPINNED pick is armed on
    // cancels it THERE and arms nothing on the new tab (that would inject
    // into every tab visited); the card says why pick mode went off.
    seq = await mark();
    await switchTab(TAB);
    await settle(300);
    sent = await motionSent(seq);
    ok(toTab(sent, OTHER).filter((x) => x.msg.type === "motion.pick-cancel").length === 1, `switching away from an unpinned armed pick sends motion.pick-cancel once, to ${OTHER} (${typesOf(toTab(sent, OTHER))})`);
    ok(sent.filter((x) => x.msg.type === "motion.pick-element").length === 0, `and arms nothing on tab ${TAB} — no auto-arm (F6) (${typesOf(toTab(sent, TAB))})`);
    m = await motion();
    ok(m.picking === null && m.tabId === null && m.away === false && m.offReason === "switched", `picking null, no pin, not away, offReason "switched" (${m.picking}, ${m.tabId}, ${m.away}, ${m.offReason})`);
    const switchedCopy = page.getByText("You switched tabs, so pick mode is off.", { exact: true });
    ok(await switchedCopy.isVisible(), 'the card reads "You switched tabs, so pick mode is off."');
    ok((await page.getByText("Pick mode is off.", { exact: true }).count()) === 0, 'not the plain Esc copy "Pick mode is off."');
    ok(await pickLink.isVisible(), 'with the same "Pick on page" link');
    await page.screenshot({ path: path.join(SHOTS, "motion-switched-off.png"), fullPage: true });
    seq = await mark();
    await switchTab(OTHER);
    await settle(300);
    ok((await motionSent(seq)).filter((x) => x.msg.type === "motion.pick-element").length === 0 && (await switchedCopy.isVisible()), "coming back arms nothing either — the copy stays until the link is clicked");
    seq = await mark();
    await click(pickLink);
    await waitPicking("start");
    sent = await motionSent(seq);
    m = await motion();
    ok(toTab(sent, OTHER).filter((x) => x.msg.type === "motion.pick-element").length === 1 && m.picking === "start" && m.offReason === null, `"Pick on page" arms the ACTIVE tab ${OTHER} and clears the reason (${typesOf(toTab(sent, OTHER))}, ${m.offReason})`);
    ok(await page.getByText("Esc leaves pick mode.", { exact: true }).isVisible(), 'the hint is back to "Esc leaves pick mode."');
    seq = await mark();
    await fromPage({ type: "motion.picked", target: GRID }, OTHER);
    await settle(150);
    m = await motion();
    ok(m.tabId === OTHER && m.pickedTarget && m.pickedTarget.selector === "ul.grid", `a pick from tab ${OTHER} pins ${OTHER} (${m.tabId})`);
    sent = await sentAfter(seq, "motion.rehearse");
    ok(sent.length === 1 && sent[0].tabId === OTHER && sent[0].msg.patternId === "stagger", `and its auto-play rehearses on ${OTHER} (${ids(sent)} → ${sent.map((x) => x.tabId).join(",")})`);
    await page.evaluate(() => window.__app.stopMotionRehearsal());
    await settle();

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
