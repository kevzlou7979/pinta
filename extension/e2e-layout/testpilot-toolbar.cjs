#!/usr/bin/env node
// Real-Chromium regression: the Test Pilot header actions are ONE toolbar.
//
// Report 2026-10-19 (screenshot): "Test Pilot sheets picker sat outside
// the action toolbar". The saved-sheets switcher (layers glyph · count ·
// chevron) was a 24px bordered button of its own, beside the title in the
// left column, while Re-import / Clear marks / File issues / Export ▾ were
// a 32px segmented group in the right column — two boxes, two heights,
// two rows on a narrow panel. The switcher is now the group's FIRST
// segment: same border, same divide-x, same h-8, left-rounded; Re-import
// is left-rounded only when the switcher is absent (connected mode).
//
// Mounts the REAL TestPilotTab (Shell.testpilot.svelte, standalone) and
// asserts, at 380 and 600 wide, in every state the header can be in:
//   - exactly one bordered `divide-x` group contains BOTH the switcher
//     and the Export button, and no other bordered box wraps the switcher;
//   - every button in that group shares the same height and top (±1px);
//   - the switcher's menu opens on click and closes on Escape; Export's
//     menu still opens;
//   - with several saved sheets, with one sheet (nothing else saved), and
//     in connected mode (switcher hidden; Re-import becomes the first,
//     left-rounded segment — the rounding moves, it is not duplicated).
//
// QA-A follow-ups (same day), at 380 / 400 / 420 / 600, standalone AND
// connected:
//   - F2: the group stays on the TITLE row (its top == the title column's
//     top ±1) — the title column's basis was 200px, which at ≤430px
//     wrapped the 154px group under the title;
//   - F1: in that wrapped row the Export ▾ menu opened 288px wide from the
//     button's LEFT edge and <main overflow-x-clip> cut it off. Both menus
//     are now gutter-clamped from their real rect: menu left ≥ 16, right
//     ≤ width − 16, and EVERY row inside is fully visible; re-placed when
//     the panel resizes with the menu open;
//   - F4: the sheets popover is left-anchored to the picker, i.e. sits as
//     far right as the gutter allows (±2) instead of hanging off the
//     picker's right edge under the title;
//   - F3: picker and Export chevrons are the same 8px glyph;
//   - a long title at 380 wraps inside its column without pushing the
//     group down or overflowing.
//
//   node e2e-layout/testpilot-toolbar.cjs            build + run
//   node e2e-layout/testpilot-toolbar.cjs --no-build reuse an existing dist
//   --out <dir> / --shots <dir>                      as run.cjs
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

const sheet = (docId, title, prefix) =>
  `---\npinta-test-pilot: 1\ndoc-id: ${docId}\n---\n\n# ${title}\n\n## 1.1 Login & Session\n\n` +
  `| ID | Test | Expected Result | Result |\n|----|------|-----------------|--------|\n` +
  `| ${prefix}-01 | Login page fields and elements | Username and password fields show |  |\n` +
  `| ${prefix}-02 | Log out from the user menu | Returns to login |  |\n`;
const BCP = { docId: "e2e-tb-bcp", md: sheet("e2e-tb-bcp", "UAT — Broker Connect Portal (BCP)", "BCP") };
const AWP = { docId: "e2e-tb-awp", md: sheet("e2e-tb-awp", "UAT — Agent Web Portal (AWP)", "AWP") };
const LONG = { docId: "e2e-tb-long", md: sheet("e2e-tb-long", "UAT — Broker Connect Portal (BCP) regression sweep for the October release, commissions and statements", "LNG") };

