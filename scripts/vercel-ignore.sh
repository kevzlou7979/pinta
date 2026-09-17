#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the docs site: exit 0 skips the deploy,
# exit 1 deploys. Deploy whenever docs/ changed, and also whenever the
# comparison can't be made (the previous deployed commit is often missing
# from Vercel's shallow clone) — a spare deploy is cheap, a stale site isn't.
base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="HEAD^"
fi
if git diff --quiet "$base" HEAD -- docs/ 2>/dev/null; then
  echo "docs/ unchanged since $base: skipping deploy"
  exit 0
fi
echo "docs/ changed (or no comparable base): deploying"
exit 1
