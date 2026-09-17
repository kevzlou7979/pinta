// Design Variants helpers the overlay needs, as ONE lazily imported
// module (Overlay.svelte imports it on the first preview / match check).
// A content-only entry point keeps the dynamic chunk's exports real
// named exports, so the bundler doesn't need its namespace-object
// runtime — which otherwise lives in a large shared chunk (prism-setup)
// that would then be loaded into the host page.
export {
  buildShadowPreviewHost,
  diffRenderedTrees,
  locateAppliedElement,
  makeDefaultStyleOf,
  sanitizeVariantFragment,
} from "../lib/design-variants.js";
