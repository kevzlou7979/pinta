#!/usr/bin/env bash
# Syncs the canonical skill (skill/pinta/) into the Claude Code plugin
# (pinta-plugin/skills/pinta/) so the plugin ships an identical /pinta.
#
# The plugin is fetched from GitHub as-is — no build runs on the user's
# machine — so the copy under pinta-plugin/ MUST be committed and current at
# release time. Run this whenever skill/pinta/SKILL.md changes, and from the
# release flow before tagging.
#
# Usage: bash scripts/sync-plugin.sh   (verify-only: --check)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${REPO_ROOT}/skill/pinta"
DEST="${REPO_ROOT}/pinta-plugin/skills/pinta"
FILES=("SKILL.md" "find-companion.js")

if [ "${1:-}" = "--check" ]; then
  rc=0
  for f in "${FILES[@]}"; do
    if ! diff -q "${SRC}/${f}" "${DEST}/${f}" >/dev/null 2>&1; then
      echo "out of sync: pinta-plugin/skills/pinta/${f} (run: bash scripts/sync-plugin.sh)" >&2
      rc=1
    fi
  done
  [ "$rc" -eq 0 ] && echo "plugin skill is in sync with skill/pinta/"
  exit "$rc"
fi

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "${SRC}/${f}" "${DEST}/${f}"
done
echo "synced skill/pinta/ → pinta-plugin/skills/pinta/ (${FILES[*]})"
