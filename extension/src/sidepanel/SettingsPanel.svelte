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
        class:border-ink-200={!enabled || ready}
        class:dark:border-night-line={!enabled || ready}
        class:border-amber-400={enabled && !ready}
        class:dark:border-amber-700={enabled && !ready}
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-wrap">
              <!-- Module icon — colored when enabled, grey when off. Same
                   visual identity as the Test Pilot tab/section flask so
                   the user can recognize a module at a glance. -->
              <span
                class="inline-flex shrink-0"
                class:text-brand-pink={enabled}
                class:dark:text-brand-pink-light={enabled}
                class:text-ink-400={!enabled}
                class:dark:text-night-mute={!enabled}
                aria-hidden="true"
              >
                {#if spec.id === "test-pilot"}
                  <!-- Flask -->
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 3h6" />
                    <path d="M10 3v6.5L4.4 18.7A1.6 1.6 0 0 0 5.8 21h12.4a1.6 1.6 0 0 0 1.4-2.3L14 9.5V3" />
                    <path d="M7.5 14.5h9" opacity="0.55" />
                  </svg>
                {:else if spec.id === "gitlab-issues"}
                  <!-- Ticket / issue tag -->
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                    <line x1="7" y1="7" x2="7.01" y2="7" />
                  </svg>
                {:else}
                  <!-- Generic puzzle-piece fallback for future modules -->
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.872-.95-.04-.275-.21-.498-.456-.605l-.039-.018a1 1 0 0 0-1.137.227l-1.488 1.488A2.41 2.41 0 0 1 12 17.474V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2.526c0 .626.42 1.083 1.057 1.083.275 0 .507-.107.694-.295l1.488-1.488a1 1 0 0 1 1.137-.227l.039.018c.246.107.416.33.456.605.07.47.402.88.872.95a.98.98 0 0 0 .837-.276l1.611-1.611c.47-.47.706-1.087.706-1.704s-.235-1.233-.706-1.704L19.728 1.85a.98.98 0 0 0-.276.837z" />
                  </svg>
                {/if}
              </span>
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
      class="rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-2"
    >
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <!-- Radio-wave / pulse glyph — colored when enabled, grey
                 when off. Matches the visual cue the feature provides
                 around the page edges. -->
            <span
              class="inline-flex shrink-0"
              class:text-brand-pink={app.pulseSettings.enabled}
              class:dark:text-brand-pink-light={app.pulseSettings.enabled}
              class:text-ink-400={!app.pulseSettings.enabled}
              class:dark:text-night-mute={!app.pulseSettings.enabled}
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12a10 10 0 0 1 10-10" opacity="0.4" />
                <path d="M5 12a7 7 0 0 1 7-7" opacity="0.7" />
                <path d="M9 12a3 3 0 0 1 3-3" />
                <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </span>
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
