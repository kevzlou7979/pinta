// Entry for the full-screen Design Variants preview. Opened by the side
// panel (DesignVariantsTab openFullScreen) with a one-time storage key;
// the variant renders inside an empty-sandbox srcdoc iframe.
import "../styles/app.css";
import { mount } from "svelte";
import { applyTheme } from "../lib/theme.svelte.js";
import VariantPreview from "./VariantPreview.svelte";

applyTheme();
mount(VariantPreview, { target: document.getElementById("app")! });
