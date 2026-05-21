// Built-in Pinta modules. Each module exposes a settings schema (rendered
// by the Settings panel as a form) and ships matching agent instructions
// inside the /pinta skill — the agent matches on `module.id` from
// `session.modules[]` and runs the corresponding handler.
//
// Modules are bundled into the extension; users don't upload them. To
// extend: add a new entry below, document its `id` in the skill, ship.

export type ModuleSettingType = "string" | "secret" | "boolean";

export type ModuleSettingSpec = {
  /** Storage key under chrome.storage.local. */
  key: string;
  type: ModuleSettingType;
  label: string;
  /** Visible explainer under the field. */
  hint?: string;
  /** Default value used when the user hasn't filled the field yet. */
  default?: string | boolean;
  /** Required fields gate the module's "ready to use" state. */
  required?: boolean;
  /** Optional placeholder for the input. */
  placeholder?: string;
};

/**
 * How a module surfaces in the side panel.
 * - "per-submit" — user opts in via a footer checkbox each submit. The
 *   module runs after the agent's source edits land (e.g. GitLab
 *   Issues files one issue per annotation).
 * - "interactive" — module owns its own tab in the side panel. It
 *   doesn't ride on annotation submits; the user drives it directly
 *   from within the tab (e.g. Test Pilot imports a doc and runs
 *   queries against the agent without touching source files).
 * - "inquiry" — module is cross-cutting; one Settings toggle lights up
 *   multiple chat / Q&A surfaces across the side panel (header global
 *   icon, Annotate "Just Ask" checkbox, Test Pilot FAB). Doesn't own a
 *   tab and doesn't ride on submits — it's the "ask before you commit"
 *   verb (e.g. Chat).
 */
export type ModuleMode = "per-submit" | "interactive" | "inquiry";

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
  settings: [],
};

export const BUILTIN_MODULES: ModuleSpec[] = [GITLAB_ISSUES, TEST_PILOT, CHAT];

export function getModuleSpec(id: string): ModuleSpec | null {
  return BUILTIN_MODULES.find((m) => m.id === id) ?? null;
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
