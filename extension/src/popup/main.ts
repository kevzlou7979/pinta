import "../styles/app.css";
import { mount } from "svelte";
import { applyTheme } from "../lib/theme.svelte.js";
import Popup from "./Popup.svelte";

applyTheme();
mount(Popup, { target: document.getElementById("app")! });
