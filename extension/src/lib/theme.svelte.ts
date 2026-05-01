// Theme manager — reads + writes a 'dark' class on <html>, persists to
// localStorage. Imported synchronously by each entry's main.ts so
// applyTheme() runs before the Svelte tree mounts. MV3's default CSP
// (script-src 'self') forbids inline pre-paint scripts, so the class
// is set on first module evaluation rather than before the very first
// frame — there can be a one-frame light-themed flash on dark-mode
// boot. Acceptable trade-off for CSP compliance.

const STORAGE_KEY = "pinta-theme";

export type Theme = "light" | "dark";

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function bootTheme(): Theme {
  // Stored preference wins, then prefers-color-scheme, then light. Reads
  // the live class as a tiebreaker if anything else set it (e.g. a
  // future inline script via a hashed CSP allowlist).
  if (typeof document !== "undefined") {
    const stored = readStored();
    if (stored != null) return stored;
    if (document.documentElement.classList.contains("dark")) return "dark";
    return systemTheme();
  }
  return "light";
}

function applyClass(t: Theme) {
  const html = document.documentElement;
  if (t === "dark") html.classList.add("dark");
  else html.classList.remove("dark");
}

export const theme = $state<{ value: Theme }>({ value: bootTheme() });

export function applyTheme(): void {
  applyClass(theme.value);
}

export function setTheme(next: Theme): void {
  theme.value = next;
  applyClass(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage unavailable — class still applied for the page lifetime
  }
}

export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}
