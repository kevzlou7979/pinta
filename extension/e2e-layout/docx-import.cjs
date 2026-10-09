#!/usr/bin/env node
// Real-Chromium regression for Test Pilot's .docx import.
//
// Bug: Test Pilot only read Markdown. A sheet that came back from Google
// Drive as .docx (Drive converts an uploaded .md into a Google Doc) could
// not be imported. This picks real .docx files through the tab's own file
// input and asserts the catalog that renders.
//
//   node e2e-layout/docx-import.cjs            build + run
//   node e2e-layout/docx-import.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                as run.cjs
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
const { zipSync, strToU8 } = loadFrom([path.join(EXT, "node_modules/fflate"), path.join(EXT, "../node_modules/fflate"), "fflate"], "fflate");

// ── .docx fixtures (built here so the test owns its inputs) ───────────
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml"';
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (t, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (inner, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const heading = (t, n) => para(run(t), `<w:pStyle w:val="Heading${n}"/>`);
const row = (...cells) => `<w:tr>${cells.map((c) => `<w:tc>${para(run(c))}</w:tc>`).join("")}</w:tr>`;
const step = (t) => para(run(t), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`);
const NUMBERING = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
const docx = (body, withNumbering = true) =>
  Buffer.from(
    zipSync({
      "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
      ...(withNumbering ? { "word/numbering.xml": strToU8(NUMBERING) } : {}),
    }),
  );

// What Google Drive hands back for a Pinta tester sheet: the `---`
// envelope has become a horizontal rule + one Heading 2 with every key.
const GOOGLE_DOCX = docx(
  para(`<w:r><w:pict><v:rect o:hr="t"/></w:pict></w:r>`) +
    heading("pinta-test-pilot: 1 doc-id: e2e-doc-42", 2) +
    heading("Claims UAT — Thorough", 1) +
    para(run("By Mark", "<w:i/>")) +
    heading("1.1 Sign in", 2) +
    `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("AUTH-01", "Login with valid credentials", "Lands on the dashboard", "✓ Pass")}${row("AUTH-02", "Wrong password", "Shows an inline error", "✗ Fail")}${row("AUTH-03", "Logout", "Returns to sign in", "")}</w:tbl>` +
    heading("Steps", 3) +
    heading("AUTH-01 — Login with valid credentials", 4) +
    step("Open the login page") +
    step("Press Sign in") +
    heading("1.2 Claim form", 2) +
    `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("CLM-01", "Date of loss accepts today", "No range error", "")}</w:tbl>`,
);

function build() {
  console.log("[docx-import] building →", OUT);
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
    const page = await browser.newPage({ viewport: { width: 420, height: 760 } });
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=test-pilot`);
    await page.waitForFunction(() => window.__harnessVariant === "test-pilot" && !!window.__app);
    const input = page.locator('input[type="file"]').first();
    const catalog = () =>
      page.evaluate(() => {
        const c = window.__app.testPilot.catalog;
        if (!c) return null;
        const tests = c.sections.flatMap((s) => s.tests);
        return {
          docId: c.docId,
          title: c.title,
          author: c.author,
          sections: c.sections.map((s) => s.title),
          status: Object.fromEntries(tests.map((t) => [t.id, t.status])),
          steps: tests.find((t) => t.id === "AUTH-01")?.detail?.steps ?? [],
        };
      });

    console.log("\n[docx-import] import card offers Word files");
    ok(/\.docx/.test((await input.getAttribute("accept")) || ""), "file input accepts .docx");
    ok(/Import tester sheet/.test(await page.locator("#shell-main").innerText()), "standalone empty state offers Import tester sheet");

    console.log("\n[docx-import] the standalone screen is a drop target and explains a file it can't take");
    const dropOn = (selector, name, bytes) =>
      page.evaluate(
        ({ selector, name, bytes }) => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(bytes)], name));
          const el = document.querySelector(selector);
          el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
          el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        },
        { selector, name, bytes: Array.from(bytes) },
      );
    await dropOn("[data-pinta-spec-drop-standalone]", "holiday-photo-with-a-very-long-name-that-should-wrap-inside-the-panel.png", Buffer.from("x"));
    await page.waitForTimeout(150);
    const noteText = await page.locator("#shell-main").innerText();
    ok(/isn't a Markdown or Word file/.test(noteText), "a dropped .png gets the \"isn't a Markdown or Word file\" note");
    const noteFit = await page.evaluate(() => { const m = document.getElementById("shell-main"); return m.scrollWidth - m.clientWidth; });
    ok(noteFit <= 0, "a long file name wraps instead of widening the panel");
    await page.getByRole("button", { name: "Dismiss" }).first().click();
    ok(!/isn't a Markdown or Word file/.test(await page.locator("#shell-main").innerText()), "the note is dismissible");

    console.log("\n[docx-import] an unreadable .docx explains itself and imports nothing");
    await input.setInputFiles({ name: "broken.docx", mimeType: "application/octet-stream", buffer: Buffer.from("this is not a zip") });
    await page.waitForFunction(() => !!window.__app.testPilot.error, null, { timeout: 5000 }).catch(() => {});
    const err = await page.evaluate(() => window.__app.testPilot.error);
    ok(!!err && err.includes("broken.docx") && /isn't a Word \.docx file/.test(err), `error names the file and the cause (${JSON.stringify(err)})`);
    ok((await catalog()) === null, "no catalog loaded from a broken file");
    ok(await page.getByText("broken.docx", { exact: false }).first().isVisible(), "error is visible in the panel");
    await page.screenshot({ path: path.join(SHOTS, "docx-import-error.png") });
    ok((await page.locator('[role="alert"]').count()) > 0, "error banner is announced (role=alert)");
    await page.locator('[role="alert"] button').first().click();
    ok((await page.evaluate(() => window.__app.testPilot.error)) === null, "the banner's X dismisses the error");

    console.log("\n[docx-import] a Word plan with headings but no test rows is refused with a reason");
    await input.setInputFiles({ name: "release plan.docx", mimeType: "application/octet-stream", buffer: docx(heading("Release plan", 1) + heading("Checkout", 2) + para(run("Pay by card and confirm the order.")), false) });
    await page.waitForFunction(() => !!window.__app.testPilot.error, null, { timeout: 5000 }).catch(() => {});
    const noRows = await page.evaluate(() => window.__app.testPilot.error);
    ok(!!noRows && noRows.startsWith("release plan.docx:") && /No test rows found/.test(noRows), `names the file and says why (${JSON.stringify((noRows || "").slice(0, 70))}…)`);
    ok((await catalog()) === null, "no empty catalog loaded");
    await page.evaluate(() => { window.__app.testPilot.error = null; });

    console.log("\n[docx-import] a Google-Drive-converted tester sheet imports as a catalog");
    await input.setInputFiles({
      name: "Claims UAT.md.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: GOOGLE_DOCX,
    });
    await page.waitForFunction(() => !!window.__app.testPilot.catalog, null, { timeout: 8000 }).catch(() => {});
    const c = await catalog();
    ok(!!c, "catalog loaded from the .docx");
    if (c) {
      ok(c.docId === "e2e-doc-42", `doc-id recovered from the mangled envelope (${c.docId})`);
      ok(c.title === "Claims UAT — Thorough" && c.author === "Mark", `title + author (${c.title} / ${c.author})`);
      ok(JSON.stringify(c.sections) === JSON.stringify(["1.1 Sign in", "1.2 Claim form"]), `sections (${c.sections.join(", ")})`);
      ok(
        JSON.stringify(c.status) === JSON.stringify({ "AUTH-01": "pass", "AUTH-02": "fail", "AUTH-03": "untested", "CLM-01": "untested" }),
        `Pass / Fail marks (${JSON.stringify(c.status)})`,
      );
      ok(JSON.stringify(c.steps) === JSON.stringify(["Open the login page", "Press Sign in"]), `numbered steps (${c.steps.join(" | ")})`);
    }
    const text = await page.locator("#shell-main").innerText();
    ok(/Claims UAT — Thorough/.test(text) && /1\.1 Sign in/.test(text) && /1\.2 Claim form/.test(text), "catalog title and both sections are on screen");
    ok(/1\s*passed/i.test(text) && /1\s*failed/i.test(text) && /2\s*untested/i.test(text), "tally reads 1 passed · 1 failed · 2 untested");
    const scroll = await page.evaluate(() => ({ doc: document.scrollingElement.scrollLeft, mainW: document.getElementById("shell-main").scrollWidth - document.getElementById("shell-main").clientWidth }));
    ok(scroll.doc === 0 && scroll.mainW <= 0, "no horizontal overflow after import");
    await page.screenshot({ path: path.join(SHOTS, "docx-import-catalog.png") });
    ok((await page.evaluate(() => window.__app.testPilot.catalog.filename)) === "Claims UAT.md", "\"Claims UAT.md.docx\" is named Claims UAT.md, not .md.md");

    console.log("\n[docx-import] Pinta's own results .docx overlays the catalog it came from");
    // Export the results as Word from this catalog, change a mark, then
    // import the export back: it must overlay (banner, doc-id kept, steps
    // kept), not replace.
    const exported = await page.evaluate(async () => {
      const bytes = await window.__app.exportResultsDocx({ tester: "Jeremy Cruz", email: "", date: "2026-10-08", environment: "UAT", runType: "Thorough", notes: "" });
      return Array.from(bytes);
    });
    await page.evaluate(() => window.__app.setTestStatus("AUTH-03", "pass"));
    await input.setInputFiles({ name: "Claims UAT-results-2026-10-08.docx", mimeType: "application/octet-stream", buffer: Buffer.from(exported) });
    await page.waitForFunction(() => !!window.__app.testPilot.importedRun, null, { timeout: 8000 }).catch(() => {});
    const overlay = await page.evaluate(() => {
      const t = window.__app.testPilot;
      return { run: t.importedRun ? { tester: t.importedRun.signoff.tester, applied: t.importedRun.applied } : null, conflict: !!t.pendingImportConflict, docId: t.catalog.docId, title: t.catalog.title };
    });
    ok(!!overlay.run && overlay.run.tester === "Jeremy Cruz" && overlay.run.applied === 4, `imported-run overlay with the sign-off (${JSON.stringify(overlay.run)})`);
    ok(overlay.docId === "e2e-doc-42" && overlay.title === "Claims UAT — Thorough", "catalog identity untouched (no \"Test Pilot results —\" title)");
    const after = await catalog();
    ok(after.status["AUTH-03"] === "untested", "the run's marks are shown (AUTH-03 back to untested)");
    ok(after.steps.length === 2, "the developer's steps survive the overlay");
    ok(/Imported run/.test(await page.locator("#shell-main").innerText()), "\"Imported run\" banner is on screen");
    await page.screenshot({ path: path.join(SHOTS, "docx-import-overlay.png") });
    await page.evaluate(() => window.__app.clearImportedRun());

    console.log("\n[docx-import] a DIFFERENT Word sheet is kept beside the open one — nothing is wiped, nothing is asked");
    await page.evaluate(() => window.__app.setTestStatus("AUTH-01", "pass"));
    const plain = docx(heading("Another sheet", 1) + heading("Only section", 2) + `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("X-1", "Something else", "Works", "")}</w:tbl>`, false);
    const dialog = page.getByRole("dialog").filter({ hasText: "Replace test catalog?" });
    await input.setInputFiles({ name: "another.docx", mimeType: "application/octet-stream", buffer: plain });
    await page.waitForFunction(() => window.__app.testPilot.catalog?.title === "Another sheet", null, { timeout: 5000 }).catch(() => {});
    ok((await catalog()).title === "Another sheet", "the new sheet is on screen");
    ok(!(await dialog.isVisible()), "no \"Replace test catalog?\" prompt — the open sheet was saved, not replaced");
    const saved = await page.evaluate(() => window.__app.testPilot.savedSheets.map((x) => ({ title: x.title, pass: x.pass })));
    ok(saved.length === 1 && saved[0].title === "Claims UAT — Thorough" && saved[0].pass >= 1, `the first sheet is saved with its marks (${JSON.stringify(saved)})`);

    console.log("\n[docx-import] the SAME plain Word sheet again never wipes Pass / Fail marks without asking");
    await page.evaluate(() => window.__app.setTestStatus("X-1", "pass"));
    await input.setInputFiles({ name: "another.docx", mimeType: "application/octet-stream", buffer: plain });
    await dialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ok(await dialog.isVisible(), "\"Replace test catalog?\" prompt appears");
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await page.waitForTimeout(150);
    const kept = await catalog();
    ok(kept.title === "Another sheet" && kept.status["X-1"] === "pass", "Cancel keeps the catalog and its marks");
    await input.setInputFiles({ name: "another.docx", mimeType: "application/octet-stream", buffer: plain });
    await dialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await dialog.getByRole("button", { name: "Replace catalog" }).click();
    await page.waitForFunction(() => window.__app.testPilot.catalog?.sections[0]?.tests[0]?.status === "untested", null, { timeout: 5000 }).catch(() => {});
    ok((await catalog()).status["X-1"] === "untested", "Replace catalog adopts the re-imported sheet");
    ok((await page.evaluate(() => window.__app.testPilot.savedSheets.length)) === 1, "still exactly one other saved sheet");
    await page.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[docx-import] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[docx-import] crashed:", e);
  process.exit(2);
});
