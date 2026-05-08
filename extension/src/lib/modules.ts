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

export type ModuleSpec = {
  id: string;
  name: string;
  /** One-line description shown in the Settings card. */
  description: string;
  /** What the user gets when they tick the per-session checkbox. */
  sessionCheckboxLabel: string;
  /** Subtext under the per-session checkbox. */
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

export const BUILTIN_MODULES: ModuleSpec[] = [GITLAB_ISSUES];

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
