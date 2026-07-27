import type { Session } from "@pinta/shared";

/**
 * Where an incoming `session.created` / `session.synced` broadcast belongs
 * in the async-batch model (Phase 20).
 *
 * Invariant: `state.session` (the active draft) is ALWAYS a `drafting`
 * session. Every in-flight or finished batch lives in `inFlightBatches`
 * (the "Submitted" tray). So the ONLY broadcast that may become the active
 * draft is a `drafting` one. A non-draft broadcast that isn't already
 * tracked is a batch — routing it to the draft slot strands the footer on
 * "Submitted — waiting for agent" and freezes annotating (both
 * `canEditAnnotations` and `canSubmit` require status "drafting"). That was
 * the regression this classifier prevents.
 */
export type SyncRoute =
  /** Already in the tray → update that row in place. */
  | "tray-update"
  /** A live `drafting` session → adopt it as the active draft. */
  | "adopt-draft"
  /** An untracked submitted/applying batch → add it to the tray. */
  | "tray-add"
  /** A stale terminal (done/error) echo for an untracked batch → ignore. */
  | "drop";

export function classifySyncedSession(
  incoming: Pick<Session, "id" | "status">,
  ctx: { inTray: boolean },
): SyncRoute {
  if (ctx.inTray) return "tray-update";
  if (incoming.status === "drafting") return "adopt-draft";
  if (incoming.status === "submitted" || incoming.status === "applying")
    return "tray-add";
  return "drop";
}
