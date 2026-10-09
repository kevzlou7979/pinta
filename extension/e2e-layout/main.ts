import "../src/styles/app.css";
import { mount } from "svelte";
import Shell from "./Shell.svelte";
import ShellHidden from "./Shell.hidden.svelte";
import ShellTestPilot from "./Shell.testpilot.svelte";

// ?variant=control mounts the simulated pre-fix shell (negative control);
// ?variant=test-pilot mounts the Test Pilot tab (docx-import.cjs).
const variant = new URLSearchParams(location.search).get("variant");
const control = variant === "control";
const target = document.getElementById("app")!;
mount(variant === "test-pilot" ? ShellTestPilot : control ? ShellHidden : Shell, { target });
(window as unknown as { __harnessVariant: string }).__harnessVariant =
  variant === "test-pilot" ? "test-pilot" : control ? "control" : "real";
