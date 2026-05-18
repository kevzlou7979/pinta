<script lang="ts">
  // Settings panel — slot rendered inside the side panel's main area
  // when `app.viewingSettings` is true. Lists Pinta's built-in modules
  // (currently just GitLab Issues) with an enable toggle and a settings
  // form generated from each module's spec.
  //
  // Scope: deliberately small. No file uploads, no marketplace, no
  // module updates. To add a module, edit `extension/src/lib/modules.ts`
  // and ship the matching agent instructions in `skill/pinta/SKILL.md`.

  import { app } from "../lib/state.svelte.js";
  import {
    BUILTIN_MODULES,
    moduleIsConfigured,
    type ModuleSettingSpec,
    type ModuleSpec,
  } from "../lib/modules.js";

  let revealedSecrets = $state<Record<string, boolean>>({});

  function settingValue(spec: ModuleSpec, field: ModuleSettingSpec): string | boolean {
    const stored = app.modules[spec.id]?.settings[field.key];
    if (stored !== undefined) return stored;
    return field.default ?? (field.type === "boolean" ? false : "");
  }

  function isReady(spec: ModuleSpec): boolean {
    const entry = app.modules[spec.id];
    if (!entry) return false;
    return moduleIsConfigured(spec, entry.settings);
  }

  function toggleSecret(key: string) {
    revealedSecrets[key] = !revealedSecrets[key];
  }
</script>

