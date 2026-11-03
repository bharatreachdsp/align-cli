/**
 * Spec validation and pattern safety (docs/13 §Safety). Every check spec passes here before it is accepted
 * (`accept_check` callers, the judge's proposals) and again before it runs (`runCheck`), so a spec stored
 * by any path cannot make a matcher hang.
 *
 * Patterns are RE2 regular expressions (regex.ts, D150), matched line by line on the first 1,000 characters
 * of each line. RE2 is linear-time, so no pattern can backtrack; the rules below are defence in depth and
 * keep the automaton small. Rejected: more than 200 characters, control characters, back-references,
 * lookarounds, nested quantifiers (a quantifier on a group that already contains one), alternation repeated
 * more than once (`(a|ab)*`), more than three variable-width parts (each `?`, `*`, `+`, `{m,n}` with m ≠ n
 * and each alternation counts one), counted repetition above 100, and anything RE2 refuses.
 */

import { formatIssues } from "../schema/zod";
import { compileGlobs, compilePattern, expandBraces, globSyntaxIssue } from "./regex";
import { type CheckDefinition, CheckDefinition as CheckDefinitionSchema, MAX_PATTERN_LENGTH } from "./spec";

export const MAX_VARIABLE_PARTS = 3;
export const MAX_COUNTED_REPETITION = 100;
/** RE2's cost per character grows with the unrolled program: `\w{100}\w{100}\d` is about 2.5 ms a line. */
export const MAX_UNROLLED_SIZE = 300;

export type SafetyIssue =
  | "too_long"
  | "empty"
  | "invalid_syntax"
  | "back_reference"
  | "lookaround"
  | "nested_quantifier"
  | "quantified_alternation"
  | "too_many_variable_parts"
  | "repetition_too_large"
  | "absolute_path"
  | "parent_segment"
  | "backslash"
  | "negation"
  | "control_character"
  | "invalid_name";

interface Frame {
  quantified: boolean;
  alternation: boolean;
  /** Size of the group's automaton with counted repetition unrolled, roughly (each atom counts one). */
  size: number;
}

const COUNTED = /^\{(\d+)(,(\d*))?\}/;
// Group openers after `(`: non-capturing, named (`?<n>`, `?P<n>`), flag groups (`?i)`, `?i:`), lookarounds.
const GROUP_PREFIX = /^\?(?:(=|!|<=|<!)|:|P?<[A-Za-z_][A-Za-z0-9_]*>|[imsU-]+(\)|:))/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why `pattern` is unsafe or invalid, or null when it may be used. */
export function patternIssue(pattern: string): SafetyIssue | null {
  if (pattern.length === 0) return "empty";
  if (pattern.length > MAX_PATTERN_LENGTH) return "too_long";
  if (CONTROL.test(pattern)) return "control_character";

  const stack: Frame[] = [{ quantified: false, alternation: false, size: 0 }];
  // What the next quantifier would apply to: a closed group (with what it contained), an atom, or nothing.
  let last: { group: Frame } | "atom" | null = null;
  let lastSize = 0; // unrolled size of what the next quantifier would repeat
  const grow = (n: number) => {
    (stack[stack.length - 1] as Frame).size += n;
  };
  let variable = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "\\") {
      const n = pattern[i + 1] ?? "";
      if (/[1-9]/.test(n) || n === "k" || n === "g") return "back_reference";
      if (n === "Q") {
        const end = pattern.indexOf("\\E", i + 2);
        i = end === -1 ? pattern.length : end + 2;
      } else i += 2;
      last = "atom";
      lastSize = 1;
      grow(1);
      continue;
    }
    if (c === "[") {
      i += 1;
      if (pattern[i] === "^") i += 1;
      if (pattern[i] === "]") i += 1;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      last = "atom";
      lastSize = 1;
      grow(1);
      i += 1;
      continue;
    }
    if (c === "(") {
      const prefix = GROUP_PREFIX.exec(pattern.slice(i + 1, i + 40));
      if (prefix?.[1]) return "lookaround";
      if (prefix?.[2] === ")") {
        // a flag group such as `(?i)` sets flags and contains nothing
        i += 1 + prefix[0].length;
        last = null;
        continue;
      }
      stack.push({ quantified: false, alternation: false, size: 0 });
      last = null;
      i += 1 + (prefix ? prefix[0].length : 0);
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) return "invalid_syntax";
      const frame = stack.pop() as Frame;
      const parent = stack[stack.length - 1] as Frame;
      if (frame.quantified) parent.quantified = true;
      if (frame.alternation) {
        parent.alternation = true;
        variable += 1;
      }
      last = { group: frame };
      lastSize = frame.size;
      parent.size += frame.size;
      i += 1;
      continue;
    }
    if (c === "|") {
      const frame = stack[stack.length - 1] as Frame;
      if (stack.length === 1 && !frame.alternation) variable += 1; // top-level alternation counts once
      frame.alternation = true;
      last = null;
      i += 1;
      continue;
    }
    const counted = c === "{" ? COUNTED.exec(pattern.slice(i, i + 20)) : null;
    if (c === "*" || c === "+" || c === "?" || counted) {
      let repeats = c === "?" ? 1 : Number.POSITIVE_INFINITY;
      let fixed = false;
      let unroll = c === "?" ? 1 : 2; // copies of the element in the unrolled program
      let length = 1;
      if (counted) {
        length = counted[0].length;
        const low = Number(counted[1]);
        const high = counted[2] === undefined ? low : counted[3] === "" ? Number.POSITIVE_INFINITY : Number(counted[3]);
        if (low > MAX_COUNTED_REPETITION || (high !== Number.POSITIVE_INFINITY && high > MAX_COUNTED_REPETITION)) {
          return "repetition_too_large";
        }
        repeats = high;
        fixed = low === high;
        unroll = high === Number.POSITIVE_INFINITY ? Math.max(low + 1, 2) : high;
      }
      if (last !== null && last !== "atom") {
        if (last.group.quantified) return "nested_quantifier";
        if (last.group.alternation && repeats > 1) return "quantified_alternation";
      }
      if (!fixed) variable += 1;
      // `{m,n}` repeats the element up to n times; `*` and `+` behave like about two copies.
      grow(lastSize * (unroll - 1));
      if ((stack[0] as Frame).size + stack.slice(1).reduce((n, f) => n + f.size, 0) > MAX_UNROLLED_SIZE) {
        return "repetition_too_large";
      }
      (stack[stack.length - 1] as Frame).quantified = true;
      i += length;
      if (pattern[i] === "?") i += 1; // lazy modifier
      last = null;
      continue;
    }
    last = "atom";
    lastSize = 1;
    grow(1);
    i += 1;
  }
  if ((stack[0] as Frame).size > MAX_UNROLLED_SIZE) return "repetition_too_large";
  if (variable > MAX_VARIABLE_PARTS) return "too_many_variable_parts";
  if (stack.length !== 1) return "invalid_syntax";
  try {
    compilePattern(pattern);
  } catch {
    return "invalid_syntax";
  }
  return null;
}

