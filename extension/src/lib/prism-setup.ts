// Prism.js wrapper for Test Pilot code blocks. Only loads the
// languages we need (bash + json) so the side-panel bundle stays
// small. Prism's own bash grammar doesn't tag CLI flags, so we
// extend it with a `parameter` token before the `function` slot.
//
// Exposes a single `highlight(code, lang)` helper that returns
// pre-escaped HTML safe to render via `{@html}`.

import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";

// Add `-X`, `--header`, `-Dprop=val` style flags as their own token.
// Inserted before `function` so it wins over the command-name pattern.
Prism.languages.insertBefore("bash", "function", {
  parameter: {
    pattern: /(^|\s)--?[A-Za-z0-9][\w-]*/,
    lookbehind: true,
  },
});

export function highlight(code: string, lang: string): string {
  const key = (lang || "").toLowerCase().trim();
  const grammar = Prism.languages[key];
  if (!grammar) return escapeHtml(code);
  return Prism.highlight(code, grammar, key);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
