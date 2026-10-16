#!/usr/bin/env node
// Real-Chromium regression for "Report: declare the owner".
//
// The Report tab says whose work it covers. Report settings (the gear)
// takes the owner's git author name and/or emails — up to 5 — and the
// report is gathered for those committers only; with none it covers
// every committer and says so. The owner shows above the report, is
// written under the title of the markdown export, and a report generated
// before the setting changed is flagged until it is regenerated.
//
// Mounts the whole side panel with Report on (`?variant=report`). There
// is no companion: every message the panel sends lands in window.__sent
// and the script answers as the agent would (`session.synced` through
// `__app.onMessage`). Guards: the tab gate, the owner line, the settings
// dialog copy, add / remove (Enter and the button), normalization and
// every refusal, persistence under `pinta-report-owners`, the
// `author` / `authors` shape of the query, the stamp on the finished run,
// the stale flag, the "covers only" mismatch banner, the export, a
// pending run with no `authors` (the loading-states walk) and one pass
// at 600px wide. The companion-side half (`git log --author` per entry)
// is a SKILL.md rule and can't be driven from a browser.
//
//   node e2e-layout/report-owner.cjs            build + run
//   node e2e-layout/report-owner.cjs --no-build reuse an existing dist
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

function build() {
  console.log("[report-owner] building →", OUT);
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

const TAB = 7;
const PAGE_URL = "http://localhost:5173/dashboard";
const COPY =
  "Whose work the report covers. Add the git author name or email the commits are made under — add more if the same person commits under several. With none, the report covers every committer.";
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

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

  /** Open the panel at a width, play the companion, land on the Report tab. */
  const open = async (width) => {
    const context = await browser.newContext({ viewport: { width, height: 760 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message.slice(0, 200));
      failures.push(`pageerror (${width}px): ` + e.message.slice(0, 200));
    });
    await page.addInitScript(
      ({ TAB, PAGE_URL }) => {
        window.__tabs = [{ id: TAB, url: PAGE_URL, active: true, windowId: 1 }];
        // The export writes a .md through a blob URL + <a download>;
        // keep the blob and swallow the click so nothing downloads.
        window.__blobs = [];
        const realCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => {
          window.__blobs.push(b);
          return realCreate(b);
        };
        const realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.hasAttribute("download")) return;
          return realClick.call(this);
        };
      },
      { TAB, PAGE_URL },
    );
    await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=report`);
    await page.waitForFunction(() => window.__harnessVariant === "report" && !!window.__app);
    await page
      .waitForFunction(() => (window.__runtimeSent || []).some((r) => r.msg && r.msg.type === "ensure-content-script"), null, { timeout: 5000 })
      .catch(() => {});
    await page.evaluate(() => {
      const app = window.__app;
      window.__sent = [];
      // The pattern must cover the tab, or the "associate this page?"
      // prompt replaces the tab bar.
      app.selectedCompanion = { port: 7878, projectRoot: "C:/proj/pinta", urlPatterns: ["http://localhost:5173/*"] };
      app.connectionStatus = "connected";
      app.client = { send: (m) => window.__sent.push(m) };
      app.report.owners = [];
      app.report.projects = [];
      app.report.currentRun = null;
      app.report.pending = null;
      app.report.error = null;
      app.report.range = "daily";
    });
    return { context, page, errors };
  };

  /** Helpers bound to one page. */
  const bind = (page) => {
    const settle = (ms = 60) => page.waitForTimeout(ms);
    const nav = page.locator("nav");
    const reportTab = nav.getByRole("button", { name: "Report", exact: true });
    const ownerLine = page.locator("[data-pinta-report-owner]");
    const ownerText = async () => norm(await ownerLine.innerText().catch(() => ""));
    const stale = page.locator("[data-pinta-report-owner-stale]");
    const gear = page.getByRole("button", { name: "Report settings", exact: true });
    const dialog = page.getByRole("dialog", { name: "Report settings" });
    const input = dialog.getByLabel("Report owner — git author name or email");
    const addBtn = dialog.getByRole("button", { name: "Add owner", exact: true });
    const refusal = dialog.locator('[role="status"]');
    // The refusal's own words, without the ✕ that follows them.
    const refusalText = () => refusal.locator("span").first().innerText().catch(() => "");
    const chip = (name) => dialog.getByRole("button", { name: `Remove owner ${name}`, exact: true });
    const owners = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__app.report.owners)));
    const stored = () => page.evaluate(async () => (await chrome.storage.local.get("pinta-report-owners"))["pinta-report-owners"] ?? null);
    const lastQuery = () =>
      page.evaluate(() => {
        const m = (window.__sent || []).filter((x) => x.type === "module.query.submit").at(-1);
        return m ? { comment: JSON.parse(m.queryComment), raw: m.queryComment, total: window.__sent.length } : null;
      });
    const generateBtn = page.getByRole("button", { name: /^(Generate|Regenerate) report$/ });
    const generate = async () => {
      await generateBtn.click();
      await page.waitForFunction(() => !!window.__app.report.pending, null, { timeout: 3000 }).catch(() => {});
      return lastQuery();
    };
    // Answer the open run as the agent. `extra` is merged into the
    // report payload (e.g. an `authors` echo).
    const finish = (raw, extra = {}) =>
      page.evaluate(
        ({ raw, extra }) => {
          const q = JSON.parse(raw);
          const payload = {
            type: "report",
            days: [{ date: q.since, items: [{ id: "a1", title: "Fix login redirect", category: "bug-fix", source: "git" }] }],
            ...extra,
          };
          window.__app.onMessage({
            type: "session.synced",
            session: {
              id: `e2e-${q.runId}`,
              url: q.url,
              status: "done",
              modules: [{ id: "report" }],
              annotations: [{ id: "q1", kind: "query", comment: raw }],
              appliedSummary: JSON.stringify(payload),
            },
          });
        },
        { raw, extra },
      );
    const settled = () => page.waitForFunction(() => !window.__app.report.pending, null, { timeout: 5000 }).catch(() => {});
    const typeOwner = async (value) => {
      await input.fill(value);
      await settle(30);
    };
    return { settle, reportTab, ownerLine, ownerText, stale, gear, dialog, input, addBtn, refusal, refusalText, chip, owners, stored, lastQuery, generateBtn, generate, finish, settled, typeOwner };
  };

  try {
    // ======================================================================
    // 380 × 760 — the full walk
    // ======================================================================
    const { page, errors } = await open(380);
    const t = bind(page);
    const inside = async (loc, width) => {
      const box = await loc.boundingBox();
      return !!box && box.x >= 0 && box.x + box.width <= width + 0.5;
    };

    console.log("\n[report-owner] 1 · the tab, the owner line, the settings dialog");
    await t.reportTab.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok(await t.reportTab.isVisible(), "the Report tab shows with the module enabled");
    await t.reportTab.click();
    await t.ownerLine.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok(await t.ownerLine.isVisible(), "the owner line is on screen");
    ok((await t.ownerText()) === "Owner All committers", `with no owner it reads "Owner All committers" ("${await t.ownerText()}")`);
    ok(await page.getByRole("button", { name: "Report owner: All committers — change", exact: true }).isVisible(), "the name is a button that opens the settings");
    ok(await t.gear.isVisible(), 'a gear button named "Report settings" is in the toolbar');
    await t.gear.click();
    await t.dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await t.dialog.isVisible(), 'it opens a dialog named "Report settings"');
    const section = t.dialog.locator("[data-pinta-report-owner-settings]");
    ok((await section.count()) === 1, "the dialog has the Owner section");
    // textContent: the heading is `uppercase` by CSS, innerText would read OWNER.
    ok(norm(await section.locator("h4").first().textContent()) === "Owner", 'the section is headed "Owner"');
    const para = norm(await section.locator("p").first().innerText());
    ok(para === COPY, `the paragraph copy is exact ("${para}")`);
    ok(norm(await section.innerText()).includes("All committers"), 'with no owner the section shows the "All committers" pill');
    ok(await inside(t.dialog, 380), "the dialog stays inside the 380px panel");
    ok(norm(await section.locator("[data-pinta-report-owner-count]").innerText()) === "0 of 5", 'the cap reads "0 of 5" beside the heading (F9)');
    await page.screenshot({ path: path.join(SHOTS, "report-owner-dialog-empty.png") });
    // Keyboard: focus starts in the owner input, Tab / Shift+Tab stay
    // inside, Esc closes and hands focus back to the gear (F4, F7).
    ok(await t.input.evaluate((el) => document.activeElement === el), "focus starts in the owner input");
    await page.keyboard.press("Shift+Tab");
    ok(await t.dialog.getByRole("button", { name: "Close", exact: true }).evaluate((el) => document.activeElement === el), "Shift+Tab from the input lands on Close (the first control)");
    await page.keyboard.press("Shift+Tab");
    ok(await t.dialog.evaluate((d) => d.contains(document.activeElement) && document.activeElement !== d), "Shift+Tab from the first control wraps to the last — focus stays inside the dialog");
    await page.keyboard.press("Tab");
    ok(await t.dialog.getByRole("button", { name: "Close", exact: true }).evaluate((el) => document.activeElement === el), "Tab from the last control wraps to Close");
    const dialogTop = (await t.dialog.boundingBox()).y;
    await page.keyboard.press("Escape");
    await t.settle();
    ok((await t.dialog.count()) === 0, "Esc closes the dialog");
    ok(await t.gear.evaluate((el) => document.activeElement === el), "and focus returns to the gear");
    await t.gear.click();
    await t.dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await t.dialog.isVisible(), "the gear reopens it");
    // Anchored to a fixed top: a refusal banner must not re-centre it (F11).
    await t.typeOwner("x");
    await t.input.press("Enter");
    await t.settle();
    ok((await t.refusal.count()) === 1, "a refusal shows under the input");
    ok(Math.abs((await t.dialog.boundingBox()).y - dialogTop) < 1, `the dialog's top does not move when the refusal appears (${dialogTop} → ${(await t.dialog.boundingBox()).y})`);
    ok((await t.refusalText()) === "Use a git author name or email (2–100 characters: letters, numbers, spaces, . _ ' - + @).", `the refusal copy is exact ("${await t.refusalText()}")`);
    await t.refusal.getByRole("button", { name: "Dismiss", exact: true }).click();
    await t.input.fill("");
    await t.settle();

    console.log("\n[report-owner] 2 · Enter adds an owner; it shows, it persists");
    await t.typeOwner("Mark Baldemor");
    await t.input.press("Enter");
    await t.settle();
    ok(await t.chip("Mark Baldemor").isVisible(), 'a chip with a "Remove owner Mark Baldemor" button appears');
    ok((await t.input.inputValue()) === "", "the input is cleared");
    ok((await t.refusal.count()) === 0, "no refusal is shown");
    ok(norm(await section.innerText()).includes("All committers") === false, 'the "All committers" pill is gone');
    ok(JSON.stringify(await t.owners()) === JSON.stringify(["Mark Baldemor"]), `app.report.owners = ["Mark Baldemor"] (${JSON.stringify(await t.owners())})`);
    ok(JSON.stringify(await t.stored()) === JSON.stringify(["Mark Baldemor"]), `chrome.storage.local["pinta-report-owners"] = ["Mark Baldemor"] (${JSON.stringify(await t.stored())})`);
    ok((await t.ownerText()) === "Owner Mark Baldemor", `the owner line now reads "Owner Mark Baldemor" ("${await t.ownerText()}")`);

    console.log("\n[report-owner] 3 · normalization and every refusal");
    // Extra spaces + case: the same person → refused as a repeat.
    await t.typeOwner("  mark   baldemor  ");
    await t.input.press("Enter");
    await t.settle();
    let said = norm(await t.refusalText());
    ok(/already listed/.test(said) && /mark baldemor/.test(said), `"  mark   baldemor  " is refused as a repeat of Mark Baldemor ("${said}")`);
    ok((await t.owners()).length === 1, "and nothing was added");
    // A pasted line break is just spacing (a text input strips LF, so
    // this goes through the same entry point the dialog calls).
    const viaApi = await page.evaluate(() => window.__app.addReportOwner("  mark\nbaldemor  "));
    ok(/already listed/.test(viaApi || ""), `"  mark\\nbaldemor  " is refused as the same person ("${viaApi}")`);
    const dismiss = t.refusal.getByRole("button", { name: "Dismiss", exact: true });
    ok(await dismiss.isVisible(), "the refusal has a Dismiss ✕");
    await dismiss.click();
    await t.settle();
    ok((await t.refusal.count()) === 0, "✕ clears the refusal");
    // Unicode letters and _ are fine; the value is trimmed.
    await t.typeOwner(" José_Ñ ");
    await t.addBtn.click();
    await t.settle();
    ok(await t.chip("José_Ñ").isVisible(), '" José_Ñ " is accepted as "José_Ñ"');
    ok(JSON.stringify(await t.owners()) === JSON.stringify(["Mark Baldemor", "José_Ñ"]), `owners = ${JSON.stringify(await t.owners())}`);
    // Too short.
    await t.typeOwner("x");
    await t.addBtn.click();
    await t.settle();
    said = norm(await t.refusalText());
    ok(said.includes("Use a git author name or email"), `"x" is refused ("${said}")`);
    ok((await t.owners()).length === 2, "and nothing was added");
    // Typing again clears the refusal; empty + Enter asks for a name.
    await t.typeOwner("");
    ok((await t.refusal.count()) === 0, "the next keystroke clears the refusal");
    ok(await t.addBtn.isDisabled(), "Add is disabled while the box is empty");
    await t.input.press("Enter");
    await t.settle();
    said = norm(await t.refusalText());
    ok(said === "Type a git author name or email.", `Enter on an empty box says "Type a git author name or email." ("${said}")`);
    // Flag-like input never gets in.
    await t.typeOwner("--all");
    await t.addBtn.click();
    await t.settle();
    said = norm(await t.refusalText());
    ok(said.includes("Use a git author name or email") && (await t.owners()).length === 2, `"--all" is refused ("${said}")`);
    // Up to 5.
    await t.typeOwner("mark.baldemor@insclix.com");
    await t.input.press("Enter");
    await t.typeOwner("kevzlou7979");
    await t.input.press("Enter");
    await t.typeOwner("Dana Cruz");
    await t.input.press("Enter");
    await t.settle();
    ok((await t.owners()).length === 5, `five owners are listed (${JSON.stringify(await t.owners())})`);
    ok(await t.input.isDisabled(), "the input is disabled at 5");
    ok(await t.addBtn.isDisabled(), "Add is disabled at 5");
    const sixth = await page.evaluate(() => window.__app.addReportOwner("a6"));
    ok(sixth === "Up to 5 names or emails — remove one first.", `a sixth is refused with "Up to 5 names or emails — remove one first." ("${sixth}")`);
    ok((await t.owners()).length === 5, "and the list stays at 5");
    ok(await inside(t.dialog, 380), "a full dialog still fits inside the 380px panel");
    await page.screenshot({ path: path.join(SHOTS, "report-owner-dialog-full.png") });

    console.log("\n[report-owner] 4 · removing a chip");
    await t.chip("Dana Cruz").click();
    await t.settle();
    ok((await t.chip("Dana Cruz").count()) === 0, "the chip is gone");
    ok(!(await t.owners()).includes("Dana Cruz"), `it left app.report.owners (${JSON.stringify(await t.owners())})`);
    ok(!((await t.stored()) || []).includes("Dana Cruz"), `and storage (${JSON.stringify(await t.stored())})`);
    ok(await t.input.isEnabled(), "the input is enabled again");
    await t.chip("José_Ñ").click();
    await t.chip("kevzlou7979").click();
    await t.chip("mark.baldemor@insclix.com").click();
    await t.settle();
    ok(JSON.stringify(await t.owners()) === JSON.stringify(["Mark Baldemor"]), `down to ["Mark Baldemor"] (${JSON.stringify(await t.owners())})`);
    await t.dialog.getByRole("button", { name: "Close", exact: true }).click();
    await t.settle();
    ok((await t.dialog.count()) === 0, "Close shuts the dialog");
    ok((await t.ownerText()) === "Owner Mark Baldemor", `the owner line follows the setting ("${await t.ownerText()}")`);

    console.log("\n[report-owner] 5 · the query carries the owner");
    let q = await t.generate();
    ok(!!q && q.comment.op === "report-generate", "Generate submits a report-generate query");
    ok(!!q && q.comment.author === "Mark Baldemor", `one owner → author: "Mark Baldemor" (${q && JSON.stringify(q.comment.author)})`);
    ok(!!q && !("authors" in q.comment), "one owner → no `authors` (lean, old-skill shape)");
    ok((await t.ownerText()) === "Owner Mark Baldemor", `while pending the line names the run in flight ("${await t.ownerText()}")`);
    await t.finish(q.raw);
    await t.settled();
    ok(await page.evaluate(() => !window.__app.report.pending && !!window.__app.report.currentRun), "the agent's reply lands as the current run");
    ok(await page.evaluate(() => JSON.stringify(window.__app.report.currentRun.authors) === JSON.stringify(["Mark Baldemor"])), "the run is stamped with the owner asked");
    ok((await t.stale.count()) === 0, "no stale flag after a fresh run");
    // Three identities.
    await page.evaluate(() => {
      window.__app.addReportOwner("mark.baldemor@insclix.com");
      window.__app.addReportOwner("kevzlou7979");
    });
    await t.settle();
    ok(await t.stale.isVisible(), "adding identities after the run flags it");
    q = await t.generate();
    ok(!!q && q.comment.author === "Mark Baldemor", `three owners → author is the first (${q && JSON.stringify(q.comment.author)})`);
    ok(!!q && Array.isArray(q.comment.authors) && q.comment.authors.length === 3, `three owners → authors has 3 (${q && JSON.stringify(q.comment.authors)})`);
    ok(!!q && JSON.stringify(q.comment.authors) === JSON.stringify(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]), "in the order declared");
    ok((await t.stale.count()) === 0, "the flag clears while the regenerate is in flight");

    console.log("\n[report-owner] 6 · the finished run is stamped; the stale flag");
    await t.finish(q.raw, { authors: ["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"] });
    await t.settled();
    ok(
      await page.evaluate(() => JSON.stringify(window.__app.report.currentRun.authors) === JSON.stringify(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"])),
      "the run is stamped with the three owners asked",
    );
    ok((await t.ownerText()) === "Owner Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979", `the owner line names them ("${await t.ownerText()}")`);
    ok(await page.evaluate(() => window.__app.report.error === null), "no error banner");
    ok((await t.stale.count()) === 0, "no stale flag");
    ok(await inside(t.ownerLine, 380), "the long owner line wraps inside 380px");
    await page.screenshot({ path: path.join(SHOTS, "report-owner-three.png") });
    // Change the setting: a 4th identity.
    await t.gear.click();
    await t.typeOwner("Dana Cruz");
    await t.input.press("Enter");
    await t.dialog.getByRole("button", { name: "Close", exact: true }).click();
    await t.settle();
    ok((await t.ownerText()).startsWith("Owner Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979"), `the line keeps naming who the run on screen covers ("${await t.ownerText()}")`);
    const staleText = norm(await t.stale.innerText().catch(() => ""));
    ok(staleText.includes("regenerate"), `a stale flag says to regenerate ("${staleText}")`);
    ok(staleText === "— now set to Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979, Dana Cruz; regenerate to apply", "with the exact wording");
    ok(await inside(t.stale, 380), "the flag stays inside the panel");
    await page.screenshot({ path: path.join(SHOTS, "report-owner-stale.png") });
    // Same people in another order / case is not a change.
    await page.evaluate(() => {
      window.__app.removeReportOwner("Dana Cruz");
      window.__app.setReportOwners(["KEVZLOU7979", "mark baldemor", "Mark.Baldemor@insclix.com"]);
    });
    await t.settle();
    ok((await t.stale.count()) === 0, "the same people in another order and case is not a change");
    await page.evaluate(() => window.__app.addReportOwner("Dana Cruz"));
    await t.settle();
    ok(await t.stale.isVisible(), "a 4th identity flags it again");
    ok(await page.getByRole("button", { name: "Regenerate report", exact: true }).isVisible(), 'the button now reads "Regenerate report"');
    q = await t.generate();
    ok(!!q && Array.isArray(q.comment.authors) && q.comment.authors.length === 4, `regenerate asks for the 4 (${q && JSON.stringify(q.comment.authors)})`);
    await t.finish(q.raw, { authors: q.comment.authors });
    await t.settled();
    ok((await t.stale.count()) === 0, "the flag clears once regenerated");
    ok((await t.ownerText()).includes("Dana Cruz"), `the line names the new set ("${await t.ownerText()}")`);

    console.log("\n[report-owner] 7 · the agent confirmed fewer than asked");
    await page.evaluate(() => window.__app.setReportOwners(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]));
    await t.settle();
    q = await t.generate();
    ok(!!q && q.comment.authors && q.comment.authors.length === 3, "asked for 3");
    await t.finish(q.raw, { authors: ["Mark Baldemor"] });
    await t.settled();
    // A NOTICE on a run that succeeded: amber, role=status, never the red
    // alert (F2); plain copy with no backticks (F14).
    const notice = page.locator("[data-pinta-report-notice]");
    await notice.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    const noticeText = norm(await notice.innerText().catch(() => ""));
    ok(noticeText.startsWith("This report covers only “Mark Baldemor”."), `a banner says "This report covers only …" ("${noticeText.slice(0, 80)}")`);
    ok(
      noticeText === "This report covers only “Mark Baldemor”. Your Pinta agent is out of date and filters on one name only. Update it (npx pinta-companion@latest install-skill), restart it, then regenerate. ✕",
      `with the exact copy ("${noticeText}")`,
    );
    ok(!noticeText.includes("`"), "no backticks are rendered");
    ok((await notice.getAttribute("role")) === "status", 'it is a role="status" notice, not an alert');
    ok((await page.getByRole("alert").count()) === 0, "no red alert is shown");
    ok(await page.evaluate(() => window.__app.report.error === null && typeof window.__app.report.notice === "string"), "it lives in report.notice; report.error stays null");
    const noticeColor = await notice.evaluate((el) => getComputedStyle(el).borderColor);
    const [nr, ng, nb] = (noticeColor.match(/\d+/g) || []).map(Number);
    ok(nr > 200 && ng > 150 && nb < 120, `the border is amber, not red (${noticeColor})`);
    ok(await page.evaluate(() => JSON.stringify(window.__app.report.currentRun.authors) === JSON.stringify(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"])), "the run keeps the label it was asked for");
    ok((await t.ownerText()) === "Owner Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979", "the owner line too");
    ok(await inside(notice, 380), "the banner stays inside the panel");
    await page.screenshot({ path: path.join(SHOTS, "report-owner-mismatch.png") });
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    await t.settle();
    ok((await notice.count()) === 0 && (await page.evaluate(() => window.__app.report.notice === null)), "its ✕ clears it");
    // An echo that confirms everyone, or no echo at all, is not a mismatch.
    const clean = () => page.evaluate(() => window.__app.report.error === null && window.__app.report.notice === null);
    q = await t.generate();
    await t.finish(q.raw, { authors: ["kevzlou7979", "Mark Baldemor", "mark.baldemor@insclix.com"] });
    await t.settled();
    ok(await clean(), "an echo of all three (any order) raises no banner");
    q = await t.generate();
    await t.finish(q.raw);
    await t.settled();
    ok(await clean(), "no echo (older skill, can't tell) raises no banner");
    // The notice is about ONE run: the next generate clears it.
    q = await t.generate();
    await t.finish(q.raw, { authors: ["Mark Baldemor"] });
    await t.settled();
    ok(await notice.isVisible(), "a second mismatch raises it again");
    q = await t.generate();
    ok((await notice.count()) === 0 && (await page.evaluate(() => window.__app.report.notice === null)), "the next generate clears it while in flight");
    await t.finish(q.raw, { authors: q.comment.authors });
    await t.settled();
    ok(await clean(), "and a full echo keeps it clear");

    console.log("\n[report-owner] 8 · the markdown export carries the owner");
    const exportBtn = page.getByRole("button", { name: "Export report as markdown", exact: true });
    ok(await exportBtn.isVisible(), "the whole-report export button shows once there is a run");
    await page.evaluate(() => (window.__blobs = []));
    await exportBtn.click();
    await page.waitForFunction(() => window.__blobs.length > 0, null, { timeout: 3000 }).catch(() => {});
    const exported = await page.evaluate(async () => (window.__blobs[0] ? await window.__blobs[0].text() : null));
    ok(typeof exported === "string" && exported.length > 0, `the export writes a markdown file (${exported ? exported.length + " chars" : "nothing"})`);
    ok(
      typeof exported === "string" && /(^|\n)Owner: Mark Baldemor, mark\.baldemor@insclix\.com, kevzlou7979\n/.test(exported),
      `it carries the owner line (got: ${JSON.stringify((exported || "").split("\n").slice(0, 4))})`,
    );
    const detailed = await page.evaluate(() => window.__app.exportReportMarkdown());
    ok(/^# Report — [^\n]+\n\nOwner: Mark Baldemor, mark\.baldemor@insclix\.com, kevzlou7979\n/.test(detailed), `exportReportMarkdown() writes the owner under the title (${JSON.stringify(detailed.split("\n").slice(0, 3))})`);
    ok(typeof exported === "string" && exported.startsWith("Owner: Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979\n\n"), "the summary opens with it, then a blank line");
    // The per-day export (the day card's button) carries it under the heading (F15).
    const dayExportBtn = page.getByRole("button", { name: /^Export (?!report as markdown$).+ as markdown$/ }).first();
    ok(await dayExportBtn.isVisible(), "the day card has its own export button");
    await page.evaluate(() => (window.__blobs = []));
    await dayExportBtn.click();
    await page.waitForFunction(() => window.__blobs.length > 0, null, { timeout: 3000 }).catch(() => {});
    const exportedDay = await page.evaluate(async () => (window.__blobs[0] ? await window.__blobs[0].text() : null));
    ok(
      typeof exportedDay === "string" && /^## [^\n]+\nOwner: Mark Baldemor, mark\.baldemor@insclix\.com, kevzlou7979\n\n/.test(exportedDay),
      `the per-day export writes the owner under the day heading (got: ${JSON.stringify((exportedDay || "").split("\n").slice(0, 3))})`,
    );
    // With no owner declared the summary has no Owner line at all (F6:
    // an invoice paste must not gain "Owner: All committers"); the
    // detailed audit-trail export still says All committers.
    await page.evaluate(() => window.__app.setReportOwners([]));
    q = await t.generate();
    ok(!!q && q.comment.author === null && !("authors" in q.comment), "no owner → author: null, no authors");
    await t.finish(q.raw);
    await t.settled();
    ok((await t.ownerText()) === "Owner All committers", `the line is back to "Owner All committers" ("${await t.ownerText()}")`);
    await page.evaluate(() => (window.__blobs = []));
    await exportBtn.click();
    await page.waitForFunction(() => window.__blobs.length > 0, null, { timeout: 3000 }).catch(() => {});
    const exportedAll = await page.evaluate(async () => (window.__blobs[0] ? await window.__blobs[0].text() : null));
    ok(typeof exportedAll === "string" && exportedAll.length > 0 && !/Owner:/.test(exportedAll), `with no owner the summary has no Owner line (got: ${JSON.stringify((exportedAll || "").split("\n").slice(0, 4))})`);
    await page.evaluate(() => (window.__blobs = []));
    await dayExportBtn.click();
    await page.waitForFunction(() => window.__blobs.length > 0, null, { timeout: 3000 }).catch(() => {});
    const exportedDayAll = await page.evaluate(async () => (window.__blobs[0] ? await window.__blobs[0].text() : null));
    ok(typeof exportedDayAll === "string" && /^## /.test(exportedDayAll) && !/Owner:/.test(exportedDayAll), `with no owner the per-day export has no Owner line (got: ${JSON.stringify((exportedDayAll || "").split("\n").slice(0, 3))})`);
    const detailedAll = await page.evaluate(() => window.__app.exportReportMarkdown());
    ok(/\n\nOwner: All committers\n/.test(detailedAll), "exportReportMarkdown() (the detailed audit trail) still says All committers");

    console.log("\n[report-owner] 9 · a pending run with no `authors` (loading-states walk)");
    const before = errors.length;
    await page.evaluate(() => {
      const app = window.__app;
      app.report.currentRun = null;
      app.report.pending = {
        runId: "walk-1",
        startedAt: Date.now(),
        range: "daily",
        anchorDate: "2026-06-05",
        since: "2026-06-05",
        until: "2026-06-05",
        sessionId: null,
      };
    });
    await t.settle(120);
    ok(await page.getByText("Generating report…").isVisible().catch(() => false), "the loading state renders");
    ok(await t.ownerLine.isVisible(), "the owner line still renders");
    ok((await t.ownerText()) === "Owner All committers", `and falls back to the setting ("${await t.ownerText()}")`);
    // A stored run from before the owner existed (no author / authors).
    await page.evaluate(() => {
      const app = window.__app;
      app.report.pending = null;
      app.report.currentRun = {
        runId: "old-1",
        range: "daily",
        anchorDate: "2026-06-05",
        generatedAt: Date.now(),
        days: [{ date: "2026-06-05", items: [{ id: "o1", title: "Old entry", category: "feature", source: "git" }] }],
      };
      app.addReportOwner("Mark Baldemor");
    });
    await t.settle(120);
    // F1: it WAS an every-committer run, so a setting declared since
    // flags it — the line never silently shows the setting as its owner.
    ok(await t.stale.isVisible(), "a run stored before the owner existed is flagged once a setting exists");
    ok((await t.ownerText()) === "Owner All committers — now set to Mark Baldemor; regenerate to apply", `its owner line says who it covered and that the setting moved on ("${await t.ownerText()}")`);
    // The flag's "regenerate" is a button that runs the same generate (F13).
    const inlineRegen = t.stale.getByRole("button", { name: "Regenerate the report for the new owner", exact: true });
    ok(await inlineRegen.isVisible(), 'the stale line\'s "regenerate" is a button');
    const sentBefore = await page.evaluate(() => window.__sent.length);
    await inlineRegen.click();
    await page.waitForFunction(() => !!window.__app.report.pending, null, { timeout: 3000 }).catch(() => {});
    q = await t.lastQuery();
    ok(!!q && q.total > sentBefore && q.comment.op === "report-generate" && q.comment.author === "Mark Baldemor", `it submits a report-generate for the new owner (${q && JSON.stringify(q.comment.author)})`);
    await t.finish(q.raw);
    await t.settled();
    ok((await t.stale.count()) === 0 && (await t.ownerText()) === "Owner Mark Baldemor", `regenerated: the flag clears and the line names the owner ("${await t.ownerText()}")`);
    await page.evaluate(() => {
      window.__app.report.currentRun = null;
      window.__app.setReportOwners([]);
    });
    await t.settle();
    await page.evaluate(() => {
      window.__app.report.owners = undefined;
      window.__app.report.pending = { runId: "walk-2", startedAt: Date.now(), range: "daily", anchorDate: "2026-06-05", since: "2026-06-05", until: "2026-06-05", sessionId: null };
    });
    await t.settle(120);
    ok(await t.ownerLine.isVisible(), "an owners list that is still loading does not crash the tab");
    await page.evaluate(() => {
      window.__app.report.pending = null;
      window.__app.setReportOwners([]);
    });
    await t.settle();
    ok(errors.length === before, `no page error during the walk (${errors.slice(before).join(" | ") || "none"})`);
    // Leave the tab and come back — nothing throws.
    await page.locator("nav").getByRole("button", { name: "Annotate", exact: true }).click();
    await t.settle();
    await t.reportTab.click();
    await t.ownerLine.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await t.ownerLine.isVisible(), "the tab remounts clean");

    console.log("\n[report-owner] 10 · persistence survives a reload");
    await page.evaluate(() => window.__app.setReportOwners(["Mark Baldemor", "kevzlou7979"]));
    await t.settle();
    const storedNow = await t.stored();
    ok(JSON.stringify(storedNow) === JSON.stringify(["Mark Baldemor", "kevzlou7979"]), `stored: ${JSON.stringify(storedNow)}`);
    await page.evaluate(() => {
      window.__app.report.owners = [];
    });
    await page.evaluate(() => window.__app.loadReportRun());
    await t.settle();
    ok(JSON.stringify(await t.owners()) === JSON.stringify(["Mark Baldemor", "kevzlou7979"]), `loadReportRun() reads them back (${JSON.stringify(await t.owners())})`);
    await page.evaluate(() => chrome.storage.local.set({ "pinta-report-owners": ["Mark Baldemor", "--all", "$(whoami)", 7, "mark baldemor"] }));
    await page.evaluate(() => window.__app.loadReportRun());
    await t.settle();
    ok(JSON.stringify(await t.owners()) === JSON.stringify(["Mark Baldemor"]), `a tampered blob is sanitized on load (${JSON.stringify(await t.owners())})`);
    ok(errors.length === 0, `no page error for the whole 380px run (${errors.join(" | ") || "none"})`);
    await page.context().close();

    // ======================================================================
    // 600 × 760 — one pass
    // ======================================================================
    console.log("\n[report-owner] 11 · one pass at 600px wide");
    const wide = await open(600);
    const w = bind(wide.page);
    await w.reportTab.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await w.reportTab.click();
    await w.ownerLine.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok((await w.ownerText()) === "Owner All committers", `600px: "Owner All committers" ("${await w.ownerText()}")`);
    await w.gear.click();
    await w.dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await w.dialog.isVisible(), "600px: the settings dialog opens");
    ok(norm(await w.dialog.locator("[data-pinta-report-owner-settings] p").first().innerText()) === COPY, "600px: the paragraph copy is exact");
    await w.typeOwner("Mark Baldemor");
    await w.input.press("Enter");
    await w.typeOwner("mark.baldemor@insclix.com");
    await w.addBtn.click();
    await w.settle();
    ok((await w.chip("Mark Baldemor").isVisible()) && (await w.chip("mark.baldemor@insclix.com").isVisible()), "600px: two chips");
    const dbox = await w.dialog.boundingBox();
    ok(!!dbox && dbox.x >= 0 && dbox.x + dbox.width <= 600, "600px: the dialog stays inside the panel");
    await wide.page.screenshot({ path: path.join(SHOTS, "report-owner-600.png") });
    await w.dialog.getByRole("button", { name: "Close", exact: true }).click();
    await w.settle();
    ok((await w.ownerText()) === "Owner Mark Baldemor, mark.baldemor@insclix.com", `600px: the line names both ("${await w.ownerText()}")`);
    const wq = await w.generate();
    ok(!!wq && JSON.stringify(wq.comment.authors) === JSON.stringify(["Mark Baldemor", "mark.baldemor@insclix.com"]), "600px: the query carries both");
    await w.finish(wq.raw, { authors: wq.comment.authors });
    await w.settled();
    ok((await w.stale.count()) === 0 && (await w.ownerText()) === "Owner Mark Baldemor, mark.baldemor@insclix.com", "600px: the finished run keeps the label");
    ok(wide.errors.length === 0, `600px: no page error (${wide.errors.join(" | ") || "none"})`);
    await wide.context.close();
  } catch (e) {
    console.error(e);
    failures.push("harness error: " + (e && e.message));
    await browser.close();
    srv.close();
    process.exit(2);
  }
  await browser.close();
  srv.close();
  console.log(`\n[report-owner] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})();
