---
name: build-pinta
description: Use when the user wants to build and install Pinta from scratch — installs npm dependencies, builds the Chrome extension and the companion server, installs the Claude Code skill into ~/.claude/skills/pinta/, and prints the steps to load the unpacked extension in Chrome. One-shot setup.
---

# build-pinta

Run the full local build + install for Pinta. End state: an extension dist
ready to load into Chrome, a built companion, and a working `/pinta` skill.

## 1. Sanity check the working directory

```bash
test -f package.json && grep -q '"name": "pinta"' package.json && echo "OK in pinta repo" || { echo "ERROR: run this from the pinta repo root"; exit 1; }
```

If that fails, ask the user to `cd` into their pinta clone and re-invoke.

## 2. Install dependencies

```bash
npm install
```

(safe to re-run; idempotent.)

## 3. Build extension and companion in parallel

```bash
npm run build --workspace @pinta/extension &
npm run build --workspace @pinta/companion &
wait
```

Both should print `built in <X>s` with no errors. If either fails, surface
the failure and stop.

## 4. Install the Claude Code skill

```bash
bash scripts/install-skill.sh
```

Writes `~/.claude/skills/pinta/SKILL.md` and a `start-companion.js` that
points back to the absolute path of this repo. Re-running overwrites both.

## 5. Print next steps

Tell the user, with the resolved absolute path:

```
✅ Pinta is built and the /pinta skill is installed.

Next:
  1. Open Chrome → chrome://extensions
  2. Enable "Developer mode" (top right)
  3. Click "Load unpacked" → pick:
        <REPO_ROOT>/extension/dist
  4. Pin the Pinta icon to your toolbar.

To use it on a project:
  - In another terminal, in your project root:
        node ~/.claude/skills/pinta/start-companion.js .
  - Open your app in Chrome, click the Pinta icon → Open side panel.
  - Annotate (S = select, D = draw), hit "Send to agent".
  - In Claude Code (in the project root), run /pinta.
```

Resolve `<REPO_ROOT>` with `pwd` when you print, so the user can copy-paste
the path directly.

## Notes

- **Reinstalling**: re-run `/build-pinta` after pulling new commits. It's
  idempotent.
- **Removing**: `rm -rf ~/.claude/skills/pinta` removes the skill;
  uninstall the extension from `chrome://extensions`.
- **Build-only mode**: if the user just wants to rebuild without
  reinstalling the skill, run steps 2 and 3 only.
