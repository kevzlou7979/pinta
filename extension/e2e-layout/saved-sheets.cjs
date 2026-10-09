#!/usr/bin/env node
// Real-Chromium regression for standalone Test Pilot's saved sheets.
//
// Request: a tester with no companion runs several projects' sheets (AWP,
// BCP…) in one browser. Importing the second sheet used to replace the
// first, so switching projects meant re-importing and losing the marks.
// Now every sheet is kept — the open one in the standalone slot, the rest
// in IndexedDB — and a switcher beside the title swaps them.
//
// This drives the tab's own file input and switcher against the REAL
// IndexedDB store (the component suite uses an in-memory shelf).
//
//   node e2e-layout/saved-sheets.cjs            build + run
//   node e2e-layout/saved-sheets.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                 as run.cjs
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

// Tester sheets as the developer's Pinta exports them (doc-id envelope).
const sheet = (docId, title, prefix) =>
  `---\npinta-test-pilot: 1\ndoc-id: ${docId}\n---\n\n# ${title}\n\n## 1.1 Login & Session\n\n` +
  `| ID | Test | Expected Result | Result |\n|----|------|-----------------|--------|\n` +
  `| ${prefix}-01 | Login page fields and elements | Username and password fields show |  |\n` +
  `| AUTH-06 | Log out from the user menu | Returns to login |  |\n` +
  `| ${prefix}-03 | Forgot password | Recovery form opens |  |\n\n` +
  `## 1.2 Dashboard\n\n| ID | Test | Expected Result | Result |\n|----|------|-----------------|--------|\n` +
  `| ${prefix}-10 | Dashboard loads | Widgets show |  |\n`;
const BCP = { docId: "e2e-bcp", title: "UAT — Broker Connect Portal (BCP) — Thorough", md: sheet("e2e-bcp", "UAT — Broker Connect Portal (BCP) — Thorough", "BCP") };
const AWP = { docId: "e2e-awp", title: "UAT — Agent Web Portal (AWP)", md: sheet("e2e-awp", "UAT — Agent Web Portal (AWP)", "AWP") };

