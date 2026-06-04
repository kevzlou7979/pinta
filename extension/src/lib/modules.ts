// Built-in Pinta modules. Each module exposes a settings schema (rendered
// by the Settings panel as a form) and ships matching agent instructions
// inside the /pinta skill — the agent matches on `module.id` from
// `session.modules[]` and runs the corresponding handler.
//
// Built-in modules are bundled into the extension. As of Phase 19, users
// can ALSO import their own modules (see `manifestToSpec` below) — those
// ship as a `.pinta-module.json` and render through the same Settings /
// footer machinery as the built-ins, with no bundled code.

import type {
  ModuleSettingType,
  ModuleSettingSpec,
  ModuleMode,
  ModuleManifest,
} from "@pinta/shared";

// Re-export the declarative shapes (now sourced from @pinta/shared so the
// importable-module manifest can reference the exact same types) for
// existing call sites that import them from this module.
export type { ModuleSettingType, ModuleSettingSpec, ModuleMode };

export type ModuleSpec = {
  id: string;
  name: string;
  /** One-line description shown in the Settings card. */
  description: string;
  /** Surface kind — drives where the module renders in the UI. */
  mode: ModuleMode;
  /** What the user gets when they tick the per-session checkbox.
   *  Unused for "interactive" modules. */
  sessionCheckboxLabel: string;
  /** Subtext under the per-session checkbox.
   *  Unused for "interactive" modules. */
  sessionCheckboxHint: string;
  settings: ModuleSettingSpec[];
  /**
   * If true, ticking this module's per-session checkbox auto-enables
   * "Include full-page screenshot" so the agent has the image to embed
   * in the module's output (e.g. GitLab issue body, Slack message).
   * Does NOT auto-disable the screenshot when the module is unticked —
   * the user may still want it for their own purposes.
   */
  recommendsScreenshot?: boolean;
};

/**
 * GitLab Issues — the v1 reference module. Creates one issue per
 * annotation in the user's GitLab project after the agent applies the
 * source edits.
 *
 * Authentication is delegated entirely to the GitLab CLI (`glab`)
 * already installed on the user's machine. The agent invokes
 * `glab issue create` and `glab` reads its own auth from the user's
 * keyring / config (set up once via `glab auth login`). **No tokens are
 * stored in Pinta, transmitted over the wire, or written to disk.**
 *
 * The two settings below are optional power-user overrides:
 *   - `project_id` overrides the project auto-detected from the current
 *     git repo's GitLab remote.
 *   - `labels` apply to every issue Pinta files.
 * Leave both blank for the common case — `glab` figures it out.
 */
const GITLAB_ISSUES: ModuleSpec = {
  id: "gitlab-issues",
  name: "GitLab Issues",
  description:
    "Create one GitLab issue per annotation. The agent applies your source edits first, then files the tickets via the `glab` CLI on your machine — auth comes from your `glab auth login`. No tokens stored.",
  mode: "per-submit",
  sessionCheckboxLabel: "Create GitLab issues",
  sessionCheckboxHint:
    "After the agent finishes, file one issue per annotation using `glab` on your machine.",
  recommendsScreenshot: true,
  settings: [
    {
      key: "project_id",
      type: "string",
      label: "Project (optional)",
      hint: "Numeric ID or `group/project` path. Leave blank to use the current repo's GitLab remote.",
      placeholder: "12345 or my-group/my-app",
    },
    {
      key: "labels",
      type: "string",
      label: "Default labels (optional)",
      hint: "Comma-separated. Applied to every issue created.",
      placeholder: "bug, ui",
    },
  ],
};

/**
 * Test Pilot — interactive module that imports a markdown test spec,
 * extracts the test catalog via the agent, and lets the user check
 * tests off (Pass / Fail) and ask for step-by-step instructions per
 * test row. Lives in its own side-panel tab; never appears in the
 * footer (no per-submit checkbox).
 *
 * No settings — the only state is the imported catalog, which lives
 * in `chrome.storage.local` under a separate key (`pinta-test-pilot:current`)
 * managed by the extension state class.
 */
const TEST_PILOT: ModuleSpec = {
  id: "test-pilot",
  name: "Test Pilot",
  description:
    "Import a markdown test spec; the agent extracts the test catalog and lets you check off tests as you run them. Click any row to get step-by-step instructions. Enable here, then open the new Test Pilot tab in the side panel.",
  mode: "interactive",
  sessionCheckboxLabel: "",
  sessionCheckboxHint: "",
  settings: [
    {
      key: "detailed_steps",
      type: "boolean",
      label: "Detailed help steps",
      hint: "Off (default) — short, tester-friendly steps. Uses fewer tokens. On — deeper steps with technical context (URLs, payloads, code blocks). Slower and more expensive.",
      default: false,
    },
  ],
};

