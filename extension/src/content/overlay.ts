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

  document.documentElement.appendChild(host);

  mount(Overlay, { target: root });
}
