import "../src/styles/app.css";
import { mount } from "svelte";
import Shell from "./Shell.svelte";
import ShellHidden from "./Shell.hidden.svelte";

// ?variant=control mounts the simulated pre-fix shell (negative control).
const control = new URLSearchParams(location.search).get("variant") === "control";
const target = document.getElementById("app")!;
mount(control ? ShellHidden : Shell, { target });
(window as unknown as { __harnessVariant: string }).__harnessVariant = control ? "control" : "real";