function build() {
  console.log("[saved-sheets] building →", OUT);
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
    // One context for the whole run: IndexedDB must survive the reload.
    const context = await browser.newContext({ viewport: { width: 420, height: 760 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    const url = `http://127.0.0.1:${srv.address().port}/?variant=test-pilot`;
    const ready = () => page.waitForFunction(() => window.__harnessVariant === "test-pilot" && !!window.__app);
    await page.goto(url);
    await ready();
    const input = () => page.locator('input[type="file"]').first();
    const pick = (name, md) => input().setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(md, "utf8") });
    const onScreen = (docId) => page.waitForFunction((id) => window.__app.testPilot.catalog?.docId === id, docId, { timeout: 8000 }).catch(() => {});
    const state = () =>
      page.evaluate(() => {
        const t = window.__app.testPilot;
        const tests = t.catalog ? t.catalog.sections.flatMap((s) => s.tests) : [];
        return {
          docId: t.catalog?.docId ?? null,
          title: t.catalog?.title ?? null,
          status: Object.fromEntries(tests.map((x) => [x.id, x.status])),
          notes: tests.flatMap((x) => (x.failNotes ?? []).map((n) => `${x.id}: ${n.description}`)),
          saved: t.savedSheets.map((s) => ({ docId: s.docId, title: s.title, pass: s.pass, fail: s.fail, total: s.total })),
          error: t.error,
        };
      });
    // Rows of the real IndexedDB store, read independently of the app.
    const idbRows = () =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("pinta-standalone");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains("test_sheets")) return resolve(null);
              const req = db.transaction("test_sheets", "readonly").objectStore("test_sheets").getAll();
              req.onsuccess = () => {
                db.close();
                resolve(req.result.map((r) => ({ docId: r.docId, marked: r.catalog.sections.flatMap((s) => s.tests).filter((x) => x.status !== "untested").length })));
              };
              req.onerror = () => reject(req.error);
            };
          }),
      );
    const text = () => page.locator("#shell-main").innerText();

    console.log("\n[saved-sheets] first sheet: import BCP, fail a test and write a failure note");
    await pick("bcp-uat.md", BCP.md);
    await onScreen(BCP.docId);
    ok((await state()).docId === BCP.docId, "BCP is on screen");
    const switcher = page.getByRole("button", { name: "Switch test sheet" });
    ok(await switcher.isVisible(), "the sheet switcher sits beside the title");
    ok((await switcher.innerText()).trim() === "1", "it counts one sheet");
    await page.getByRole("button", { name: "Set status for BCP-01" }).click();
    await page.getByRole("menuitem", { name: "Pass" }).click();
    await page.getByRole("button", { name: "Set status for AUTH-06" }).click();
    await page.getByRole("menuitem", { name: "Fail" }).click();
    await page.getByRole("button", { name: "Add failure note for AUTH-06" }).click();
    await page.getByLabel("Failure description for AUTH-06").fill("BCP: dashboard stays on screen after Log out");
    await page.getByRole("button", { name: "Save note" }).click();
    ok((await state()).notes.join() === "AUTH-06: BCP: dashboard stays on screen after Log out", "failure note saved on BCP");

    console.log("\n[saved-sheets] second project: importing AWP keeps BCP instead of replacing it");
    await pick("awp-uat.md", AWP.md);
    await onScreen(AWP.docId);
    let s = await state();
    ok(s.docId === AWP.docId && s.status["AWP-01"] === "untested", "AWP is on screen, unmarked");
    ok(!(await page.getByRole("dialog").filter({ hasText: "Replace test catalog?" }).isVisible()), "no \"Replace test catalog?\" prompt");
    ok(JSON.stringify(s.saved) === JSON.stringify([{ docId: BCP.docId, title: BCP.title, pass: 1, fail: 1, total: 4 }]), `BCP is saved with its marks (${JSON.stringify(s.saved)})`);
    ok(JSON.stringify(await idbRows()) === JSON.stringify([{ docId: BCP.docId, marked: 2 }]), "BCP is really in IndexedDB (test_sheets)");
    ok((await switcher.innerText()).trim() === "2", "the switcher now counts two sheets");
    ok(!/BCP: dashboard stays on screen/.test(await text()), "BCP's failure note is not shown on AWP (both have an AUTH-06)");
    await page.getByRole("button", { name: "Set status for AWP-03" }).click();
    await page.getByRole("menuitem", { name: "Fail" }).click();

    console.log("\n[saved-sheets] the switcher menu lists both and fits inside the panel");
    await switcher.click();
    const menu = page.getByRole("dialog", { name: "Your test sheets" });
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await menu.isVisible(), "menu opens");
    const menuText = (await menu.innerText()).replace(/\s+/g, " ");
    ok(menuText.includes(AWP.title) && /1 of 4 run · 1 failed · open now/.test(menuText), "the open sheet is listed with its progress");
    ok(menuText.includes(BCP.title) && /2 of 4 run · 1 failed/.test(menuText), "the saved sheet is listed with its progress");
    const box = await menu.boundingBox();
    ok(!!box && box.x >= 0 && box.x + box.width <= 420 + 0.5, `menu stays inside the 420px panel (x ${box && Math.round(box.x)}–${box && Math.round(box.x + box.width)})`);
    const overflow = await page.evaluate(() => ({ doc: document.scrollingElement.scrollLeft, main: document.getElementById("shell-main").scrollWidth - document.getElementById("shell-main").clientWidth }));
    ok(overflow.doc === 0 && overflow.main <= 0, "no horizontal scrollbar while the menu is open");
    await page.screenshot({ path: path.join(SHOTS, "saved-sheets-menu.png") });

    console.log("\n[saved-sheets] the menu opens under its button, not across the panel from it");
    // Reported: on a wide panel the button sits at the right of the title
    // row but the menu opened at the far left. Its right edge must line up
    // with the button's; on a narrow panel it slides right to stay inside.
    const edges = async () => {
      const b = await switcher.boundingBox();
      const m = await menu.boundingBox();
      return { btnRight: Math.round(b.x + b.width), btnBottom: Math.round(b.y + b.height), left: Math.round(m.x), right: Math.round(m.x + m.width), top: Math.round(m.y) };
    };
    let e = await edges();
    ok(e.left >= 16 && e.right <= 420 - 16 + 1, `420px panel: menu keeps the gutters (${e.left}–${e.right})`);
    // The title wraps to two lines here, so the row is taller than the button.
    ok(e.top >= e.btnBottom && e.top - e.btnBottom <= 48, `420px panel: menu opens below the title row, never over it (${e.top} vs button bottom ${e.btnBottom})`);
    await page.locator("#shell-header").click(); // close
    for (const width of [900, 640]) {
      await page.setViewportSize({ width, height: 760 });
      await switcher.click();
      await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      e = await edges();
      ok(Math.abs(e.right - e.btnRight) <= 1, `${width}px panel: menu's right edge is under the button's (${e.right} vs ${e.btnRight})`);
      ok(e.left >= 16, `${width}px panel: menu stays inside the panel (left ${e.left})`);
      if (width === 900) await page.screenshot({ path: path.join(SHOTS, "saved-sheets-menu-wide.png") });
      await page.locator("#shell-header").click();
    }
    // Resizing with the menu open closes it instead of leaving it adrift.
    await switcher.click();
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await page.setViewportSize({ width: 420, height: 760 });
    await page.waitForTimeout(100);
    ok(!(await menu.isVisible()), "resizing the panel closes the open menu");
    await switcher.click();
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});

    console.log("\n[saved-sheets] one click brings BCP back — marks and the failure note included, no re-import");
    await menu.getByRole("button", { name: `Open ${BCP.title}` }).click();
    await onScreen(BCP.docId);
    s = await state();
    ok(s.docId === BCP.docId, "BCP is on screen again");
    ok(s.status["BCP-01"] === "pass" && s.status["AUTH-06"] === "fail", `its marks are back (${JSON.stringify(s.status)})`);
    ok(/BCP: dashboard stays on screen after Log out/.test(await text()), "its failure note is shown under AUTH-06");
    ok(!(await menu.isVisible()), "the menu closed");
    ok(JSON.stringify(s.saved) === JSON.stringify([{ docId: AWP.docId, title: AWP.title, pass: 0, fail: 1, total: 4 }]), `AWP took its place, with its own mark (${JSON.stringify(s.saved)})`);
    ok(JSON.stringify(await idbRows()) === JSON.stringify([{ docId: AWP.docId, marked: 1 }]), "IndexedDB now holds AWP only — no stale BCP copy");
    await page.screenshot({ path: path.join(SHOTS, "saved-sheets-switched.png") });

    console.log("\n[saved-sheets] an outside click closes the menu");
    await switcher.click();
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await page.locator("#shell-header").click();
    ok(!(await menu.isVisible()), "clicking outside closes the menu");

    console.log("\n[saved-sheets] Escape closes the menu and returns focus to the switcher");
    await switcher.click();
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await page.keyboard.press("Escape");
    ok(!(await menu.isVisible()), "Escape closes the menu");
    ok(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Switch test sheet"), "focus is back on the switcher");

    console.log("\n[saved-sheets] the saved sheet survives a full page reload (real IndexedDB)");
    await page.reload();
    await ready();
    // The harness's chrome.storage stub is memory-only, so after a reload
    // the open slot is empty: the "nothing on screen, sheets saved" case.
    await page.evaluate(() => window.__app.loadTestPilot(null));
    await page.waitForFunction(() => window.__app.testPilot.savedSheets.length === 1, null, { timeout: 8000 }).catch(() => {});
    s = await state();
    ok(s.docId === null, "nothing is opened on its own (a connecting project would adopt it)");
    const list = page.locator("[data-pinta-saved-sheets]");
    ok(await list.isVisible(), "the empty screen lists \"Your saved sheets\"");
    ok(/UAT — Agent Web Portal \(AWP\)/.test(await list.innerText()) && /1 of 4 run · 1 failed/.test((await list.innerText()).replace(/\s+/g, " ")), "AWP is listed with its progress, read from IndexedDB");
    const fit = await page.evaluate(() => { const m = document.getElementById("shell-main"); return m.scrollWidth - m.clientWidth; });
    ok(fit <= 0, "the list fits the panel (no horizontal scrollbar)");
    await page.screenshot({ path: path.join(SHOTS, "saved-sheets-empty.png") });
    await list.getByRole("button", { name: `Open ${AWP.title}` }).click();
    await onScreen(AWP.docId);
    s = await state();
    ok(s.docId === AWP.docId && s.status["AWP-03"] === "fail", `AWP reopened from IndexedDB with its mark (${JSON.stringify(s.status)})`);
    ok(s.error === null, "no error");
    ok(JSON.stringify(await idbRows()) === JSON.stringify([]), "it moved off the shelf when it opened");

    console.log("\n[saved-sheets] deleting a saved sheet asks first");
    await pick("bcp-uat.md", BCP.md);
    await onScreen(BCP.docId);
    await page.getByRole("button", { name: "Switch test sheet" }).click();
    await page.getByRole("button", { name: `Delete saved sheet ${AWP.title}` }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Delete this saved sheet?" });
    await confirm.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await confirm.isVisible(), "\"Delete this saved sheet?\" prompt appears");
    await confirm.getByRole("button", { name: "Delete sheet" }).click();
    await page.waitForFunction(() => window.__app.testPilot.savedSheets.length === 0, null, { timeout: 5000 }).catch(() => {});
    s = await state();
    ok(s.saved.length === 0 && s.docId === BCP.docId, "the saved sheet is gone, the open one untouched");
    ok(JSON.stringify(await idbRows()) === JSON.stringify([]), "and it is gone from IndexedDB");
    await page.close();
    await context.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[saved-sheets] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[saved-sheets] crashed:", e);
  process.exit(2);
});
