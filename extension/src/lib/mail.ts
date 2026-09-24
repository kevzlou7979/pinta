/** Prefilled email drafts.
 *
 *  Neither `mailto:` nor Gmail's compose URL can carry an attachment
 *  (browsers and Gmail both refuse), so every caller downloads the file
 *  first and the draft body tells the sender to drag it in.
 *
 *  `gmail` opens Gmail's web compose — on a machine with no registered
 *  OS mail handler a bare `mailto:` only offers the browser itself,
 *  which is what testers hit in practice. `mailto` stays available for
 *  people who do live in Outlook / Mail / Thunderbird.
 */
export type MailVia = "gmail" | "mailto";

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
}

/** Build the compose URL for a draft. Exported for tests. */
export function mailDraftUrl(draft: MailDraft, via: MailVia = "gmail"): string {
  const to = encodeURIComponent(draft.to.trim());
  const su = encodeURIComponent(draft.subject);
  const body = encodeURIComponent(draft.body);
  return via === "gmail"
    ? `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=${to}&su=${su}&body=${body}`
    : `mailto:${to}?subject=${su}&body=${body}`;
}

/** Good-enough address check — `type="email"` validates nothing outside a
 *  <form>, and a typo'd address would otherwise sail into the compose URL. */
export function isEmailish(value: string): boolean {
  const v = value.trim();
  // Dotless hosts are allowed on purpose — intranet addresses like
  // qa@intranet are real and must not lock the send button out.
  return /^[^\s@]+@[^\s@]+$/.test(v) && !v.includes("..");
}

/** Open a prefilled draft in a new tab (Gmail) or the OS mail client.
 *  Returns false when the browser refused to open it (popup blocker, no
 *  registered mail handler) so callers can surface that instead of
 *  leaving the user staring at an unchanged panel. */
export function openMailDraft(draft: MailDraft, via: MailVia = "gmail"): boolean {
  // No `noopener` feature string here: per spec `window.open(…,
  // "noopener")` ALWAYS returns null, which read as "popup blocked" even
  // when the Gmail tab opened fine. Open plainly and sever the opener
  // afterwards — the compose tab still has no way back into the panel.
  const opened = window.open(mailDraftUrl(draft, via), "_blank");
  if (opened) opened.opener = null;
  // `mailto:` legitimately returns null in some browsers even when the
  // handler fired, so only the Gmail tab is verifiable. Callers must
  // word the mailto confirmation as "if your mail app opened…" rather
  // than asserting a draft appeared.
  return via === "mailto" ? true : Boolean(opened);
}

/** Gesture-free variant of `openMailDraft` for drafts that open after a
 *  long async wait (e.g. Test Pilot auto-generating steps before it
 *  emails a tester sheet). By then the click that started it is long
 *  gone, and `window.open` without a user gesture is popup-blocked —
 *  `chrome.tabs.create` needs no gesture, so the Gmail compose tab goes
 *  through it when the extension API is present. `mailto:` keeps the
 *  `window.open` path: a tab created on a `mailto:` URL fires the OS
 *  handler but leaves a blank tab behind. Falls back to `openMailDraft`
 *  outside an extension context or when the tabs call throws. */
export async function openMailDraftTab(
  draft: MailDraft,
  via: MailVia = "gmail",
): Promise<boolean> {
  const tabs = (globalThis as { chrome?: { tabs?: { create?: (p: { url: string }) => Promise<unknown> } } })
    .chrome?.tabs;
  if (via === "gmail" && typeof tabs?.create === "function") {
    try {
      await tabs.create({ url: mailDraftUrl(draft, via) });
      return true;
    } catch {
      // Fall through to the window.open path below.
    }
  }
  return openMailDraft(draft, via);
}
