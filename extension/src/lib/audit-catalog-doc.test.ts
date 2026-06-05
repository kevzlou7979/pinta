import { describe, it, expect } from "vitest";
import type {
  AuditCategoryResult,
  AuditCheck,
  AuditOverlay,
} from "@pinta/shared";
import {
  composeAuditCatalog,
  parseAuditCatalog,
  mergeAuditOverlays,
  normalizeAuditOverlay,
  emptyAuditOverlay,
} from "./audit-catalog-doc.js";

function check(id: string, label: string): AuditCheck {
  return {
    id,
    category: "security",
    status: "fail",
    label,
  } as AuditCheck;
}

function category(id: string, name: string): AuditCategoryResult {
  return { id: id as AuditCategoryResult["id"], name, score: 0, checks: [] };
}

function sampleOverlay(): AuditOverlay {
  return {
    addedCategories: [category("audit-flow-custom:a", "Accessibility")],
    addedChecks: { security: [check("USER-1", "No eval")] },
    edits: { "AGENT-1": { label: "Renamed" } },
    deleted: ["AGENT-2"],
  };
}

describe("audit-catalog-doc", () => {
  it("round-trips compose → JSON → parse", () => {
    const out = composeAuditCatalog(sampleOverlay(), ["security"], 1234);
    const json = JSON.stringify(out);
    const back = parseAuditCatalog(json);
    expect(back).not.toBeNull();
    expect(back!.$pintaAuditCatalog).toBe("1");
    expect(back!.exportedAt).toBe(1234);
    expect(back!.selectedCategories).toEqual(["security"]);
    expect(back!.overlay).toEqual(sampleOverlay());
  });

  it("rejects non-catalog JSON", () => {
    expect(parseAuditCatalog("{}")).toBeNull();
    expect(parseAuditCatalog('{"$pintaModule":"1"}')).toBeNull();
    expect(parseAuditCatalog("not json")).toBeNull();
  });

  it("normalizes junk overlay fields to empty", () => {
    const o = normalizeAuditOverlay({
      addedCategories: "nope",
      addedChecks: { security: [{ noId: true }, check("USER-9", "ok")] },
      edits: null,
      deleted: ["x", 5, "y"],
    });
    expect(o.addedCategories).toEqual([]);
    expect(o.addedChecks.security.map((c) => c.id)).toEqual(["USER-9"]);
    expect(o.edits).toEqual({});
    expect(o.deleted).toEqual(["x", "y"]);
  });

  it("merge unions categories, dedupes checks, set-unions deleted", () => {
    const base = sampleOverlay();
    const incoming: AuditOverlay = {
      addedCategories: [
        category("audit-flow-custom:a", "Accessibility v2"), // collision → incoming wins
        category("audit-flow-custom:b", "Performance"),
      ],
      addedChecks: {
        security: [check("USER-1", "dup"), check("USER-2", "fresh")],
      },
      edits: { "AGENT-3": { fixHint: "do x" } },
      deleted: ["AGENT-2", "AGENT-9"],
    };
    const merged = mergeAuditOverlays(base, incoming);

    expect(merged.addedCategories.map((c) => c.id)).toEqual([
      "audit-flow-custom:a",
      "audit-flow-custom:b",
    ]);
    expect(merged.addedCategories[0].name).toBe("Accessibility v2");
    expect(merged.addedChecks.security.map((c) => c.id)).toEqual([
      "USER-1",
      "USER-2",
    ]);
    expect(merged.edits).toEqual({
      "AGENT-1": { label: "Renamed" },
      "AGENT-3": { fixHint: "do x" },
    });
    expect(merged.deleted.sort()).toEqual(["AGENT-2", "AGENT-9"]);
  });

  it("merge onto empty overlay yields the incoming overlay", () => {
    expect(mergeAuditOverlays(emptyAuditOverlay(), sampleOverlay())).toEqual(
      sampleOverlay(),
    );
  });
});
