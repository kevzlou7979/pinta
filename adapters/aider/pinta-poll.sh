#!/usr/bin/env bash
# Polls the Pinta companion for a submitted annotation session, then prints
# a primer message you can paste into aider's chat (along with the session
# JSON) to drive the edit.
#
# Usage:
#   bash pinta-poll.sh                 # waits up to 30s for a submission
#   bash pinta-poll.sh --watch         # loops indefinitely
#
# Env:
#   PINTA_COMPANION_URL  default http://127.0.0.1:7878

set -euo pipefail

URL="${PINTA_COMPANION_URL:-http://127.0.0.1:7878}"
WATCH=false
[ "${1:-}" = "--watch" ] && WATCH=true

emit() {
  local body="$1"
  local id
  id=$(printf '%s' "$body" | python -c 'import sys, json; print(json.load(sys.stdin)["id"])')

  cat <<EOF
================== Pinta session ${id} ==================
Apply the annotations in this Pinta session to the current project.

  - For each annotation, use \`target.sourceFile\` if present; otherwise
    grep for \`target.nearbyText[0]\` to locate the component.
  - Show the plan grouped by file before editing.
  - When done, run:
      curl -sf -X POST "${URL}/v1/sessions/${id}/status" \\
        -H "Content-Type: application/json" \\
        -d '{"status":"done","summary":"<one-liner>"}'

Session payload:
${body}
=========================================================
EOF
}

poll_once() {
  local body
  body=$(curl -sSf --max-time 30 "${URL}/v1/sessions/poll" || true)
  if [ -n "$body" ]; then
    emit "$body"
    return 0
  fi
  return 1
}

if $WATCH; then
  echo "[pinta-poll] watching ${URL}/v1/sessions/poll … Ctrl+C to stop" >&2
  while true; do
    poll_once || true
  done
else
  if ! poll_once; then
    echo "[pinta-poll] no session within 30s. Re-run, or use --watch." >&2
    exit 1
  fi
fi
