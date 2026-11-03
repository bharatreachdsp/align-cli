/** One named redaction rule: a pure function from text to text plus the number of replacements it made. */
export interface RuleResult {
  text: string;
  count: number;
}

export type RuleFn = (text: string) => RuleResult;

export interface Rule {
  /** Stable rule name, used in tests and the rule table (docs/17 §Redaction). */
  name: string;
  /** The hit-count key this rule adds to (`secret`, `env`, `email`, …). */
  group: string;
  apply: RuleFn;
}

/**
 * Every marker the engine writes (`‹secret›`, `‹code: 3 lines›`, …, and the truncation marker). No rule
 * changes the inside of one: the context-token rules (known usernames and hostnames, which can be any word,
 * `user` or `secret` included) match a whole marker first and keep it (`replaceOutsideMarkers`); the rules
 * whose value may run over a marker swallow it whole into one `‹secret›`; no other rule's pattern can match
 * marker text (property-tested with marker words as usernames and hostnames).
 */
export const MARKER_PATTERN = "(?:‹(?:secret|email|phone|ip|host|user|code: \\d{1,9} lines)›|…\\[truncated\\])";
const EXACT = new RegExp(`^${MARKER_PATTERN}$`);

/**
 * True when a matched value is exactly one of our markers (already redacted). Only an exact marker is skipped: a
 * value that merely contains `‹` is still redacted, so planting a marker character cannot shield a secret.
 */
export function isMarker(value: string): boolean {
  return EXACT.test(value);
}

/**
 * Replaces every match of a global regular expression. The replacer returns the replacement, or `null` to keep
 * the match unchanged (not counted).
 */
export function replaceCounting(
  text: string,
  re: RegExp,
  replacer: (match: RegExpExecArray) => string | null,
): RuleResult {
  if (!re.global) throw new Error("replaceCounting needs a global regular expression");
  re.lastIndex = 0;
  // A replacement never splits a marker: one that ends inside a marker swallows it whole, one that starts
  // inside a marker is skipped.
  const hasMarkers = text.includes("‹") || text.includes("…[");
  let spans: Array<[number, number]> | null = null;
  let spanAt = 0;
  let out = "";
  let last = 0;
  let count = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index < last) continue;
    let end = m.index + m[0].length;
    if (hasMarkers) {
      // Computed on the first match only, so a rule that matches nothing costs nothing extra.
      spans ??= spansOf(text);
      while (spanAt < spans.length && (spans[spanAt]?.[1] ?? 0) <= m.index) spanAt++;
      const first = spans[spanAt];
      if (first && first[0] < m.index && m.index < first[1]) continue;
      for (let k = spanAt; k < spans.length; k++) {
        const sp = spans[k];
        if (!sp || sp[0] >= end) break;
        if (sp[0] < end && end < sp[1]) end = sp[1];
      }
    }
    const replacement = replacer(m);
    if (replacement === null || replacement === m[0]) continue;
    out += text.slice(last, m.index) + replacement;
    last = end;
    count++;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(last), count };
}

/**
 * `replaceCounting` for a pattern that must never match inside a marker: the regex is `MARKER|pattern`, a
 * marker match is kept as it is, so the scan steps over whole markers in one linear pass.
 */
export function replaceOutsideMarkers(
  text: string,
  pattern: string,
  flags: string,
  replacer: (match: RegExpExecArray) => string | null,
): RuleResult {
  const re = new RegExp(`(${MARKER_PATTERN})|${pattern}`, flags.includes("g") ? flags : `${flags}g`);
  return replaceCounting(text, re, (m) => (m[1] !== undefined ? null : replacer(m)));
}

function spansOf(text: string): Array<[number, number]> {
  const re = new RegExp(MARKER_PATTERN, "g");
  const out: Array<[number, number]> = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push([m.index, m.index + m[0].length]);
  return out;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
