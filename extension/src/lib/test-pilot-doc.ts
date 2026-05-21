// Pure helpers for Test Pilot catalog ↔ markdown round-trips. Lives
// outside the state class so it can be unit-tested without booting
// the chrome.* API surface or Svelte's $state runtime.
//
// Both functions are referentially transparent — same input, same
// output. The state class wraps them with persistence + companion
// disk-sync side effects.

import type { TestPilotCatalog } from "./state.svelte.js";

/**
 * Compose a catalog back into the markdown shape the agent emits on
 * `op: "doc-parse"` / `op: "generate-doc"`. The companion writes this
 * to `.pinta/test-docs/{docId}.md` whenever the user edits the catalog
 * (Phase 13). Idempotent — a fresh `doc-parse` of the output should
 * yield an equivalent catalog (id-keyed comparison).
 *
 * Escaping: pipes (`|`) in table cells get backslash-escaped; newlines
 * in test text / expected text collapse to spaces so each row stays
 * one markdown table row.
 */
export function composeTestDocMarkdown(catalog: TestPilotCatalog): string {
  const heading = catalog.title?.trim() || catalog.filename;
  let out = `# ${heading}\n\n`;
  if (catalog.author?.trim()) out += `_By ${catalog.author.trim()}_\n\n`;
  if (catalog.description?.trim()) {
    out += `${catalog.description.trim()}\n\n`;
  }
  for (const section of catalog.sections) {
    out += `## ${section.title}\n\n`;
    out += `| ID | Test | Expected Result |\n`;
    out += `|----|------|-----------------|\n`;
    for (const t of section.tests) {
      const id = t.id.replace(/\|/g, "\\|");
      const test = t.test.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const expected = t.expected
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      out += `| ${id} | ${test} | ${expected} |\n`;
    }
    out += `\n`;
  }
  return out;
}

/**
 * Compute the next `USER-N` id across the catalog. Walks every section
 * and parses any existing `USER-<digits>` ids — returns one above the
 * max, or `USER-1` for a fresh catalog. Collisions are impossible by
 * construction.
 *
 * The `USER-*` prefix is contractual with the skill's regen logic
 * (SKILL.md §7.10.1b) — the agent preserves these rows verbatim on
 * regenerate so user-added scenarios survive.
 */
export function nextUserTestId(catalog: TestPilotCatalog): string {
  let max = 0;
  for (const section of catalog.sections) {
    for (const t of section.tests) {
      const m = /^USER-(\d+)$/.exec(t.id);
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (n > max) max = n;
      }
    }
  }
  return `USER-${max + 1}`;
}
