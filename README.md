# canny-shadow

Runs [Canny](https://github.com/qkal/Canny) in **shadow mode** across four coding-agent harnesses. Canny is a deterministic done-gate and pattern guard: it refuses a "done" claim when code changed and no test, build, lint or type-check has passed since, and it flags secrets in written files, deleted or skipped tests, and piped test commands that hide failures.

In shadow mode Canny's ledger records every edit and check, and every verdict it would have returned is logged, but the wrapper always answers `{}`. Nothing is blocked, rewritten or injected. Canny's optional Jev model is disabled (the key is stripped and the endpoint points at a dead port), so no text leaves the host.

| Harness | Config written | Scope | Translation |
|---|---|---|---|
| Claude Code | `<project>/.claude/settings.json` | that project | native |
| Codex CLI | `<project>/.codex/hooks.json` | that project | native. Codex runs a new hook only after you trust it once with `/hooks` in an interactive session |
| Kimi Code | `~/.kimi-code/config.toml` | every Kimi session | `scripts/adapter.mjs kimi` |
| Gemini CLI | `~/.gemini/settings.json` | every Gemini session | `scripts/adapter.mjs gemini` |

OpenCode, Pi and Hermes are not supported: none has a hook that can refuse a finish.

## Requirements

Node 22+, `jq`, `git`, bash. Canny itself has no dependencies and ships a built `dist/`.

## Install

```bash
bash scripts/install.sh --project /path/to/project                 # all four harnesses
bash scripts/install.sh --harness claude,gemini --project .         # a subset
bash scripts/install.sh --dry-run                                   # show what would change
```

The installer clones Canny at the pinned commit `f2c5e53` (v0.3.0) into `--canny-dir` (default `/home/workspace/Integrations/canny`) unless a checkout is already there, backs up every config file to `~/.canny/backups/` before touching it, and adds one hook group per event. Existing hooks are kept, and re-running it changes nothing.

## Use

```bash
bash scripts/report.sh           # would-be verdicts by harness and kind, latency, crash count
CANNY_SHADOW_DISABLE=1           # per-process kill switch
```

| Path | Holds |
|---|---|
| `~/.canny/sessions/*.jsonl` | Canny's ledger: command lines, exit codes, edited paths. Command lines can contain secrets, so the directory is owner-only |
| `~/.canny/shadow.jsonl` | Every non-empty verdict, with harness, event and latency |
| `~/.canny/errors.log` | Canny crashes (it fails open) |

Environment overrides: `CANNY_DIR`, `CANNY_CLI`, `CANNY_HOME`, `CANNY_SHADOW_LOG`.

**Rollback:** copy each backup from `~/.canny/backups/` over its config file.

## How the adapters work

Canny reads Claude Code's hook format. `scripts/adapter.mjs` converts the other harnesses' events into it. The shapes were captured from live sessions (Kimi Code 0.41.0, Gemini CLI 0.58.0), not taken from documentation.

- **Kimi** uses Claude-style event and tool names but calls the file argument `path`, returns `tool_output` as a string, and reports failures as a structured `error` whose message carries the exit code.
- **Gemini** uses `BeforeTool`/`AfterTool`/`AfterAgent`, tools named `write_file`, `replace` and `run_shell_command`, and reports a command's exit code as `Exit Code: N` inside `llmContent`.

Kimi and Gemini ledgers are named `claude-kimi-<id>` / `claude-gemini-<id>` because Canny parses them as Claude events.

## Tests

```bash
bash test/run.sh
```

Hermetic: a fake Canny CLI and a temporary `HOME` and project. It covers adapter translation, the shadow contract (every harness answers `{}` even when Canny blocks, and the Jev key never reaches Canny), the kill switch, and installer merge, preservation and idempotency.

## Moving to enforcement

1. Sample every would-be Stop block. It is a false positive when the work was verified by something Canny doesn't count (for example `bun some.test.ts` or a curl smoke test). Add those as `verify` patterns in a trusted `.canny.json` first.
2. Every secret deny must be a real secret shape. Enforce this check first.
3. Keep p50 latency under 250 ms per tool call, with zero crashes.
4. Enforce by pointing a hook at `node <canny>/dist/cli.js hook --agent claude` (or `codex`) directly, one check at a time.
