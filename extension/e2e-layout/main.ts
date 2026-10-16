import "../src/styles/app.css";
import { mount } from "svelte";
import Shell from "./Shell.svelte";
import ShellHidden from "./Shell.hidden.svelte";
import ShellTestPilot from "./Shell.testpilot.svelte";
import ShellVariants from "./Shell.variants.svelte";
import ShellApp from "./Shell.app.svelte";
import ShellDevices from "./Shell.devices.svelte";
import ShellMotion from "./Shell.motion.svelte";
import ShellReport from "./Shell.report.svelte";

// ?variant=control mounts the simulated pre-fix shell (negative control);
// ?variant=test-pilot mounts the Test Pilot tab (docx-import.cjs);
// ?variant=design-variants mounts the Design Variants tab (variants-count.cjs);
// ?variant=app mounts the whole side panel (resubmit-skipped.cjs);
// ?variant=devices mounts the Devices canvas (devices-pulse.cjs);
// ?variant=overlay runs the content overlay as a device frame (devices-frames.cjs);
// ?variant=motion mounts the side panel with the Motion module on (motion.cjs);
// ?variant=motion-runner is a bare page exposing the in-page motion runner (motion.cjs);
// ?variant=report mounts the side panel with the Report module on (report-owner.cjs).
const variant = new URLSearchParams(location.search).get("variant");
const control = variant === "control";
const target = document.getElementById("app")!;
const named: Record<string, typeof Shell> = {
  "test-pilot": ShellTestPilot,
  "design-variants": ShellVariants,
  app: ShellApp,
  devices: ShellDevices,
  motion: ShellMotion,
  report: ShellReport,
};
const tab = variant && named[variant] ? variant : null;
if (variant === "motion-runner") {
  // The REAL runner (src/content/motion-run.ts) on whatever fixture DOM
  // the driver injects — jsdom has no Element.animate, so this is the
  // only honest place to test it.
  void Promise.all([import("../src/content/motion-run.js"), import("../src/lib/motion.js")]).then(
    ([run, lib]) => {
      (window as unknown as { __motion: unknown }).__motion = {
        runPlan: run.runPlan,
        childCountFor: run.childCountFor,
        buildPlan: lib.buildPlan,
        getPattern: lib.getPattern,
        DEFAULT_MOTION_SYSTEM: lib.DEFAULT_MOTION_SYSTEM,
      };
      (window as unknown as { __harnessVariant: string }).__harnessVariant = "motion-runner";
    },
  );
} else if (variant === "overlay") {
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
