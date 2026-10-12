#!/usr/bin/env node
// Real-Chromium regression for the Design Variants count.
//
// Report (2026-10-12): the Variants selector was on 5, the agent returned
// 3, and the tab showed the short deck as if nothing was missing. Two of
// the three runs had "give 3 options" typed in the direction box.
//
// The agent's half is a SKILL.md rule (`count` is the only source of the
// number) and can't be driven from a browser. This script covers the tab's
// half: it must ask for the selected count whatever the direction says, and
// say so when fewer come back.
//
//   node e2e-layout/variants-count.cjs            build + run
//   node e2e-layout/variants-count.cjs --no-build reuse an existing dist
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
  console.log("[variants-count] building →", OUT);
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
    const context = await browser.newContext({ viewport: { width: 420, height: 760 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=design-variants`);
    await page.waitForFunction(() => window.__harnessVariant === "design-variants" && !!window.__app);

    // Stand in for the companion: connected, and every message the tab
    // sends lands in window.__sent.
    await page.evaluate(() => {
      window.__sent = [];
      window.__app.client = { send: (m) => window.__sent.push(m) };
      window.__app.connectionStatus = "connected";
    });
    const lastQuery = () =>
      page.evaluate(() => {
        const m = window.__sent.filter((x) => x.type === "module.query.submit").at(-1);
        return m ? { comment: JSON.parse(m.queryComment), raw: m.queryComment, total: window.__sent.length } : null;
      });
    // Answer the open run as the agent: `n` variants, session marked done.
    const agentReturns = (n, raw) =>
      page.evaluate(
        ({ n, raw }) => {
          const q = JSON.parse(raw);
          const variants = Array.from({ length: n }, (_, i) => ({
            id: `v${i + 1}`,
            label: `Direction ${i + 1}`,
            rationale: "Harness variant.",
            previewHtml: `<div style="padding:24px;background:#0d2c54;color:#fff">Variant ${i + 1}</div>`,
            summary: "src/routes/+page.svelte: harness change.",
          }));
          window.__app.onMessage({
            type: "session.synced",
            session: {
              id: `e2e-${q.runId}`,
              url: q.url,
              status: "done",
              modules: [{ id: "design-variants" }],
              annotations: [{ id: "q1", kind: "query", comment: raw }],
              appliedSummary: JSON.stringify({ type: "design-variants-run", runId: q.runId, variants }),
            },
          });
        },
        { n, raw },
      );
    const cards = () => page.locator('[id^="variant-card-"]').count();
    const notice = page.getByTestId("variants-shortfall");
    const settled = () => page.waitForFunction(() => !window.__app.variants.pending, null, { timeout: 5000 }).catch(() => {});

    console.log("\n[variants-count] ask for 5 with a direction that names another number");
    await page.getByRole("button", { name: "Whole page" }).click();
    await page.locator("textarea").first().fill("Redesign this product selection, give 3 options");
    await page.getByRole("group", { name: "How many variants" }).getByRole("button", { name: "5", exact: true }).click();
    const generate = page.getByRole("button", { name: "Generate 5 variants" });
    ok(await generate.isVisible(), 'the button reads "Generate 5 variants"');
    await generate.click();
    let q = await lastQuery();
    ok(!!q && q.comment.op === "variants-generate", "the tab submits a variants-generate query");
    ok(!!q && q.comment.count === 5, `the query asks for 5 (count=${q && q.comment.count})`);
    ok(await page.getByText("Generating 5 variants…").isVisible(), 'the wait reads "Generating 5 variants…"');

    console.log("\n[variants-count] the agent returns 3 of the 5");
    await agentReturns(3, q.raw);
    await settled();
    ok((await cards()) === 3, `3 cards render (${await cards()})`);
    await notice.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    ok(await notice.isVisible(), "a notice says the run came back short");
    const said = (await notice.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    ok(/asked for 5/.test(said) && /returned 3/.test(said), `it names both numbers ("${said}")`);
    const box = await notice.boundingBox();
    ok(!!box && box.x >= 0 && box.x + box.width <= 420, "the notice stays inside the 420px panel");
    ok(await page.evaluate(() => window.__app.variants.error === null), "it is a notice, not an error");
    await page.screenshot({ path: path.join(SHOTS, "variants-count-short.png") });

    console.log("\n[variants-count] regenerate, and the agent returns all 5");
    const before = q.total;
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    q = await lastQuery();
    ok(!!q && q.total > before && q.comment.count === 5, `the retry asks for 5 again (count=${q && q.comment.count})`);
    ok((await notice.count()) === 0, "the notice clears while the retry runs");
    await agentReturns(5, q.raw);
    await settled();
    ok((await cards()) === 5, `5 cards render (${await cards()})`);
    ok((await notice.count()) === 0, "no shortfall notice on a full run");
    await page.screenshot({ path: path.join(SHOTS, "variants-count-full.png") });

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[variants-count] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[variants-count] crashed:", e);
  process.exit(2);
});
