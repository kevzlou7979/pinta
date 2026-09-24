#!/usr/bin/env node
// Real-Chromium layout regression harness for the Settings → Modules toggle
// scroll bug. See README.md.
//
//   node e2e-layout/run.cjs              build + real shell (must PASS)
//   node e2e-layout/run.cjs --control    build + real + simulated pre-fix
//                                         shell (real must PASS, control FAIL)
//   --matrix                             --control plus informational rows for
//                                         each half of the fix on its own
//   --no-build                           reuse an existing dist
//   --out <dir>                          dist dir (default: E2E_LAYOUT_OUT or
//                                         <tmp>/pinta-e2e-layout-dist)
//   --shots <dir>                        screenshot dir (default: <out>/../e2e-layout-shots)
"use strict";

const { execSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EXT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : d;
};
const OUT = opt("--out", process.env.E2E_LAYOUT_OUT || path.join(os.tmpdir(), "pinta-e2e-layout-dist"));
const SHOTS = opt("--shots", path.join(path.dirname(OUT), "e2e-layout-shots"));
const MATRIX = flag("--matrix");
const CONTROL = flag("--control") || MATRIX;

const WIDTH = 420;
const HEIGHTS = [480, 560, 700, 900];
const MODULES = ["Chat", "Report", "Devices", "Code Review", "Test Pilot"];
const TAB_PRESSES = 30;

function loadPlaywright() {
  const candidates = [
    "C:/rnd/puwersa/node_modules/playwright",
    "playwright",
    "@playwright/test",
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {}
  }
  throw new Error("Playwright not found (tried " + candidates.join(", ") + ")");
}

function build() {
  console.log("[e2e-layout] building →", OUT);
  execSync("npx vite build --config e2e-layout/vite.config.ts --logLevel error", {
    cwd: EXT, // Tailwind content globs are relative to extension/
    stdio: "inherit",
    env: { ...process.env, E2E_LAYOUT_OUT: OUT },
  });
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".woff": "font/woff", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml",
};
function serve(root) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        resp.writeHead(404).end();
        return;
      }
      resp.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(resp);
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

// Layout probe evaluated in the page after every interaction.
function probe() {
  const root = document.getElementById("shell-root");
  const header = document.getElementById("shell-header");
  const main = document.getElementById("shell-main");
  const a = document.activeElement;
  const mr = main.getBoundingClientRect();
  let focusInMain = null;
  if (a && a.tagName === "INPUT" && main.contains(a)) {
    const r = a.getBoundingClientRect();
    // sr-only input is 1x1 with -1px margin; allow 2px slack.
    focusInMain = r.top >= mr.top - 2 && r.bottom <= mr.bottom + 2;
  }
  return {
    rootTop: root.scrollTop,
    docTop: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
    headerTop: Math.round(header.getBoundingClientRect().top * 100) / 100,
    mainBottomGap: Math.round(window.innerHeight - mr.bottom),
    focusInMain,
    focused: a ? (a.getAttribute("aria-label") || a.tagName) : null,
  };
}

function check(p, ctx, failures) {
  const errs = [];
  if (p.rootTop !== 0) errs.push(`root.scrollTop=${p.rootTop} (want 0)`);
  if (p.docTop !== 0) errs.push(`scrollingElement.scrollTop=${p.docTop} (want 0)`);
  if (p.headerTop !== 0) errs.push(`header.top=${p.headerTop} (want 0)`);
  if (p.mainBottomGap !== 0) errs.push(`main.bottom gap=${p.mainBottomGap}px (want 0: dead area below)`);
  if (p.focusInMain === false) errs.push(`focused input outside <main> scrollport`);
  if (errs.length) failures.push(`${ctx}: ${errs.join("; ")}`);
  return errs.length === 0;
}

const QUERY = {
  real: "",
  control: "?variant=control",
  "clip-only": "?variant=control&root=clip", // real root, pre-fix labels
  "rel-only": "?variant=control&labels=relative", // pre-fix root, real labels
};

