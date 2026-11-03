/**
 * docs/17 §Redaction rule 1, secrets. One named function per credential shape, applied in the order of
 * `SECRET_RULES` (specific shapes first, the generic high-entropy rule last). Every match becomes `‹secret›`;
 * where a prefix tells the reader what was there (`Bearer `, `API_KEY=`, `postgres://`), the prefix stays.
 *
 * Never write a real or realistic credential in this file or its tests: the shapes below are patterns only,
 * and the tests assemble their samples from fragments at run time (AGENTS.md rule 12).
 */
import { MARKER } from "../version";
import {
  bareKeyValue,
  codeName,
  credentialAssignment,
  credentialLineSweep,
  isCredentialName,
  keepsCredentialValue,
  nameValuePair,
  reverseComparison,
  sqlIdentifiedBy,
  userPasswordProse,
} from "./credential";
import { isCommonWord } from "./prose";
import { isMarker, type Rule, type RuleFn, type RuleResult, replaceCounting } from "./rule";
import { madeOfWords } from "./words";

export {
  bareKeyValue,
  credentialAssignment,
  credentialLineSweep,
  isCredentialName,
  madeOfWords,
  nameValuePair,
  sqlIdentifiedBy,
  userPasswordProse,
};

const S = MARKER.secret;

/** Replaces each whole match with `‹secret›`, optionally only when `accept(match)` holds. */
function whole(re: RegExp, accept?: (m: RegExpExecArray) => boolean) {
  return (text: string): RuleResult =>
    replaceCounting(text, re, (m) => (isMarker(m[0]) || (accept && !accept(m)) ? null : S));
}

/** Keeps capture group 1 (a prefix such as `Bearer `) and replaces group 2 with `‹secret›`. */
function keepPrefix(re: RegExp, accept?: (value: string) => boolean) {
  return (text: string): RuleResult =>
    replaceCounting(text, re, (m) => {
      const prefix = m[1] ?? "";
      const value = m[2] ?? "";
      if (value.length === 0 || isMarker(value) || (accept && !accept(value))) return null;
      return prefix + S + m[0].slice(prefix.length + value.length);
    });
}

// ------------------------------------------------------------------------- glued-aware bodies (L10b)

/**
 * Where a glued-aware token body stops: where another vendor token starts, or at a credential name with its separator
 * (`…private_key_id: <value>`, `…SENTRY_DSN=<value>`), so the name stays for the credential rules. Only where the body
 * could not run on through that token: each alternative lists the characters its prefix always holds beyond letters
 * and digits, and a body whose class holds them keeps going (it redacts the next token with it, as before). Every
 * alternative has a bounded length, so the check costs a constant per character (#65 security review).
 */
const STOPS: ReadonlyArray<readonly [string, string]> = [
  ["gh[pousr]_[A-Za-z0-9]{30}", "_"],
  ["github_pat_[A-Za-z0-9_]{22}", "_"],
  ["sk-ant-[A-Za-z0-9_-]{20}", "-"],
  ["sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20}", "-"],
  ["[sr]k_(?:live|test)_[0-9A-Za-z]{10}", "_"],
  ["hf_[A-Za-z0-9]{30}", "_"],
  ["aln_[A-Za-z0-9_-]{8}", "_"],
  ["(?:xox(?:[abeprs]|e\\.xox[bp])|xapp)-[A-Za-z0-9-]{10}", "-"],
  ["lin_(?:api|oauth)_[A-Za-z0-9]{32}", "_"],
  ["glpat-[A-Za-z0-9_-]{20}", "-"],
  ["GOCSPX-[0-9A-Za-z_-]{20}", "-"],
  ["ya29\\.[0-9A-Za-z._-]{20}", "."],
  ["AIza[0-9A-Za-z_-]{35}", ""],
  ["npm_[A-Za-z0-9]{36}", "_"],
  ["do[por]_v1_[a-f0-9]{64}", "_"],
  ["IQoJb3JpZ2luX2Vj", ""],
  ["eyJ[A-Za-z0-9_-]{8,200}\\.ey", "."],
  ["SG\\.[A-Za-z0-9_-]{16,64}\\.", "."],
  ["whsec_[A-Za-z0-9+/=]{20}", "_"],
  ["pdl_(?:live|sdbx)_[A-Za-z0-9_]{10}", "_"],
  ["pk_(?:live|test)_[0-9A-Za-z]{10}", "_"],
  ["re_[A-Za-z0-9_]{20}", "_"],
  ["hv[sbr]\\.[A-Za-z0-9_-]{20}", "."],
  ["sbp_[A-Za-z0-9]{32}", "_"],
  ["shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}", "_"],
  ["ATATT3[A-Za-z0-9_=-]{20}", ""],
  ["sq0(?:atp|csp)-[A-Za-z0-9_-]{20}", "-"],
  ["dckr_pat_[A-Za-z0-9_-]{20}", "_"],
  ["rubygems_[a-f0-9]{48}", "_"],
  ["figd_[A-Za-z0-9_-]{20}", "_"],
  ["PMAK-[a-f0-9]{24}", "-"],
  ["NRAK-[A-Z0-9]{27}", "-"],
  ["pscale_(?:pw|tkn|oauth)_[A-Za-z0-9_-]{20}", "_"],
  ["pypi-Ag[A-Za-z0-9_-]{40}", "-"],
  [
    "(?:[_-](?:[A-Za-z0-9]{1,24}[_-]){0,4})?(?i:password|passwd|pwd|secret|token|api_?key|private_key(?:_id)?|dsn|credentials?)[ \\t]*[=:]",
    "=: _-",
  ],
];

const stopFor = new Map<string, string>();
function stop(cls: string): string {
  let v = stopFor.get(cls);
  if (v === undefined) {
    const inClass = new RegExp(`^[${cls}]$`);
    const alts = STOPS.filter(([, chars]) => [...chars].some((c) => !inClass.test(c))).map(([a]) => a);
    v = alts.length > 0 ? `(?!${alts.join("|")})` : "";
    stopFor.set(cls, v);
  }
  return v;
}

/** One body character of class `cls` that does not start a `STOP` the body could not run through. */
const body = (cls: string) => `(?:${stop(cls)}[${cls}])`;

/** A neighbour that makes a match glued: a letter or digit (`-` and `_` before a prefix are as on main: a boundary). */
const WORD_CHAR = /[A-Za-z0-9]/;

/** Letter-to-letter case changes and letter–digit contacts: many in a random token, few in an identifier. */
function irregularity(p: string): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) {
    const x = p[i - 1] ?? "";
    const y = p[i] ?? "";
    if (/[A-Z]/.test(x) && /[A-Z]/.test(y)) s++;
    else if ((/\d/.test(x) && /[A-Za-z]/.test(y)) || (/[A-Za-z]/.test(x) && /\d/.test(y))) s++;
  }
  return s;
}

/**
 * The end of a vendor token's body right before `at`: a token that a glued-aware body stopped at (`STOP`) starts
 * there, so its left neighbour is a token, not an identifier.
 */
const TOKEN_BEFORE =
  /(?:gh[pousr]_|github_pat_|sk-ant-|sk-(?:proj|svcacct|admin)-|[sr]k_(?:live|test)_|hf_|aln_|xox[abeprs]-|xapp-|lin_(?:api|oauth)_|glpat-|GOCSPX-|ya29\.|AIza|npm_|do[por]_v1_|IQoJb3JpZ2luX2Vj|(?:AKIA|ASIA))([A-Za-z0-9+/=%._-]{8,})$/;
const tokenBefore = (m: RegExpExecArray) => {
  // Right after a secret already replaced: the boundary of a pasted token, not an identifier.
  if (m.input.slice(Math.max(0, m.index - S.length), m.index) === S) return true;
  const t = TOKEN_BEFORE.exec(m.input.slice(Math.max(0, m.index - 1024), m.index));
  return t !== null && tokenShaped(t[1] ?? "");
};

/** Lower-to-upper case changes (`aB`): one per word in camelCase, about a quarter of the pairs in a random token. */
function lowerUpper(p: string): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) if (/[a-z]/.test(p[i - 1] ?? "") && /[A-Z]/.test(p[i] ?? "")) s++;
  return s;
}

/**
 * Token-shaped: some piece between `-`, `_` and `.` that reads as random, not as an identifier (not
 * `release-2026-10-22`, `Requests12`, `partitioned_by_day_2024`, `Tests9Key1`, `ServerConfigurationHandler`,
 * `XMLHTTPRequestJSONParser`):
 * - at least 8 characters with at least two digits and two letters, a digit before a letter, and at least five
 *   upper-case pairs or letter–digit contacts; or
 * - at least 16 characters with both cases, a digit and at least seven of those (a random token with one digit:
 *   `xoxb-<digits>-<digits>-<24>`, `glpat-<20>`, #65 round 2); or
 * - at least 20 characters with no digit but at least six upper-case pairs and four lower-to-upper changes (a random
 *   base62 run without a digit, which an acronym-heavy identifier does not reach).
 */
export function tokenShaped(value: string): boolean {
  return value.split(/[-_.]/).some((p) => {
    if (p.length < 8) return false;
    const digits = p.match(/\d/g)?.length ?? 0;
    const letters = p.match(/[A-Za-z]/g)?.length ?? 0;
    const irr = irregularity(p);
    if (digits >= 2 && letters >= 2 && /\d[\s\S]*[A-Za-z]/.test(p) && irr >= 5) return true;
    const cased = /[A-Z]/.test(p) && /[a-z]/.test(p);
    if (p.length >= 16 && cased && digits >= 1 && irr >= 7) return true;
    return p.length >= 20 && cased && digits === 0 && irr >= 6 && lowerUpper(p) >= 4;
  });
}

/**
 * A vendor token that may stand glued to a word on either side (`tokenghp_…`, `…ghp_<36>abc`): glued, its body (after
 * `prefix`) must be token-shaped, so a prefix inside an identifier (`inboxapp-…`, `kotlin_api_…`, `maya29.events`) is
 * not taken for one and cannot eat a credential name (L10b, D284; #65 security review).
 */
/** Whether a match has a letter or digit right before it. */
const gluedLeft = (m: RegExpExecArray) => /[A-Za-z0-9]/.test(m.input[m.index - 1] ?? "");

/** The run of token characters right before a glued match (bounded). */
const LEFT_RUN = /[A-Za-z0-9+/=._-]+$/;

type VendorOptions = {
  /** A fixed-length body (`AIza` + 35, `npm_` + 36, `do?_v1_` + 64): a letter or digit right after it also glues it. */
  fixed?: boolean;
  accept?: (m: RegExpExecArray) => boolean;
  /**
   * A prefix no identifier holds (`glpat-`, `GOCSPX-`, `AIza`) or the token's own structure (`xoxb-<digits>-<digits>-`):
   * glued, a match of this with a body holding a digit or both cases is a token even when the body is not
   * token-shaped (a random body with one digit, short pieces between `-`; #65 round 2).
   */
  shape?: RegExp;
  /** The left neighbours that make a match glued (default: a letter or digit); `.` too where the base rule refuses it. */
  glue?: RegExp;
  /** The token's whole structure (`$1$<salt>$<hash>`, `live_<27 hex>`): glued, a match of this is a token as it is. */
  structure?: RegExp;
  /** The text `madeOfWords` reads for `shape` (default: the body); a fixed-length body cut inside a word reads the whole word. */
  words?: (m: RegExpExecArray) => string;
};

