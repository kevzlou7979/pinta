import "../styles/app.css";
import { mount } from "svelte";
import { applyTheme } from "../lib/theme.svelte.js";
import { applyDensity } from "../lib/density.svelte.js";
import App from "./App.svelte";

applyTheme();
applyDensity();
mount(App, { target: document.getElementById("app")! });
