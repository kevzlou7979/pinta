/** Submit-footer choices, remembered across submits and panel reloads. */
export type SubmitOptions = {
  autoApply: boolean;
  includeScreenshot: boolean;
  justAsk: boolean;
};

/** Fresh-install defaults: every box unticked (auto-apply is opt-in). */
export const DEFAULT_SUBMIT_OPTIONS: Readonly<SubmitOptions> = Object.freeze({
  autoApply: false,
  includeScreenshot: false,
  justAsk: false,
});

/**
 * Parse the stored submit-options blob. Each boolean field that is present
 * wins; anything missing or malformed falls back to the default. `ticked`
 * (per-submit module ids ticked `true`) is only returned when the blob
 * carries a ticked map, so callers can leave their current ticks alone.
 */
export function parseSubmitOptions(raw: unknown): {
  options: SubmitOptions;
  ticked?: Record<string, boolean>;
} {
  const options: SubmitOptions = { ...DEFAULT_SUBMIT_OPTIONS };
  if (!raw || typeof raw !== "object") return { options };
  const r = raw as Record<string, unknown>;
  for (const k of ["autoApply", "includeScreenshot", "justAsk"] as const) {
    if (typeof r[k] === "boolean") options[k] = r[k];
  }
  if (!r.ticked || typeof r.ticked !== "object") return { options };
  const ticked: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(r.ticked as Record<string, unknown>)) {
    if (on === true) ticked[id] = true;
  }
  return { options, ticked };
}