<section class="space-y-3">
  <div class="flex items-start justify-between gap-2">
    <div>
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">Settings</h2>
      <p class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5">
        Built-in modules extend Pinta with extra workflows. Enable here, opt
        in per submit from the footer.
      </p>
    </div>
    <button
      type="button"
      class="shrink-0 text-ink-500 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text text-lg leading-none px-1"
      onclick={() => (app.viewingSettings = false)}
      aria-label="Close settings"
      title="Close"
    >
      ✕
    </button>
  </div>

  <div class="space-y-2">
    <h3 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
      Modules
    </h3>
    {#each BUILTIN_MODULES as spec (spec.id)}
      {@const entry = app.modules[spec.id]}
      {@const enabled = entry?.enabled ?? false}
      {@const ready = enabled && isReady(spec)}
      <div
        class="rounded-md border bg-white dark:bg-night-card p-3 space-y-2"
        class:border-ink-200={!enabled}
        class:dark:border-night-line={!enabled}
        class:border-brand-pink={enabled && ready}
        class:dark:border-brand-pink-light={enabled && ready}
        class:border-amber-400={enabled && !ready}
        class:dark:border-amber-700={enabled && !ready}
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-sm font-semibold text-ink-900 dark:text-night-text">
                {spec.name}
              </span>
              {#if enabled && !ready}
                <span class="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800/50 rounded-full px-1.5 py-0.5">
                  Needs setup
                </span>
              {:else if enabled && ready}
                <span class="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800/50 rounded-full px-1.5 py-0.5">
                  Ready
                </span>
              {/if}
            </div>
            <p class="text-[12px] text-ink-700 dark:text-night-dim mt-0.5">
              {spec.description}
            </p>
          </div>
          <label class="shrink-0 inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              class="sr-only peer"
              checked={enabled}
              onchange={(e) =>
                app.setModuleEnabled(spec.id, (e.currentTarget as HTMLInputElement).checked)}
            />
            <span
              class="relative w-9 h-5 bg-ink-300 dark:bg-night-line rounded-full peer-checked:bg-brand-pink dark:peer-checked:bg-brand-pink-light transition-colors"
              aria-hidden="true"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"
                class:translate-x-4={enabled}
              ></span>
            </span>
          </label>
        </div>

        {#if enabled}
          <div class="space-y-2 pt-2 border-t border-ink-100 dark:border-night-line">
            {#each spec.settings as field (field.key)}
              {@const value = settingValue(spec, field)}
              {#if field.type === "boolean"}
                <!-- Inline checkbox layout — keeps boolean toggles tight
                     and reads more like a real setting row. -->
                <div class="text-[11px] text-ink-700 dark:text-night-dim">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      class="accent-brand-pink shrink-0"
                      checked={value === true}
                      onchange={(e) =>
                        app.setModuleSetting(
                          spec.id,
                          field.key,
                          (e.currentTarget as HTMLInputElement).checked,
                        )}
                    />
                    <span class="flex items-center gap-1">
                      {field.label}
                      {#if field.required}
                        <span class="text-brand-pink dark:text-brand-pink-light" title="Required">*</span>
                      {/if}
                    </span>
                  </label>
                  {#if field.hint}
                    <p class="text-[10px] text-ink-500 dark:text-night-mute mt-0.5 leading-tight pl-6">
                      {field.hint}
                    </p>
                  {/if}
                </div>
              {:else}
              <label class="block text-[11px] text-ink-700 dark:text-night-dim">
                <span class="flex items-center gap-1">
                  {field.label}
                  {#if field.required}
                    <span class="text-brand-pink dark:text-brand-pink-light" title="Required">*</span>
                  {/if}
                </span>
                {#if field.type === "secret"}
                  <div class="mt-0.5 relative">
                    <input
                      type={revealedSecrets[`${spec.id}:${field.key}`] ? "text" : "password"}
                      value={typeof value === "string" ? value : ""}
                      placeholder={field.placeholder ?? ""}
                      class="w-full rounded border border-ink-300 bg-white text-ink-900 px-2 py-1 pr-14 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text font-mono"
                      onchange={(e) =>
                        app.setModuleSetting(
                          spec.id,
                          field.key,
                          (e.currentTarget as HTMLInputElement).value,
                        )}
                    />
                    <button
                      type="button"
                      class="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-ink-500 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text px-1.5 py-0.5 rounded hover:bg-ink-100 dark:hover:bg-night-line"
                      onclick={() => toggleSecret(`${spec.id}:${field.key}`)}
                      aria-label={revealedSecrets[`${spec.id}:${field.key}`] ? "Hide" : "Show"}
                    >
                      {revealedSecrets[`${spec.id}:${field.key}`] ? "Hide" : "Show"}
                    </button>
                  </div>
                {:else}
                  <input
                    type="text"
                    value={typeof value === "string" ? value : ""}
                    placeholder={field.placeholder ?? ""}
                    class="mt-0.5 w-full rounded border border-ink-300 bg-white text-ink-900 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text"
                    onchange={(e) =>
                      app.setModuleSetting(
                        spec.id,
                        field.key,
                        (e.currentTarget as HTMLInputElement).value,
                      )}
                  />
                {/if}
                {#if field.hint}
                  <span class="block text-[10px] text-ink-500 dark:text-night-mute mt-0.5 leading-tight">
                    {field.hint}
                  </span>
                {/if}
              </label>
              {/if}
            {/each}
            {#if !ready}
              <p class="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                Fill in the required fields above to mark this module ready
                — the per-submit checkbox will activate in the footer.
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    <p class="text-[11px] text-ink-500 dark:text-night-mute italic">
      More modules coming in future releases.
    </p>
  </div>

  <div class="space-y-2">
    <h3 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
      Visual feedback
    </h3>
    <div
      class="rounded-md border bg-white dark:bg-night-card p-3 space-y-2"
      class:border-ink-200={!app.pulseSettings.enabled}
      class:dark:border-night-line={!app.pulseSettings.enabled}
      class:border-brand-pink={app.pulseSettings.enabled}
      class:dark:border-brand-pink-light={app.pulseSettings.enabled}
    >
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="text-sm font-semibold text-ink-900 dark:text-night-text">
              Processing pulse
            </span>
          </div>
          <p class="text-[12px] text-ink-700 dark:text-night-dim mt-0.5">
            Pulsating glow around the page edges while the agent is
            applying a session. Off by default.
          </p>
        </div>
        <label class="shrink-0 inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            class="sr-only peer"
            checked={app.pulseSettings.enabled}
            onchange={(e) =>
              app.setPulseEnabled((e.currentTarget as HTMLInputElement).checked)}
          />
          <span
            class="relative w-9 h-5 bg-ink-300 dark:bg-night-line rounded-full peer-checked:bg-brand-pink dark:peer-checked:bg-brand-pink-light transition-colors"
            aria-hidden="true"
          >
            <span
              class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"
              class:translate-x-4={app.pulseSettings.enabled}
            ></span>
          </span>
        </label>
      </div>

      {#if app.pulseSettings.enabled}
        <div class="pt-2 border-t border-ink-100 dark:border-night-line">
          <span class="block text-[11px] text-ink-700 dark:text-night-dim mb-1.5">
            Color
          </span>
          <div class="flex items-center gap-2 flex-wrap">
            {#each [
              { hex: "#3B82F6", name: "Blue" },
              { hex: "#FF3D6E", name: "Pink" },
              { hex: "#10B981", name: "Green" },
              { hex: "#A855F7", name: "Purple" },
              { hex: "#F59E0B", name: "Orange" },
            ] as swatch (swatch.hex)}
              <button
                type="button"
                class="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                class:border-ink-900={app.pulseSettings.color.toLowerCase() === swatch.hex.toLowerCase()}
                class:dark:border-night-text={app.pulseSettings.color.toLowerCase() === swatch.hex.toLowerCase()}
                class:border-transparent={app.pulseSettings.color.toLowerCase() !== swatch.hex.toLowerCase()}
                style:background-color={swatch.hex}
                onclick={() => app.setPulseColor(swatch.hex)}
                aria-label="{swatch.name} (current: {app.pulseSettings.color.toLowerCase() === swatch.hex.toLowerCase() ? 'selected' : 'click to select'})"
                title={swatch.name}
              ></button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</section>
