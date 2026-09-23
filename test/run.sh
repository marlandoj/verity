#!/usr/bin/env bash
# Hermetic tests: adapter translation, the shadow contract, and installer idempotency.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
adapt() { printf '%s' "$2" | node "$ROOT/scripts/adapter.mjs" "$1"; }

o=$(adapt kimi '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Write","tool_input":{"path":"/p/a.ts","content":"x"}}')
check "kimi path->file_path" "$(jq -r .tool_input.file_path <<<"$o")" "/p/a.ts"
check "kimi session prefix" "$(jq -r .session_id <<<"$o")" "kimi-s1"
o=$(adapt kimi '{"hook_event_name":"PostToolUseFailure","session_id":"s1","tool_name":"Bash","error":{"message":"Command exited with code 3"}}')
check "kimi exit code kept" "$(jq -r .error <<<"$o" | head -1)" "Exit code 3"
o=$(adapt gemini '{"hook_event_name":"BeforeTool","session_id":"g","tool_name":"replace","tool_input":{"file_path":"/p/b.ts","old_string":"a","new_string":"b"}}')
check "gemini BeforeTool->PreToolUse" "$(jq -r .hook_event_name <<<"$o")" "PreToolUse"
check "gemini replace->Edit" "$(jq -r .tool_name <<<"$o")" "Edit"
o=$(adapt gemini '{"hook_event_name":"AfterTool","session_id":"g","tool_name":"run_shell_command","tool_input":{"command":"npm test","dir_path":"/p"},"tool_response":{"llmContent":"Output: ok\nExit Code: 1"}}')
check "gemini exit code parsed" "$(jq -r .tool_response.exit_code <<<"$o")" "1"
check "gemini dir_path->cwd" "$(jq -r .cwd <<<"$o")" "/p"
o=$(adapt gemini '{"hook_event_name":"AfterAgent","session_id":"g","prompt_response":"Done."}')
check "gemini AfterAgent->Stop" "$(jq -r .hook_event_name,.last_assistant_message <<<"$o" | paste -sd' ')" "Stop Done."

# Shadow contract: a blocking verdict is logged but the wrapper still answers {}.
cat > "$T/cli.js" <<'JS'
if (process.env.TYPESAFE_API_KEY) { process.stdout.write('{"leak":true}'); process.exit(0); }
process.stdout.write('{"decision":"block","reason":"no passing check"}');
JS
export CANNY_CLI="$T/cli.js" CANNY_SHADOW_LOG="$T/shadow.jsonl" TYPESAFE_API_KEY=should-not-pass
for h in claude codex kimi gemini; do
  out=$(printf '{"hook_event_name":"Stop","session_id":"x"}' | bash "$ROOT/scripts/canny-shadow-hook.sh" "$h")
  check "$h wrapper answers {}" "$out" "{}"
done
check "verdicts logged" "$(wc -l < "$T/shadow.jsonl" | tr -d ' ')" "4"
check "jev key stripped" "$(jq -r .verdict.decision "$T/shadow.jsonl" | sort -u)" "block"
out=$(printf 'not json' | CANNY_SHADOW_DISABLE=1 bash "$ROOT/scripts/canny-shadow-hook.sh")
check "kill switch answers {}" "$out" "{}"
unset CANNY_CLI TYPESAFE_API_KEY

# Installer: wires all four harnesses, keeps existing hooks, and is idempotent.
mkdir -p "$T/home/.gemini" "$T/proj/.claude" "$T/canny/.git" "$T/canny/dist"
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' > "$T/proj/.claude/settings.json"
touch "$T/canny/dist/cli.js"
git -C "$T/canny" init -q 2>/dev/null
inst() { HOME="$T/home" bash "$ROOT/scripts/install.sh" --project "$T/proj" --canny-dir "$T/canny" --backup-dir "$T/bk" >/dev/null 2>&1; }
inst; check "installer exit" "$?" "0"; inst
check "claude keeps existing hook" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$T/proj/.claude/settings.json")" "keep-me"
check "claude wired once" "$(jq '[.hooks[][] | tostring | select(test("canny-shadow"))] | length' "$T/proj/.claude/settings.json")" "5"
check "codex wired once" "$(jq '[.hooks[][] | tostring | select(test("canny-shadow"))] | length' "$T/proj/.codex/hooks.json")" "4"
check "gemini wired once" "$(jq '[.hooks[][] | tostring | select(test("canny-shadow"))] | length' "$T/home/.gemini/settings.json")" "4"
check "kimi wired once" "$(grep -c canny-shadow-hook "$T/home/.kimi-code/config.toml")" "5"
check "custom canny dir passed" "$(grep -c "CANNY_DIR=$T/canny" "$T/home/.kimi-code/config.toml")" "5"
check "backup written" "$(ls "$T/bk" | grep -c claude_settings)" "1"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
