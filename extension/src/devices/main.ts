// Entry for the full-tab Devices canvas (Phase 24). Opened by the
// side panel's Devices tab via chrome.tabs.create — never embedded.
import "../styles/app.css";
import { mount } from "svelte";
import { applyTheme } from "../lib/theme.svelte.js";
import DevicesApp from "./DevicesApp.svelte";

applyTheme();
mount(DevicesApp, { target: document.getElementById("app")! });