function build() {
  console.log("[testpilot-toolbar] building →", OUT);
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

// What the header's bordered groups look like, measured in the page.
// A "group" is any element with the segmented-toolbar classes (rounded-md
// + border + divide-x); the picker, Re-import and Export buttons are found
// by their aria-labels.
const measure = () => {
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top * 10) / 10, height: Math.round(b.height * 10) / 10, left: Math.round(b.left) };
  };
  const main = document.getElementById("shell-main");
  const picker = main.querySelector('button[aria-label="Switch test sheet"]');
  const reimport = main.querySelector('button[aria-label="Re-import catalog"]');
  const exportBtn = main.querySelector('button[aria-label="Export catalog"]');
  const groups = [...main.querySelectorAll("div")].filter((d) => {
    const c = d.classList;
    return c.contains("rounded-md") && c.contains("border") && c.contains("divide-x") && d.contains(exportBtn);
  });
  const groupsWithBoth = groups.filter((g) => picker && g.contains(picker));
  // Any bordered element between the picker and the group (the old
  // standalone 24px box had its own `border`).
  let strayBorder = null;
  if (picker) {
    for (let el = picker; el && el !== main; el = el.parentElement) {
      if (groups.includes(el)) break;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) {
        strayBorder = el.tagName.toLowerCase() + "." + [...el.classList].slice(0, 4).join(".");
        break;
      }
    }
  }
  const group = groups[0] ?? null;
  const buttons = group ? [...group.querySelectorAll("button")].filter((b) => !b.closest('[role="dialog"]')) : [];
  const first = buttons[0] ?? null;
  // The title column is the group's sibling in the header's flex-wrap
  // row; same top == same row.
  const titleCol = group?.previousElementSibling ?? null;
  const titleBtn = titleCol?.querySelector('button[title^="Edit title"], button[title^="Click to set a title"]') ?? null;
  const chevron = (btn) => {
    const svgs = btn ? [...btn.querySelectorAll("svg")] : [];
    const last = svgs[svgs.length - 1];
    return last ? `${last.getAttribute("width")}x${last.getAttribute("height")}` : null;
  };
  return {
    titleTop: titleCol ? r(titleCol).top : null,
    titleColWidth: titleCol ? Math.round(titleCol.getBoundingClientRect().width) : null,
    titleOverflow: titleBtn ? Math.max(0, titleBtn.scrollWidth - titleBtn.clientWidth) : null,
    titleRight: titleBtn ? Math.round(titleBtn.getBoundingClientRect().right) : null,
    pickerChevron: chevron(picker),
    exportChevron: chevron(exportBtn),
    groupCount: groups.length,
    groupsWithBoth: groupsWithBoth.length,
    strayBorder,
    pickerPresent: !!picker,
    pickerIsFirst: !!picker && first === picker,
    reimportIsFirst: first === reimport,
    firstLabel: first?.getAttribute("aria-label") ?? null,
    pickerRounded: picker ? getComputedStyle(picker).borderTopLeftRadius : null,
    reimportRounded: reimport ? getComputedStyle(reimport).borderTopLeftRadius : null,
    groupRect: group ? r(group) : null,
    buttons: buttons.map((b) => ({ label: b.getAttribute("aria-label"), ...r(b) })),
  };
};

// A popover's rect plus the rect of every button inside it (viewport px).
const measureMenu = (name) => {
  const menu = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === name);
  if (!menu) return null;
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, width: Math.round(b.width) };
  };
  return {
    ...r(menu),
    rows: [...menu.querySelectorAll("button")].map((b) => ({ label: (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 30), ...r(b) })),
  };
};

