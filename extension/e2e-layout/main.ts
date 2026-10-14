import "../src/styles/app.css";
import { mount } from "svelte";
import Shell from "./Shell.svelte";
import ShellHidden from "./Shell.hidden.svelte";
import ShellTestPilot from "./Shell.testpilot.svelte";
import ShellVariants from "./Shell.variants.svelte";
import ShellApp from "./Shell.app.svelte";
import ShellDevices from "./Shell.devices.svelte";

// ?variant=control mounts the simulated pre-fix shell (negative control);
// ?variant=test-pilot mounts the Test Pilot tab (docx-import.cjs);
// ?variant=design-variants mounts the Design Variants tab (variants-count.cjs);
// ?variant=app mounts the whole side panel (resubmit-skipped.cjs);
// ?variant=devices mounts the Devices canvas (devices-pulse.cjs);
// ?variant=overlay runs the content overlay as a device frame (devices-frames.cjs).
const variant = new URLSearchParams(location.search).get("variant");
const control = variant === "control";
const target = document.getElementById("app")!;
const named: Record<string, typeof Shell> = {
  "test-pilot": ShellTestPilot,
  "design-variants": ShellVariants,
  app: ShellApp,
  devices: ShellDevices,
};
const tab = variant && named[variant] ? variant : null;
if (variant === "overlay") {
  // ?variant=overlay is "the user's app" inside a device frame: a plain
  // page running the REAL content overlay (devices-frames.cjs frames it).
  target.innerHTML = '<h1>The app</h1><button id="buy" style="color: rgb(0, 0, 0)">Buy now</button>';
  void import("../src/content/overlay.js").then(() => {
    (window as unknown as { __harnessVariant: string }).__harnessVariant = "overlay";
  });
} else {
  mount(tab ? named[tab]! : control ? ShellHidden : Shell, { target });
  (window as unknown as { __harnessVariant: string }).__harnessVariant =
    tab ?? (control ? "control" : "real");
}