/** Why `glob` is not a usable repository-relative glob, or null. */
export function globIssue(glob: string): SafetyIssue | null {
  if (glob.length === 0) return "empty";
  if (glob.length > MAX_PATTERN_LENGTH) return "too_long";
  if (CONTROL.test(glob)) return "control_character";
  if (glob.startsWith("/")) return "absolute_path";
  if (glob.includes("\\")) return "backslash";
  if (glob.startsWith("!")) return "negation";
  if (glob.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    return "parent_segment";
  }
  if (globSyntaxIssue(glob)) return "invalid_syntax";
  // Braces must not spell `.`, `..` or an empty segment either (`{..,a}/x`).
  for (const segment of glob.split("/")) {
    const spellings = expandBraces(segment);
    if (spellings === null) return "invalid_syntax";
    if (spellings.some((spelling) => spelling === ".." || spelling === "." || spelling === "")) return "parent_segment";
  }
  try {
    compileGlobs([glob], true);
  } catch {
    return "invalid_syntax";
  }
  return null;
}

// Module and package names: npm (scoped), Python dotted, Go paths, Ruby, Java/Kotlin, Rust `::`, Maven `g:a`.
const NAME = /^[A-Za-z0-9@_~$][A-Za-z0-9@_~$.:/-]*$/;

/** Shown to whoever wrote the glob (the judge's retry, `align confirm`, the console): what to do instead. */
export const BRACKETS_IN_BRACES_MESSAGE =
  "Brackets inside braces are not supported; write separate globs instead (for example `src/[ab].ts` and `src/c.ts` rather than `src/{[ab],c}.ts`).";

function globSpecIssue(path: string, glob: string, issue: SafetyIssue): SpecIssue {
  return globSyntaxIssue(glob) === "bracket in braces"
    ? { path, issue, message: BRACKETS_IN_BRACES_MESSAGE }
    : { path, issue };
}

export interface SpecIssue {
  readonly path: string;
  readonly issue: SafetyIssue | "schema";
  readonly message?: string;
}

export type ValidateSpecResult =
  | { readonly ok: true; readonly check: CheckDefinition }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

/** Shape (zod) plus safety: the only way a `{kind, spec}` becomes something `runCheck` will run. */
export function validateSpec(input: unknown): ValidateSpecResult {
  const parsed = CheckDefinitionSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, issues: [{ path: "", issue: "schema", message: formatIssues(parsed.error.issues) }] };
  const check = parsed.data;
  const issues: SpecIssue[] = [];
  const globList = (paths: readonly string[], at: string) =>
    paths.forEach((glob, index) => {
      const issue = globIssue(glob);
      if (issue) issues.push(globSpecIssue(`${at}.${index}`, glob, issue));
    });
  switch (check.kind) {
    case "forbid_import":
      if (!NAME.test(check.spec.module)) issues.push({ path: "spec.module", issue: "invalid_name" });
      globList(check.spec.paths, "spec.paths");
      break;
    case "forbid_dependency":
      if (!NAME.test(check.spec.package)) issues.push({ path: "spec.package", issue: "invalid_name" });
      break;
    case "forbid_pattern":
    case "require_pattern": {
      const issue = patternIssue(check.spec.pattern);
      if (issue) issues.push({ path: "spec.pattern", issue });
      globList(check.spec.paths, "spec.paths");
      break;
    }
    case "path_exists":
    case "path_absent": {
      const issue = globIssue(check.spec.glob);
      if (issue) issues.push(globSpecIssue("spec.glob", check.spec.glob, issue));
      break;
    }
  }
  return issues.length === 0 ? { ok: true, check } : { ok: false, issues };
}