/** A body with a digit or both cases: not a lower-case word run (`glpat-rotation-docs`). */
const mixedBody = (body: string) => {
  // All-digit pieces (Slack's `<digits>-<digits>-`) say nothing about the rest (`…-a_data_ptr`; #90 re-review).
  const b = body
    .split(/[-_.]/)
    .filter((p) => !/^[0-9]*$/.test(p))
    .join("_");
  return /[0-9]/.test(b) || (/[a-z]/.test(b) && /[A-Z]/.test(b));
};

/**
 * The text `madeOfWords` reads for a match: its body, and for a fixed-length body (`AIza` + 35) cut inside a word, the
 * rest of that word too (`xAIzaaccessTokenFromTheConfiguration…`; #90 re-review).
 */
function wordsAfter(m: RegExpExecArray, b: string): string {
  const end = m.index + m[0].length;
  return b + (/^[A-Za-z0-9]{0,256}/.exec(m.input.slice(end, end + 256))?.[0] ?? "");
}

/**
 * How a `vendor` rule looks again inside a refused candidate for the real token (`are_0` + `re_<token>`): at each later
 * copy of the prefix whose next `LOOK_HEAD` characters hold a capital or a digit (lower-case words start no token), at
 * most `MAX_LOOKS` times per candidate, so other text cannot use the looks up; past them, the rest of the candidate goes
 * whatever its shape (fail closed). Bounded per candidate (#90 security review, M3 and re-review).
 */
const LOOK_HEAD = 12;
const MAX_LOOKS = 16;

function vendor(re: RegExp, prefix: RegExp, opts: VendorOptions = {}) {
  // The prefix found anywhere: a refused candidate can hold the real token's prefix further on.
  const inner = new RegExp(prefix.source.replace(/^\^/, ""), "g");
  // The same pattern, matched at one position only.
  const at = new RegExp(re.source, "y");
  return (text: string): RuleResult => {
    /** Whether a match is taken: free-standing, or glued with a token's body (or right after a token). */
    const taken = (m: RegExpExecArray): boolean => {
      const prev = text[m.index - 1] ?? "";
      const next = text[m.index + m[0].length] ?? "";
      const leftGlued = (opts.glue ?? WORD_CHAR).test(prev);
      // A variable-length body runs on over letters and digits, so only a `STOP` ends it before one: not glue.
      const glued = leftGlued || (opts.fixed === true && WORD_CHAR.test(next));
      const b = m[0].replace(prefix, "");
      // A prefix alone (`shape`) is not enough for a body made of words (a GitLab prefix before
      // `RotationScheduleDocsV2-for-team`): that is an identifier.
      const shaped =
        tokenShaped(b) ||
        opts.structure?.test(m[0]) === true ||
        (opts.shape?.test(m[0]) === true &&
          mixedBody(b) &&
          !madeOfWords(opts.words ? opts.words(m) : wordsAfter(m, b)));
      return !((glued && !shaped && !tokenBefore(m)) || (opts.accept && !opts.accept(m)));
    };
    /** The token inside a refused candidate, at a later copy of the prefix (see `FIRST_INNER`). */
    const innerToken = (m: RegExpExecArray): RegExpExecArray | null => {
      inner.lastIndex = 1;
      let looks = 0;
      for (let k = inner.exec(m[0]); k !== null; k = inner.exec(m[0])) {
        if (k[0].length === 0) inner.lastIndex++;
        // Lower-case words after the prefix (`are_are_…`, `store_value_name`) start no token: a constant-cost skip.
        const head = m[0].slice(k.index + k[0].length, k.index + k[0].length + LOOK_HEAD);
        if (!/[A-Z0-9]/.test(head)) continue;
        if (looks++ >= MAX_LOOKS) {
          // Out of looks (a hostile run of prefixes): the rest goes (fail closed; #90 re-review).
          at.lastIndex = m.index + k.index;
          return at.exec(text);
        }
        at.lastIndex = m.index + k.index;
        const sub = at.exec(text);
        if (sub !== null && taken(sub)) return sub;
      }
      return null;
    };
    re.lastIndex = 0;
    let out = "";
    let last = 0;
    let count = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m.index < last) continue;
      if (!taken(m)) {
        // A fixed-length candidate refused can hide the real token starting inside it (`AIza_x_AIza<35>`): look again
        // from the next character (bounded: the body has a fixed length) (#65, D292 round 2).
        if (opts.fixed === true) {
          re.lastIndex = m.index + 1;
          continue;
        }
        // A refused candidate that holds the prefix again (`are_0re_<token>`, `xsk-ab-sk-<token>`) (L10b-3, D1202).
        const sub = innerToken(m);
        if (sub === null) continue;
        m = sub;
        re.lastIndex = m.index + m[0].length;
      }
      // Glued after a random run (`s.ni0…3pA` + `aln_…`), the run goes too: it is part of the same pasted secret.
      let start = m.index;
      if ((opts.glue ?? WORD_CHAR).test(text[m.index - 1] ?? "")) {
        const run = LEFT_RUN.exec(text.slice(Math.max(last, m.index - 256), m.index))?.[0] ?? "";
        if (run.length > 0 && tokenShaped(run)) start = m.index - run.length;
      }
      out += text.slice(last, start) + S;
      last = m.index + m[0].length;
      count++;
    }
    return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
  };
}

// ---------------------------------------------------------------------------------------------- PEM blocks

/**
 * `‹secret›` followed by as many newlines as `replaced` held, so a multi-line secret keeps the line count (PR
 * hunks map findings to line numbers; review round 6).
 */
function keepLines(replaced: string): string {
  let n = 0;
  for (let i = replaced.indexOf("\n"); i !== -1; i = replaced.indexOf("\n", i + 1)) n++;
  return S + "\n".repeat(n);
}

/**
 * Where a PEM block without its END line stops: at the end of the text, or at a blank line whose next
 * non-blank line is neither base64 nor a `Header: value` line (`Proc-Type`, `DEK-Info`). Each blank line is
 * looked at once, so the scan is linear.
 */
function truncatedPemEnd(text: string, from: number): number {
  const blank = /\n[ \t]*\r?\n/g;
  blank.lastIndex = from;
  for (let m = blank.exec(text); m !== null; m = blank.exec(text)) {
    const start = m.index + m[0].length;
    const nl = text.indexOf("\n", start);
    const line = text.slice(start, nl === -1 ? text.length : nl).trim();
    if (line === "" || /^[A-Za-z0-9+/=]+$/.test(line) || /^[A-Za-z][A-Za-z-]*: \S/.test(line)) {
      blank.lastIndex = start;
      continue;
    }
    return m.index;
  }
  return text.length;
}

const PEM_BEGIN = /-{4,5} ?BEGIN ([A-Za-z0-9 ]{1,40}?) ?-{4,5}/g;
const PEM_END = /-{4,5} ?END ([A-Za-z0-9 ]{1,40}?) ?-{4,5}/g;

/**
 * PEM blocks: `-----BEGIN <label>-----` to the matching END (any indentation, headers such as `Proc-Type` and
 * `DEK-Info` inside, `\n` escapes inside JSON strings, four or five dashes, a space inside the dashes, a
 * lower-case label), or, when the END is missing, to the end of the text or the first blank line followed by
 * something that is not part of a key (`truncatedPemEnd`). Linear: the END lines are found in one forward
 * scan and each BEGIN takes the first END of its label after it, so many distinct labels cost nothing extra.
 */
export function pemBlock(text: string): RuleResult {
  if (!/BEGIN/.test(text)) return { text, count: 0 };
  const ends = new Map<string, number[]>();
  PEM_END.lastIndex = 0;
  for (let e = PEM_END.exec(text); e !== null; e = PEM_END.exec(text)) {
    const label = (e[1] ?? "").trim().toUpperCase();
    const list = ends.get(label) ?? [];
    list.push(e.index + e[0].length);
    ends.set(label, list);
  }
  const cursor = new Map<string, number>();
  let out = "";
  let last = 0;
  let count = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m !== null; m = PEM_BEGIN.exec(text)) {
    const label = (m[1] ?? "").trim().toUpperCase();
    const after = m.index + m[0].length;
    const list = ends.get(label) ?? [];
    let i = cursor.get(label) ?? 0;
    while (i < list.length && (list[i] ?? 0) <= after) i++;
    cursor.set(label, i);
    const end = i < list.length ? (list[i] ?? text.length) : truncatedPemEnd(text, after);
    out += text.slice(last, m.index) + keepLines(text.slice(m.index, end));
    last = end;
    count++;
    PEM_BEGIN.lastIndex = end;
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}

/**
 * A PEM body without its BEGIN line: three or more consecutive lines of 60–76 base64 characters (a key pasted
 * from the middle). Each line is looked at once.
 */
export function pemBody(text: string): RuleResult {
  return replaceCounting(text, /(?:^|(?<=\n))(?:[ \t]*[A-Za-z0-9+/]{60,76}={0,2}[ \t]*\r?(?:\n|$)){3,}/g, (m) =>
    keepLines(m[0]),
  );
}

// ------------------------------------------------------------------------------- Google Cloud credentials

/**
 * Service-account key JSON: the values of `"private_key"` and `"private_key_id"` (also doubly encoded as
 * `\"private_key\": \"…\"`, and `private_key_id: <40 hex>` in YAML or TOML). Redacted wherever the field
 * appears, with or without `"type": "service_account"` beside it (a chunk boundary can separate them), so
 * the 40-hex key id never reaches the hex exemption of the high-entropy rule.
 */
