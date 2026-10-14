# Verity Engine — provenance

This directory is a **clean-room reimplementation** of the done-gate engine
Verity previously obtained by cloning `qkal/Canny` at install time.

- **No code is shared** with that implementation. Every module here was
  written from the behavioral specification in `test/fixtures/engine`
  (32 black-box fixture suites: hook-event sequences in, verdicts and
  ledger lines out) plus the architecture notes in
  `~/workspace/goals/verity-done-gate-live-on-codex/files/ai-engineer-design-review.md`.
- The prior implementation's sources were **never read** during this work;
  it was executed only as a black box to record the fixtures.
- Before delivery, `engine/` is diffed against the prior `dist/` for
  accidental textual similarity; structural similarity (same CLI contract,
  same ledger format) is expected and intended.
- Behavioral compatibility is deliberate, including details that look
  odd in isolation:
  - verdict messages keep the `Canny:` prefix so dual-run verdict diffs
    stay byte-identical during the cutover soak;
  - the config file remains `.canny.json` so existing trusted projects
    keep working through the migration.
  Both are flagged for revisit after cutover, not during it.
- Design rule preserved: *facts go to code, judgments go to a model, only
  facts can block.* There is no model on the verdict path — the disabled
  judge of the old engine is absent here by design, not by omission.
- The two constitutional amendments hold: the gate fails closed in live
  mode when the engine cannot answer (see `scripts/verity-hook.sh`), and
  ledgers keep provenance only — paths, commands, and outcomes, never
  file contents.
