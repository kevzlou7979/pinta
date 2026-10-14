#!/usr/bin/env node
// Real-Chromium regression for annotations an agent skipped.
//
// Report (2026-10-13): a batch of three came back with one ✓ and two idle
// dots — the agent had closed the batch after the first card. The two
// cards sat in the Submitted tray looking unprocessed, with no way to send
// them again short of redoing the annotation.
//
// This mounts the whole side panel (`?variant=app`), plays the companion,
// and checks the tray: skipped cards say "Not applied" and carry a
// resubmit icon that copies them into the draft; applied cards, cards
// still in progress and file-only batches are left alone.
//
//   node e2e-layout/resubmit-skipped.cjs            build + run
//   node e2e-layout/resubmit-skipped.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                     as run.cjs
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
  console.log("[resubmit-skipped] building →", OUT);
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

// The reported batch: three cards, the agent applied the first and closed it.
const card = (id, over) => ({
  id,
  createdAt: 1,
  kind: "select",
  color: "#ec4899",
  comment: "",
  target: { selector: `#ld-w1-pcd > div.${id}`, outerHTML: "<div></div>", computedStyles: {}, nearbyText: [], boundingRect: { x: 0, y: 0, width: 10, height: 10 } },
  ...over,
});
const batch = (id, status, annotations, over) => ({
  id,
  url: "http://localhost:5173/components/wizard",
  projectRoot: "C:/proj",
  startedAt: 1,
  submittedAt: 2,
  producer: "extension",
  status,
  annotations,
  ...over,
});
const SKIPPED = batch("batch-skipped", "done", [
  card("ann-width", { status: "done", cssChanges: { width: "574px" } }),
  card("ann-move", { kind: "move", move: { drop: "reorder", position: "before", container: { selector: "#ld-w1-pcd" } } }),
  card("ann-height", { cssChanges: { height: "306px" } }),
]);
// Controls: still being worked on, and a file-only batch (no per-card status).
const RUNNING = batch("batch-running", "applying", [card("ann-run-1", { status: "done" }), card("ann-run-2")]);
const FILE_ONLY = batch("batch-file-only", "done", [card("ann-file-1", { comment: "file me" }), card("ann-file-2", { comment: "and me" })]);
const ONE_ERROR = batch("batch-one-error", "done", [card("ann-ok", { status: "done" }), card("ann-err", { status: "error", errorMessage: "Could not locate the source file." })]);
// The agent marked a card "applying", never finished it, and closed the batch.
const STUCK = batch("batch-stuck", "done", [card("ann-stuck-ok", { status: "done" }), card("ann-stuck", { status: "applying" })]);
// The whole batch failed before any card was touched.
const FAILED = batch("batch-failed", "error", [card("ann-failed-1"), card("ann-failed-2")], { errorMessage: "Could not start." });

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
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=app`);
    await page.waitForFunction(() => window.__harnessVariant === "app" && !!window.__app);

    // Stand in for the companion: connected, a live draft, and the tray
    // seeded. `annotation.add` is echoed back into the draft as the
    // companion's session.synced would.
    await page.evaluate(
      ({ batches }) => {
        const app = window.__app;
        window.__sent = [];
        app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: [] };
        app.connectionStatus = "connected";
        app.session = { id: "draft-1", url: "http://localhost:5173/components/wizard", projectRoot: "C:/proj", startedAt: 3, producer: "extension", status: "drafting", annotations: [] };
        app.client = {
          send: (m) => {
            window.__sent.push(m);
            if (m.type === "annotation.add") app.session = { ...app.session, annotations: [...app.session.annotations, m.annotation] };
            if (m.type === "annotation.remove") app.session = { ...app.session, annotations: app.session.annotations.filter((a) => a.id !== m.id) };
          },
        };
        app.inFlightBatches = batches;
      },
      { batches: [SKIPPED, RUNNING, FILE_ONLY, ONE_ERROR, STUCK, FAILED] },
    );
    const tray = page.getByRole("list", { name: "Submitted annotations" });
    await tray.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    ok(await tray.isVisible(), "the Submitted tray renders");
    const trayCard = (sel) => tray.locator("li").filter({ hasText: sel });
    const badge = (c) => c.getByTestId("annotation-not-applied");
    const icon = (c) => c.getByRole("button", { name: "Resubmit annotation" });

    console.log("\n[resubmit-skipped] the batch the agent closed after its first card");
    const width = trayCard("div.ann-width");
    const move = trayCard("div.ann-move");
    const height = trayCard("div.ann-height");
    ok((await badge(width).count()) === 0 && (await icon(width).count()) === 0, "the applied card has no badge and no resubmit icon");
    ok(await width.getByLabel("done").isVisible(), "the applied card keeps its ✓");
    ok(await badge(move).isVisible(), 'the skipped MOVE card says "Not applied"');
    ok(await badge(height).isVisible(), 'the skipped SELECT card says "Not applied"');
    ok((await icon(move).isVisible()) && (await icon(height).isVisible()), "both skipped cards carry a resubmit icon");
    await page.screenshot({ path: path.join(SHOTS, "resubmit-skipped-tray.png"), fullPage: true });

    console.log("\n[resubmit-skipped] cards that must be left alone");
    const run2 = trayCard("div.ann-run-2");
    ok((await badge(run2).count()) === 0 && (await icon(run2).count()) === 0, "a card in a batch still being applied is not flagged");
    const file1 = trayCard("div.ann-file-1");
    ok((await badge(file1).count()) === 0 && (await icon(file1).count()) === 0, "a file-only batch (no per-card status) is not flagged");
    const err = trayCard("div.ann-err");
    ok((await badge(err).count()) === 0 && (await icon(err).isVisible()), "a failed card keeps its error and gains the resubmit icon");

    console.log("\n[resubmit-skipped] a card left at \"applying\" when its batch closed");
    const stuck = trayCard("div.ann-stuck").filter({ hasNotText: "ann-stuck-ok" });
    ok((await badge(stuck).isVisible()) && (await icon(stuck).isVisible()), 'it says "Not applied" and can be resubmitted');
    ok(await stuck.getByLabel("not applied").isVisible(), "its status dot is the amber one");
    ok((await stuck.getByLabel("applying").count()) === 0 && (await stuck.getByLabel("waiting").count()) === 0, "and it does not spin");
    ok(!(await stuck.evaluate((el) => el.classList.contains("pinta-loading-card"))), "nor carry the loading-card tint");

    console.log("\n[resubmit-skipped] a batch that failed outright");
    const failed1 = trayCard("div.ann-failed-1");
    ok((await icon(failed1).isVisible()) && (await badge(failed1).count()) === 0, "its cards can be resubmitted, without a \"Not applied\" badge");

    console.log("\n[resubmit-skipped] resubmit the skipped MOVE card");
    await icon(move).click();
    await page.waitForFunction(() => window.__app.session.annotations.length === 1, null, { timeout: 5000 }).catch(() => {});
    const add = await page.evaluate(() => window.__sent.filter((m) => m.type === "annotation.add").at(-1)?.annotation ?? null);
    ok(!!add && add.kind === "move" && add.move?.drop === "reorder", "the copy keeps the annotation's payload (kind move, reorder)");
    ok(!!add && add.id !== "ann-move" && add.status === undefined && add.errorMessage === undefined, `the copy has a fresh id and no status (${add && add.id})`);
    ok((await move.getByTestId("annotation-requeued").innerText().catch(() => "")).trim().toUpperCase() === "IN DRAFT", 'the tray card now reads "In draft"');
    ok((await icon(move).count()) === 0, "its resubmit icon is gone, so it can't be queued twice");
    ok(await icon(height).isVisible(), "the other skipped card still offers resubmit");
    ok(await page.getByRole("button", { name: "Resubmit", exact: true }).isVisible(), 'the send button reads "Resubmit"');
    await page.screenshot({ path: path.join(SHOTS, "resubmit-skipped-queued.png"), fullPage: true });

    console.log("\n[resubmit-skipped] a double-click queues one copy");
    await icon(height).dblclick();
    await page.waitForTimeout(300);
    const copies = await page.evaluate(() => window.__sent.filter((m) => m.type === "annotation.add").length);
    ok(copies === 2, `two cards resubmitted, two copies sent (${copies})`);

    console.log("\n[resubmit-skipped] the copies are removed from the draft → the icon returns");
    await page.evaluate(() => {
      window.__app.session = { ...window.__app.session, annotations: [] };
    });
    await icon(move).waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    ok((await icon(move).isVisible()) && (await badge(move).isVisible()), 'the card is back to "Not applied" with its icon');
    ok(await page.getByRole("button", { name: "Send to agent", exact: true }).isVisible(), 'and the send button is back to "Send to agent"');

    console.log("\n[resubmit-skipped] resubmit again, then the draft is sent");
    await icon(move).click();
    await page.waitForFunction(() => window.__app.session.annotations.length === 1, null, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => {
      const app = window.__app;
      const sent = { ...app.session, id: "batch-resent", status: "submitted", submittedAt: 9 };
      app.inFlightBatches = [...app.inFlightBatches, sent];
      app.session = { ...app.session, id: "draft-2", annotations: [] };
    });
    await page.waitForFunction(() => window.__app.inFlightBatches.length === 7, null, { timeout: 3000 }).catch(() => {});
    // The tray now holds the original and its copy (same selector text).
    ok((await move.count()) === 2, `the copy sits in the tray as its own card (${await move.count()})`);
    const original = move.filter({ has: page.getByTestId("annotation-requeued") });
    ok((await original.getByTestId("annotation-requeued").innerText().catch(() => "")).trim().toUpperCase() === "RESUBMITTED", 'the original card reads "Resubmitted"');
    ok((await icon(move).count()) === 0, "and neither card offers another resubmit");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, `no horizontal overflow at 420px (${overflow}px)`);
    await page.screenshot({ path: path.join(SHOTS, "resubmit-skipped-sent.png"), fullPage: true });

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[resubmit-skipped] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[resubmit-skipped] crashed:", e);
  process.exit(2);
});
