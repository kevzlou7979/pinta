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

  document.documentElement.appendChild(host);

  mount(Overlay, { target: root });
}
