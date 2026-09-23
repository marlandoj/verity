#!/usr/bin/env bash
# Verity hook: feeds every harness event to Canny so its ledger fills, logs any verdict,
# and applies it only in live mode. Shadow mode (the default) always answers {}.
# Jev is disabled in both modes: no key, dead endpoint.
# Usage: verity-hook.sh [claude|codex|kimi|gemini]   (default claude)
set -u
HARNESS="${1:-claude}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANNY_DIR="${CANNY_DIR:-/home/workspace/Integrations/canny}"
CANNY_CLI="${CANNY_CLI:-$CANNY_DIR/dist/cli.js}"
VERITY_HOME="${VERITY_HOME:-$HOME/.verity}"
VERITY_LOG="${VERITY_LOG:-$VERITY_HOME/verdicts.jsonl}"
input=$(cat)
answer='{}'
if [ -f "$CANNY_CLI" ] && [ "${VERITY_DISABLE:-0}" != "1" ]; then
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

  cfg="$VERITY_HOME/config.json"
  [ -f "$cfg" ] || cfg=/dev/null
  mode=$(jq -r --arg h "$HARNESS" '.harness[$h].mode // .mode // "shadow"' "$cfg" 2>/dev/null)
  checks=$(jq -r --arg h "$HARNESS" '(.harness[$h].checks // .checks // ["all"]) | join(",")' "$cfg" 2>/dev/null)
  mode="${VERITY_MODE:-${mode:-shadow}}"
  checks="${VERITY_CHECKS:-${checks:-all}}"

  kind=$(printf '%s' "${out:-}" | jq -r '
    if .decision == "block" then "done"
    elif .hookSpecificOutput.permissionDecision == "deny" then "deny"
    elif .hookSpecificOutput.permissionDecision == "ask" then "ask"
    elif .hookSpecificOutput.updatedInput != null then "rewrite"
    elif .hookSpecificOutput.additionalContext != null then "note"
    elif .systemMessage != null then "warn"
    else "none" end' 2>/dev/null)
  kind="${kind:-none}"

  applied=false
  if [ "$mode" = live ] && [ "$kind" != none ] && [[ ",$checks," == *",all,"* || ",$checks," == *",$kind,"* ]]; then
    case "$HARNESS" in
      kimi|gemini)
        translated=$(jq -nc --argjson e "${input:-{\}}" --argjson v "$out" '{event: $e, verdict: $v}' 2>/dev/null \
          | timeout 5 node "$DIR/adapter.mjs" --out "$HARNESS" 2>/dev/null) ;;
      *) translated="$out" ;;
    esac
    if [ -n "${translated:-}" ] && [ "$translated" != '{}' ] && printf '%s' "$translated" | jq -e . >/dev/null 2>&1; then
      answer="$translated"; applied=true
    fi
  fi

  if [ -n "${out:-}" ]; then
    mkdir -p -m 700 "$(dirname "$VERITY_LOG")"; umask 077
    printf '%s' "${event:-{\}}" | jq -c --arg out "${out:-}" --argjson ms "$ms" --arg h "$HARNESS" \
      --arg mode "$mode" --arg kind "$kind" --argjson applied "$applied" '{
        ts: (now | todate), ms: $ms, harness: $h, mode: $mode, kind: $kind, applied: $applied,
        event: .hook_event_name, session: .session_id, cwd: .cwd, tool: .tool_name,
        verdict: (($out | fromjson?) // {raw: $out})
      } | select(.verdict != {})' >> "$VERITY_LOG" 2>/dev/null
  fi
fi
printf '%s' "$answer"
