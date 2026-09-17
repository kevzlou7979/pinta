// Memoized on-demand loaders for heavy side-panel pieces (ChatSheet pulls
// in the Prism highlighter). A failed import is forgotten so the next
// attempt retries instead of replaying the rejection forever.

type ChatSheetModule = typeof import("../sidepanel/ChatSheet.svelte");
type PrismModule = typeof import("./prism-setup.js");

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = load().catch((err: unknown) => {
        p = null;
        throw err;
      });
    }
    return p;
  };
}

export const loadChatSheet = memo<ChatSheetModule>(() => import("../sidepanel/ChatSheet.svelte"));
export const loadPrism = memo<PrismModule>(() => import("./prism-setup.js"));

/** Plain-text fallback while the highlighter loads (or if it can't). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
