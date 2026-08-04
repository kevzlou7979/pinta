// Density manager — Compact vs Comfortable spacing for the side panel.
// Scales the panel document's ROOT font-size, so every rem-based Tailwind
// spacing + text utility breathes in "comfortable" and stays IDE-tight in
// "compact". Persists to localStorage; applied on boot from the sidepanel
// entry's main.ts, mirroring theme.svelte.ts.
//
// Only the side-panel document is affected (the on-page overlay + floating
// toolbar live in the host page's document, which we never touch here).

const STORAGE_KEY = "pinta-density";

export type Density = "compact" | "comfortable";

// Root font-size per mode. Compact keeps today's tuned, IDE-tight look
// (16px = Tailwind's rem baseline, i.e. no change); comfortable adds air.
const ROOT_PX: Record<Density, string> = {
  compact: "16px",
  comfortable: "18px",
};

function readStored(): Density | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "compact" || v === "comfortable" ? v : null;
  } catch {
    return null;
  }
}

function bootDensity(): Density {
  // Stored preference wins; otherwise Compact (matches IDE tooling).
  return readStored() ?? "compact";
}

function applyPx(d: Density): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = ROOT_PX[d];
}

export const density = $state<{ value: Density }>({ value: bootDensity() });

export function applyDensity(): void {
  applyPx(density.value);
}

export function setDensity(next: Density): void {
  density.value = next;
  applyPx(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage unavailable — size still applied for the page lifetime
  }
}
