import { describe, it, expect } from "vitest";
import type { TestPilotCatalog } from "./state.svelte.js";
import { composeAuditCatalog } from "./audit-catalog-doc.js";
import {
  composeSettingsBundle,
  parseSettingsBundle,
  summarizeBundle,
} from "./pinta-settings.js";

function sampleCatalog(): TestPilotCatalog {
  return {
    docId: "doc-1",
    filename: "uat.md",
    importedAt: 1,
    title: "UAT",
    sections: [
      {
        title: "Auth",
        tests: [
          { id: "AUTH-1", test: "Login", expected: "Home", status: "pass" },
          { id: "AUTH-2", test: "Logout", expected: "Bye", status: "fail" },
        ],
      },
    ],
  };
}

function sampleAuditCatalog() {
  return composeAuditCatalog(
    {
      addedCategories: [
        { id: "audit-flow-custom:a" as never, name: "A11y", score: 0, checks: [] },
      ],
      addedChecks: { security: [{ id: "USER-1" } as never] },
      edits: { "AGENT-1": { label: "x" } },
      deleted: [],
    },
    ["security"],
    999,
  );
}

describe("pinta-settings", () => {
  it("round-trips a full bundle", () => {
    const bundle = composeSettingsBundle(
      {
        testPilot: [sampleCatalog()],
        auditCatalog: sampleAuditCatalog(),
        appVersion: "0.5.0",
      },
      4321,
    );
    const back = parseSettingsBundle(JSON.stringify(bundle));
    expect(back).not.toBeNull();
    expect(back!.$pintaSettings).toBe("1");
    expect(back!.exportedAt).toBe(4321);
    expect(back!.appVersion).toBe("0.5.0");
    expect(back!.testPilot).toEqual([sampleCatalog()]);
    expect(back!.auditCatalog).toEqual(sampleAuditCatalog());
  });

  it("omits empty slots from the envelope", () => {
    const bundle = composeSettingsBundle({ testPilot: [] }, 1);
    expect(bundle.testPilot).toBeUndefined();
    expect(bundle.auditCatalog).toBeUndefined();
  });

  it("rejects non-bundle JSON", () => {
    expect(parseSettingsBundle("{}")).toBeNull();
    expect(parseSettingsBundle('{"$pintaModule":"1"}')).toBeNull();
    expect(parseSettingsBundle("nope")).toBeNull();
  });

  it("drops a malformed test pilot catalog but keeps valid ones", () => {
    const raw = JSON.stringify({
      $pintaSettings: "1",
      exportedAt: 0,
      testPilot: [{ docId: "bad" }, sampleCatalog()],
    });
    const back = parseSettingsBundle(raw);
    expect(back!.testPilot).toHaveLength(1);
    expect(back!.testPilot![0].docId).toBe("doc-1");
  });

  it("summarizes counts for the confirm dialog", () => {
    const bundle = composeSettingsBundle(
      { testPilot: [sampleCatalog()], auditCatalog: sampleAuditCatalog() },
      1,
    );
    expect(summarizeBundle(bundle)).toEqual({
      testPilotCatalogs: 1,
      testPilotTests: 2,
      auditCustomCategories: 1,
      auditCustomChecks: 1,
      auditEdits: 1,
    });
  });
});