/**
 * Chat — inquiry-mode module (Phase 14). One Settings toggle lights up
 * three chat surfaces at once: a global FAB / header icon, a "Just Ask"
 * checkbox on Annotate's submit footer, and a chat button on Test
 * Pilot's row detail view. All three reach the same agent over
 * `op: "chat"` and render via the same bottom-sheet component.
 *
 * Off by default. v1 ships as a single switch; future settings can
 * split it into per-surface toggles ("Enable global / on Annotate / on
 * Test Pilot") if users ask for that granularity.
 *
 * Why a module rather than a permanent capability: makes the surface
 * consistent with how the agent reasons about session.modules
 * (`{ id: "chat" }` rides on `module.query.submit` so the skill's
 * `op: "chat"` handler is gated identically to the other ops); also
 * lets advanced users hide the FAB if they don't want chat clutter.
 */
const CHAT: ModuleSpec = {
  id: "chat",
  name: "Chat",
  description:
    "Ask the agent about anything — a global chat in the header, a \"Just Ask\" option on Annotate (skip the source edit, just discuss), and a chat button on Test Pilot test rows for in-context questions. One switch lights up all three.",
  mode: "inquiry",
  sessionCheckboxLabel: "",
  sessionCheckboxHint: "",
  settings: [
    {
      key: "detailed_responses",
      type: "boolean",
      label: "Detailed responses",
      hint: "Off (default) — concise, tester-friendly replies. Uses fewer tokens. On — deeper technical detail (curl, payloads, env vars, ARIA names, code blocks). Slower and more expensive. Same shape as Test Pilot's \"Detailed help steps\" but covers every chat surface (global, Annotate Just Ask, Test Pilot per-row).",
      default: false,
    },
    {
      key: "redact_pii",
      type: "boolean",
      label: "Redact PII from page content (recommended)",
      hint: "On (default) — strip emails, phone numbers, credit-card-shaped digit runs, US-SSN-shaped strings, and long numeric IDs from the captured outerHTML / nearbyText before sending to the agent. Replaces each match with [REDACTED:<kind>]. Token / API-key scrubbing is always on (separate pipeline). Turn off if PII is essential context for your agent's reply — e.g. \"why does this email field show jane@example.com?\" stops working when emails are redacted.",
      default: true,
    },
  ],
};

/**
 * AuditFlow — interactive module (Phase 15). Runs Lighthouse-style
 * audits on the user's project and routes each finding into an
 * actionable handoff: Fix-with-agent (composes a pre-filled Pinta
 * annotation, opens the Annotate tab for review), Discuss (Phase 14
 * chat), File issue (GitLab module). The audit is the source of work;
 * the existing modules become sinks that consume findings.
 *
 * Phase 15a ships Security only + card view + Fix-with-agent.
 * Categories 2-5 land in 15b; custom audits in 15c; cross-run
 * fingerprint persistence in 15d; GitLab + Chat handoffs in 15e.
 *
 * No settings in 15a — Security is always-on, the only built-in
 * category. 15b adds browser-target selection for Cross Browser;
 * 15c adds custom-audit storage. Settings array stays narrow until
 * those phases land.
 */
const AUDIT_FLOW: ModuleSpec = {
  id: "audit-flow",
  name: "AuditFlow",
  description:
    "Run Lighthouse-style audits on your project — Security (Phase 15a), then Performance / Accessibility / Mobile / Cross-Browser (15b). Each finding is one click from being fixed: Fix-with-agent opens the Annotate tab pre-filled with the check details, so audits become a source of work that flows into Pinta's existing edit pipeline.",
  mode: "interactive",
  sessionCheckboxLabel: "",
  sessionCheckboxHint: "",
  settings: [],
};

export const BUILTIN_MODULES: ModuleSpec[] = [
  GITLAB_ISSUES,
  TEST_PILOT,
  CHAT,
  AUDIT_FLOW,
];

export function getModuleSpec(id: string): ModuleSpec | null {
  return BUILTIN_MODULES.find((m) => m.id === id) ?? null;
}

/**
 * Adapt an imported module's on-disk manifest into the `ModuleSpec`
 * shape the Settings panel and submit footer already render. This is
 * what lets a third-party module appear in the UI with zero bundled
 * code — the manifest carries everything `ModuleSpec` needs.
 *
 * Imported modules are per-submit in v1 (footer checkbox + settings),
 * so `sessionCheckbox*` come straight from the manifest. `settings`
 * defaults to an empty array when the manifest omits it.
 */
export function manifestToSpec(m: ModuleManifest): ModuleSpec {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    mode: m.mode,
    sessionCheckboxLabel: m.sessionCheckboxLabel ?? "",
    sessionCheckboxHint: m.sessionCheckboxHint ?? "",
    settings: m.settings ?? [],
    recommendsScreenshot: m.recommendsScreenshot,
  };
}

/**
 * A module is "configured" when every required setting has a non-empty
 * value. The Settings panel uses this to mark the module ready; the
 * footer uses it to gate the per-session checkbox.
 */
export function moduleIsConfigured(
  spec: ModuleSpec,
  settings: Record<string, string | boolean> | undefined,
): boolean {
  // No required fields → module is configured the moment it's enabled.
  // (e.g. GitLab Issues, which delegates auth to the user's `glab` CLI.)
  for (const field of spec.settings) {
    if (!field.required) continue;
    const value = settings?.[field.key];
    if (field.type === "boolean") {
      if (typeof value !== "boolean") return false;
    } else {
      if (typeof value !== "string" || value.trim() === "") return false;
    }
  }
  return true;
}
