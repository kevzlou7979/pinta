<script lang="ts">
  // NEGATIVE CONTROL — simulates the pre-fix side panel: root uses
  // `overflow-hidden` (programmatically scrollable) and the toggle labels
  // lose `relative`, so the sr-only checkbox escapes <main>. run.cjs must
  // report FAIL for this variant; if it passes, the harness is blind.
  //
  // Diagnostic knobs (run.cjs --matrix): ?root=clip keeps the real
  // `overflow-clip` root; ?labels=relative keeps the real labels. Lets the
  // harness show what each half of the fix contributes on its own.
  import SettingsPanel from "../src/sidepanel/SettingsPanel.svelte";

  const q = new URLSearchParams(location.search);
  const rootClip = q.get("root") === "clip";
  if (q.get("labels") !== "relative") {
    // Injected at runtime (not a component <style>) so the rule never lands
    // in the shared CSS bundle and leaks into the real variant.
    const s = document.createElement("style");
    s.id = "control-prefix-sim";
    s.textContent = "label.relative{position:static!important}";
    document.head.appendChild(s);
  }
</script>

<div
  id="shell-root"
  class="flex flex-col h-full"
  class:overflow-hidden={!rootClip}
  class:overflow-clip={rootClip}
>
  <header
    id="shell-header"
    class="shrink-0 px-4 py-3 border-b border-ink-200 bg-white dark:border-night-line dark:bg-night-card flex items-center justify-between"
  >
    <h1 class="font-semibold text-sm dark:text-night-text">Pinta (control)</h1>
  </header>
  <div id="shell-body" class="flex-1 relative flex flex-col min-h-0">
    <main id="shell-main" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <SettingsPanel />
    </main>
    <button
      type="button"
      id="shell-fab"
      class="absolute bottom-5 right-5 z-20 w-12 h-12 inline-flex items-center justify-center rounded-full bg-brand-pink text-white shadow-lg"
      aria-label="Ask Pinta"
    >?</button>
  </div>
</div>
