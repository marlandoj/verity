#!/usr/bin/env bash
# Shadow wrapper for Canny: feeds every hook event to Canny so its ledger fills,
# records any verdict Canny would have returned, and always answers {} so nothing
# is blocked, rewritten, or injected. Jev is disabled: no key, dead endpoint.
# Usage: canny-shadow-hook.sh [claude|codex|kimi|gemini]   (default claude)
set -u
HARNESS="${1:-claude}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANNY_DIR="${CANNY_DIR:-/home/workspace/Integrations/canny}"
CANNY_CLI="${CANNY_CLI:-$CANNY_DIR/dist/cli.js}"
SHADOW_LOG="${CANNY_SHADOW_LOG:-${CANNY_HOME:-$HOME/.canny}/shadow.jsonl}"
input=$(cat)
if [ -f "$CANNY_CLI" ] && [ "${CANNY_SHADOW_DISABLE:-0}" != "1" ]; then
  start=$(date +%s%3N)
  case "$HARNESS" in
    kimi|gemini)
      event=$(printf '%s' "$input" | timeout 5 node "$DIR/adapter.mjs" "$HARNESS" 2>/dev/null)
      agent=claude ;;
    codex) event="$input"; agent=codex ;;
    *) event="$input"; agent=claude ;;
  esac
  out=$(printf '%s' "${event:-{\}}" | env -u TYPESAFE_API_KEY CANNY_JEV_URL=http://127.0.0.1:9/disabled \
    timeout 8 node "$CANNY_CLI" hook --agent "$agent" 2>/dev/null)
  ms=$(( $(date +%s%3N) - start ))
  mkdir -p -m 700 "$(dirname "$SHADOW_LOG")"; umask 077
  printf '%s' "${event:-{\}}" | jq -c --arg out "${out:-}" --argjson ms "$ms" --arg h "$HARNESS" '{
      ts: (now | todate), ms: $ms, harness: $h,
      event: .hook_event_name, session: .session_id, cwd: .cwd, tool: .tool_name,
      verdict: (($out | fromjson?) // {raw: $out})
    } | select(.verdict != {})' >> "$SHADOW_LOG" 2>/dev/null
fi
printf '{}'
