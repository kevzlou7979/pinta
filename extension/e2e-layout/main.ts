import "../src/styles/app.css";
import { mount } from "svelte";
import Shell from "./Shell.svelte";
import ShellHidden from "./Shell.hidden.svelte";
import ShellTestPilot from "./Shell.testpilot.svelte";
import ShellVariants from "./Shell.variants.svelte";

// ?variant=control mounts the simulated pre-fix shell (negative control);
// ?variant=test-pilot mounts the Test Pilot tab (docx-import.cjs);
// ?variant=design-variants mounts the Design Variants tab (variants-count.cjs).
const variant = new URLSearchParams(location.search).get("variant");
const control = variant === "control";
const target = document.getElementById("app")!;
const named: Record<string, typeof Shell> = {
  "test-pilot": ShellTestPilot,
  "design-variants": ShellVariants,
};
const tab = variant && named[variant] ? variant : null;
mount(tab ? named[tab]! : control ? ShellHidden : Shell, { target });
(window as unknown as { __harnessVariant: string }).__harnessVariant =
  tab ?? (control ? "control" : "real");
