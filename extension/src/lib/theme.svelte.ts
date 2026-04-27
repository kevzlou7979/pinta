// Theme manager — reads + writes a 'dark' class on <html>, persists to
// localStorage. The popup/sidepanel HTMLs run a tiny inline script before
// this module loads, so the class is already correct by the time the
// Svelte tree mounts. This module just keeps the reactive store in sync
// with that boot decision and lets components toggle.

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
  // Source of truth at boot is the class set by the inline FOUC script.
  if (typeof document !== "undefined") {
    if (document.documentElement.classList.contains("dark")) return "dark";
    if (readStored() != null) return readStored() as Theme;
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
