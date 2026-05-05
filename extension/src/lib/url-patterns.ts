// Glob-style URL matching used by the side panel to auto-route a tab
// to its companion. URLs aren't filesystem trees, so `*` is greedy
// across slashes — `http://localhost:5173/*` matches every path under
// that host, including nested ones like `/foo/bar/baz`. (`**` is also
// accepted as a synonym for backward-compat with filesystem-glob
// instincts.)
//
// Patterns are matched against the *normalized* URL: protocol, host,
// port, and pathname only — query string and hash are dropped. That
// way "http://localhost:5173/*" matches "http://localhost:5173/foo?x=1"
// without users having to learn URL escaping in glob syntax.

import type { Companion } from "./companions.js";

function normalize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob pattern into a regex. `*` and `**` both compile to
 * `.*` — see file header for the rationale (URLs are not filesystem
 * trees; users expect `/foo/*` to match nested paths).
 *
 * Trailing `/*` (or `/**`) is special-cased to make the trailing
 * separator optional so the pattern matches both the bare segment and
 * its descendants — `/login/*` matches `/login`, `/login/`, and
 * `/login/dashboard`. This is what users expect from a glob like
 * "this section of the site" and matches how `chrome.match_patterns`
 * treats path wildcards.
 */
function compile(pattern: string): RegExp {
  const norm = normalize(pattern);
  const trailingGlob = /\/\*+$/.test(norm);
  const body = trailingGlob ? norm.replace(/\/\*+$/, "") : norm;
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "*") {
      // Collapse `**` to a single `.*` to keep the regex tidy.
      if (body[i + 1] === "*") i++;
      out.push(".*");
    } else {
      out.push(escapeRe(ch!));
    }
  }
  // The optional `(?:/.*)?` lets the URL end exactly at the prefix or
  // continue with `/...` — without it, `/foo/*` would reject `/foo`.
  const tail = trailingGlob ? "(?:/.*)?" : "";
  return new RegExp(`^${out.join("")}${tail}$`, "i");
}

export function matchPattern(url: string, pattern: string): boolean {
  return compile(pattern).test(normalize(url));
}

export function matchAny(url: string, patterns: string[]): boolean {
  return patterns.some((p) => matchPattern(url, p));
}

/**
 * Returns the unique companion whose patterns match `url`. If 0 or >1
 * match, returns null — caller should prompt the user to pick.
 */
export function findCompanionForUrl(
  companions: Companion[],
  url: string,
): Companion | null {
  const matches = companions.filter((c) => matchAny(url, c.urlPatterns));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Suggests a default URL pattern from a tab URL — drops query/hash and
 * wildcards the path. Used by the "Associate this URL" button so the
 * user sees a sensible default in the prompt.
 */
export function suggestPattern(url: string): string {
  try {
    const u = new URL(url);
    // file:// URLs — include enough of the path to uniquely identify
    // the project root. Walks up to the directory containing the
    // current file and adds /*. Avoids the catch-all `file:///*`.
    if (u.protocol === "file:") {
      const path = u.pathname.replace(/\/[^/]*$/, ""); // drop filename
      return `file://${path}/*`;
    }
    // http(s) — include the first path segment if there is one.
    // This keeps localhost:5173/claims/* from clashing with
    // localhost:5173/docs/*.
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length > 0) {
      return `${u.protocol}//${u.host}/${segs[0]}/*`;
    }
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return url;
  }
}