const WIDTHS = [380, 400, 420, 600];

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
    const context = await browser.newContext({ viewport: { width: 380, height: 760 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push("pageerror: " + e.message.slice(0, 200)));
    const url = `http://127.0.0.1:${srv.address().port}/?variant=test-pilot`;
    await page.goto(url);
    await page.waitForFunction(() => window.__harnessVariant === "test-pilot" && !!window.__app);
    const input = () => page.locator('input[type="file"]').first();
    const pick = (name, md) => input().setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(md, "utf8") });
    const onScreen = (docId) => page.waitForFunction((id) => window.__app.testPilot.catalog?.docId === id, docId, { timeout: 8000 }).catch(() => {});
    const setConnected = (on) =>
      page.evaluate((on) => {
        window.__app.selectedCompanion = on ? { port: 7878, projectRoot: "C:/p", pid: 1 } : null;
      }, on);
    const picker = page.getByRole("button", { name: "Switch test sheet" });
    const exportBtn = page.getByRole("button", { name: "Export catalog" });
    const sheetMenu = page.getByRole("dialog", { name: "Your test sheets" });
    const exportMenu = page.getByRole("dialog", { name: "Export options" });

    // One toolbar: shared assertions for a state, at a width.
    const checkOneGroup = async (label, { withPicker }) => {
      const m = await page.evaluate(measure);
      const first = withPicker ? "Switch test sheet" : "Re-import catalog";
      ok(m.groupCount === 1, `${label}: exactly one bordered divide-x toolbar group holds the actions (${m.groupCount})`);
      if (withPicker) {
        ok(m.pickerPresent, `${label}: the sheets picker is on screen`);
        ok(m.groupsWithBoth === 1, `${label}: that group contains the sheets picker AND Export (${m.groupsWithBoth} do)`);
        ok(m.strayBorder === null, `${label}: no other bordered box wraps the picker${m.strayBorder ? ` (${m.strayBorder})` : ""}`);
        ok(m.pickerIsFirst, `${label}: the picker is the first segment (first is ${m.firstLabel})`);
        ok(m.pickerRounded !== "0px", `${label}: the picker is left-rounded (${m.pickerRounded})`);
        ok(m.reimportRounded === "0px", `${label}: Re-import is NOT left-rounded next to it (${m.reimportRounded})`);
      } else {
        ok(!m.pickerPresent, `${label}: the sheets picker is hidden`);
        ok(m.reimportIsFirst, `${label}: Re-import is the first segment (first is ${m.firstLabel})`);
        ok(m.reimportRounded !== "0px", `${label}: Re-import is left-rounded (${m.reimportRounded})`);
      }
      const hs = new Set(m.buttons.map((b) => b.height));
      const tops = m.buttons.map((b) => b.top);
      const spread = Math.max(...tops) - Math.min(...tops);
      const heightSpread = Math.max(...m.buttons.map((b) => b.height)) - Math.min(...m.buttons.map((b) => b.height));
      const want = withPicker ? 4 : 3;
      ok(m.buttons.length >= want && heightSpread <= 1, `${label}: all ${want}+ segments are in the group at one height (${m.buttons.length} segments, ${[...hs].join("/")}px)`);
      ok(spread <= 1, `${label}: every segment sits on the same row (tops ${tops.join("/")})`);
      ok(m.buttons[0]?.label === first, `${label}: first segment is ${first}`);
      ok(m.groupRect && m.titleTop !== null && Math.abs(m.groupRect.top - m.titleTop) <= 1, `${label}: the group sits on the title row (group top ${m.groupRect?.top}, title top ${m.titleTop})`);
      return m;
    };

    // A popover is inside the panel's 16px gutters, and so is every row in it.
    const checkMenuInside = async (label, name, width) => {
      const mm = await page.evaluate(measureMenu, name);
      ok(!!mm && mm.left >= 16 - 0.5 && mm.right <= width - 16 + 0.5, `${label}: the ${name} menu keeps the gutters (${mm?.left}–${mm?.right} in ${width})`);
      const clipped = (mm?.rows ?? []).filter((b) => b.left < 16 - 0.5 || b.right > width - 16 + 0.5);
      ok(!!mm && mm.rows.length > 0 && clipped.length === 0, `${label}: every row in the ${name} menu is fully visible (${mm?.rows.length ?? 0} rows${clipped.length ? "; clipped: " + clipped.map((b) => `${b.label} ${b.left}–${b.right}`).join(", ") : ""})`);
      return mm;
    };

    console.log("\n[testpilot-toolbar] two sheets saved, standalone");
    await pick("bcp-uat.md", BCP.md);
    await onScreen(BCP.docId);
    await pick("awp-uat.md", AWP.md);
    await onScreen(AWP.docId);
    await page.waitForFunction(() => window.__app.testPilot.savedSheets.length === 1, null, { timeout: 8000 }).catch(() => {});
    ok((await picker.innerText()).trim() === "2", "the picker counts two sheets");
    {
      const m = await page.evaluate(measure);
      ok(m.pickerChevron === "8x8" && m.exportChevron === "8x8", `the picker and Export chevrons are the same 8px glyph (${m.pickerChevron} vs ${m.exportChevron})`);
    }
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(80);
      await checkOneGroup(`${width}px · 2 sheets · standalone`, { withPicker: true });
      await page.screenshot({ path: path.join(SHOTS, `testpilot-toolbar-${width}.png`) });

      // The menus still work from inside the group.
      await picker.click();
      await sheetMenu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      ok(await sheetMenu.isVisible(), `${width}px: the sheets menu opens on click`);
      const mb = await sheetMenu.boundingBox();
      const pb = await picker.boundingBox();
      ok(!!mb && mb.y >= pb.y + pb.height - 1 && mb.y - (pb.y + pb.height) <= 12, `${width}px: the menu hangs right under the picker (menu top ${mb && Math.round(mb.y)}, picker bottom ${Math.round(pb.y + pb.height)})`);
      ok(!!mb && mb.x >= 16 - 0.5 && mb.x + mb.width <= width - 16 + 1, `${width}px: the menu keeps the panel gutters (${mb && Math.round(mb.x)}–${mb && Math.round(mb.x + mb.width)})`);
      await checkMenuInside(`${width}px`, "Your test sheets", width);
      // F4: left-aligned to the picker when the 22rem panel fits to its
      // right; the toolbar hugs the panel's right edge, so at every
      // width that means "as far right as the gutter allows".
      const wantLeft = mb && Math.max(16, Math.min(pb.x, width - 16 - mb.width));
      ok(!!mb && Math.abs(mb.x - wantLeft) <= 2, `${width}px: the sheets menu is left-anchored to the picker, gutter-clamped (menu ${mb && Math.round(mb.x)}, picker ${Math.round(pb.x)}, want ${wantLeft && Math.round(wantLeft)})`);
      if (width === 380) await page.screenshot({ path: path.join(SHOTS, `testpilot-toolbar-${width}-menu.png`) });
      await page.keyboard.press("Escape");
      ok(!(await sheetMenu.isVisible()), `${width}px: Escape closes the sheets menu`);
      await exportBtn.click();
      await exportMenu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      ok(await exportMenu.isVisible(), `${width}px: the Export menu still opens`);
      await page.waitForTimeout(50);
      await checkMenuInside(`${width}px`, "Export options", width);
      if (width === 380) await page.screenshot({ path: path.join(SHOTS, `testpilot-toolbar-${width}-export.png`) });
      await page.keyboard.press("Escape");
      ok(!(await exportMenu.isVisible()), `${width}px: Escape closes the Export menu`);
    }

    // Resize with the Export menu open: it is re-placed, not clipped.
    await page.setViewportSize({ width: 600, height: 760 });
    await exportBtn.click();
    await exportMenu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await page.setViewportSize({ width: 380, height: 760 });
    await page.waitForTimeout(120);
    ok(await exportMenu.isVisible(), "600→380 with Export open: the menu stays open");
    await checkMenuInside("600→380 with Export open", "Export options", 380);
    await page.keyboard.press("Escape");

    console.log("\n[testpilot-toolbar] one sheet, nothing else saved, standalone");
    await picker.click();
    await sheetMenu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await sheetMenu.getByRole("button", { name: /^Delete saved sheet/ }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Delete this saved sheet?" });
    await confirm.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await confirm.getByRole("button", { name: "Delete sheet" }).click();
    await page.waitForFunction(() => window.__app.testPilot.savedSheets.length === 0, null, { timeout: 5000 }).catch(() => {});
    await page.locator("#shell-header").click();
    ok((await picker.innerText()).trim() === "1", "the picker stays, counting the open sheet only");
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(80);
      await checkOneGroup(`${width}px · 1 sheet · standalone`, { withPicker: true });
    }

    console.log("\n[testpilot-toolbar] connected: no picker, Re-import leads the same group");
    await setConnected(true);
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Switch test sheet"]'), null, { timeout: 3000 }).catch(() => {});
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(80);
      const m = await checkOneGroup(`${width}px · connected`, { withPicker: false });
      ok(m.buttons.some((b) => b.label === "File failed tests as issues"), `${width}px · connected: File issues is in the group`);
      await exportBtn.click();
      await exportMenu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(50);
      await checkMenuInside(`${width}px · connected`, "Export options", width);
      await page.keyboard.press("Escape");
      if (width === 600) await page.screenshot({ path: path.join(SHOTS, `testpilot-toolbar-${width}-connected.png`) });
    }
    await setConnected(false);
    await page.waitForFunction(() => !!document.querySelector('button[aria-label="Switch test sheet"]'), null, { timeout: 3000 }).catch(() => {});
    const back = await page.evaluate(measure);
    ok(back.pickerIsFirst && back.reimportRounded === "0px", "back in standalone the picker leads again and Re-import gives up its rounding");

    console.log("\n[testpilot-toolbar] a long title at 380 wraps in its column; the group stays beside it");
    await pick("long-uat.md", LONG.md);
    await onScreen(LONG.docId);
    for (const connected of [false, true]) {
      await setConnected(connected);
      await page.waitForFunction((on) => !document.querySelector('button[aria-label="Switch test sheet"]') === on, connected, { timeout: 3000 }).catch(() => {});
      await page.setViewportSize({ width: 380, height: 760 });
      await page.waitForTimeout(80);
      const label = `380px · long title · ${connected ? "connected" : "standalone"}`;
      const m = await checkOneGroup(label, { withPicker: !connected });
      ok(m.titleColWidth >= 140, `${label}: the title column keeps ≥140px (${m.titleColWidth}px)`);
      ok(m.titleOverflow === 0, `${label}: the title wraps without overflowing its column (overflow ${m.titleOverflow}px)`);
      ok(m.groupRect && m.titleRight <= m.groupRect.left, `${label}: the title ends before the group starts (title right ${m.titleRight}, group left ${m.groupRect?.left})`);
      if (!connected) await page.screenshot({ path: path.join(SHOTS, "testpilot-toolbar-380-long-title.png") });
    }
    await setConnected(false);

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\n[testpilot-toolbar] ${failures.length ? "FAILED: " + failures.length : "ALL CHECKS PASS"}  (screenshots: ${SHOTS})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[testpilot-toolbar] crashed:", e);
  process.exit(2);
});