export function gcpServiceAccountKey(text: string): RuleResult {
  let count = 0;
  let out = "";
  let last = 0;
  // A backslash run is entered only at its start and is at most 7 long, so long runs cannot backtrack.
  const start = /(?<!\\)(\\{0,7})"private_key(?:_id)?\1"\s*:\s*\1"/g;
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    const esc = m[1] ?? "";
    const valueStart = m.index + m[0].length;
    let end = valueStart;
    if (esc.length === 0) {
      while (end < text.length) {
        const c = text[end];
        if (c === '"' || c === "\n") break;
        end += c === "\\" ? 2 : 1;
      }
      end = Math.min(end, text.length);
    } else {
      const close = text.indexOf(`${esc}"`, valueStart);
      const newline = text.indexOf("\n", valueStart);
      end =
        close === -1 ? (newline === -1 ? text.length : newline) : newline !== -1 && newline < close ? newline : close;
    }
    const value = text.slice(valueStart, end);
    start.lastIndex = Math.max(end, start.lastIndex);
    if (value.length === 0 || value === S) continue;
    out += text.slice(last, valueStart) + S;
    last = end;
    count++;
  }
  const json = count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
  const loose = keepPrefix(/\b(private_key_id["']?\s*[=:]\s*["']?)([0-9A-Fa-f]{40})(?![0-9A-Za-z])/g)(json.text);
  return { text: loose.text, count: json.count + loose.count };
}

/** Google API keys: `AIza` plus 35 characters. */
export const googleApiKey = whole(/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g);

/** Google OAuth access tokens (`ya29.` …). */
export const googleOAuthAccessToken = whole(new RegExp(`(?<![A-Za-z0-9])ya29\\.${body("0-9A-Za-z._-")}{20,}`, "g"));

/** Google OAuth refresh tokens (`1//` …, usually `1//0` …). */
export const googleOAuthRefreshToken = whole(/(?<![0-9A-Za-z/:.])1\/\/[0-9A-Za-z_-]{20,}/g);

/** Google OAuth client secrets (`GOCSPX-` …). */
export const googleOAuthClientSecret = whole(new RegExp(`(?<![A-Za-z0-9])GOCSPX-${body("0-9A-Za-z_-")}{20,}`, "g"));

// ------------------------------------------------------------------------------------------ vendor tokens

/** AWS access key ids (`AKIA…`, `ASIA…` and the other documented prefixes, 20 characters). */
export const awsAccessKeyId = whole(
  /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|APKA|ASCA)[A-Z0-9]{16}\b/g,
);

/** AWS secret access keys: 40 base64 characters after an `aws_secret_access_key`-like name. */
export const awsSecretAccessKey = keepPrefix(
  /\b(aws_?secret_?(?:access_?)?key["']?\s*[=:]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
);

/** GitHub tokens: `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_` and fine-grained `github_pat_`. */
export const githubToken = whole(
  new RegExp(
    `(?<![A-Za-z0-9])(?:gh[pousr]_${body("A-Za-z0-9")}{30,255}|github_pat_${body("A-Za-z0-9_")}{22,255})\\b`,
    "g",
  ),
);

/** Slack tokens (`xoxa-`, `xoxb-`, `xoxe-`, `xoxp-`, `xoxr-`, `xoxs-`, `xoxe.xoxb-`, app-level `xapp-`). */
export const slackToken = whole(
  new RegExp(`(?<![A-Za-z0-9])(?:xox(?:[abeprs]|e\\.xox[bp])|xapp)-${body("A-Za-z0-9-")}{10,}`, "g"),
);

/** Slack incoming-webhook URLs: the path after `hooks.slack.com/services/` is the secret. */
export const slackWebhook = keepPrefix(
  /(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)([A-Za-z0-9_/-]{8,})/g,
);

/** GitLab personal, project and group access tokens (`glpat-` …). */
export const gitlabToken = whole(new RegExp(`(?<![A-Za-z0-9])glpat-${body("A-Za-z0-9_-")}{20,}`, "g"));

/** npm access tokens (`npm_` plus 36). */
export const npmToken = whole(/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g);

/** Hugging Face tokens (`hf_` …). */
export const huggingFaceToken = whole(new RegExp(`(?<![A-Za-z0-9])hf_${body("A-Za-z0-9")}{30,}(?![A-Za-z0-9])`, "g"));

/** SendGrid API keys (`SG.<id>.<secret>`). */
export const sendgridKey = whole(
  new RegExp(`(?<![A-Za-z0-9])SG\\.${body("A-Za-z0-9_-")}{16,}\\.${body("A-Za-z0-9_-")}{16,}`, "g"),
);

/** DigitalOcean tokens (`dop_v1_`, `doo_v1_`, `dor_v1_` plus 64 hex: hex, so the hex exemption must not see them first). */
export const digitalOceanToken = whole(/(?<![A-Za-z0-9])do[por]_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g);

/** Resend API keys (`re_` plus a mixed-case body with digits; plain snake_case identifiers stay). */
export const resendKey = whole(/(?<![A-Za-z0-9])re_[A-Za-z0-9_]{20,}/g, (m) => {
  const body = m[0].slice(3);
  // Both cases, and a digit or a body not made of words (a random body has no digit about once in 300; #90 re-review).
  return /[a-z]/.test(body) && /[A-Z]/.test(body) && (/[0-9]/.test(body) || !madeOfWords(body));
});

/** Linear API keys (`lin_api_` …) and OAuth tokens (`lin_oauth_` …). */
export const linearKey = whole(new RegExp(`(?<![A-Za-z0-9])lin_(?:api|oauth)_${body("A-Za-z0-9")}{32,}`, "g"));

/**
 * Vendor tokens recognised by their prefix alone, wherever they stand (no credential word needed): HashiCorp
 * Vault (`hvs.`, `hvb.`, `hvr.`), Supabase (`sbp_`), Shopify (`shpat_`, `shpss_`, `shpca_`, `shppa_`), Atlassian
 * (`ATATT3`), Square (`sq0atp-`, `sq0csp-`), Fly.io (`fo1_`), Mailgun (`key-` plus 32 hex), New Relic (`NRAK-`),
 * Docker Hub (`dckr_pat_`), RubyGems (`rubygems_`), Figma (`figd_`), Postman (`PMAK-`), Doppler (`dp.st.`,
 * `dp.pt.`, `dp.ct.`, `dp.sa.`), PlanetScale (`pscale_pw_`, `pscale_tkn_`), and crypt(3) password hashes
 * (`$1$`, `$apr1$`, `$2b$`, `$6$`, `$y$`, as in `.htpasswd` and `/etc/shadow`), and Mailgun's newer keys
 * (`<32 hex>-<8 hex>-<8 hex>`). Each body has a minimum length,
 * so a prefix in prose (`hvs.` alone, `key-value`) stays.
 */
export const vendorPrefixedToken = whole(
  new RegExp(
    // `-` and `_` may stand before a prefix (`shop-shpat_…`, `key_NRAK-…`); only letters, digits or `.` may not.
    "(?<![A-Za-z0-9.])(?:" +
      [
        "hv[sbr]\\.[A-Za-z0-9_-]{20,}",
        "sbp_[A-Za-z0-9]{32,}",
        "shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}",
        "ATATT3[A-Za-z0-9_=-]{20,}",
        "sq0(?:atp|csp)-[A-Za-z0-9_-]{20,}",
        "fo1_[A-Za-z0-9_-]{20,}",
        "key-[0-9a-f]{32}",
        "NRAK-[A-Z0-9]{27}",
        "dckr_pat_[A-Za-z0-9_-]{20,}",
        "rubygems_[a-f0-9]{48}",
        "figd_[A-Za-z0-9_-]{20,}",
        "PMAK-[a-f0-9]{24}-[a-f0-9]{34}",
        "dp\\.(?:st|pt|ct|sa)\\.[A-Za-z0-9._-]{20,}",
        "pscale_(?:pw|tkn|oauth)_[A-Za-z0-9_-]{20,}",
        "\\$(?:1|apr1|2[aby]|5|6|y)\\$[./A-Za-z0-9$]{20,}",
        "[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{8}",
      ].join("|") +
      ")(?![A-Za-z0-9_-])",
    "g",
  ),
  // Supabase (`sbp_` + 32 or more): a digit, or a body not made of words (`sbp_assertStructuredOutputCompatible`; #90
  // round 3).
  (m) => !m[0].startsWith("sbp_") || /[0-9]/.test(m[0].slice(4)) || !madeOfWords(m[0].slice(4)),
);

/**
 * Legacy HashiCorp Vault service tokens (`s.` plus 24 base62): only with upper case and lower case in the body, and a
 * digit or a body not made of words (`s.someVariableNameForTheConfig` stays; a random body has no digit about once in
 * 70; #90 re-review), so `s.` in prose or an identifier stays.
 */
export const vaultLegacyToken = whole(/(?<![A-Za-z0-9.])s\.[A-Za-z0-9]{24}(?![A-Za-z0-9])/g, (m) =>
  vaultBody(m[0].slice(2)),
);

/** A legacy Vault token's body: both cases, and a digit or not made of words (`run`: the whole word it stands in). */
function vaultBody(b: string, run = b): boolean {
  return /[a-z]/.test(b) && /[A-Z]/.test(b) && (/\d/.test(b) || !madeOfWords(run));
}

/** The letters and digits after `s.` up to the end of the word (at most 256). */
function vaultRun(m: RegExpExecArray): string {
  return /^[A-Za-z0-9]{0,256}/.exec(m.input.slice(m.index + 2, m.index + 258))?.[0] ?? "";
}

/** AWS temporary session tokens (STS): base64 that always starts `IQoJb3JpZ2luX2Vj` (`\t\x02origin_ec`). */
export const awsSessionToken = whole(
  new RegExp(`(?<![A-Za-z0-9+/])IQoJb3JpZ2luX2Vj${body("A-Za-z0-9+/=%")}{20,}`, "g"),
);

/**
 * An OpenSSH private-key body without its BEGIN line: base64 starting `b3BlbnNzaC1rZXktdjE` (`openssh-key-v1`),
 * with the base64 lines that continue it.
 */
export const openSshKeyBody = (text: string): RuleResult =>
  replaceCounting(
    text,
    /(?<![A-Za-z0-9+/])b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*(?:\r?\n[ \t]*[A-Za-z0-9+/]{16,}={0,2}(?=[ \t]*(?:\r?\n|$)))*/g,
    (m) => keepLines(m[0]),
  );

/**
 * A bare 40-character AWS secret access key in text that also holds an AWS access key id (`AKIA…` beside its
 * secret, as `aws configure` and credential CSVs print them): any 40-character base64 word with upper case,
 * lower case and a digit, or a `/` or `+`.
 */
export function awsPairedSecret(text: string): RuleResult {
  if (!/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) return { text, count: 0 };
  return replaceCounting(text, /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, (m) => {
    const v = m[0];
    const mixed = /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v);
    return mixed || /[/+]/.test(v) ? S : null;
  });
}

/** Anthropic keys (`sk-ant-` …). */
export const anthropicKey = whole(new RegExp(`(?<![A-Za-z0-9])sk-ant-${body("A-Za-z0-9_-")}{20,}`, "g"));

/** OpenAI keys (`sk-`, `sk-proj-`, `sk-svcacct-`, `sk-admin-`): a long body with letters and digits. */
export const openaiKey = whole(
  new RegExp(`(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?${body("A-Za-z0-9_-")}{20,}`, "g"),
  (m) => {
    const body = m[0].replace(/^sk-(?:proj-|svcacct-|admin-)?/, "");
    const longestRun = Math.max(0, ...body.split(/[_-]/).map((s) => s.length));
    return /[0-9]/.test(body) && /[A-Za-z]/.test(body) && longestRun >= 16;
  },
);

/** Stripe secret, restricted and publishable keys, and webhook signing secrets. */
export function stripeKey(text: string): RuleResult {
  const a = whole(new RegExp(`(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_${body("0-9A-Za-z")}{10,}\\b`, "g"))(text);
  const b = whole(/(?<![A-Za-z0-9])whsec_[A-Za-z0-9+/=]{20,}/g)(a.text);
  return { text: b.text, count: a.count + b.count };
}

/** Paddle API keys (`pdl_live_…`, `pdl_sdbx_…`) and client-side tokens (`live_` or `test_` plus 27 hex). */
export function paddleKey(text: string): RuleResult {
  const a = whole(/(?<![A-Za-z0-9])pdl_(?:live|sdbx)_[A-Za-z0-9_]{10,}/g)(text);
  const b = whole(/(?<![A-Za-z0-9])(?:live|test)_[0-9a-f]{27}\b/g)(a.text);
  return { text: b.text, count: a.count + b.count };
}

/** Our own tokens (`aln_<prefix>_<secret>`, docs/11): always redacted, never exempted. */
export const alignToken = whole(new RegExp(`(?<![A-Za-z0-9])aln_${body("A-Za-z0-9_-")}{8,}`, "g"));

/** JSON Web Tokens: three base64url parts, the first two JSON objects (`ey…`); several back to back are one match. */
export const jwt = whole(
  new RegExp(`(?<![A-Za-z0-9])(?:ey[A-Za-z0-9_-]{8,}\\.ey[A-Za-z0-9_-]{8,}\\.${body("A-Za-z0-9_-")}*)+`, "g"),
);

// ------------------------------------------------------------------------------ headers, URLs, DSNs

/** `Authorization: <scheme> <credentials>` header values (any scheme). */
export const authorizationHeader = keepPrefix(
  /\b(Authorization["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token|Digest|Bot|Key)\s+)?)([^\s"',;]{8,})/gi,
);

/** `Bearer <token>`: the token when it looks like one (a digit or symbol, or at least 20 characters). */
export const bearerToken = keepPrefix(
  /\b(Bearer\s+)([A-Za-z0-9._~+/=‹›-]{8,})/gi,
  (v) => /[0-9._~+/=-]/.test(v) || v.length >= 20,
);

/** A user-info part without a password that is a plain user name (`git`, `deploy`), not a token. */
const PLAIN_USER = /^[a-z_][a-z0-9_.-]{0,31}$/;

function validScheme(head: string, sep: number): boolean {
  let i = sep;
  while (i > 0 && sep - i < 21 && /[A-Za-z0-9+.-]/.test(head[i - 1] ?? "")) i--;
  return sep - i >= 2 && /[A-Za-z]/.test(head[i] ?? "");
}

/**
 * URLs with credentials, the scheme kept: `scheme://user:password@host` (an empty user too, as in
 * `redis://:pw@host`), `scheme://<token>@host` (a user part that is not a plain user name such as `git`), and
 * `user:password@host` without a scheme (`postgres:pw@db`). A token scan, linear: each whitespace-delimited
 * word is looked at once, its last `@` ends the user part (so `@` and `/` inside a password cannot split it),
 * and its first `://` starts it.
 */
export function credentialUrl(text: string): RuleResult {
  if (!text.includes("@")) return { text, count: 0 };
  let out = "";
  let last = 0;
  let count = 0;
  const word = /\S+/g;
  for (let m = word.exec(text); m !== null; m = word.exec(text)) {
    const tok = m[0];
    const at = tok.lastIndexOf("@");
    if (at <= 0 || !/[A-Za-z0-9[‹]/.test(tok[at + 1] ?? "")) continue;
    if (/^sha(?:256|384|512):/i.test(tok.slice(at + 1, at + 8))) continue; // image@sha256:… digests
    const head = tok.slice(0, at);
    const sep = head.indexOf("://");
    let from: number;
    if (sep !== -1 && validScheme(head, sep)) {
      from = sep + 3;
      const info = head.slice(from);
      const colon = info.indexOf(":");
      if (info.length === 0 || isMarker(info)) continue;
      if (colon === -1) {
        if (PLAIN_USER.test(info) || /[/?#]/.test(info)) continue;
      } else if (/[/?#]/.test(info.slice(0, colon))) {
        continue;
      } else if (colon === info.length - 1) {
        continue; // `scheme://user:@host`: no password
      }
    } else {
      // No scheme: only `user:password@host`, never `mailto:a@b` or a path.
      const colon = head.indexOf(":");
      if (colon === -1 || /^[("'<[]*(?:mailto|tel|sip|sips|xmpp)$/i.test(head.slice(0, colon))) continue;
      const pw = head.slice(colon + 1);
      if (pw.length === 0 || isMarker(pw) || pw.startsWith("//") || /[/\\]/.test(head.slice(0, colon))) continue;
      from = colon + 1;
    }
    out += text.slice(last, m.index + from) + S;
    last = m.index + at;
    count++;
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}

/** `curl -u user:password` and `--user user:password`: the password. */
export const curlUserPassword = keepPrefix(/(?<!\S)((?:-u|--user)(?:\s+|=)["']?[^\s:"']*:)([^\s"']+)/g);

/** Whether a value after a credential name is kept: empty, a marker, a code literal or a reference to another variable. */
const keepsValue = keepsCredentialValue;

/**
 * Credentials in command lines: `--password <v>`, `--token <v>`, `--api-key <v>` (any flag whose name is a
 * credential name, value not starting with `-`), `docker login -p <v>`, and MySQL's `-p<password>`.
 */
export function cliSecretFlag(text: string): RuleResult {
  const flags = replaceCounting(
    text,
    /(?<!\S)(--?([A-Za-z][A-Za-z0-9-]{0,63})[ \t]+)(?![-=:])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
    (m) => {
      const name = m[2] ?? "";
      const raw = m[3] ?? "";
      const quote = raw.startsWith('"') || raw.startsWith("'") ? (raw[0] ?? "") : "";
      const value = quote ? raw.slice(1, -1) : raw;
      if (name.length < 3 || /^no-/i.test(name) || !isCredentialName(name) || keepsValue(value)) return null;
      return `${m[1]}${quote}${S}${quote}`;
    },
  );
  const docker = replaceCounting(
    flags.text,
    /(\bdocker[ \t]+login\b[^\n]{0,200}?(?<!\S)-p[ \t]+)([^\s-][^\s]*)/g,
    (m) => (isMarker(m[2] ?? "") ? null : `${m[1]}${S}`),
  );
  const mysql = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/.test(docker.text)
    ? replaceCounting(docker.text, /(?<!\S)(-p)([^\s-][^\s]*)/g, (m) => (isMarker(m[2] ?? "") ? null : `-p${S}`))
    : { text: docker.text, count: 0 };
  const sshpass = replaceCounting(
    mysql.text,
    /(\bsshpass\b[^\n]{0,100}?(?<!\S)-p[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
    (m) => (isMarker((m[2] ?? "").replace(/^["']|["']$/g, "")) ? null : `${m[1]}${S}`),
  );
  const curlCookie = replaceCounting(
    sshpass.text,
    /(\bcurl\b[^\n]{0,200}?(?<!\S)(?:-b|--cookie)[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
    (m) => (isMarker((m[2] ?? "").replace(/^["']|["']$/g, "")) ? null : `${m[1]}${S}`),
  );
  // Password flags after a sign-in command (`az login -u ops -p …`, `ldapsearch -w …`, `psql -W …`).
  const login = replaceCounting(
    curlCookie.text,
    /(\b(?:login|logon|signin|sign-in|authenticate|auth)\b[^\n]{0,200}?(?<!\S)(?:-p|-P|-w|--pass|--passwd)[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
    (m) => (isMarker((m[2] ?? "").replace(/^["']|["']$/g, "")) ? null : `${m[1]}${S}`),
  );
  const ldap = replaceCounting(
    login.text,
    /(\b(?:ldapsearch|ldapmodify|ldapadd|ldapdelete|ldapwhoami|ldappasswd|smbclient|psql)\b[^\n]{0,200}?(?<!\S)(?:-w|-W)[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
    (m) => (isMarker((m[2] ?? "").replace(/^["']|["']$/g, "")) ? null : `${m[1]}${S}`),
  );
  const redis = replaceCounting(
    ldap.text,
    /(\bredis-cli\b[^\n]{0,200}?(?<!\S)(?:-a|--pass|--askpass)[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
    (m) => (isMarker(m[2] ?? "") ? null : `${m[1]}${S}`),
  );
  const shortFlag0 = passwordShortFlag(redis.text);
  const loginPair = loginUserPassword(shortFlag0.text);
  const more = moreCliPasswords(loginPair.text);
  const shortFlag = { text: more.text, count: shortFlag0.count + loginPair.count + more.count };
  return {
    text: shortFlag.text,
    count:
      shortFlag.count +
      flags.count +
      docker.count +
      mysql.count +
      sshpass.count +
      curlCookie.count +
      login.count +
      ldap.count +
      redis.count,
  };
}

/**
 * Programs whose `-p` / `-P` takes no password: a flag (`mkdir -p`, `git log -p`, `cp -p`, `make -p`), a port (`ssh -p`,
 * `scp -P`, `rails s -p`), a package or project (`npx -p`, `cargo -p`, `mypy -p`, `mvn -P`, `docker-compose -p`), a
 * profile, a prompt (`claude -p`), an expression (`node -p`, `perl -p`), a pattern (`grep -P`) or a process (`ps -p`).
 * A wrapper (`sudo`, `env`, `time`) or an English word is never one: the program is the word nearest the flag (D1206,
 * #99 review). `unzip` only for a lower-case `-p` (`-P` is its password); `zip -P` is a password.
 */
const NO_PASSWORD_P = new Set(
  (
    "mkdir cp mv ls ln git npx npm pnpm yarn bun node deno perl python python3 ruby php tar rsync grep egrep fgrep rg " +
    "ag sed awk jq yq ps pgrep pkill top htop pidstat taskset renice iotop perf py-spy strace ltrace gdb lsof pip pip3 " +
    "uv poetry cargo go make gcc clang docker podman docker-compose kubectl helm minikube skaffold ssh scp sftp nc ncat " +
    "netcat man diff patch quilt chmod chown kill xargs tsc vitest jest pytest tox nox mypy pylint black ruff coverage " +
    "locust k6 ab wrk gh aws gcloud terraform serverless sls heroku firebase vercel nmap ping traceroute gzip split " +
    "head tail sort uniq wc tr cut paste od xxd hexdump less more curl wget install find vite next astro ng expo rails bundle flask uvicorn " +
    "hugo http-server serve jekyll webpack mvn mvnw gradle gradlew sbt ansible-playbook cmake ctest act hyperfine " +
    "parallel tmux screen df iostat mpstat dpkg apt-cache rpm brew conda virtualenv pyenv dotnet nuget claude agent " +
    "cursor-agent codex gemini llm"
  ).split(" "),
);

/** Programs that take a password after `-p` / `-P`: the backward look stops at them before a wrapper (`docker exec`). */
const PASSWORD_P = new Set(
  (
    "mongo mongosh mongodump mongorestore mongoexport mongoimport mongostat mongotop sqlcmd bcp isql osql mysql " +
    "mysqldump mysqladmin mysqlimport mysqlcheck mariadb mariadb-dump zip 7z 7za rar unrar openvpn openconnect ftp " +
    "sshpass redis-cli"
  ).split(" "),
);

/** Programs whose `-p` takes a password glued to it (`7z a -pSecret`, `unrar x -pSecret`, `docker login -pSecret`). */
const GLUED_P = new Set([
  "7z",
  "7za",
  "rar",
  "unrar",
  "docker",
  "mongo",
  "mongosh",
  "mongodump",
  "mongorestore",
  "sqlcmd",
  "bcp",
  "zip",
]);

/** Programs that launch another program after their own arguments (`docker run <image> <command>`, `npx <tool>`). */
const LAUNCHERS = new Set([
  "npx",
  "docker",
  "podman",
  "kubectl",
  "ssh",
  "xargs",
  "sudo",
  "env",
  "gcloud",
  "python",
  "node",
]);

/** Words that run the next word as a program (`sudo /usr/bin/mongo`, `exec ./bin/x`). */
const WRAPPERS = new Set(["sudo", "env", "exec", "time", "nohup", "nice", "command", "xargs", "timeout", "watch"]);

/** A port, a port range or a mapping (`5432`, `8080:80`, `3000-3010`, `53/udp`, `127.0.0.1:5432:5432`). */
const PORT_VALUE = /^(?:\d{1,3}(?:\.\d{1,3}){3}:)?\d{1,5}(?:[:-]\d{1,5})*(?:\/(?:tcp|udp))?$/;

/** A word that names code or a file, not a password: `python3.12`, `Script.cmake`, `align_core`, `Version=1.2`. */
const NAMED_VALUE = /=|\.[A-Za-z0-9]{1,8}$|^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^[a-z]+[0-9.]*$/;

/**
 * The program a `-p` / `-P` flag at `at` belongs to: the nearest word before it, in its clause, that names a program
 * which takes a password there (`PASSWORD_P`) or uses the flag otherwise (`NO_PASSWORD_P`). `docker`/`podman`/`kubectl`
 * `exec` and `ssh <host>` run another command, so the flag after them is that command's (unknown: a password).
 */
function flagProgram(text: string, at: number, flag: string): "password" | "unknown" | "other" {
  const ls = text.lastIndexOf("\n", at) + 1;
  const clause =
    text
      .slice(Math.max(ls, at - 300), at)
      .split(/&&|\|\||[;|]|\$\(|`/)
      .pop() ?? "";
  const raws = clause.split(/[\s{}()]+/).filter((w) => w.length > 0);
  const words = raws.map((w) =>
    w
      .replace(/^.*\//, "")
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.-]+$/g, "")
      .toLowerCase(),
  );
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k] ?? "";
    if (PASSWORD_P.has(w)) return "password";
    if (w === "unzip") return flag === "-p" ? "other" : "password";
    if (!NO_PASSWORD_P.has(w)) continue;
    // After a password program, an exempt word is its argument (`mongosh agent -p …`, `bcp dbo.T out make -P …`), unless
    // it launches another program (`docker run mongo ls -p …`; #99 review round 3).
    // A launcher counts only in a program's place: first in the clause or after a wrapper (`mongosh node -p …` is
    // mongosh's; #99 review round 4). An image or a host that names a password program (`docker run mongo mkdir -p …`)
    // still counts: over-redacting the command inside is safer than parsing every launcher's flags (#99 round 5).
    const pwBefore = words.slice(0, k).some((x) => PASSWORD_P.has(x));
    if (pwBefore && !(LAUNCHERS.has(w) && (k === 0 || WRAPPERS.has(words[k - 1] ?? "")))) continue;
    // Not a program: a flag's value (`mongo -u node`, `sqlcmd -d agent`), a URL or `host:port`, or a path that is not in
    // a program's place (`mongosh mongodb://db/agent`, `--file ./scripts/make`; #99 review round 2).
    const rawWord = (raws[k] ?? "").replace(/^["']+|["']+$/g, "");
    const prev = raws[k - 1] ?? "";
    if (/^-/.test(prev) && prev !== "--") continue;
    if (rawWord.includes(":")) continue;
    // A path is a program only at the start of the clause, or absolute after a wrapper (`sudo /usr/bin/mongo`; not
    // `env ./mkdir`).
    if (rawWord.includes("/") && k > 0 && !(WRAPPERS.has(prev.toLowerCase()) && rawWord.startsWith("/"))) continue;
    const after = words.slice(k + 1);
    if (w === "docker" && after.includes("login")) return "password";
    if ((w === "docker" || w === "podman" || w === "kubectl") && after.some((x) => x === "exec" || x === "--")) {
      return "password";
    }
    // `ssh [flags] <host> <command> -p …`: a word after ssh that is not a flag or a flag's value is the host.
    if (
      w === "ssh" &&
      after.some((x, i) => !x.startsWith("-") && !/^\d+$/.test(x) && !/^-[pilFoJ]$/.test(after[i - 1] ?? ""))
    )
      return "password";
    return "other";
  }
  return "unknown";
}

/**
 * `-p` / `-P` and its value, unless the program it belongs to uses the flag otherwise (`flagProgram`): quoted or bare,
 * glued to a quote (`-p'…'`), after `=` (`-p=…`) or a space, glued for `7z`, `rar` and `docker login`; a port, a path, a
 * variable, a named value (`NAMED_VALUE`) or a marker stays; a plain lower-case word stays outside a password program
 * (L10b-5, D1206).
 */
export function passwordShortFlag(text: string): RuleResult {
  if (!/-[pP]/.test(text)) return { text, count: 0 };
  return replaceCounting(
    text,
    /(?<!\S)(-[pP])(?:([ \t]+|=)|(?=["'])|(?=[^\s"'=-]))("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
    (m) => {
      const flag = m[1] ?? "";
      const sep = m[2];
      const raw = m[3] ?? "";
      const quote = /^["']/.test(raw) ? (raw[0] ?? "") : "";
      // Unquoted, quotes and escapes around the value are not part of it (`-p 6379\"` in printed JSON).
      const value = quote
        ? raw.slice(1, -1)
        : (raw.replace(/^[\\"'`]+/, "").split(/[`,;]/)[0] ?? "").replace(/[\\"'`,;:.)\]}]+$/, "");
      if (
        value.length < 2 ||
        !/[A-Za-z0-9]/.test(value) ||
        isMarker(value) ||
        keepsValue(value) ||
        PORT_VALUE.test(value)
      )
        return null;
      // A variable, an HTML entity, a placeholder (`<V>`, `${v}`) or an English word is not a password.
      if (/^[$<]/.test(value) || /&[a-z]+;/.test(value) || isCommonWord(value)) return null;
      const program = flagProgram(m.input, m.index, flag);
      if (program === "other") return null;
      // Glued (`-pSecret`) only for the programs that take it so (mysql has its own rule); `-p=` always.
      if (sep === undefined && !quote) {
        const ls = m.input.lastIndexOf("\n", m.index) + 1;
        const before = m.input.slice(Math.max(ls, m.index - 200), m.index).toLowerCase();
        if (![...GLUED_P].some((p) => new RegExp(`(?:^|[\\s/])${p}(?:\\s|$)`).test(before))) return null;
      }
      // A path, or a plain lower-case word in prose (`use -p to create parents`), is not a password; after a program
      // that takes one (`openconnect -p sunshine`), any value is.
      // `mysql -u root -p app`: a bare `-p` prompts, and the plain word after it is the database.
      const ls0 = m.input.lastIndexOf("\n", m.index) + 1;
      const mysqlish = /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mariadb(?:-dump)?)\b/.test(
        m.input.slice(Math.max(ls0, m.index - 200), m.index),
      );
      if (!quote && (program === "unknown" || mysqlish)) {
        if (/^[./~]|\//.test(value) || /^[a-z]{1,12}(?:-[a-z]{1,12}){0,3}$/.test(value)) return null;
        if (NAMED_VALUE.test(value) && !/[A-Z].*[0-9]|[0-9].*[A-Z]|[!@#%^&*~+]/.test(value)) return null;
      }
      // Unquoted, what followed the value stays (`-p X\`),` keeps its `` `), ``).
      // Only punctuation: a comma inside a password must not leave its second half (`-p <A>,<B>`; #99 review round 3).
      const rest = quote ? "" : raw.slice(raw.indexOf(value) + value.length);
      const tail = /^[^\p{L}\p{N}]*$/u.test(rest) ? rest : "";
      return `${m[1]}${sep ?? ""}${quote}${S}${quote}${tail}`;
    },
  );
}

/**
 * Passwords of a few more command lines (#99 review): `openssl … -passin pass:<v>` / `-passout pass:<v>` / `-k <v>`,
 * `htpasswd -b <file> <user> <v>`, `ssh-keygen -N <v>`, `keytool -storepass <v>`, `lftp -u <user>,<v>`,
 * `smbclient -U <user>%<v>`.
 */
const MORE_CLI_PASSWORDS: readonly RegExp[] = [
  /(\bpass:)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
  /(\bopenssl\b[^\n]{0,200}?(?<!\S)-k[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
  /(\bhtpasswd\b[^\n]{0,100}?(?<!\S)-[a-zA-Z]*b[a-zA-Z]*[ \t]+\S+[ \t]+\S+[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
  /(\bssh-keygen\b[^\n]{0,200}?(?<!\S)-N[ \t]+)("[^"\n]+"|'[^'\n]+'|[^\s"'-][^\s]*)/g,
  /(\bkeytool\b[^\n]{0,300}?(?<!\S)-(?:storepass|keypass|srcstorepass|deststorepass|srckeypass|destkeypass)[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)/g,
  /(\blftp\b[^\n]{0,200}?(?<!\S)-u[ \t]+["']?[^,\s"']+,)([^\s"']+)/g,
  /(\bsmbclient\b[^\n]{0,200}?(?<!\S)-U[ \t]+["']?[^%\s"']+%)([^\s"']+)/g,
];

export function moreCliPasswords(text: string): RuleResult {
  let t = text;
  let count = 0;
  for (const re of MORE_CLI_PASSWORDS) {
    const r = replaceCounting(t, re, (m) => {
      const v = (m[2] ?? "").replace(/^["']|["']$/g, "").replace(/[`,;.)]+$/, "");
      if (v.length < 2 || !/[A-Za-z0-9]/.test(v) || /^[$<]/.test(v) || isMarker(v) || keepsValue(v)) return null;
      const q = /^["']/.test(m[2] ?? "") ? (m[2] ?? "")[0] : "";
      return `${m[1]}${q}${S}${q}`;
    });
    t = r.text;
    count += r.count;
  }
  return { text: t, count };
}

/** Error, type and class names after `login <user>` (`PermissionDenied`, `AuthController`): not passwords. */
const NAME_SUFFIX =
  /(?:Error|Exception|Denied|Refused|Failed|Failure|Timeout|NotFound|Unavailable|Invalid|Expired|Required|Controller|Service|Handler|Manager|Provider|Client|Server|Module|Component|Config|Options|Request|Response)$/;

/**
 * `login <user> <password>` and `login <user> / <password>` in prose (`my login is bob / <passphrase>`, `login: bob /
 * …`): the value after the user name when it reads as a password, not as a word or a name: eight or more characters
 * with a capital, a digit or a symbol, not a code name, a path, a file name, a date, CONSTANT_CASE, an error or class
 * name, a number or a marker (L10b-5, D1207).
 */
export function loginUserPassword(text: string): RuleResult {
  if (!/login/i.test(text)) return { text, count: 0 };
  return replaceCounting(
    text,
    /(\blogin(?:[ \t]+is)?[ \t]*:?[ \t]+([A-Za-z][\w.@-]{0,31})[ \t]+(?:[/:][ \t]*)?)([^\s/"'`]{6,128})/gi,
    (m) => {
      // The user is a name, not a word of the sentence (`login and device code`) or of code (`login: await get(…)`).
      const user = m[2] ?? "";
      if (
        isCommonWord(user) ||
        /^(?:with|via|using|page|flow|screen|form|button|await|new|this|return|async|typeof)$/i.test(user)
      )
        return null;
      const raw = m[3] ?? "";
      const v = raw.replace(/[.,;!?)]+$/, "");
      if (/&[a-z]+;/.test(v) || /[(){}[\],;=<>$]/.test(v)) return null;
      // Eight or more characters, or six with letters and digits (`xk9qLm2`).
      const long = v.length >= 8 || (v.length >= 6 && /[A-Za-z]/.test(v) && /[0-9]/.test(v));
      // A version or a technology name (`v1.2.3`, `OAuth2`, `HTTP2`, `sha256`) is not a password.
      if (
        /^v?\d+(?:\.\d+)+/.test(v) ||
        /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(v) ||
        /^(?:o?auth|https?|sha|md|base|utf|ipv|ec|tls|ssl|web)\d+$/i.test(v)
      )
        return null;
      if (!long || isMarker(v) || keepsValue(v) || !/[A-Z0-9!@#$%^&*~+=]/.test(v) || /^[a-z]+$/.test(v)) {
        return null;
      }
      if (codeName(v, false) || /[/\\]/.test(v) || /^\d+$/.test(v)) return null;
      // A date, a file name, CONSTANT_CASE, an error or class name (#99 review).
      if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/.test(v) || /^[\w-]+\.[a-z]{1,5}$/.test(v)) return null;
      if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(v) || (/^[0-9]*[A-Z][A-Za-z]+$/.test(v) && NAME_SUFFIX.test(v)))
        return null;
      // Capitalised words joined by `-` (`Rate-Limited`), a name ending in an acronym (`Account2FA`), or three or more
      // capitalised words with at most one trailing digit (`SignUpFlow2`): feature and state names.
      if (/^[A-Z][a-z]+(?:-[A-Z]?[a-z]+)+$/.test(v) || /^[A-Z][a-z]+[0-9]?(?:2FA|MFA|OTP|SSO|API|ID|URL)$/.test(v))
        return null;
      if (/^(?:[A-Z][a-z]+){2,}[A-Z][a-z]*[0-9]?$/.test(v) && (v.match(/[A-Z]/g) ?? []).length >= 3) return null;
      return `${m[1]}${S}${raw.slice(v.length)}`;
    },
  );
}

/** XML elements and key/value attribute pairs that hold a credential: `<password>…</password>`, `<add key="ApiKey" value="…"/>`. */
export function xmlCredential(text: string): RuleResult {
  if (!text.includes("<") && !/value\s*=/.test(text)) return { text, count: 0 };
  const element = replaceCounting(text, /<([A-Za-z_][\w.:-]{0,63})>([^<\n]{1,512})<\/\1>/g, (m) =>
    isCredentialName(m[1] ?? "") && !keepsValue(m[2] ?? "") ? `<${m[1]}>${S}</${m[1]}>` : null,
  );
  const pair = replaceCounting(
    element.text,
    /(\b(?:key|name)[ \t]*=[ \t]*["']([^"'\n]{1,64})["'][ \t]+value[ \t]*=[ \t]*)(["'])([^"'\n]*)\3/g,
    (m) => (isCredentialName(m[2] ?? "") && !keepsValue(m[4] ?? "") ? `${m[1]}${m[3]}${S}${m[3]}` : null),
  );
  return { text: pair.text, count: element.count + pair.count };
}

/** Kubernetes `env` entries: `- name: DB_PASSWORD` followed by `value: …` on the next line. */
export const kubernetesEnvValue = (text: string): RuleResult =>
  replaceCounting(
    text,
    /(\bname:[ \t]*["']?([A-Za-z0-9_.-]{1,64})["']?[ \t]*\r?\n[ \t]*(?:-[ \t]*)?value:[ \t]*)(["']?)([^\s"']+)\3/g,
    (m) => (isCredentialName(m[2] ?? "") && !keepsValue(m[4] ?? "") ? `${m[1]}${m[3]}${S}${m[3]}` : null),
  );

/** `Cookie:` and `Set-Cookie:` header values (session cookies are bearer credentials). */
export const cookieHeader = keepPrefix(/\b((?:Set-)?Cookie:[ \t]*)([^\r\n]+)/gi, (v) => v.includes("="));

/** `.netrc` lines (`machine <host> login <user> password <v>`). */
export const netrcPassword = keepPrefix(/(\b(?:machine|default)\b[^\n]{0,200}?\bpassword[ \t]+)(\S+)/g);

/** `.pgpass` lines (`host:port:database:user:password`). */
export const pgpassLine = keepPrefix(
  /((?:^|(?<=\n))[^:\s]{1,253}:(?:\d{1,5}|\*):[^:\s]{1,63}:[^:\s]{1,63}:)(\S{1,256})(?=\r?\n|$)/g,
);

/** Twilio account and API key ids (`AC` / `SK` plus 32 hex), with the auth token when it follows (`AC…:<32 hex>`). */
// Once `:<32 hex>` follows the SID, the auth token always goes with it, whatever is glued after it (`…:<token>was`);
// the look-ahead applies to a SID alone (#90 round 4).
export const twilioSid = whole(/(?<![A-Za-z0-9])(?:AC|SK)[a-f0-9]{32}(?::[a-f0-9]{32}|(?![A-Za-z0-9]))/g);

/** Databricks personal access tokens (`dapi` plus 32 hex). */
export const databricksToken = whole(/(?<![A-Za-z0-9])dapi[a-f0-9]{32}(?:-\d)?(?![A-Za-z0-9])/g);

/** Telegram bot tokens (`<bot id>:AA…`). */
export const telegramBotToken = whole(/(?<![0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{32,}/g);

/** Discord bot tokens: three base64url parts whose first decodes to the bot's numeric id. */
export const discordBotToken = whole(
  /(?<![A-Za-z0-9_.-])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g,
  (m) => {
    const id = (m[0].split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    try {
      return /^[0-9]{17,20}$/.test(atob(id + "=".repeat((4 - (id.length % 4)) % 4)));
    } catch {
      return false;
    }
  },
);

/** age secret keys (`AGE-SECRET-KEY-1…`). */
export const ageSecretKey = whole(/AGE-SECRET-KEY-1[0-9A-Za-z]{40,}/g);

/** PyPI upload tokens (`pypi-Ag…`, a macaroon). */
export const pypiToken = whole(/(?<![A-Za-z0-9])pypi-Ag[A-Za-z0-9_-]{40,}/g);

/** A 64-hex private key written as `0x…` (Ethereum and other wallets); transaction hashes go too (the safe side). */
export const hexPrivateKey = whole(/(?<![A-Za-z0-9])0x[0-9a-fA-F]{64}(?![0-9A-Za-z])/g);

/** Old 40-hex GitHub tokens: only with `github`, `gh` or `token` just before them (a bare 40-hex word is a commit SHA). */
export const githubLegacyToken = keepPrefix(
  /((?<![A-Za-z0-9])(?:github|gh|token|tokens)(?![A-Za-z0-9])[^\n]{0,40}?)(?<![A-Za-z0-9])([0-9a-f]{40})(?![0-9A-Za-z])/gi,
);

/**
 * PuTTY key files (`PuTTY-User-Key-File-3: …`): the header line and every key line after it (`Encryption:`,
 * `Public-Lines:`, `Private-Lines:`, `Private-MAC:` and the base64 lines) become one `‹secret›`.
 */
export function puttyPrivateKey(text: string): RuleResult {
  if (!text.includes("PuTTY-User-Key-File-")) return { text, count: 0 };
  let out = "";
  let last = 0;
  let count = 0;
  const re = /PuTTY-User-Key-File-[0-9]+:/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let end = text.indexOf("\n", m.index);
    end = end === -1 ? text.length : end;
    while (end < text.length) {
      const next = text.indexOf("\n", end + 1);
      const line = text.slice(end + 1, next === -1 ? text.length : next).trim();
      if (!/^(?:[A-Za-z][A-Za-z0-9-]*: ?\S.*|[A-Za-z0-9+/=]+)$/.test(line)) break;
      end = next === -1 ? text.length : next;
    }
    out += text.slice(last, m.index) + keepLines(text.slice(m.index, end));
    last = end;
    count++;
    re.lastIndex = end;
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}

/** Base64 of `user:password` (HTTP Basic credentials pasted without their header). */
export const basicAuthBase64 = whole(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{12,512}={0,2}(?![A-Za-z0-9+/=])/g, (m) => {
  const v = m[0];
  if (v.length % 4 !== 0) return false;
  try {
    return /^[\x21-\x39\x3b-\x7e]{1,64}:[\x20-\x7e]{3,}$/.test(atob(v));
  } catch {
    return false;
  }
});

// ------------------------------------------------------------------------------------- high entropy

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORDISH_SEGMENT = /^(?:[a-z]+[0-9]*|v?[0-9]+)$/;

function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Whether a candidate of ≥ 32 characters is a likely secret. Exempt: pure hex (commit SHAs, `sha256:`
 * digests), UUIDs, URL remainders (`//host/path`) and lower-case identifiers made of words and numbers
 * (`checkout-service-v2-production-eu-west1`). Everything else needs letters, digits and an entropy of at
 * least 4.2 bits per character. `aln_` tokens never get here: `alignToken` runs first.
 */
export function isHighEntropy(value: string): boolean {
  if (value.length < 32) return false;
  if (/^[0-9a-fA-F]+$/.test(value)) return false;
  if (UUID.test(value)) return false;
  if (value.startsWith("//")) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  const segments = value.split(/[-_.~/+=]+/).filter((s) => s.length > 0);
  if (segments.length >= 3 && segments.every((s) => WORDISH_SEGMENT.test(s))) return false;
  return shannon(value) >= 4.2;
}

const ENTROPY_CHARS = "A-Za-z0-9+/=_.~-";

/** High-entropy strings of ≥ 32 characters inside quotes or after `=` or `:`. */
export function highEntropyString(text: string): RuleResult {
  const quoted = replaceCounting(text, new RegExp(`(["'\`])([${ENTROPY_CHARS}]{32,})\\1`, "g"), (m) =>
    isHighEntropy(m[2] ?? "") ? `${m[1]}${S}${m[1]}` : null,
  );
  const assigned = replaceCounting(quoted.text, new RegExp(`([=:][ \\t]*)([${ENTROPY_CHARS}]{32,})`, "g"), (m) =>
    isHighEntropy(m[2] ?? "") ? `${m[1]}${S}` : null,
  );
  return { text: assigned.text, count: quoted.count + assigned.count };
}

// ---------------------------------------------------------------------------------------- the order

const r = (name: string, apply: (text: string) => RuleResult): Rule => ({ name, group: "secret", apply });

/** The order the rules run in: specific shapes first, name-keyed values next, the generic high-entropy rule last. */
export const SECRET_RULES: readonly Rule[] = [
  r("pemBlock", pemBlock),
  r("pemBody", pemBody),
  r("puttyPrivateKey", puttyPrivateKey),
  r("gcpServiceAccountKey", gcpServiceAccountKey),
  r("googleApiKey", googleApiKey),
  r("googleOAuthAccessToken", googleOAuthAccessToken),
  r("googleOAuthRefreshToken", googleOAuthRefreshToken),
  r("googleOAuthClientSecret", googleOAuthClientSecret),
  r("awsPairedSecret", awsPairedSecret),
  r("awsAccessKeyId", awsAccessKeyId),
  r("awsSecretAccessKey", awsSecretAccessKey),
  r("githubToken", githubToken),
  r("githubLegacyToken", githubLegacyToken),
  r("slackToken", slackToken),
  r("slackWebhook", slackWebhook),
  r("gitlabToken", gitlabToken),
  r("npmToken", npmToken),
  r("pypiToken", pypiToken),
  r("huggingFaceToken", huggingFaceToken),
  r("sendgridKey", sendgridKey),
  r("digitalOceanToken", digitalOceanToken),
  r("resendKey", resendKey),
  r("linearKey", linearKey),
  r("vendorPrefixedToken", vendorPrefixedToken),
  r("vaultLegacyToken", vaultLegacyToken),
  r("awsSessionToken", awsSessionToken),
  r("openSshKeyBody", openSshKeyBody),
  r("anthropicKey", anthropicKey),
  r("openaiKey", openaiKey),
  r("stripeKey", stripeKey),
  r("paddleKey", paddleKey),
  r("alignToken", alignToken),
  r("telegramBotToken", telegramBotToken),
  r("discordBotToken", discordBotToken),
  r("ageSecretKey", ageSecretKey),
  r("hexPrivateKey", hexPrivateKey),
  r("jwt", jwt),
  r("authorizationHeader", authorizationHeader),
  r("bearerToken", bearerToken),
  r("cookieHeader", cookieHeader),
  r("credentialUrl", credentialUrl),
  r("curlUserPassword", curlUserPassword),
  r("nameValuePair", nameValuePair),
  r("credentialAssignment", credentialAssignment),
  r("reverseComparison", reverseComparison),
  r("sqlIdentifiedBy", sqlIdentifiedBy),
  r("cliSecretFlag", cliSecretFlag),
  r("xmlCredential", xmlCredential),
  r("kubernetesEnvValue", kubernetesEnvValue),
  r("netrcPassword", netrcPassword),
  r("pgpassLine", pgpassLine),
  r("twilioSid", twilioSid),
  r("databricksToken", databricksToken),
  r("basicAuthBase64", basicAuthBase64),
  r("bareKeyValue", bareKeyValue),
  r("userPasswordProse", userPasswordProse),
  r("credentialLineSweep", credentialLineSweep),
  r("highEntropyString", highEntropyString),
];

// ------------------------------------------------------------------------------- glued vendor tokens (L10b)
//
// The rules above are matched first, to a fixed point, exactly as before L10b; then these, which only add: vendor
// tokens glued to a word on either side (`tokenghp_…`, `…npm_<36>abc`, `xxxxsk-ant-…`), through `vendor` (glued, the
// body must be token-shaped or start where another token ended; it stops at the next vendor token or a credential
// name; a random run right before it goes too), JWTs and `AKIA`/`ASIA` wherever they stand, and the most distinctive
// prefixes of `vendorPrefixedToken` glued too. Running after the base rules, they can never undo what those find
// (L10b, D284; #65 security review, D292).

const g = (name: string, apply: RuleFn): Rule => ({ name, group: "secret", apply });

/**
 * A bare AWS secret glued to more letters (`…AgMCja` + `abc`) beside an access key id: the whole run of 40 to 256
 * characters. The key id is looked for in the text as it was before any rule ran (by now it is a marker).
 */
export function awsPairedGlued(original: string): RuleFn {
  const present =
    /(?:AKIA|ASIA)(?=[A-Z0-9]{0,15}\d)[A-Z0-9]{16}(?![A-Z0-9])|(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(
      original,
    );
  return (text) => {
    if (!present) return { text, count: 0 };
    // Never the middle of a longer token (`sk-proj-<40>_f0-…`): `_` and `-` do not start one here.
    return replaceCounting(text, /(?<![A-Za-z0-9/+=_-])[A-Za-z0-9/+]{40,256}(?![A-Za-z0-9/+=])/g, (m) => {
      const v = m[0];
      const mixed = /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v);
      return mixed || /[/+]/.test(v) ? S : null;
    });
  };
}

/**
 * The rest of a pasted token after a secret replaced inside it. A rule whose body alphabet is narrower than the token's
 * (`re_`, `pdl_live_`, `figd_`: no `+`, `/` or `-`), or whose body has a fixed length (`AIza` + 35), can match a prefix
 * glued in front of a longer token (`re_0` + `IQoJb3JpZ2luX2Vj…`) and stop at the token's first character outside its
 * alphabet: the token's own prefix is then gone with the match, so no rule recognises the tail and it stays in the
 * clear. Right after `‹secret›`, any run of token characters is the rest of the same token and goes too; it stops at a
 * credential name or another vendor token (`STOPS`), which their own rules handle; trailing `.`, `_` and `-` stay
 * (sentence punctuation), and so do lower-case words after one (`‹secret›-based`) (#65, D292 round 2).
 */
const KEPT_AFTER_SECRET =
  /^(?:[./_-](?:[a-z]{2,12}|[A-Z][a-z]{1,11}|JSON|HTML|XML|YAML|CSV|PDF|URL|URI|API|SQL|ID|IDs|UI|CLI|SDK|HTTP|HTTPS|TLS|SSH|DNS|JWT|MD|README|TODO)){1,4}[._-]*$/;
const SECRET_TAIL = new RegExp(`${S}((?:${stop("")}[A-Za-z0-9+/=%._-])+)`, "g");
export const secretTail = (text: string): RuleResult =>
  replaceCounting(text, SECRET_TAIL, (m) => {
    const run = m[1] ?? "";
    // Up to four short words after a separator (`‹secret›-based`, `‹secret›.then`, `‹secret›-Based`, `‹secret›.JSON`,
    // `‹secret›/settings/tokens`) are prose or a path, not a cut token; anything else goes (L10b-3, D1202).
    if (KEPT_AFTER_SECRET.test(run)) return null;
    const tail = run.replace(/[._-]+$/, "");
    return /[A-Za-z0-9+/=%]/.test(tail) ? S + run.slice(tail.length) : null;
  });

/**
 * A JWT glued after word characters (`x` + `eyJ…`): the run of base64url characters before `after` is read from its
 * start, once, and the token starts at the first `head` (`ey`) with at least `min` characters to the `.`. Linear: a
 * pattern starting at every `ey` (`xkey-xkey-…`) read the rest of the run from each one (#90 review: ~4 ms/KB).
 */
function gluedJwt(after: RegExp, head: string, min: number): RuleFn {
  const re = new RegExp(`(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{${min},}(?:${after.source})`, "g");
  return (text) =>
    replaceCounting(text, re, (m) => {
      const seg = m[0].slice(0, m[0].indexOf("."));
      const i = seg.indexOf(head);
      if (i === -1 || seg.length - i < min || isMarker(m[0])) return null;
      return m[0].slice(0, i) + S;
    });
}

/** A letter or digit right before: these variants only add the glued case. */
const GL = "(?<=[A-Za-z0-9])";

/**
 * A Discord bot token glued after word characters (`abc_` + `<id>.<6>.<27>`), or after a `.`: the first part's last 23
 * to 28 characters are tried for a base64 bot id (17 to 20 digits); the match starts at the start of a run, so a long
 * run is read once.
 */
function discordGlued(text: string): RuleResult {
  return replaceCounting(
    text,
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{23,1024}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g,
    (m) => {
      const first = m[0].slice(0, m[0].indexOf("."));
      for (let k = 23; k <= Math.min(28, first.length); k++) {
        const id = first
          .slice(first.length - k)
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        try {
          if (/^[0-9]{17,20}$/.test(atob(id + "=".repeat((4 - (id.length % 4)) % 4)))) {
            return m[0].slice(0, first.length - k) + S;
          }
        } catch {
          // not base64 at this length
        }
      }
      return null;
    },
  );
}

/** Right-glued too: the base rules' trailing lookaheads and `\b` are not here (`AIza`, `npm_`, `do?_v1_`, `ghp_`). */
export const GLUED_SECRET_RULES: readonly Rule[] = [
  g(
    "awsAccessKeyIdGlued",
    // Right-glued too (`AKIA<16>9`, a fixed length): glued on either side, the body needs a digit; a refused candidate
    // is looked at again from its next character (`AKIA` + `AKIA<16>`).
    (text) => {
      const re = /(?:AKIA|ASIA)[A-Z0-9]{16}/g;
      let out = "";
      let last = 0;
      let count = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const glued = gluedLeft(m) || WORD_CHAR.test(text[m.index + 20] ?? "");
        if (glued && !/\d/.test(m[0].slice(4))) {
          re.lastIndex = m.index + 1;
          continue;
        }
        out += text.slice(last, m.index) + S;
        last = m.index + 20;
        count++;
      }
      return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
    },
  ),
  g(
    "githubTokenGlued",
    vendor(
      new RegExp(`(?:gh[pousr]_${body("A-Za-z0-9")}{30,255}|github_pat_${body("A-Za-z0-9_")}{22,255})`, "g"),
      /^(?:gh[pousr]_|github_pat_)/,
    ),
  ),
  g(
    "slackTokenGlued",
    vendor(
      new RegExp(`(?:xox(?:[abeprs]|e\\.xox[bp])|xapp)-${body("A-Za-z0-9-")}{10,}`, "g"),
      /^(?:xox(?:[abeprs]|e\.xox[bp])|xapp)-/,
      // `xapp` only with its whole structure (`xapp-<digit>-<id>-<digits>-<secret>`), so `inboxapp-1-…` is not one.
      { shape: /^(?:xox(?:[abeprs]|e\.xox[bp])-\d{8,}-\d{8,}-|xapp-\d-[A-Z0-9]{8,}-\d{8,}-[A-Za-z0-9]{16,}$)/ },
    ),
  ),
  g("gitlabTokenGlued", vendor(new RegExp(`glpat-${body("A-Za-z0-9_-")}{20,}`, "g"), /^glpat-/, { shape: /^glpat-/ })),
  g("npmTokenGlued", vendor(/npm_[A-Za-z0-9]{36}/g, /^npm_/, { fixed: true })),
  g("huggingFaceTokenGlued", vendor(new RegExp(`hf_${body("A-Za-z0-9")}{30,}`, "g"), /^hf_/)),
  g("digitalOceanTokenGlued", vendor(/do[por]_v1_[a-f0-9]{64}/g, /^do[por]_v1_/, { fixed: true })),
  g("linearKeyGlued", vendor(new RegExp(`lin_(?:api|oauth)_${body("A-Za-z0-9")}{32,}`, "g"), /^lin_(?:api|oauth)_/)),
  g("googleApiKeyGlued", vendor(/AIza[0-9A-Za-z_-]{35}/g, /^AIza/, { fixed: true, shape: /^AIza/ })),
  g("googleOAuthAccessTokenGlued", vendor(new RegExp(`ya29\\.${body("0-9A-Za-z._-")}{20,}`, "g"), /^ya29\./)),
  g(
    "googleOAuthClientSecretGlued",
    vendor(new RegExp(`GOCSPX-${body("0-9A-Za-z_-")}{20,}`, "g"), /^GOCSPX-/, {
      shape: /^GOCSPX-/,
    }),
  ),
  g(
    "awsSessionTokenGlued",
    vendor(new RegExp(`IQoJb3JpZ2luX2Vj${body("A-Za-z0-9+/=%")}{20,}`, "g"), /^IQoJb3JpZ2luX2Vj/),
  ),
  g("anthropicKeyGlued", vendor(new RegExp(`sk-ant-${body("A-Za-z0-9_-")}{20,}`, "g"), /^sk-ant-/)),
  g(
    "openaiKeyGlued",
    vendor(new RegExp(`sk-(?:proj|svcacct|admin)-${body("A-Za-z0-9_-")}{20,}`, "g"), /^sk-(?:proj|svcacct|admin)-/, {
      accept: (m) => {
        const b = m[0].replace(/^sk-(?:proj|svcacct|admin)-/, "");
        const longestRun = Math.max(0, ...b.split(/[_-]/).map((x) => x.length));
        return /[0-9]/.test(b) && /[A-Za-z]/.test(b) && longestRun >= 16;
      },
    }),
  ),
  g(
    "stripeKeyGlued",
    vendor(new RegExp(`[sr]k_(?:live|test)_${body("0-9A-Za-z")}{10,}`, "g"), /^[sr]k_(?:live|test)_/, {
      // Legacy keys have a 24-character body, often not token-shaped: the prefix with 24 or more, and a body not made of
      // words (#90 re-review: shorter test names such as `network_test_acquireLock` are left to `tokenShaped`).
      shape: /^[sr]k_(?:live|test)_[0-9A-Za-z]{24,}/,
    }),
  ),
  g(
    "alignTokenGlued",
    vendor(new RegExp(`aln_${body("A-Za-z0-9_-")}{8,}`, "g"), /^aln_/, {
      // Our own structure (`aln_<8>_<secret>`, packages/engine/src/tokens): `kaln_toggleIsOnByDefault` is not one.
      shape: /^aln_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{32,}$/,
    }),
  ),
  g("jwtGlued", gluedJwt(new RegExp(`\\.ey[A-Za-z0-9_-]{8,}\\.${body("A-Za-z0-9_-")}*`), "ey", 10)),
  // SendGrid glued only with a token-shaped body (`MSG.handler_name.other_name` stays): its prefix is short.
  g(
    "sendgridKeyGlued",
    vendor(new RegExp(`SG\\.${body("A-Za-z0-9_-")}{16,}\\.${body("A-Za-z0-9_-")}{16,}`, "g"), /^SG\./, {
      accept: (m) => !gluedLeft(m) || tokenShaped(m[0].slice(3)),
    }),
  ),
  g(
    "vendorPrefixedGlued",
    whole(
      new RegExp(
        [
          "shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}",
          "ATATT3[A-Za-z0-9_=-]{20,}",
          "sq0(?:atp|csp)-[A-Za-z0-9_-]{20,}",
          "NRAK-[A-Z0-9]{27}",
          "dckr_pat_[A-Za-z0-9_-]{20,}",
          "rubygems_[a-f0-9]{48}",
          "PMAK-[a-f0-9]{24}-[a-f0-9]{34}",
          "pscale_(?:pw|tkn|oauth)_[A-Za-z0-9_-]{20,}",
        ].join("|"),
        "g",
      ),
    ),
  ),
  // L10b-3 (D1202): every other vendor prefix, glued after a letter or digit only (the base rules take it free-standing
  // or after the characters their own look-behind allows). Through `vendor`, so glued the body must be token-shaped
  // (or `shape` with a mixed body) and not made of words; the short prefixes (`sk-`, `re_`, `s.`, `AC`, `SK`, `key-`,
  // `live_`, `test_`, `0x`, `1//`) get no `shape`, so only a random body counts.
  g(
    "googleOAuthRefreshTokenGlued",
    // After a letter or digit, or after the `/`, `:` or `.` the base rule refuses (`ya29.` + `1//0…`): random bodies only.
    vendor(new RegExp(`(?<=[A-Za-z0-9/:.])1//${body("0-9A-Za-z_-")}{20,}`, "g"), /^1\/\//, {
      glue: /[A-Za-z0-9/:.]/,
    }),
  ),
  g(
    "pypiTokenGlued",
    vendor(new RegExp(`${GL}pypi-Ag${body("A-Za-z0-9_-")}{40,}`, "g"), /^pypi-Ag/, { shape: /^pypi-Ag/ }),
  ),
  g(
    "resendKeyGlued",
    // After a `.` too: the base rule needs a digit in the body.
    vendor(new RegExp(`(?<=[A-Za-z0-9.])re_${body("A-Za-z0-9_")}{20,}`, "g"), /^re_/, {
      glue: /[A-Za-z0-9.]/,
      // Resend's own structure (`re_<8>_<24>`) stands in for a random-looking body; the prefix alone is too short.
      // Not anchored at the end: right-glued (`re_<8>_<24>was`) too (#90 re-review).
      shape: /^re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/,
      // Both cases; a digit is not required (a random 32-character body has none about once in 300; #90 review).
      accept: (m) => {
        const b = m[0].slice(3);
        return /[a-z]/.test(b) && /[A-Z]/.test(b);
      },
    }),
  ),
  g(
    "openaiLegacyKeyGlued",
    vendor(new RegExp(`${GL}sk-${body("A-Za-z0-9_-")}{20,}`, "g"), /^sk-/, {
      accept: (m) => {
        const b = m[0].slice(3);
        const longestRun = Math.max(0, ...b.split(/[_-]/).map((x) => x.length));
        return /[0-9]/.test(b) && /[A-Za-z]/.test(b) && longestRun >= 16;
      },
    }),
  ),
  g(
    "stripePublishableKeyGlued",
    vendor(new RegExp(`${GL}pk_(?:live|test)_${body("0-9A-Za-z")}{10,}`, "g"), /^pk_(?:live|test)_/, {
      shape: /^pk_(?:live|test)_[0-9A-Za-z]{24,}/,
    }),
  ),
  g(
    "stripeWebhookSecretGlued",
    vendor(new RegExp(`${GL}whsec_${body("A-Za-z0-9+/=")}{20,}`, "g"), /^whsec_/, { shape: /^whsec_/ }),
  ),
  g(
    "paddleKeyGlued",
    vendor(new RegExp(`${GL}pdl_(?:live|sdbx)_${body("A-Za-z0-9_")}{10,}`, "g"), /^pdl_(?:live|sdbx)_/, {
      // Paddle's own structure (`pdl_live_apikey_<id>_<secret>`): `mypdl_live_pgJobStore` is not one (#90 re-review).
      shape: /^pdl_(?:live|sdbx)_apikey_/,
    }),
  ),
  g(
    "paddleClientTokenGlued",
    // The whole structure (`live_`/`test_` + 27 hex) stands for a random body; glued on either side (`_x`, `was`, `9`),
    // but not where the hex runs on for eight more (`latest_<commit SHA>`, `/tmp/test_<sha>`: #90 round 3).
    vendor(/(?:live|test)_[0-9a-f]{27}(?![0-9a-f]{8})/g, /^(?:live|test)_/, {
      fixed: true,
      structure: /^(?:live|test)_[0-9a-f]{27}$/,
    }),
  ),
  // Hex bodies of a fixed length (Twilio, Databricks, `0x` + 64, Mailgun `key-`): glued on either side, but never where
  // the hex runs on for eight more (`SK<commit SHA>`, `TASK<sha>`, `monkey-<sha>`, `a0x<88 hex>`: #90 round 3).
  // The price of not cutting commit SHAs: a real 32-hex key followed directly by eight or more hex characters is kept
  // (`SK<32 hex><8 hex>` reads as a longer hex run); with `:<token>` after the SID both always go (#90 round 4).
  g("twilioSidGlued", vendor(/(?:AC|SK)[a-f0-9]{32}(?::[a-f0-9]{32}|(?![0-9a-f]{8}))/g, /^(?:AC|SK)/, { fixed: true })),
  g("databricksTokenGlued", vendor(/dapi[a-f0-9]{32}(?:-\d)?(?![0-9a-f]{8})/g, /^dapi/, { fixed: true })),
  g(
    "vaultLegacyTokenGlued",
    // After a `.` too (`SG.` + `s.…`), which the base rule refuses, and right-glued (`s.<24>was`, a fixed-length body):
    // then only a random body (#90 re-review).
    vendor(/s\.[A-Za-z0-9]{24}/g, /^s\./, {
      fixed: true,
      glue: /[A-Za-z0-9.]/,
      shape: /^s\./,
      // Right-glued, the identifier runs on (`s.assertStructuredOutputCompatible`): words are read to its end.
      words: (m) => vaultRun(m),
      accept: (m) => vaultBody(m[0].slice(2), vaultRun(m)),
    }),
  ),
  g("hexPrivateKeyGlued", vendor(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F]{8})/g, /^0x/, { fixed: true })),
  // Mailgun's older keys (`key-` + 32 hex), glued on either side.
  g("mailgunLegacyKeyGlued", vendor(/key-[0-9a-f]{32}(?![0-9a-f]{8})/g, /^key-/, { fixed: true })),
  g(
    "vendorPrefixedTokenGlued",
    vendor(
      new RegExp(
        // No look-behind or look-ahead: glued on the left (`opts.glue`) a body must be token-shaped or not words; on the
        // right, letters and digits run into the body and `_x` after it no longer hides it (#90 re-review).
        `(?:` +
          [
            `hv[sbr]\\.${body("A-Za-z0-9_-")}{20,}`,
            `sbp_${body("A-Za-z0-9")}{32,}`,
            `fo1_${body("A-Za-z0-9_-")}{20,}`,
            `figd_${body("A-Za-z0-9_-")}{20,}`,
            `dp\\.(?:st|pt|ct|sa)\\.${body("A-Za-z0-9._-")}{20,}`,
          ].join("|") +
          ")",
        "g",
      ),
      /^(?:hv[sbr]\.|sbp_|fo1_|figd_|dp\.(?:st|pt|ct|sa)\.)/,
      // After a `.` too, which the base rule refuses (`a.figd_…`).
      {
        shape: /^(?:hv[sbr]\.|sbp_|fo1_|figd_|dp\.(?:st|pt|ct|sa)\.)/,
        glue: /[A-Za-z0-9.]/,
        // Free-standing too, Supabase only with a digit or a body not made of words (as `vendorPrefixedToken`).
        accept: (m) => !m[0].startsWith("sbp_") || /[0-9]/.test(m[0].slice(4)) || !madeOfWords(m[0].slice(4)),
      },
    ),
  ),
  // crypt(3) hashes glued on either side (`x$6$…`, `$2b$12$…_x`, `$2b$12$…was`), by their structure: MD5, SHA-256 and
  // SHA-512 crypt (`$1$`, `$apr1$`, `$5$`, `$6$` + salt + hash), bcrypt (`$2b$<cost>$<53>`), yescrypt
  // (`$y$<params>$<salt>$<43>`); letters glued on the right read as part of the hash (#90 re-review).
  g(
    "cryptHashGlued",
    vendor(/\$(?:1|apr1|2[aby]|5|6|y)\$[./A-Za-z0-9$]{20,}/g, /^\$(?:1|apr1|2[aby]|5|6|y)\$/, {
      structure:
        /^\$(?:(?:1|5|6|apr1)\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{22,}|2[aby]\$\d\d\$[./A-Za-z0-9]{53,}|y\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{1,64}\$[./A-Za-z0-9]{43,})$/,
      glue: /[A-Za-z0-9.]/,
    }),
  ),
  // Mailgun's newer keys (`<32 hex>-<8 hex>-<8 hex>`) and the OpenSSH key body: the structure alone is distinctive.
  // The match starts where the hex run starts (so a long run is read once), and the key is its last 32 characters.
  g("mailgunKeyGlued", (text) =>
    replaceCounting(text, /(?<![0-9a-f])[0-9a-f]{33,}-[0-9a-f]{8}-[0-9a-f]{8}(?![0-9a-f-])/g, (m) => {
      const cut = m[0].indexOf("-") - 32;
      return m[0].slice(0, cut) + S;
    }),
  ),
  g("mailgunKeyGluedAfterWord", whole(/(?<=[g-zG-Z.])[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{8}(?![0-9a-f-])/g)),
  g("openSshKeyBodyGlued", (text) =>
    replaceCounting(
      text,
      /(?<=[A-Za-z0-9+/])b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*(?:\r?\n[ \t]*[A-Za-z0-9+/]{16,}={0,2}(?=[ \t]*(?:\r?\n|$)))*/g,
      (m) => keepLines(m[0]),
    ),
  ),
  // A bot id glued after more digits: the base rule's look-behind refuses every start inside a digit run.
  g("telegramBotTokenGlued", whole(/(?<=[0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{32,}/g)),
  g("discordBotTokenGlued", discordGlued),
  // A crypt(3) hash part of which another rule took first (`x$6$<salt>$` + `‹secret›`, `$2b$12$<head>` + `‹secret›`
  // where `s.<24>` read as a Vault token): the head goes with it.
  g("cryptHeadGlued", whole(new RegExp(`\\$(?:1|5|6|apr1|2[aby]|y)\\$[./A-Za-z0-9$]{0,200}${S}`, "g"))),
  // A JWT header left before a payload another rule took first (`x` + `eyJ…`: the base rule refuses the glued header,
  // `basicAuthBase64` then decodes the payload, which holds a `:`).
  g("jwtHeaderGlued", gluedJwt(new RegExp(`\\.(?=${S})`), "eyJ", 11)),
  g("secretTail", secretTail),
];
