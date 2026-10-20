#!/usr/bin/env node
// Real-Chromium check for the "Buy me a coffee" badge in the side-panel
// header (added for 0.11.0). Mounts the whole side panel (`?variant=app`)
// with a long project name at the narrowest and the default panel widths,
// and checks the badge is visible, links to Ko-fi in a new tab, sits on the
// right of the header just left of the Settings gear, without widening the header, and doesn't hide the project name.
//
//   node e2e-layout/coffee-badge.cjs            build + run
//   node e2e-layout/coffee-badge.cjs --no-build reuse an existing dist
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
  console.log("[coffee-badge] building →", OUT);
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
    for (const width of [320, 420]) {
      console.log(`
[coffee-badge] panel ${width}px wide, long project name`);
      const context = await browser.newContext({ viewport: { width, height: 700 } });
      const page = await context.newPage();
      page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
      await page.goto(`http://127.0.0.1:${srv.address().port}/?variant=app`);
      await page.waitForFunction(() => window.__harnessVariant === "app" && !!window.__app);
      await page.evaluate(() => {
        const app = window.__app;
        app.selectedCompanion = { port: 7878, projectRoot: "C:/work/clients/insclix-claims-forms-enterprise-portal", urlPatterns: [] };
        app.connectionStatus = "connected";
      });
      await page.waitForTimeout(150);
      const badge = page.locator("[data-pinta-coffee]");
      ok((await badge.count()) === 1, "one coffee badge in the header");
      const m = await badge.evaluate((a) => {
        const r = a.getBoundingClientRect();
        const header = a.closest("header");
        const h = header.getBoundingClientRect();
        const gear = header.querySelector('[aria-label="Settings"]').getBoundingClientRect();
        const label = a.querySelector("span");
        return {
          href: a.getAttribute("href"),
          target: a.target,
          rel: a.rel,
          text: a.getAttribute("aria-label") + "|" + (label && getComputedStyle(label).display !== "none" ? label.textContent.trim() : ""),
          visible: r.width > 0 && r.height > 0,
          inHeader: r.left >= h.left && r.right <= h.right + 0.5,
          sameRow: Math.abs(r.top + r.height / 2 - (gear.top + gear.height / 2)) < 2 && r.right <= gear.left && gear.left - r.right < 12,
          headerOverflow: header.scrollWidth - header.clientWidth,
          pageOverflow: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
        };
      });
      ok(m.href === "https://ko-fi.com/markkevinringor", `links to Ko-fi (${m.href})`);
      ok(m.target === "_blank" && /noopener/.test(m.rel), `opens in a new tab, noopener (${m.target} / ${m.rel})`);
      ok(m.text.startsWith("Buy me a coffee|") && m.visible, `named "Buy me a coffee" and visible (${m.text})`);
      ok(width < 360 ? m.text.endsWith("|") : m.text.endsWith("|Buy me a coffee"), width < 360 ? "icon-only on a very narrow panel" : "shows the \"Buy me a coffee\" text");
      ok(m.inHeader && m.sameRow, `sits just left of the Settings gear (${JSON.stringify({ inHeader: m.inHeader, sameRow: m.sameRow })})`);
      ok(m.headerOverflow <= 0 && m.pageOverflow <= 0, `no horizontal overflow (header ${m.headerOverflow}, page ${m.pageOverflow})`);
      const project = page.getByRole("button", { name: /insclix-claims-forms/ }).first();
      ok(await project.isVisible(), "the project switcher is still visible");
      await page.screenshot({ path: path.join(SHOTS, `coffee-badge-${width}.png`), clip: { x: 0, y: 0, width, height: 80 } });
      await context.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`
[coffee-badge] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[coffee-badge] crashed:", e);
  process.exit(2);
});
