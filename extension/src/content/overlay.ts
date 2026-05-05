import { mount } from "svelte";
import Overlay from "./Overlay.svelte";
import css from "./styles.css?inline";

const HOST_TAG = "pinta-overlay-host";

if (!document.querySelector(HOST_TAG)) {
  const host = document.createElement(HOST_TAG);
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";

  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  const root = document.createElement("div");
  root.id = "pinta-root";
  shadow.appendChild(root);

  // Stop pointer / focus events that originated inside our shadow DOM
  // from bubbling out to document listeners. Without this, the host
  // page's popover / dialog libraries (Radix, Headless UI, etc.) treat
  // a click on our editor popup as "outside click" and dismiss the
  // dialog the user was editing, unmounting the target element mid-edit.
  //
  // Only events whose path passes through this host fire here — host-page
  // clicks bypass us entirely, so the page's normal interactivity is
  // untouched.
  const trappedEvents: (keyof DocumentEventMap)[] = [
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "pointerdown",
    "pointerup",
    "focusin",
    "focusout",
  ];
  for (const type of trappedEvents) {
    host.addEventListener(type, (e) => {
      e.stopPropagation();
    });
  }

  // Focus events specifically need a *capture-phase* stopper at window,
  // not just the bubble-phase host listener above. Modal focus traps
  // (Radix Dialog, focus-trap, Headless UI, react-focus-lock) listen
  // for `focusin`/`focusout` on document or the modal element during
  // capture, so they fire BEFORE the event reaches the host's bubble
  // listener — leaving the comment box un-typeable while a page modal
  // is open.
  //
  // Two cases must both be suppressed:
  //   (a) focus events whose path passes through our shadow — e.g. the
  //       focusin on our textarea. Filtered by `composedPath().includes(host)`.
  //   (b) focusout/blur fired on a *page* element whose focus is being
  //       handed off to our shadow — the path does NOT pass through us,
  //       but the `relatedTarget` is retargeted to our host (because the
  //       new focus owner is inside the shadow). Without this case, the
  //       page lib's focusout listener fires, sees focus leaving the
  //       modal, and yanks it straight back — exactly the symptom where
  //       a single keystroke lands and then focus is stolen.
  //
  // Safe because the textarea inside the shadow still gets focus via the
  // browser's default click→focus behavior, and we have no in-shadow
  // handlers for these events.
  const focusTrapEvents: (keyof WindowEventMap)[] = [
    "focus",
    "focusin",
    "focusout",
    "blur",
  ];
  for (const type of focusTrapEvents) {
    window.addEventListener(
      type,
      (e) => {
        if (e.composedPath().includes(host)) {
          e.stopPropagation();
          return;
        }
        const fe = e as FocusEvent;
        if (
          (fe.type === "focusout" || fe.type === "blur") &&
          fe.relatedTarget === host
        ) {
          e.stopPropagation();
        }
      },
      { capture: true },
    );
  }

  // Page libs (focus-trap, react-focus-lock, some Radix variants) use
  // capture-phase `mousedown` / `pointerdown` listeners that call
  // `e.preventDefault()` to block the browser's default click-to-focus
  // when the click target is "outside" their modal. The shadow root
  // makes our textarea look outside, so the page's preventDefault fires
  // and the textarea never actually focuses.
  //
  // Stop these at window-capture, but ONLY when the actual target is a
  // form field inside our shadow. Two reasons for the narrow scope:
  //   1. stopPropagation at window-capture also skips the AT_TARGET
  //      phase, so it would silence the canvas's own `onmousedown`
  //      (Canvas.svelte) and the image-placement drag/resize handlers
  //      (Overlay.svelte). Filtering on the target spares those.
  //   2. Only focusable inputs need the click→focus default action
  //      protected. Buttons get activated via `click`, not via the
  //      mousedown focus default, so leaving their mousedown alone is
  //      harmless.
  //
  // Default actions (focus, selection start) still fire because
  // stopPropagation doesn't prevent default — only listeners are
  // skipped. The matching `click` event is intentionally left alone so
  // our popup's onclick handlers still fire normally; the host-bubble
  // click stopper above handles outside-click dismissal.
  const FOCUSABLE_INPUT_SELECTOR =
    "input, textarea, select, [contenteditable=''], [contenteditable='true']";
  const pointerEventsToShield: (keyof WindowEventMap)[] = [
    "mousedown",
    "pointerdown",
  ];
  for (const type of pointerEventsToShield) {
    window.addEventListener(
      type,
      (e) => {
        const path = e.composedPath();
        if (!path.includes(host)) return;
        const target = path[0];
        if (
          target instanceof Element &&
          target.matches(FOCUSABLE_INPUT_SELECTOR)
        ) {
          e.stopPropagation();
        }
      },
      { capture: true },
    );
  }

  document.documentElement.appendChild(host);

  mount(Overlay, { target: root });
}
