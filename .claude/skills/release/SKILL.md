---
name: release
description: Cut a new Pinta release end-to-end. Bumps versions, updates CHANGELOG, builds + zips the extension, commits, tags, pushes, publishes pinta-companion to npm, and creates a GitHub release with the zip attached. Chrome Web Store upload is the only manual step left (Google doesn't expose a key-free publish API).
---

# /release

You are cutting a Pinta release. Follow these steps in order, confirming
before each externally-visible action (push, publish, release). Use the
existing `scripts/release.mjs` for build/zip/verify — don't reinvent it.

Accepts an optional bump kind as argument: `patch`, `minor`, `major`, or
`<exact-version>` (e.g. `0.4.0`). If none given, ask the user via
AskUserQuestion.

## Pre-flight (always)

1. Check `git status` is clean. If not, stop and tell the user. Don't
   silently stash.
2. Check `npm whoami` returns `kevzlou7979`. If 401 or wrong user, stop
   and tell the user to fix `~/.npmrc` (automation token should be live).
3. Check `gh auth status` shows kevzlou7979 logged in. If not, stop.
4. Read current version from `companion/package.json` and
   `extension/package.json`. They must match. If they drift, stop.
   Also note `pinta-plugin/.claude-plugin/plugin.json` and
   `.claude-plugin/marketplace.json` (`plugins[0].version`) — these get
   bumped in Step 4 and should track the same number.

If any pre-flight fails, surface the actual error — don't paper over it.

## Step 1 — Decide the new version

Compute the new version based on the bump kind:

- `patch`: 0.3.0 → 0.3.1
- `minor`: 0.3.0 → 0.4.0
- `major`: 0.3.0 → 1.0.0
- `<x.y.z>`: use exact

If no arg given, AskUserQuestion with all three options + "Other" for
explicit version. Recommend patch by default.

## Step 2 — Ask for the release summary

AskUserQuestion: "One-line summary for this release?" — give the user a
free-text "Other" option. This becomes the git commit subject and the
GitHub release title (e.g. "per-page annotations + GitLab Issues").

Keep it short — under 60 chars. If the user gives something longer,
truncate the title but keep the full version in the body.

## Step 3 — Generate CHANGELOG entry

Get the commit log since the last tag:

```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --pretty=format:"%h %s"
```

Group commits into sections (Added / Changed / Fixed) using your best
judgment based on commit message prefixes. Compose a new CHANGELOG.md
section:

```markdown
## $NEW_VERSION — $TODAY

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

(Today = local date in YYYY-MM-DD.)

Show the draft to the user with AskUserQuestion → "Looks good /
Let me edit." If they pick edit, write the draft to a temp file and
ask them to amend, OR ask them to paste a corrected version.

## Step 4 — Bump versions + write CHANGELOG

- Edit `companion/package.json`: bump `"version"` to new value.
- Edit `extension/package.json`: bump `"version"` to new value.
- Edit `pinta-plugin/.claude-plugin/plugin.json`: bump `"version"`.
- Edit `.claude-plugin/marketplace.json`: bump `plugins[0].version`.
  (Plugin updates only reach users when this version changes — bumping it
  is what makes `/plugin` offer the new release.)
- **Re-sync the plugin's bundled skill** so it ships the current `/pinta`:

  ```bash
  bash scripts/sync-plugin.sh
  ```

  The plugin is fetched from GitHub as-is (no build on the user's machine),
  so `pinta-plugin/skills/pinta/SKILL.md` must be committed and current. The
  npm flavor re-vendors automatically in `npm run build` (see Step 5).
- Edit `CHANGELOG.md`: insert the new section at the top, immediately
  after the H1 + intro paragraph. Preserve existing entries.

## Step 5 — Build + verify

Run:

```bash
npm run release
```

This invokes `scripts/release.mjs` which:
- Asserts versions match
- Asserts working tree clean (modulo our staged version bumps — see note)
- Runs `npm run build --workspaces --if-present`
- Verifies `extension/dist/manifest.json` matches the new version
- Zips `extension/dist/*` → `dist/pinta-extension-v$VERSION.zip`
- Verifies `companion/dist/{cli,mcp-stdio}.cjs` exist

Note on clean-tree check: at this point our version bumps + CHANGELOG
edit are UNCOMMITTED, so the clean-tree check will fail. Run with
`--skip-clean-check`:

```bash
node scripts/release.mjs --skip-clean-check
```

If anything else fails, stop. Don't proceed with broken builds.

## Step 6 — Commit, tag, push (confirm first)

AskUserQuestion: "Ready to commit + push v$VERSION? Recommended: yes."

If yes:

```bash
git add companion/package.json extension/package.json CHANGELOG.md \
  pinta-plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json \
  pinta-plugin/skills/pinta
git commit -m "v$VERSION: $SUMMARY

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git tag v$VERSION
git push origin main --tags
```

## Step 7 — Publish to npm (confirm first)

AskUserQuestion: "Ready to publish pinta-companion@$VERSION to npm?"

If yes:

```bash
cd companion && npm publish --access public
```

The automation token in `~/.npmrc` handles auth and bypasses 2FA. If
publish fails with E403/E404/EOTP, check `~/.npmrc` has a current
automation token (Settings → Tokens → Generate New Token → Classic →
type: Automation).

Verify success:

```bash
npm view pinta-companion version
```

Should print the new version.

## Step 8 — GitHub release (confirm first)

AskUserQuestion: "Create GitHub release v$VERSION?"

If yes, build the release notes from the CHANGELOG section (plus the
manual-install instructions for users who can't wait on Chrome Web Store
review):

```bash
gh release create v$VERSION dist/pinta-extension-v$VERSION.zip \
  --title "v$VERSION — $SUMMARY" \
  --notes "<CHANGELOG section + install instructions>"
```

Pattern from the v0.3.0 release for the notes body:

```markdown
## Highlights

<bulleted CHANGELOG entry summarized>

## Install

**Two steps.** Node 20+ and Chrome required.

### 1. Install the Chrome extension

[Install Pinta for Chrome](https://chromewebstore.google.com/detail/pinta/gnobpbogpbgdcpfjhbajfnbcfpbcnhah)

While the Web Store listing for v$VERSION is in review, you can also
install manually by downloading `pinta-extension-v$VERSION.zip` below,
unzipping, and loading the folder via `chrome://extensions` → Developer
mode → Load unpacked.

### 2. Run the companion in your project

\`\`\`bash
npx pinta-companion .
\`\`\`

### 3. Connect Claude Code (pick one)

- **MCP:** \`claude mcp add pinta -- npx -y -p pinta-companion pinta-mcp\`
- **\`/pinta\` skill:** \`npx pinta-companion install-skill\` then restart Claude Code
- **Plugin:** \`/plugin marketplace add kevzlou7979/pinta\` then \`/plugin install pinta@pinta\` (command is \`/pinta:pinta\`)

## Full changelog

See [CHANGELOG.md](https://github.com/kevzlou7979/pinta/blob/main/CHANGELOG.md#$VERSION-anchor)
```

## Step 9 — Final report

Print a summary with URLs:

```
Released v$VERSION

  ✓ npm:           https://www.npmjs.com/package/pinta-companion/v/$VERSION
  ✓ GitHub:        https://github.com/kevzlou7979/pinta/releases/tag/v$VERSION
  ✓ Tag pushed:    v$VERSION on origin/main
  ⧗ Chrome Store:  manual upload pending

Next step:
  1. Open https://chrome.google.com/webstore/devconsole
  2. Find Pinta (ID gnobpbogpbgdcpfjhbajfnbcfpbcnhah)
  3. Package tab → Upload new package
  4. Drag in dist/pinta-extension-v$VERSION.zip
  5. Submit for review (1-3 business days)
```

## Failure modes — recover gracefully

- **Bumped versions but build failed**: don't push, don't publish. Tell
  the user what failed. They can fix and re-run `npm run release` then
  resume from step 6.
- **Pushed but npm publish failed**: tag is already on origin. Re-run
  `cd companion && npm publish --access public` after fixing whatever
  failed (auth, network, etc.). Don't re-tag.
- **npm published but GitHub release failed**: re-run the `gh release
  create` command. The zip is in `dist/`. Don't bump version.
- **All succeeded but Chrome Web Store fails**: that's separate from
  this skill. Tell the user to manually re-upload. No code change needed.

## Don't

- Don't skip the pre-flight checks. They exist because each external
  action is hard to undo.
- Don't run `npm version <bump>` — it auto-creates a tag, which fights
  with our `git tag` later.
- Don't publish without confirming with the user.
- Don't include the npm token in any commit or log.
- Don't use `git push --force` ever.
