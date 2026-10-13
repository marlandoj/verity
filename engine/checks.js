// Check classification and guards. All behavior derived from black-box
// observation (see test/fixtures/engine); no shared code with any prior
// implementation.
import { relPath, stripQuotesAndComments, tokenize } from "./util.js";

// Programs whose invocations may count as checks (observed allowlist).
const CHECK_PROGRAMS = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "deno",
  "cargo", "go", "pytest", "python", "mocha",
  "vitest", "jest", "rspec", "tsc", "eslint",
  "prettier", "ruff", "make",
]);

// Words that mark a check invocation (word-boundaried; _ counts as a word
// char, so mylib_test / attest do not match).
const CHECK_WORDS = [
  "test", "jest", "pytest", "mocha", "vitest", "rspec",
  "tsc", "eslint", "prettier", "lint", "check", "vet", "build",
];
const WORD_RES = CHECK_WORDS.map(
  (w) => new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`)
);

function hasCheckWord(s) {
  return WORD_RES.some((re) => re.test(s));
}

function isCheckPart(part, pipefailSeen) {
  const p = part.trim();
  if (!p) return false;
  let body = p;
  if (body.includes("|")) {
    // A pipe hides the exit status unless pipefail is set.
    if (!pipefailSeen) return false;
    body = body.split("|")[0];
  }
  const prog = body.trim().split(/\s+/)[0] || "";
  if (!CHECK_PROGRAMS.has(prog)) return false;
  return hasCheckWord(body);
}

/**
 * True when the command counts as a check: a recognized check invocation
 * whose own exit status is the result. `extraPatterns` are trusted
 * substring patterns from the project config.
 */
export function isVerify(command, extraPatterns = []) {
  const s = stripQuotesAndComments(command);
  if (/\|\|/.test(s)) return false; // || masks the status
  if (/^\s*!/.test(s)) return false; // negated invocation
  if (/&\s*$/.test(s) && !/&&\s*$/.test(s)) return false; // backgrounded
  if (/\s--(version|help)\b/.test(s)) return false; // not a check run
  if (/;\s*echo\b/.test(s)) return false; // trailing echo hides the status
  if (extraPatterns.some((p) => p && s.includes(p))) return true;
  let pipefailSeen = false;
  // ; chains: the exit status is the last segment's.
  for (const seg of s.split(";")) {
    // && chains: any segment may be the check.
    for (const part of seg.split("&&")) {
      if (/set\s+-o\s+pipefail/.test(part)) pipefailSeen = true;
      if (isCheckPart(part, pipefailSeen)) return true;
    }
    if (/set\s+-o\s+pipefail/.test(seg)) pipefailSeen = true;
  }
  return false;
}

/**
 * True when a PreToolUse Bash command should be rewritten to add pipefail:
 * it pipes into `tail` (SIGPIPE-correct, unlike head/grep -q), isn't already
 * pipefail-safe, and the piped command would otherwise count as a check.
 */
export function needsPipefailRewrite(command, extraPatterns = []) {
  const s = stripQuotesAndComments(command);
  if (/set\s+-o\s+pipefail/.test(s)) return false;
  const m = s.match(/\|\s*tail\b/);
  if (!m) return false;
  return isVerify(s.slice(0, m.index), extraPatterns);
}

export function pipefailRewrite(command) {
  return `set -o pipefail && ${command}`;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// Corpus-derived patterns. Labels reproduce the observed messages verbatim,
// including their grammar ("a AWS access key", "a OpenAI or Anthropic key").
const SECRET_PATTERNS = [
  { re: /AKIA[0-9A-Z]{16}/, label: "a AWS access key" },
  { re: /ghp_[A-Za-z0-9]{36}/, label: "a GitHub token" },
  { re: /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/, label: "a OpenAI or Anthropic key" },
  { re: /xox[baprs]-[A-Za-z0-9-]{16,}/, label: "a Slack token" },
  { re: /AIza[0-9A-Za-z_-]{35}/, label: "a Google API key" },
  { re: /-----BEGIN (?:RSA )?PRIVATE KEY-----/, label: "a private key" },
  { re: /-----BEGIN OPENSSH PRIVATE KEY-----/, label: "a private key" },
];

function basename(p) {
  return String(p).split("/").pop();
}

/**
 * Returns the deny message when content looks like it contains a secret,
 * or null. `allowSecrets` comes from trusted project config.
 */
export function detectSecret(filePath, content, allowSecrets = false) {
  if (allowSecrets) return null;
  const text = String(content ?? "");
  const hit = SECRET_PATTERNS.find((p) => p.re.test(text));
  if (!hit) return null;
  const base = basename(filePath);
  if (base.startsWith(".env")) {
    return (
      `Canny: ${base} would contain what looks like ${hit.label}. ` +
      `An env file is only the place for it once git ignores the file, and a committed template never is.`
    );
  }
  return (
    `Canny: ${base} would contain what looks like ${hit.label}. ` +
    `Read the value from the environment or a git-ignored env file instead of writing it into the file.`
  );
}

// ---------------------------------------------------------------------------
// Test deletion
// ---------------------------------------------------------------------------

/** Parse rm-like commands into operand paths (flags/globs skipped). */
export function rmOperands(command) {
  let s = String(command).trim().replace(/^sudo\s+/, "");
  const m = s.match(/^(git\s+)?rm\s+([\s\S]*)$/);
  if (!m) return null;
  const ops = [];
  for (const t of tokenize(m[2])) {
    if (t.startsWith("--")) continue;
    if (t.startsWith("-") && t.length > 1) continue;
    if (/[*?[\]{}]/.test(t)) continue; // globs aren't resolved paths
    const clean = t.replace(/\/+$/, "");
    if (clean) ops.push(clean.replace(/^\.\//, ""));
  }
  return ops;
}

/** True when an rm operand points into the tests (case-sensitive). */
export function isTestPath(p) {
  const q = String(p).replace(/^\.\//, "");
  return (
    /(^|[/.])tests?([/.]|$)/.test(q) ||
    /__tests__/.test(q) ||
    /\.test\./.test(q)
  );
}

/**
 * Returns the ask message when a PreToolUse Bash command removes tests,
 * or null. The message names the first matching operand.
 */
export function detectTestDeletion(command) {
  const ops = rmOperands(command);
  if (!ops) return null;
  const hit = ops.find(isTestPath);
  if (!hit) return null;
  return (
    `Canny: this command removes ${hit} from the tests. ` +
    `Tests are only removed or skipped when the user asked for it. ` +
    `Fix the code the test covers instead.`
  );
}

// ---------------------------------------------------------------------------
// Command file tracking (the `code` array on command facts)
// ---------------------------------------------------------------------------

function skipFlags(toks) {
  return toks.filter((t) => {
    if (t.startsWith("--")) return false;
    if (t.startsWith("-") && t.length > 1) return false;
    if (/[*?[\]{}]/.test(t)) return false;
    return true;
  });
}

/**
 * Files a Bash command touches, for the ledger's `code` array:
 * rm lists operands, mv lists [dest, ...sources], cp lists [dest].
 * Paths are relativized against cwd.
 */
export function commandCodeFiles(command, cwd) {
  const s = String(command).trim().replace(/^sudo\s+/, "");
  const rel = (p) => relPath(cwd, p);
  const rmOps = rmOperands(command);
  if (rmOps) return rmOps.map(rel);
  let m = s.match(/^mv\s+([\s\S]*)$/);
  if (m) {
    const ops = skipFlags(tokenize(m[1]));
    if (ops.length >= 2) {
      return [rel(ops[ops.length - 1]), ...ops.slice(0, -1).map(rel)];
    }
    return [];
  }
  m = s.match(/^cp\s+([\s\S]*)$/);
  if (m) {
    const ops = skipFlags(tokenize(m[1]));
    if (ops.length >= 1) return [rel(ops[ops.length - 1])];
    return [];
  }
  return [];
}
