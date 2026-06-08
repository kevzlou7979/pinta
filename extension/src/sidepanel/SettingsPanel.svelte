<script lang="ts">
  // Settings panel — slot rendered inside the side panel's main area
  // when `app.viewingSettings` is true. Lists Pinta's built-in modules
  // PLUS any imported (third-party) modules installed in the active
  // project, each with an enable toggle and a settings form generated
  // from its spec.
  //
  // Importable modules (Phase 19): the user picks a `.pinta-module.json`
  // bundle, reviews its capabilities + agent instructions in a consent
  // dialog, and grants a subset. The companion writes it to
  // `.pinta/modules/<id>/`; the /pinta skill loads `agent.md` (§7.12).

  import { app } from "../lib/state.svelte.js";
  import {
    moduleIsConfigured,
    type ModuleSettingSpec,
    type ModuleSpec,
  } from "../lib/modules.js";
  import type {
    ModulePackage,
    ModuleCapability,
    InstalledModule,
  } from "@pinta/shared";
  import {
    parseSettingsBundle,
    summarizeBundle,
    type PintaSettingsBundle,
    type BundleSummary,
  } from "../lib/pinta-settings.js";

  let revealedSecrets = $state<Record<string, boolean>>({});

  // Which module cards are expanded to show their description + settings.
  // Default (undefined) is computed per-card: collapsed normally, but
  // auto-open when a module is enabled yet not configured so its required
  // fields are never hidden behind the chevron.
  let expandedModules = $state<Record<string, boolean>>({});
  function moduleOpen(spec: ModuleSpec, enabled: boolean, ready: boolean): boolean {
    const explicit = expandedModules[spec.id];
    if (explicit !== undefined) return explicit;
    return enabled && !ready;
  }
  function toggleModule(spec: ModuleSpec, current: boolean) {
    expandedModules[spec.id] = !current;
  }

  // The keyboard-shortcuts reference is a tall static block — collapsed by
  // default so it doesn't dominate the settings scroll.
  let showShortcuts = $state(false);

  // All module specs to render — built-ins first, then imported.
  const specs = $derived(app.allModuleSpecs());
  // Quick lookup: which specs are imported (vs bundled), keyed by id.
  const importedById = $derived(
    new Map<string, InstalledModule>(
      app.installedModules.map((m) => [m.manifest.id, m]),
    ),
  );

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

  // ── Import flow ──────────────────────────────────────────────────
  let fileInput = $state<HTMLInputElement | null>(null);
  // The bundle awaiting consent, plus the per-capability grant checkboxes.
  let pendingImport = $state<{ pkg: ModulePackage; fileName: string } | null>(null);
  let grantChecked = $state<Record<string, boolean>>({});
  let importing = $state(false);

  const canImport = $derived(!!app.selectedCompanion);

  /** Lenient client-side shape check — the companion does the
   *  authoritative validation, this just catches obvious junk early. */
  function parsePackage(text: string): ModulePackage {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("Not valid JSON.");
    }
    const pkg = raw as Partial<ModulePackage>;
    if (!pkg || typeof pkg !== "object" || pkg.$pintaModule !== "1") {
      throw new Error('Not a Pinta module (expected `$pintaModule: "1"`).');
    }
    if (!pkg.manifest || typeof pkg.manifest.id !== "string") {
      throw new Error("Module manifest is missing or has no id.");
    }
    if (typeof pkg.agent !== "string" || pkg.agent.trim() === "") {
      throw new Error("Module is missing its agent instructions.");
    }
    return pkg as ModulePackage;
  }

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      const pkg = parsePackage(await file.text());
      pendingImport = { pkg, fileName: file.name };
      // Default-deny: every declared capability starts UNCHECKED.
      grantChecked = {};
      app.dismissModuleError();
    } catch (err) {
      app.moduleError = `Couldn't read module: ${(err as Error).message}`;
    }
  }

  function cancelImport() {
    pendingImport = null;
    grantChecked = {};
  }

  async function confirmImport() {
    if (!pendingImport) return;
    const declared = pendingImport.pkg.manifest.capabilities ?? [];
    const granted = declared.filter((c) => grantChecked[c]) as ModuleCapability[];
    importing = true;
    try {
      await app.importModule(pendingImport.pkg, granted);
      pendingImport = null;
      grantChecked = {};
    } catch {
      // app.moduleError already set by importModule — keep the dialog open
      // so the user can retry or cancel.
    } finally {
      importing = false;
    }
  }

  /** Friendly one-liner for a capability id shown in the consent dialog. */
  function capLabel(c: ModuleCapability): string {
    if (c === "read-files") return "Read files in this project";
    if (c === "write-files") return "Create / edit files in this project";
    if (c.startsWith("run-tool:")) return `Run the \`${c.slice("run-tool:".length)}\` command`;
    if (c.startsWith("network:")) return `Make network requests to ${c.slice("network:".length)}`;
    return c;
  }

  /** write/shell/network are the elevated ones we warn harder about. */
  function capIsElevated(c: ModuleCapability): boolean {
    return c !== "read-files";
  }

  // ── Backup & restore (global settings bundle) ────────────────────
  // One `pinta-settings.json` carries Test Pilot catalogs (with results)
  // + the AuditFlow catalog, so the user can recover after a cache wipe
  // or move state between machines. Module config + secrets are NEVER
  // exported. Import merges audit catalog + adopts the Test Pilot catalog.
  let settingsFileInput = $state<HTMLInputElement | null>(null);
  let pendingRestore = $state<{
    bundle: PintaSettingsBundle;
    summary: BundleSummary;
    fileName: string;
  } | null>(null);
  let restoring = $state(false);
  let backupError = $state<string | null>(null);

  function fileStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function exportAllSettings() {
    const bundle = app.exportSettingsBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pinta-settings-${fileStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function onSettingsFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;
    backupError = null;
    const bundle = parseSettingsBundle(await file.text());
    if (!bundle) {
      backupError =
        "Couldn't read that file — it isn't a Pinta settings bundle (expected `$pintaSettings: \"1\"`).";
      return;
    }
    pendingRestore = {
      bundle,
      summary: summarizeBundle(bundle),
      fileName: file.name,
    };
  }

  function cancelRestore() {
    pendingRestore = null;
  }

  async function confirmRestore() {
    if (!pendingRestore) return;
    restoring = true;
    try {
      await app.importSettingsBundle(pendingRestore.bundle);
      pendingRestore = null;
    } catch (err) {
      backupError = `Restore failed: ${(err as Error).message}`;
    } finally {
      restoring = false;
    }
  }
</script>

<section class="space-y-3">
  <div class="flex items-start justify-between gap-2">
    <div>
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">Settings</h2>
      <p class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5">
        Modules extend Pinta with extra workflows. Enable here, opt in per
        submit from the footer. Import your own below.
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

    {#if app.moduleError}
      <div
        class="flex items-start gap-2 rounded-md border border-red-300 dark:border-red-800/60 bg-red-50 dark:bg-red-950/40 px-2.5 py-2 text-[11px] text-red-700 dark:text-red-300"
        role="alert"
      >
        <span class="min-w-0 flex-1 leading-snug">{app.moduleError}</span>
        <button
          type="button"
          class="shrink-0 text-red-500 hover:text-red-800 dark:hover:text-red-200 leading-none"
          onclick={() => app.dismissModuleError()}
          aria-label="Dismiss error"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    {/if}

    {#each specs as spec (spec.id)}
      {@const entry = app.modules[spec.id]}
      {@const enabled = entry?.enabled ?? false}
      {@const ready = enabled && isReady(spec)}
      {@const installed = importedById.get(spec.id)}
      {@const open = moduleOpen(spec, enabled, ready)}
      <div
        class="rounded-md border bg-white dark:bg-night-card overflow-hidden"
        class:border-ink-200={!enabled || ready}
        class:dark:border-night-line={!enabled || ready}
        class:border-amber-400={enabled && !ready}
        class:dark:border-amber-700={enabled && !ready}
      >
        <!-- Compact header — icon + name + status, always one tidy line.
             The chevron expands the description + settings on demand so the
             list stays scannable. Toggle stays outside the expander button
             (nested interactive controls aren't allowed). -->
        <div class="flex items-center gap-2 p-3">
          <button
            type="button"
            class="min-w-0 flex-1 flex items-center gap-1.5 text-left group"
            onclick={() => toggleModule(spec, open)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${spec.name}` : `Expand ${spec.name}`}
          >
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
              class="shrink-0 text-ink-400 dark:text-night-mute transition-transform"
              class:rotate-90={open}
              aria-hidden="true"
            ><polyline points="9 18 15 12 9 6" /></svg>
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
            <span class="text-sm font-semibold text-ink-900 dark:text-night-text truncate">
              {spec.name}
            </span>
            {#if installed}
              <span class="inline-flex shrink-0 items-center text-[10px] uppercase tracking-wide font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-950/50 border border-indigo-300 dark:border-indigo-800/50 rounded-full px-1.5 py-0.5">
                Imported
              </span>
            {/if}
            {#if enabled && !ready}
              <span class="inline-flex shrink-0 items-center text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800/50 rounded-full px-1.5 py-0.5">
                Needs setup
              </span>
            {:else if enabled && ready}
              <span class="inline-flex shrink-0 items-center text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800/50 rounded-full px-1.5 py-0.5">
                Ready
              </span>
            {/if}
          </button>
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

        {#if open}
        <div class="px-3 pb-3 space-y-2 border-t border-ink-100 dark:border-night-line pt-2">
          <p class="text-[12px] text-ink-700 dark:text-night-dim">
            {spec.description}
          </p>
          {#if installed}
            <!-- Imported module — show who shipped it + the capabilities
                 the user granted at import, and a way to remove it. -->
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-[10px] text-ink-500 dark:text-night-mute">
                v{installed.manifest.version}{installed.manifest.author
                  ? ` · ${installed.manifest.author}`
                  : ""}
              </span>
            </div>
            <div class="flex items-center gap-1 flex-wrap">
              {#if installed.grantedCapabilities.length === 0}
                <span class="text-[10px] text-ink-500 dark:text-night-mute italic">
                  Read-only (no extra capabilities granted)
                </span>
              {:else}
                {#each installed.grantedCapabilities as cap (cap)}
                  <span class="inline-flex items-center font-mono text-[10px] text-ink-700 dark:text-night-dim bg-ink-100 dark:bg-night-bg border border-ink-200 dark:border-night-line rounded px-1 py-0.5">
                    {cap}
                  </span>
                {/each}
              {/if}
            </div>
          {/if}

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

        {#if installed}
          <div class="pt-2 border-t border-ink-100 dark:border-night-line flex justify-end">
            <button
              type="button"
              class="text-[11px] text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200 hover:underline"
              onclick={() => app.uninstallModule(spec.id)}
            >
              Uninstall
            </button>
          </div>
        {/if}
        </div>
        {/if}
      </div>
    {/each}

    <!-- Import a third-party module (Phase 19). A module is a single
         `.pinta-module.json` (manifest + agent instructions); the consent
         dialog below shows exactly what it can do before anything lands. -->
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,.pinta-module.json,application/json"
      class="hidden"
      onchange={onFilePicked}
    />
    <button
      type="button"
      class="w-full rounded-md border border-dashed border-ink-300 dark:border-night-line px-3 py-2 text-[12px] font-medium text-ink-700 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink dark:hover:text-brand-pink-light disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-ink-300 disabled:hover:text-ink-700"
      disabled={!canImport}
      onclick={() => fileInput?.click()}
      title={canImport
        ? "Import a .pinta-module.json"
        : "Connect to a project companion to import modules"}
    >
      + Import module…
    </button>
    {#if !canImport}
      <p class="text-[11px] text-ink-500 dark:text-night-mute italic">
        Connect to a project to import modules — they install into that
        project's <code>.pinta/modules/</code>.
      </p>
    {/if}
  </div>

  <!-- Backup & restore — one bundle for Test Pilot (with results) + the
       AuditFlow catalog. Recovers state after a cache clear; ports it
       between machines. Module config + secrets are never exported. -->
  <div class="space-y-2">
    <h3 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
      Backup &amp; restore
    </h3>
    <div class="rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-2.5">
      <p class="text-[12px] text-ink-600 dark:text-night-dim leading-snug">
        Export your <strong>Test Pilot</strong> test cases (with results) and
        <strong>AuditFlow</strong> categories to a single
        <code class="font-mono text-[10.5px] bg-ink-100 dark:bg-night-alt px-1 rounded">pinta-settings.json</code>.
        Re-import it after clearing your browser data, or to move your setup to
        another machine. Module API keys are never included.
      </p>
      {#if backupError}
        <div class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug">
          <p class="flex-1 min-w-0 break-words">{backupError}</p>
          <button
            type="button"
            class="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 leading-none px-1"
            onclick={() => (backupError = null)}
            aria-label="Dismiss error"
            title="Dismiss"
          >✕</button>
        </div>
      {/if}
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line px-3 py-2 text-[12px] font-medium text-ink-700 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink dark:hover:text-brand-pink-light"
          onclick={exportAllSettings}
          title="Download all your Pinta settings as one file"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export all settings
        </button>
        <button
          type="button"
          class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line px-3 py-2 text-[12px] font-medium text-ink-700 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink dark:hover:text-brand-pink-light"
          onclick={() => settingsFileInput?.click()}
          title="Import a pinta-settings.json file"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import settings…
        </button>
      </div>
      <input
        bind:this={settingsFileInput}
        type="file"
        accept=".json,application/json"
        class="hidden"
        onchange={onSettingsFilePicked}
      />
    </div>
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

  <!-- Phase 18 — keybindings reference. Read-only; the bindings
       themselves live in code (Overlay.svelte hotkey handler,
       ChatSheet/CommentInput/ElementEditor key handlers). When the
       bindings change, update this list AND /staging walks the same
       inventory to flag drift. The sections mirror where the user is
       when the shortcut applies, so they don't try Alt+S inside a
       textarea and wonder why nothing happens. -->
  <div class="space-y-2">
    <button
      type="button"
      class="w-full flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium hover:text-ink-700 dark:hover:text-night-dim transition-colors"
      onclick={() => (showShortcuts = !showShortcuts)}
      aria-expanded={showShortcuts}
    >
      <svg
        width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
        class="shrink-0 transition-transform"
        class:rotate-90={showShortcuts}
        aria-hidden="true"
      ><polyline points="9 18 15 12 9 6" /></svg>
      Keyboard shortcuts
    </button>
    {#if showShortcuts}
    <div class="rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-3">
      <div>
        <p class="text-[11px] font-semibold text-ink-900 dark:text-night-text mb-1.5">
          On the page
        </p>
        <dl class="space-y-1 text-[12px]">
          {#each [
            { keys: ["Alt", "S"], label: "Toggle Select mode" },
            { keys: ["Alt", "P"], label: "Toggle Draw mode" },
            { keys: ["Alt", "X"], label: "Exit to idle" },
            { keys: ["Esc"], label: "Cancel current annotation / exit mode" },
          ] as kb (kb.label)}
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-700 dark:text-night-dim min-w-0 flex-1 truncate">{kb.label}</dt>
              <dd class="shrink-0 flex items-center gap-0.5">
                {#each kb.keys as k, i (i)}
                  {#if i > 0}<span class="text-[10px] text-ink-400 dark:text-night-mute">+</span>{/if}
                  <kbd class="font-mono text-[10px] px-1.5 py-0.5 rounded border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-bg text-ink-700 dark:text-night-text">{k}</kbd>
                {/each}
              </dd>
            </div>
          {/each}
        </dl>
      </div>

      <div class="pt-2 border-t border-ink-100 dark:border-night-line">
        <p class="text-[11px] font-semibold text-ink-900 dark:text-night-text mb-1.5">
          Inline element editor + comment popover
        </p>
        <dl class="space-y-1 text-[12px]">
          {#each [
            { keys: ["Ctrl/⌘", "Enter"], label: "Submit comment / save edit" },
            { keys: ["Esc"], label: "Cancel and close" },
          ] as kb (kb.label)}
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-700 dark:text-night-dim min-w-0 flex-1 truncate">{kb.label}</dt>
              <dd class="shrink-0 flex items-center gap-0.5">
                {#each kb.keys as k, i (i)}
                  {#if i > 0}<span class="text-[10px] text-ink-400 dark:text-night-mute">+</span>{/if}
                  <kbd class="font-mono text-[10px] px-1.5 py-0.5 rounded border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-bg text-ink-700 dark:text-night-text">{k}</kbd>
                {/each}
              </dd>
            </div>
          {/each}
        </dl>
      </div>

      <div class="pt-2 border-t border-ink-100 dark:border-night-line">
        <p class="text-[11px] font-semibold text-ink-900 dark:text-night-text mb-1.5">
          Chat input
        </p>
        <dl class="space-y-1 text-[12px]">
          {#each [
            { keys: ["Enter"], label: "Send message" },
            { keys: ["Alt", "Enter"], label: "New line (Shift+Enter also works)" },
          ] as kb (kb.label)}
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-700 dark:text-night-dim min-w-0 flex-1 truncate">{kb.label}</dt>
              <dd class="shrink-0 flex items-center gap-0.5">
                {#each kb.keys as k, i (i)}
                  {#if i > 0}<span class="text-[10px] text-ink-400 dark:text-night-mute">+</span>{/if}
                  <kbd class="font-mono text-[10px] px-1.5 py-0.5 rounded border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-bg text-ink-700 dark:text-night-text">{k}</kbd>
                {/each}
              </dd>
            </div>
          {/each}
        </dl>
      </div>

      <p class="text-[10px] text-ink-500 dark:text-night-mute italic leading-snug pt-1">
        Page shortcuts ignore inputs / textareas / contenteditable so
        typing into form fields on your app never triggers them.
      </p>
    </div>
    {/if}
  </div>
</section>

<!-- ── Import consent dialog (Phase 19) ──────────────────────────────
     An imported module is a stranger writing instructions for the user's
     coding agent. Before anything is installed, show the manifest, the
     full agent.md, and the declared capabilities — each granted
     explicitly (default-deny). This is the trust boundary. -->
{#if pendingImport}
  {@const m = pendingImport.pkg.manifest}
  {@const declared = m.capabilities ?? []}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
    role="dialog"
    aria-modal="true"
    aria-label="Confirm module import"
  >
    <div
      class="w-full max-w-md max-h-[88vh] overflow-y-auto rounded-lg bg-white dark:bg-night-card border border-ink-200 dark:border-night-line shadow-xl p-4 space-y-3"
    >
      <div>
        <h3 class="text-sm font-semibold text-ink-900 dark:text-night-text">
          Import “{m.name}”?
        </h3>
        <p class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5">
          <span class="font-mono">{m.id}</span> · v{m.version}{m.author
            ? ` · ${m.author}`
            : ""}
        </p>
        <p class="text-[12px] text-ink-700 dark:text-night-dim mt-1.5 leading-snug">
          {m.description}
        </p>
      </div>

      <!-- Capabilities — what the module is asking permission to do.
           Default-unchecked; the agent never exceeds what's granted. -->
      <div class="space-y-1.5">
        <h4 class="text-[11px] font-semibold text-ink-900 dark:text-night-text">
          Capabilities
        </h4>
        {#if declared.length === 0}
          <p class="text-[11px] text-ink-600 dark:text-night-dim">
            None requested — this module runs read-only (it can read project
            files and report back, but not write, run commands, or use the
            network).
          </p>
        {:else}
          <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug">
            Grant only what you trust this module to do. Anything left
            unchecked is denied — the agent is instructed never to exceed
            these grants.
          </p>
          {#each declared as cap (cap)}
            <label
              class="flex items-start gap-2 rounded border px-2 py-1.5 cursor-pointer"
              class:border-amber-300={capIsElevated(cap)}
              class:dark:border-amber-800={capIsElevated(cap)}
              class:bg-amber-50={capIsElevated(cap)}
              class:dark:bg-amber-950={capIsElevated(cap)}
              class:border-ink-200={!capIsElevated(cap)}
              class:dark:border-night-line={!capIsElevated(cap)}
            >
              <input
                type="checkbox"
                class="accent-brand-pink shrink-0 mt-0.5"
                checked={grantChecked[cap] === true}
                onchange={(e) =>
                  (grantChecked[cap] = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="min-w-0">
                <span class="block text-[12px] text-ink-800 dark:text-night-text">
                  {capLabel(cap)}
                </span>
                <span class="block font-mono text-[10px] text-ink-500 dark:text-night-mute">
                  {cap}
                </span>
              </span>
            </label>
          {/each}
        {/if}
      </div>

      <!-- The exact instructions the agent will follow. The user can read
           every line before consenting. -->
      <div class="space-y-1">
        <h4 class="text-[11px] font-semibold text-ink-900 dark:text-night-text">
          Agent instructions (agent.md)
        </h4>
        <pre class="max-h-44 overflow-auto rounded border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-bg p-2 text-[10px] leading-snug text-ink-700 dark:text-night-dim whitespace-pre-wrap break-words">{pendingImport.pkg.agent}</pre>
      </div>

      <p class="text-[10px] text-ink-500 dark:text-night-mute leading-snug">
        Imported modules run inside your own interactive Claude Code session
        and follow Pinta's trust rules — they can't edit outside this
        project, run commands you didn't grant, or change how the agent
        authenticates.
      </p>

      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          class="text-[12px] px-3 py-1.5 rounded text-ink-600 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text"
          onclick={cancelImport}
          disabled={importing}
        >
          Cancel
        </button>
        <button
          type="button"
          class="text-[12px] px-3 py-1.5 rounded bg-brand-pink text-white font-medium hover:bg-brand-pink-dark disabled:opacity-60 disabled:cursor-not-allowed"
          onclick={confirmImport}
          disabled={importing}
        >
          {importing ? "Installing…" : "Install module"}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Restore-from-bundle confirm dialog ────────────────────────────
     Restoring is a state-merging operation: the audit catalog merges and
     the Test Pilot catalog is adopted (replacing the current one + its
     on-disk .md). Show exactly what's inside before applying. -->
{#if pendingRestore}
  {@const s = pendingRestore.summary}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
    role="dialog"
    aria-modal="true"
    aria-label="Confirm settings restore"
  >
    <div
      class="w-full max-w-md max-h-[88vh] overflow-y-auto rounded-lg bg-white dark:bg-night-card border border-ink-200 dark:border-night-line shadow-xl p-4 space-y-3"
    >
      <div>
        <h3 class="text-sm font-semibold text-ink-900 dark:text-night-text">
          Restore from settings file?
        </h3>
        <p class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5 font-mono break-all">
          {pendingRestore.fileName}
        </p>
      </div>

      <div class="space-y-1.5">
        <h4 class="text-[11px] font-semibold text-ink-900 dark:text-night-text">
          This file contains
        </h4>
        <ul class="text-[12px] text-ink-700 dark:text-night-dim space-y-1">
          <li class="flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-brand-pink shrink-0" aria-hidden="true"></span>
            {#if s.testPilotCatalogs > 0}
              Test Pilot: {s.testPilotCatalogs} catalog{s.testPilotCatalogs === 1 ? "" : "s"},
              {s.testPilotTests} test{s.testPilotTests === 1 ? "" : "s"} (with results)
            {:else}
              <span class="text-ink-500 dark:text-night-mute">No Test Pilot catalog</span>
            {/if}
          </li>
          <li class="flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-brand-pink shrink-0" aria-hidden="true"></span>
            {#if s.auditCustomCategories > 0 || s.auditCustomChecks > 0 || s.auditEdits > 0}
              AuditFlow catalog: {s.auditCustomCategories} categor{s.auditCustomCategories === 1 ? "y" : "ies"},
              {s.auditCustomChecks} check{s.auditCustomChecks === 1 ? "" : "s"}{s.auditEdits > 0 ? `, ${s.auditEdits} edit${s.auditEdits === 1 ? "" : "s"}` : ""}
            {:else}
              <span class="text-ink-500 dark:text-night-mute">No AuditFlow catalog edits</span>
            {/if}
          </li>
        </ul>
      </div>

      <p class="text-[10px] text-ink-500 dark:text-night-mute leading-snug">
        The AuditFlow catalog <strong>merges</strong> into your current one. The
        Test Pilot catalog <strong>replaces</strong> the one loaded for this
        project (its results sync to disk). Audit findings and module API keys
        aren't part of this file.
      </p>

      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          class="text-[12px] px-3 py-1.5 rounded text-ink-600 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text"
          onclick={cancelRestore}
          disabled={restoring}
        >
          Cancel
        </button>
        <button
          type="button"
          class="text-[12px] px-3 py-1.5 rounded bg-brand-pink text-white font-medium hover:bg-brand-pink-dark disabled:opacity-60 disabled:cursor-not-allowed"
          onclick={confirmRestore}
          disabled={restoring}
        >
          {restoring ? "Restoring…" : "Restore"}
        </button>
      </div>
    </div>
  </div>
{/if}
