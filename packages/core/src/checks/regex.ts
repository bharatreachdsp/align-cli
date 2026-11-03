/**
 * Linear-time matching for check patterns and globs (L25 review round 1, D150). Both compile to `re2js`
 * (pure JavaScript, no native code): an RE2 automaton never backtracks, so matching one line costs time
 * proportional to its length times the pattern's size, whatever the pattern is. That is what makes the
 * per-line deadline in run.ts a real bound; a backtracking `RegExp` cannot be interrupted once it starts.
 *
 * RE2 has no back-references and no lookarounds; `validateSpec` rejects those with their own issue codes.
 */
import { RE2JS } from "re2js";

/** A compiled matcher: true when it matches anywhere in (pattern) or all of (glob) the input. */
export type LineMatcher = (input: string) => boolean;

/** Compiles a check pattern (RE2 syntax), or throws when RE2 refuses it. Matches anywhere in a line. */
export function compilePattern(pattern: string): LineMatcher {
  const re = RE2JS.compile(pattern);
  return (input) => re.matcher(input).find();
}

const REGEX_SPECIAL = new Set([..."\\^$.|?*+()[]{}"]);
const escapeChar = (c: string) => (REGEX_SPECIAL.has(c) ? `\\${c}` : c);

/**
 * Glob syntax that `globToRegex` refuses, or null: nested or unclosed braces, unclosed brackets, `/` inside
 * either, brackets inside braces, and character ranges that span `/` (`[+-0]`). (Round 2's H1: a bracket
 * inside braces made the translator loop forever.)
 */
export function globSyntaxIssue(glob: string): string | null {
  let brace = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "[") {
      if (brace) return "bracket in braces";
      const close = classEnd(glob, i);
      if (close === -1) return "unclosed bracket";
      const body = glob.slice(i + 1, close);
      if (body.includes("/")) return "slash in brackets";
      if (rangeSpansSlash(body)) return "range spans slash";
      i = close;
    } else if (c === "]" && brace) {
      return "bracket in braces";
    } else if (c === "{") {
      if (brace) return "nested brace";
      brace = true;
    } else if (c === "/" && brace) {
      return "slash in braces";
    } else if (c === "}") {
      if (!brace) return "unopened brace";
      brace = false;
    }
  }
  return brace ? "unclosed brace" : null;
}

function rangeSpansSlash(body: string): boolean {
  const chars = [...body.replace(/^[!^]/, "")];
  for (let k = 1; k + 1 < chars.length; k += 1) {
    if (chars[k] !== "-") continue;
    const low = (chars[k - 1] as string).codePointAt(0) as number;
    const high = (chars[k + 1] as string).codePointAt(0) as number;
    if (low <= 0x2f && high >= 0x2f) return true;
  }
  return false;
}

/** Index of the `]` closing the class that opens at `open`, or -1. A `]` right after `[`, `[!` or `[^` is literal. */
function classEnd(glob: string, open: number): number {
  let i = open + 1;
  if (glob[i] === "!" || glob[i] === "^") i += 1;
  if (glob[i] === "]") i += 1;
  return glob.indexOf("]", i);
}

/** The translator's output never needs to be larger than this for a 200-character glob; a backstop. */
const MAX_SOURCE_LENGTH = 20_000;

/**
 * One segment's worth of glob (no `/` handling beyond literal), as RE2 source. Every step moves `i` forward;
 * an unmatched `[` or `{` is a literal (validation refuses both first).
 */
function segmentSource(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    let next = i + 1;
    if (c === "*") {
      while (text[next] === "*") next += 1; // `a**b` inside a segment is one star
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[" && classEnd(text, i) > i) {
      const close = classEnd(text, i);
      let body = text.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      const clean = [...body]
        .filter((ch) => ch !== "/")
        .map((ch) => (ch === "\\" || ch === "[" || ch === "]" || ch === "^" ? `\\${ch}` : ch))
        .join("");
      out += negated ? `[^/${clean}]` : clean ? `[${clean}]` : "\\[\\]";
      next = close + 1;
    } else if (c === "{" && text.indexOf("}", i) > i) {
      const close = text.indexOf("}", i);
      const alternatives = text.slice(i + 1, close).split(",");
      out += `(?:${alternatives.map((alt) => segmentSource(alt)).join("|")})`;
      next = close + 1;
    } else {
      out += escapeChar(c);
    }
    if (next <= i || out.length > MAX_SOURCE_LENGTH) throw new Error("glob translation did not progress");
    i = next;
  }
  return out;
}

/** Every spelling of `segment` with its brace groups expanded, or null when there are more than `max`. */
export function expandBraces(segment: string, max = 256): string[] | null {
  const open = segment.indexOf("{");
  const close = open === -1 ? -1 : segment.indexOf("}", open);
  if (open === -1 || close === -1) return [segment];
  const head = segment.slice(0, open);
  const rest = expandBraces(segment.slice(close + 1), max);
  if (rest === null) return null;
  const out: string[] = [];
  for (const alt of segment.slice(open + 1, close).split(",")) {
    for (const tail of rest) {
      out.push(head + alt + tail);
      if (out.length > max) return null;
    }
  }
  return out;
}

/**
 * RE2 source for a repository-relative glob, anchored at both ends. `*` and `?` stay inside one path
 * segment; a whole segment `**` is any number of segments (`a/**` also matches `a`, `**\/x` also `x`);
 * `[…]`, `[!…]` classes; `{a,b}` alternatives (not nested); everything else is literal (no extglobs; dots
 * match like any character, as picomatch with `dot: true`). With `literalDirectory`, a glob without any
 * wildcard also matches everything under it (`lib/cart` covers `lib/cart/lock.ts`).
 */
export function globToRegex(glob: string, literalDirectory = false): string {
  const segments = glob.split("/");
  let out = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      if (segments.length === 1) out += ".*";
      else if (index === 0) out += "(?:.*/)?";
      else if (last) out += "(?:/.*)?";
      else out += "/(?:.*/)?";
      return;
    }
    const previousGlobstar = index > 0 && segments[index - 1] === "**";
    if (index > 0 && !previousGlobstar) out += "/";
    out += segmentSource(segment);
  });
  if (literalDirectory && !/[*?[{]/.test(glob)) out += "(?:/.*)?";
  return `^${out}$`;
}

/** A matcher for any of `globs`. Throws when a glob does not compile (validate first). */
export function compileGlobs(globs: readonly string[], literalDirectory = false): LineMatcher {
  const re = RE2JS.compile(globs.map((glob) => `(?:${globToRegex(glob, literalDirectory)})`).join("|"));
  return (input) => re.matches(input);
}
