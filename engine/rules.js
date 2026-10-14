// Done-gate decision logic. decideStop is a pure function of the ledger
// lines: given the same history it always returns the same verdict, which
// is what makes the gate replayable and testable.
import { hash16 } from "./util.js";

const DONE_GUIDANCE =
  "Run the project's checks and fix what fails before finishing. " +
  "A test, build, lint, or type-check command counts, run so its own exit " +
  "status is the result: a pipe into `tail`, `|| true`, or a trailing " +
  "`; echo` hides it. If no check applies to this change, say so explicitly " +
  "and stop again (a repeated stop releases the gate only where the " +
  "project's trusted .verity.json opts into the release valve).";

function summarize(lines) {
  const edited = [];
  const seen = new Set();
  let lastChangeIdx = -1;
  let lastPassIdx = -1;
  let lastCommand = null;
  let lastVerdictIdx = -1;
  let lastVerdictDecision = null;
  lines.forEach((ln, i) => {
    if (ln.type === "event" && ln.fact) {
      // The gate's change-set is the fact `code` arrays: edited files for
      // edits, touched paths for rm/mv/cp. Config `ignore` globs are
      // already stripped from `code` at write time.
      const code = Array.isArray(ln.fact.code) ? ln.fact.code : [];
      if (code.length > 0) {
        lastChangeIdx = i;
        for (const f of code) {
          if (!seen.has(f)) {
            seen.add(f);
            edited.push(f);
          }
        }
      }
      if (ln.fact.kind === "command") {
        lastCommand = { command: ln.fact.command, exitCode: ln.fact.exitCode };
        if (ln.fact.verify && ln.fact.exitCode === 0) lastPassIdx = i;
      }
    } else if (ln.type === "verdict") {
      lastVerdictIdx = i;
      lastVerdictDecision = ln.decision;
    }
  });
  return { edited, lastChangeIdx, lastPassIdx, lastCommand, lastVerdictIdx, lastVerdictDecision };
}

/**
 * Decide a Stop verdict from prior ledger lines (not including the current
 * stop event). Returns { decision, message?, valve? } with decision one of
 * "allow" | "block" | "warn".
 *
 * `releaseValveAllowed` gates the release valve and defaults to false (fail
 * closed): a repeated stop with no new facts after a block degrades to a
 * warning ONLY when the project's trusted .verity.json opts in with
 * "releaseValve": true. When the valve trips, `valve: true` is returned so
 * the trip is distinctly auditable in the ledger.
 */
export function decideStop(priorLines, stopHookActive, releaseValveAllowed = false) {
  const s = summarize(priorLines);
  if (s.lastChangeIdx === -1 || s.lastPassIdx > s.lastChangeIdx) {
    return { decision: "allow" };
  }
  // Release valve (opt-in only): a repeated stop with no new facts after a
  // block degrades to a warning instead of blocking forever. Without the
  // opt-in, the gate stays blocked — "just stop twice" must not walk through.
  if (stopHookActive && releaseValveAllowed && s.lastVerdictDecision === "block") {
    let fresh = false;
    for (let i = s.lastVerdictIdx + 1; i < priorLines.length; i++) {
      const ln = priorLines[i];
      if (
        ln.type === "event" &&
        ln.fact &&
        (ln.fact.kind === "edit" || ln.fact.kind === "command")
      ) {
        fresh = true;
        break;
      }
    }
    if (!fresh) {
      return {
        decision: "warn",
        valve: true,
        message:
          `Verity: the agent finished without a passing check after editing ` +
          `${s.edited.join(", ")}. Verify by hand.`,
      };
    }
  }
  const files = s.edited.join(", ");
  // The exit annotation appears only when the exit code is known; a null
  // (missing/failed) exit leaves the command bare.
  const tail = s.lastCommand
    ? ` The last command was \`${s.lastCommand.command}\`` +
      (s.lastCommand.exitCode == null ? "" : ` (exit ${s.lastCommand.exitCode})`) +
      "."
    : "";
  return {
    decision: "block",
    message:
      `Verity: ${files} changed, but no check has passed since the last edit.` +
      tail +
      ` ${DONE_GUIDANCE}`,
  };
}

/** Shape a decision into the hook-output verdict JSON. */
export function serialize(decision, message, agent) {
  switch (decision) {
    case "block":
      return { decision: "block", reason: message, systemMessage: message };
    case "warn":
      return { systemMessage: message };
    case "deny":
    case "ask": {
      // Codex has no ask affordance: an ask becomes a deny there.
      const pd = decision === "ask" && agent === "codex" ? "deny" : decision;
      return {
        systemMessage: message,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: pd,
          permissionDecisionReason: message,
        },
      };
    }
    case "rewrite":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { command: message.command },
          additionalContext: message.note,
        },
      };
    case "note":
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: message,
        },
      };
    default:
      return {};
  }
}

/** Summarize a session's lines for `status`. */
export function statusSummary(lines) {
  const s = summarize(lines);
  const stops = [];
  for (const ln of lines) {
    if (ln.type === "verdict" && ln.phase === "stop") stops.push(ln.decision);
  }
  let verified;
  if (s.lastPassIdx > s.lastChangeIdx && s.lastCommand) {
    verified = `yes: \`${s.lastCommand.command}\` passed after the last edit`;
  } else {
    verified = "no passing check since the last edit";
  }
  return {
    edited: s.edited,
    verified,
    lastCommand: s.lastCommand,
    lastSummary: (() => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (ln.type === "event" && ln.fact && ln.fact.kind === "command") {
          return { command: ln.fact.command, exitCode: ln.fact.exitCode, summary: ln.fact.summary };
        }
      }
      return null;
    })(),
    stops,
  };
}

export { hash16 };
