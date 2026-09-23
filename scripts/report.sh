#!/usr/bin/env bash
# Summarize what Canny would have done while in shadow mode.
set -u
LOG="${CANNY_SHADOW_LOG:-${CANNY_HOME:-$HOME/.canny}/shadow.jsonl}"
[ -s "$LOG" ] || { echo "no shadow verdicts recorded yet ($LOG)"; exit 0; }
jq -s -r '
  def kind: if .event == "Stop" and .verdict.decision == "block" then "stop-block"
    elif .verdict.hookSpecificOutput.permissionDecision == "deny" then "deny"
    elif .verdict.hookSpecificOutput.permissionDecision == "ask" then "ask"
    elif .verdict.hookSpecificOutput.updatedInput != null then "rewrite"
    elif .verdict.hookSpecificOutput.additionalContext != null then "note"
    elif .verdict.systemMessage != null then "warn"
    else "other" end;
  (group_by(.harness // "claude")[] | "\(.[0].harness // "claude"): \(length) verdicts, p50 \(map(.ms) | sort | .[length/2|floor]) ms"),
  "verdicts: \(length)  sessions: \(map(.session) | unique | length)  since: \(.[0].ts)",
  "latency ms p50/max: \(map(.ms) | sort | .[length/2|floor]) / \(map(.ms) | max)",
  "",
  (group_by(kind)[] | "\(.[0] | kind): \(length)"),
  "",
  "latest 10:",
  (.[-10:][] | "\(.ts) \(.event) \(.tool // "-") \(kind): \((.verdict.reason // .verdict.hookSpecificOutput.permissionDecisionReason // .verdict.hookSpecificOutput.additionalContext // .verdict.systemMessage // "") | tostring | .[0:140])")
' "$LOG"
echo
echo "hook crashes: $(cat "${CANNY_HOME:-$HOME/.canny}/errors.log" 2>/dev/null | wc -l)"
