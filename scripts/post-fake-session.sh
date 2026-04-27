#!/usr/bin/env bash
# Post a hardcoded annotation session to the companion to verify the Phase 0 loop.
# Usage: bash scripts/post-fake-session.sh [host:port]

set -euo pipefail

HOST="${1:-127.0.0.1:7878}"
SESSION_ID="${SESSION_ID:-test-$(date +%s)}"

read -r -d '' PAYLOAD <<JSON || true
{
  "id": "${SESSION_ID}",
  "url": "http://localhost:5173/",
  "projectRoot": "",
  "startedAt": $(($(date +%s) * 1000)),
  "submittedAt": $(($(date +%s) * 1000)),
  "annotations": [
    {
      "id": "ann-1",
      "createdAt": $(($(date +%s) * 1000)),
      "kind": "select",
      "strokes": [],
      "color": "#ef4444",
      "comment": "Make the Submit button tonal instead of filled.",
      "viewport": { "scrollY": 0, "width": 1440, "height": 900 },
      "target": {
        "selector": "button.submit",
        "outerHTML": "<button class=\"submit\">Submit Claim</button>",
        "computedStyles": {
          "background-color": "rgb(99, 102, 241)",
          "color": "rgb(255, 255, 255)",
          "padding": "12px 20px"
        },
        "nearbyText": ["Submit Claim", "Review and submit"],
        "boundingRect": { "x": 100, "y": 200, "width": 140, "height": 44 }
      }
    }
  ],
  "status": "submitted",
  "producer": "test"
}
JSON

echo "Posting fake session ${SESSION_ID} to http://${HOST}/v1/sessions"
curl -sS -X POST "http://${HOST}/v1/sessions" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" \
  | tee /dev/stderr \
  | grep -q "\"id\":\"${SESSION_ID}\""

echo
echo "OK — session ingested. Long-poll to retrieve:"
echo "  curl -sS http://${HOST}/v1/sessions/poll | head -c 200"
