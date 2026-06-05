// Pure helpers for the global "pinta-settings.json" bundle — the single
// file the user exports from Settings → Backup & restore to carry their
// Pinta state between machines / projects, or to recover it after a
// chrome.storage (clear session / cache) wipe.
//
// What it carries (locked scope): Test Pilot catalog(s) WITH results, and
// the AuditFlow catalog. Deliberately NOT included: module enable/config
// (secrets must never leave the box) and audit findings/dispositions
// (tied to one agent run, not portable). Import is additive/best-effort.
//
// Kept outside the state class so the compose/parse logic is unit-tested
// without the chrome.* surface or Svelte runtime.

import type { AuditCatalogExport } from "@pinta/shared";
import type { TestPilotCatalog } from "./state.svelte.js";

/**
 * The global settings bundle envelope. `$pintaSettings` discriminates the
 * file the same way `$pintaModule` / `$pintaAuditCatalog` do, so a picked
 * file can be validated before anything is applied.
 */
export type PintaSettingsBundle = {
  $pintaSettings: "1";
  /** ms epoch the bundle was produced. */
  exportedAt: number;
  /** Pinta version that wrote it, for forward-compat diagnostics. */
  appVersion?: string;
  /** Test Pilot catalogs with their Pass/Fail results + chat threads.
   *  Today Pinta holds one catalog per project, so this is usually a
   *  single-element array — modelled as a list for forward-compat. */
  testPilot?: TestPilotCatalog[];
  /** The AuditFlow catalog (overlay + selected categories). */
  auditCatalog?: AuditCatalogExport;
};

/** Counts shown in the import-confirm dialog so the user sees what a
 *  bundle will bring in before applying it. */
export type BundleSummary = {
  testPilotCatalogs: number;
  testPilotTests: number;
  auditCustomCategories: number;
  auditCustomChecks: number;
  auditEdits: number;
};

/** Build the bundle envelope. `now` is injected for deterministic tests.
 *  Empty/undefined slots are omitted so a bundle with nothing to carry
 *  stays minimal. */
export function composeSettingsBundle(
  parts: {
    testPilot?: TestPilotCatalog[];
    auditCatalog?: AuditCatalogExport;
    appVersion?: string;
  },
  now: number,
): PintaSettingsBundle {
  const bundle: PintaSettingsBundle = {
    $pintaSettings: "1",
    exportedAt: now,
  };
  if (parts.appVersion) bundle.appVersion = parts.appVersion;
  if (parts.testPilot && parts.testPilot.length) {
    bundle.testPilot = parts.testPilot;
  }
  if (parts.auditCatalog) bundle.auditCatalog = parts.auditCatalog;
  return bundle;
}

/**
 * Parse + validate a picked settings file. Returns null on bad JSON or a
 * missing/wrong discriminator so the UI shows a friendly error rather
 * than throwing. Slot shapes are checked leniently — a malformed slot is
 * dropped, the rest still imports.
 */
export function parseSettingsBundle(text: string): PintaSettingsBundle | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = raw as Partial<PintaSettingsBundle>;
  if (!obj || typeof obj !== "object" || obj.$pintaSettings !== "1") {
    return null;
  }
  const out: PintaSettingsBundle = {
    $pintaSettings: "1",
    exportedAt: typeof obj.exportedAt === "number" ? obj.exportedAt : 0,
  };
  if (typeof obj.appVersion === "string") out.appVersion = obj.appVersion;
  if (Array.isArray(obj.testPilot)) {
    const catalogs = obj.testPilot.filter(
      (c) => c && typeof c === "object" && Array.isArray((c as TestPilotCatalog).sections),
    ) as TestPilotCatalog[];
    if (catalogs.length) out.testPilot = catalogs;
  }
  if (
    obj.auditCatalog &&
    typeof obj.auditCatalog === "object" &&
    (obj.auditCatalog as AuditCatalogExport).$pintaAuditCatalog === "1"
  ) {
    out.auditCatalog = obj.auditCatalog as AuditCatalogExport;
  }
  return out;
}

/** Tally what a bundle contains for the confirm dialog. */
export function summarizeBundle(bundle: PintaSettingsBundle): BundleSummary {
  const catalogs = bundle.testPilot ?? [];
  let tests = 0;
  for (const c of catalogs) {
    for (const s of c.sections ?? []) tests += s.tests?.length ?? 0;
  }
  const overlay = bundle.auditCatalog?.overlay;
  const auditCustomChecks = overlay
    ? Object.values(overlay.addedChecks).reduce((n, ck) => n + ck.length, 0)
    : 0;
  return {
    testPilotCatalogs: catalogs.length,
    testPilotTests: tests,
    auditCustomCategories: overlay?.addedCategories.length ?? 0,
    auditCustomChecks,
    auditEdits: overlay ? Object.keys(overlay.edits).length : 0,
  };
}
