---
name: canny-shadow
description: Runs Canny (qkal/canny, a deterministic done-gate and pattern guard) in shadow mode across Claude Code, Codex CLI, Kimi Code and Gemini CLI. Canny's ledger records every edit and check, and its verdicts (Stop blocks, secret denies, test-removal asks, pipefail rewrites) are logged but never applied. Use to review what Canny would have caught, to decide on promotion to enforce, or to disable it.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# Canny shadow

**Repo:** private `marlandoj/canny-shadow` (this directory is its checkout).

**Source:** `Integrations/canny`, pinned at `f2c5e53` (v0.3.0). Node 22, no dependencies, nothing to build.

**Wiring** (all call `scripts/canny-shadow-hook.sh <harness>`; pre-install copies in `Backups/claude-settings/` and `Backups/harness-config/`):

| Harness | Config | Scope | Notes |
|---|---|---|---|
| Claude Code | `/home/workspace/.claude/settings.json` | sessions in /home/workspace | native |
| Codex CLI | `/home/workspace/.codex/hooks.json` | sessions in /home/workspace | native; hooks stay inert until the operator trusts them once with `/hooks` in interactive Codex |
| Kimi Code | `/root/.kimi-code/config.toml` `[[hooks]]` | every Kimi session | `scripts/adapter.mjs kimi` maps `path`, `tool_output`, structured `error` |
| Gemini CLI | `/root/.gemini/settings.json` `hooks` | every Gemini session | `scripts/adapter.mjs gemini` maps BeforeTool/AfterTool/AfterAgent, `write_file`/`replace`/`run_shell_command`, `Exit Code:` from `llmContent` |

Not covered: OpenCode, Pi and Hermes have no hook that can refuse a finish (see ZOU-1680).
Kimi and Gemini ledgers are named `claude-kimi-<id>` / `claude-gemini-<id>` because Canny parses them as Claude events.

**Shadow contract:** the wrapper always prints `{}`. Nothing is blocked, rewritten, or injected. Jev is off:
`TYPESAFE_API_KEY` is unset for the child and `CANNY_JEV_URL` points at a dead port, so no text leaves the host.

## Files

| Path | Holds |
|---|---|
| `~/.canny/sessions/claude-<session>.jsonl` | Canny's own ledger: command lines, exit codes, edited paths. Command lines can contain secrets |
| `~/.canny/shadow.jsonl` | Every non-empty verdict Canny would have returned, with latency |
| `~/.canny/errors.log` | Canny crashes (it fails open) |

## Commands

```bash
bash Skills/canny-shadow/scripts/install.sh --project /home/workspace   # wire hooks (idempotent, backs up)
bash Skills/canny-shadow/test/run.sh                             # hermetic tests
bash Skills/canny-shadow/scripts/report.sh                       # would-be verdicts, latency, crashes
node Integrations/canny/dist/cli.js status                        # latest session ledger
node Integrations/canny/dist/cli.js replay <session-file>          # re-derive Stop verdicts
CANNY_SHADOW_DISABLE=1                                            # env kill switch, per process
```

Rollback: copy each backup over its config file.

## Promotion criteria (review 2026-10-07)

1. Stop blocks: sample each one against the session. A block is a false positive when the work was verified
   by something Canny does not count (for example `bun Skills/x/scripts/y.test.ts`, a curl smoke test). Add
   those as `verify` regexes in a trusted `.canny.json` before enforcing.
2. Secret denies: every one must be a real secret shape. Promote this check first.
3. Latency p50 under 250 ms per tool call and zero crashes.
4. Enforce by pointing the hooks at `node Integrations/canny/dist/cli.js hook --agent claude` directly, one
   check at a time, with the others listed in `allow`.