async function runVariant(browser, base, variant) {
  const rows = [];
  for (const h of HEIGHTS) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: h } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    await page.goto(`${base}/index.html${QUERY[variant]}`);
    await page.waitForSelector("#shell-main");
    await page.getByRole("button", { name: /^Modules/ }).first().click();
    await page.waitForSelector('button[aria-label="Expand Chat"], button[aria-label="Collapse Chat"]');

    const failures = [];
    let checks = 0;
    const record = async (ctx) => {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const p = await page.evaluate(probe);
      checks++;
      check(p, ctx, failures);
      return p;
    };

    // 1) scroll <main> to bottom, then click each module toggle.
    await page.evaluate(() => {
      const m = document.getElementById("shell-main");
      m.scrollTop = m.scrollHeight;
    });
    await record("scrolled-bottom");

    for (const name of MODULES) {
      const labelHandle = await page.evaluateHandle((n) => {
        const btn = document.querySelector(`button[aria-label="Expand ${n}"], button[aria-label="Collapse ${n}"]`);
        if (!btn) return null;
        const label = btn.parentElement.querySelector("label");
        // Bring the card into <main>'s viewport by scrolling <main> ONLY —
        // never scrollIntoView (it would also scroll the root, masking or
        // faking the bug).
        const m = document.getElementById("shell-main");
        const mr = m.getBoundingClientRect();
        const lr = label.getBoundingClientRect();
        if (lr.top < mr.top + 8 || lr.bottom > mr.bottom - 8) {
          m.scrollTop += lr.top - mr.top - mr.height / 2;
        }
        return label;
      }, name);
      const label = labelHandle.asElement();
      if (!label) {
        failures.push(`${name}: toggle not found`);
        continue;
      }
      const box = await label.boundingBox();
      const before = await label.evaluate((l) => l.querySelector("input").checked);
      // Raw mouse click at the toggle's centre — avoids Playwright's own
      // scroll-into-view so only the app's behaviour moves anything.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await record(`click ${name}`);
      // Guard against a click that missed (would pass the layout checks
      // vacuously). Re-query: the card may have re-rendered.
      const after = await page.evaluate((n) => {
        const btn = document.querySelector(`button[aria-label="Expand ${n}"], button[aria-label="Collapse ${n}"]`);
        return btn ? btn.parentElement.querySelector("label input").checked : null;
      }, name);
      if (after === before) failures.push(`click ${name}: toggle did not change (checked=${after})`);
    }
    await page.waitForTimeout(350); // let the 150ms toggle transitions settle for the shot
    await page.screenshot({ path: path.join(SHOTS, `${variant}-${WIDTH}x${h}-clicks.png`) });

    // 2) Tab-key through the toggles from the Modules accordion header.
    await page.evaluate(() => {
      const m = document.getElementById("shell-main");
      m.scrollTop = m.scrollHeight;
    });
    await page.getByRole("button", { name: /^Modules/ }).first().focus();
    await page.evaluate(() => {
      const m = document.getElementById("shell-main");
      m.scrollTop = m.scrollHeight; // focus() may have scrolled main up; push the list below the fold again
    });
    let togglesVisited = 0;
    for (let i = 0; i < TAB_PRESSES; i++) {
      await page.keyboard.press("Tab");
      const p = await record(`tab#${i + 1}`);
      if (p.focusInMain !== null) togglesVisited++;
    }
    if (togglesVisited < 3) failures.push(`tab: only ${togglesVisited} toggle inputs reached (want >=3)`);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `${variant}-${WIDTH}x${h}-tab.png`) });

    if (errors.length) failures.push(`pageerror: ${errors[0]}`);
    rows.push({ variant, size: `${WIDTH}x${h}`, checks, togglesVisited, failures });
    await page.close();
  }
  return rows;
}

(async () => {
  if (!flag("--no-build")) build();
  if (!fs.existsSync(path.join(OUT, "index.html"))) throw new Error(`no build at ${OUT}`);
  fs.mkdirSync(SHOTS, { recursive: true });

  const { chromium } = loadPlaywright();
  const srv = await serve(OUT);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ headless: true });
  let rows = [];
  try {
    rows = rows.concat(await runVariant(browser, base, "real"));
    if (CONTROL) rows = rows.concat(await runVariant(browser, base, "control"));
    if (MATRIX) {
      rows = rows.concat(await runVariant(browser, base, "clip-only"));
      rows = rows.concat(await runVariant(browser, base, "rel-only"));
    }
  } finally {
    await browser.close();
    srv.close();
  }

  console.log("\nvariant    size     checks  tab-toggles  result  first failure");
  for (const r of rows) {
    const res = r.failures.length ? "FAIL" : "PASS";
    console.log(
      `${r.variant.padEnd(10)} ${r.size.padEnd(8)} ${String(r.checks).padEnd(7)} ${String(r.togglesVisited).padEnd(12)} ${res.padEnd(7)} ${r.failures[0] || ""}`,
    );
  }
  const real = rows.filter((r) => r.variant === "real");
  const ctrl = rows.filter((r) => r.variant === "control");
  const realOk = real.every((r) => r.failures.length === 0);
  // The control must fail at at least one short height, or the harness is blind.
  const ctrlOk = !CONTROL || ctrl.some((r) => r.failures.length > 0);
  console.log(`\nreal shell: ${realOk ? "PASS" : "FAIL"}`);
  if (CONTROL) console.log(`negative control detected: ${ctrlOk ? "YES (harness catches the bug)" : "NO — harness is blind"}`);
  if (MATRIX) console.log("clip-only / rel-only rows are informational (exit code ignores them).");
  console.log(`screenshots: ${SHOTS}`);
  process.exit(realOk && ctrlOk ? 0 : 1);
})().catch((e) => {
  console.error("[e2e-layout] error:", e);
  process.exit(2);
});
