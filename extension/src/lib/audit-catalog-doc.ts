// Pure helpers for the AuditFlow catalog ↔ JSON export round-trip.
// Lives outside the state class so it can be unit-tested without booting
// the chrome.* API surface or Svelte's $state runtime.
//
// The "catalog" is the user-curated AuditOverlay (custom categories +
// checks + field edits + hidden ids) plus the picker's selected-category
// preference. It is deliberately findings-free: re-importing it restores
// the structure you built, not a stale agent run. A chrome.storage wipe
// (clear session / cache) loses the overlay; exporting it first makes the
// loss recoverable, and the same file ports a catalog across projects.

import type {
  AuditCatalogExport,
  AuditCategoryResult,
  AuditCheck,
  AuditCategoryId,
  AuditOverlay,
} from "@pinta/shared";

/** An empty overlay — the shape `audit.overlay` defaults to. */
export function emptyAuditOverlay(): AuditOverlay {
  return { addedCategories: [], addedChecks: {}, edits: {}, deleted: [] };
}

/**
 * Coerce an untrusted value into a well-formed AuditOverlay, dropping
 * anything that doesn't match the shape. Tolerant by design — a
 * hand-edited or older export should restore as much as it validly can
 * rather than failing wholesale. Missing slots fall back to empty.
 */
export function normalizeAuditOverlay(raw: unknown): AuditOverlay {
  const o = (raw ?? {}) as Partial<AuditOverlay>;
  const addedCategories = Array.isArray(o.addedCategories)
    ? (o.addedCategories.filter(
        (c) => c && typeof (c as AuditCategoryResult).id === "string",
      ) as AuditCategoryResult[])
    : [];
  const addedChecks: Record<string, AuditCheck[]> = {};
  if (o.addedChecks && typeof o.addedChecks === "object") {
    for (const [catId, checks] of Object.entries(o.addedChecks)) {
      if (Array.isArray(checks)) {
        addedChecks[catId] = checks.filter(
          (c) => c && typeof (c as AuditCheck).id === "string",
        ) as AuditCheck[];
      }
    }
  }
  const edits: AuditOverlay["edits"] = {};
  if (o.edits && typeof o.edits === "object") {
    for (const [id, e] of Object.entries(o.edits)) {
      if (e && typeof e === "object") edits[id] = e as AuditOverlay["edits"][string];
    }
  }
  const deleted = Array.isArray(o.deleted)
    ? o.deleted.filter((s): s is string => typeof s === "string")
    : [];
  return { addedCategories, addedChecks, edits, deleted };
}

/**
 * Build a self-describing export envelope from the live overlay +
 * selected categories. `now` is injected so callers stay deterministic
 * in tests (no hidden Date.now()).
 */
export function composeAuditCatalog(
  overlay: AuditOverlay,
  selectedCategories: AuditCategoryId[],
  now: number,
): AuditCatalogExport {
  return {
    $pintaAuditCatalog: "1",
    exportedAt: now,
    overlay: normalizeAuditOverlay(overlay),
    selectedCategories: [...selectedCategories],
  };
}

/**
 * Parse + validate a `*.pinta-audit.json` file. Returns null when the
 * input isn't a Pinta audit catalog (wrong/missing discriminator or
 * unparseable JSON) so the UI can show a friendly "not a catalog" error
 * instead of throwing. Anything past the discriminator is coerced by
 * `normalizeAuditOverlay` — partial data still restores.
 */
export function parseAuditCatalog(text: string): AuditCatalogExport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = raw as Partial<AuditCatalogExport>;
  if (!obj || typeof obj !== "object" || obj.$pintaAuditCatalog !== "1") {
    return null;
  }
  const selectedCategories = Array.isArray(obj.selectedCategories)
    ? (obj.selectedCategories.filter(
        (s) => typeof s === "string",
      ) as AuditCategoryId[])
    : [];
  return {
    $pintaAuditCatalog: "1",
    exportedAt: typeof obj.exportedAt === "number" ? obj.exportedAt : 0,
    overlay: normalizeAuditOverlay(obj.overlay),
    selectedCategories,
  };
}

/**
 * Union an incoming overlay onto a base one (the "merge" import mode —
 * the safe additive default). Rules:
 *  - addedCategories: keyed by id; incoming wins on collision.
 *  - addedChecks: per category, appended; checks already present by id
 *    are skipped (no dupes).
 *  - edits: shallow-merged; incoming overrides on the same check id.
 *  - deleted: set-union.
 * Pure — neither input is mutated.
 */
export function mergeAuditOverlays(
  base: AuditOverlay,
  incoming: AuditOverlay,
): AuditOverlay {
  const byCatId = new Map<string, AuditCategoryResult>(
    base.addedCategories.map((c) => [c.id, c]),
  );
  for (const c of incoming.addedCategories) byCatId.set(c.id, c);

  const addedChecks: Record<string, AuditCheck[]> = {};
  for (const [catId, checks] of Object.entries(base.addedChecks)) {
    addedChecks[catId] = [...checks];
  }
  for (const [catId, checks] of Object.entries(incoming.addedChecks)) {
    const existing = addedChecks[catId] ? [...addedChecks[catId]] : [];
    const seen = new Set(existing.map((c) => c.id));
    for (const ck of checks) {
      if (!seen.has(ck.id)) {
        existing.push(ck);
        seen.add(ck.id);
      }
    }
    addedChecks[catId] = existing;
  }

  return {
    addedCategories: [...byCatId.values()],
    addedChecks,
    edits: { ...base.edits, ...incoming.edits },
    deleted: [...new Set([...base.deleted, ...incoming.deleted])],
  };
}
