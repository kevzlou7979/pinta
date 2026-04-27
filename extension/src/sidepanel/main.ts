import "../styles/app.css";
import { mount } from "svelte";
import { applyTheme } from "../lib/theme.svelte.js";
import App from "./App.svelte";

applyTheme();
mount(App, { target: document.getElementById("app")! });
