/**
 * docs/17 §Redaction rule 1, name-keyed credentials (D75, review rounds 3 and 4).
 *
 * A credential word that is part of an identifier (any case, quoting, subscript `["…"]`, escaped JSON `\"…\"`)
 * triggers a look at what follows. Two kinds of separator are told apart:
 *
 * - **Code separators** take the value whatever it is: `=`, `:=`, `?=`, `+=`, `=>`, a call with a literal
 *   (`setPassword("…")`), a type then `=` (`var password string = …`), a quoted string after a space (SQL
 *   `PASSWORD '…'`), a CLI flag and its next word, a `.netrc` line (`password <v>`). A quoted value runs to its
 *   closing quote (escapes and escaped-JSON levels counted, triple quotes too), else to the end of the line. A
 *   YAML key with an empty value, `|`, `>`, `{` or `[` also loses its more-indented lines.
 * - **Prose separators** (` is `, ` was `, ` are `, ` were `, ` be `, `is:`, a `Label:`, ` = ` between spaces,
 *   `->`, `→`, ` - `, a comma, `'s`, `(`, a CJK particle, and the same up to six clause words after the name:
 *   `the db password for prod is …`, `token for the bot: …`) take the value only when it does not read as
 *   English (`proseVerdict`): a secret-shaped word anywhere in it, or a first word outside the closed list of
 *   ordinary words and no sentence after it. So `The session token is stored hashed` stays and `the token is
 *   Zq81kd0Lw` does not.
 * - **Comparisons** (`==`, `!=`, `===`) keep identifiers and literals (`token == other`, `password === null`)
 *   and take a quoted or secret-shaped operand.
 *
 * Kept as a whole value: D75's prose words, code literals and type names, references to another variable, and
 * exact markers. A name whose last part describes a credential (`token_url`, `password_file`, `tokenCount`) is
 * not a trigger here (the line sweep still takes a secret-shaped word on its line). Words are matched on text
 * with lookalike letters folded (`pаssword` with a Cyrillic `а`).
 *
 * Linear: every identifier is examined once (its end and last part are cached), every value ends at its line
 * or quote, and prose checks look at no more than 12 words.
 */
import { MARKER } from "../version";
import {
  bareWord,
  cleanIdentifier,
  FILLERS,
  foldConfusables,
  isAlgorithmName,
  isCommonWord,
  isSecretShaped,
  proseVerdict,
  secretPieces,
} from "./prose";
import { MARKER_PATTERN, type RuleResult } from "./rule";
import { madeOfWords } from "./words";

const S = MARKER.secret;

/**
 * Credential words. Strong words count anywhere in an identifier part (`dbpassword`, `csrftoken`); weak words
 * only as a whole part (`pass` in `db_pass`, never in `bypass` or `passing`). Longer words first.
 */
const WORD =
  /requirepass|masterauth|password|passwd|passphrase|passcode|passw|pass|pwd|pw|secret|token|credential|creds|cred|api[ _-]?key|authorization|oauth|auth|private[ _-]?key|access[ _-]?key|session[ _-]?key|session[ _-]?id|signature|recovery[ _-]?codes?|(?:reset|verification|confirmation|security|backup|login|access)[ _-]codes?|key|dsn|pin|otp|mnemonic|seed|cookie|sid|sig/gi;
const STRONG = new Set([
  "password",
  "passwd",
  "passphrase",
  "passcode",
  "secret",
  "token",
  "credential",
  "apikey",
  "mnemonic",
  "privatekey",
  "accesskey",
  "sessionid",
  "requirepass",
  "masterauth",
]);
/** Words that make a following ` key` a credential name (`API key: …`, `signing key = …`, `wallet key 5…`). */
const KEY_QUALIFIERS = new Set([
  "api",
  "private",
  "secret",
  "access",
  "signing",
  "encryption",
  "master",
  "license",
  "deploy",
  "client",
  "session",
  "wallet",
  "hmac",
  "jwt",
  "webhook",
  "product",
]);
/** Words before ` key` that make it a data key, not a credential (`cache key`, `primary key`, `KMS key`). */
const NOT_CREDENTIAL_KEYS = new Set(
  "cache primary foreign sort partition lock idempotency object composite unique index map dict dictionary hash lookup row column table hot shortcut keyboard redis s3 kms bucket storage json yaml config registry translation i18n react list sharding shard routing dedupe dedup group join natural surrogate candidate super compound query search cursor pagination memo".split(
    " ",
  ),
);

/** A last identifier part that names something about a credential, not the credential itself. */
const DESCRIBES = new Set([
  "url",
  "uri",
  "endpoint",
  "count",
  "len",
  "length",
  "size",
  "type",
  "ttl",
  "file",
  "path",
  "dir",
  "name",
  "field",
  "label",
  "format",
  "version",
  "policy",
  "enabled",
  "required",
  "expiry",
  "expires",
  "expiration",
  "at",
  "manager",
  "scanning",
  "rotation",
  "budget",
  "limit",
  "column",
  "table",
  // round 6: parts that name a property or a method of a credential, not its value
  "prefix",
  "scope",
  "scopes",
  "status",
  "state",
  "kind",
  "mode",
  "role",
  "roles",
  "org",
  "id",
  "ids",
  "ms",
  "sec",
  "secs",
  "seconds",
  "minutes",
  "hours",
  "days",
  "lifetime",
  "timeout",
  "age",
  "get",
  "has",
  "includes",
  "startswith",
  "endswith",
  "indexof",
  "find",
  "lookup",
  "exists",
  "contains",
  "delete",
  "remove",
  "revoke",
  "parse",
]);

/** The fixed prose words of D75: kept only when one of them is the whole value. */
const PROSE_VALUES =
  /^(?:required|optional|none|missing|hidden|redacted|set|unset|reset|changed|empty|true|false)[.,;]?$/i;
/** Code literals and type names that are never a credential's value. */
const LITERALS =
  /^(?:null|undefined|nil|None|true|false|True|False|string|String|str|number|int|bool|boolean|any|unknown|bytes|SecretStr|\[\]|\{\}|""|'')[;,]?$/;
/** References to another variable: they carry no value. `$NAME` only when NAME is not itself secret-shaped. */
const REFERENCE =
  /^(?:process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[["'][A-Za-z_][A-Za-z0-9_]*["']\])|import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*|os\.getenv\(["'][A-Za-z_][A-Za-z0-9_]*["']\)|os\.environ(?:\[["'][A-Za-z_][A-Za-z0-9_]*["']\]|\.get\(["'][A-Za-z_][A-Za-z0-9_]*["']\))|System\.getenv\("[A-Za-z_][A-Za-z0-9_]*"\)|ENV\[["'][A-Za-z_][A-Za-z0-9_]*["']\]|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{\{ ?secrets\.[A-Za-z_][A-Za-z0-9_]* ?\}\}|\$[A-Z_][A-Z0-9_]*)!?[;,]?$/;
const EXACT_MARKER = new RegExp(`^${MARKER_PATTERN}$`);
/** A header built from a variable: `Bearer ${token}` (a template literal's text). */
const AUTH_TEMPLATE = /^(?:Bearer|Basic|Token|Bot)[ \t]+\$\{[A-Za-z_$][\w$.]{0,63}\}$/;
const MARKER_AT = new RegExp(MARKER_PATTERN, "y");

const CODE_TOKEN =
  /\s+|[A-Za-z_$][\w$]*|\d[\d_]*(?:\.\d+)?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[()[\]{}.,;:?!<>=+\-*/%&|^~]+/y;
const CODE_KEYWORDS = new Set([
  "await",
  "new",
  "yield",
  "typeof",
  "void",
  "as",
  "in",
  "of",
  "instanceof",
  "not",
  "and",
  "or",
  "is",
  "return",
]);
/** A quoted literal inside an expression that names something (`"x-align-token"`, `'password'`, `"sha256"`). */
const NAME_LITERAL = /^(?:|[A-Za-z_][\w.:/-]{0,127})$/;

/**
 * A code expression rather than a value (round 6): `await getToken(req)`, `req.headers.get("x-align-token") ??
 * ""`, `z.string().min(32)`, `process.env.X!`, `15 * 60 * 1000`, `kms.decrypt({ name: keyName, ciphertext })`.
 * It must be a call, member or arithmetic expression made only of identifiers, numbers, operators and quoted
 * literals that name things; no identifier may be secret-shaped, and a literal after `??`, `||`, `or` or a comma
 * (a default value, a second argument) must be empty. A trailing `//` comment is ignored.
 */
export function isCodeExpression(value: string): boolean {
  let v = value.trim();
  const comment = v.search(/\s\/\/\s/);
  if (comment !== -1) v = v.slice(0, comment).trim();
  v = v.replace(/[;,]+$/, "").trim();
  if (v.length === 0 || v.length > 400) return false;
  // Arithmetic of short numbers only: `15 * 60 * 1000` is a duration, `479146413 * 1` hides a PIN (round 7).
  if (/^\d[\d_]*(?:\s*[*+/-]\s*\d[\d_]*)+$/.test(v))
    return v.split(/[^\d_]+/).every((n) => n.replace(/_/g, "").length < 6);
  if (!/^(?:(?:await|new|yield)\s+)*[A-Za-z_$]/.test(v)) return false;
  // Member access or a call written as code (`a.b`, `a?.b`, `f(`, `x[`), not a sentence's full stop.
  const structured = /[\w$\])][?!]?\.[A-Za-z_$]|[\w$\]]\(|[\w$\]]\[/.test(v);
  if (!structured) return false;
  let p = 0;
  let prev = "";
  let prevIdent = false;
  let identifiers = 0;
  while (p < v.length) {
    CODE_TOKEN.lastIndex = p;
    const m = CODE_TOKEN.exec(v);
    if (!m) return false;
    const t = m[0];
    p += t.length;
    if (/^\s+$/.test(t)) continue;
    const c = t[0] ?? "";
    if (c === '"' || c === "'") {
      const inner = t.slice(1, -1);
      if (!NAME_LITERAL.test(inner) || (inner.length >= 8 && isSecretShaped(inner))) return false;
      // A literal with a digit (other than a known name such as `sha256`) or of equal generated groups
      // (`hayx-jefs-dcuf`) is a value, not a name (round 7).
      if (/\d/.test(inner) && !isAlgorithmName(inner) && !/^v\d{1,3}$/.test(inner)) return false;
      if (/^[a-z]{3,6}(?:-[a-z]{3,6}){2,}$/.test(inner) && new Set(inner.split("-").map((g) => g.length)).size === 1) {
        return false;
      }
      if (inner.length > 0 && (/(?:\?\?|\|\||,)$/.test(prev) || prev === "or")) return false;
      prevIdent = false;
    } else if (/^[A-Za-z_$]/.test(c)) {
      // Every identifier must read as code, whatever its length (`f(itdkFYL)`, `cfg.zqawbVanpq` are values).
      if (!cleanIdentifier(t) || (t.length >= 8 && isSecretShaped(t))) return false;
      // Two words in a row are a sentence unless the first is a keyword (`await getToken(req)`).
      if (prevIdent && !CODE_KEYWORDS.has(prev)) return false;
      identifiers++;
      prevIdent = true;
    } else {
      // A number used as an argument or operand keeps the expression code only when it is short.
      if (/^\d/.test(t) && t.replace(/[_.]/g, "").length >= 6) return false;
      prevIdent = false;
    }
    prev = t;
  }
  return identifiers > 0;
}

/** A cookie's name as a constant (`SESSION_COOKIE = "__Host-align_session"`): a name, not a credential. */
const COOKIE_NAME = /^(?:__(?:Host|Secure)-)?[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A reference to another variable, strictly: `$X` and `${X}` with a plain name, `process.env.X`, …. */
export function isReference(value: string): boolean {
  const v = value.trim();
  return REFERENCE.test(v) && !isSecretShaped(v.replace(/^\$\{?/, "").replace(/\}?[;,]?$/, ""));
}

/** Whether a whole value is kept (D75): empty, a prose word, a literal, a reference or a marker. */
export function keepsCredentialValue(value: string): boolean {
  const v = value.trim();
  return (
    v.length === 0 ||
    PROSE_VALUES.test(v) ||
    LITERALS.test(v) ||
    isReference(v) ||
    EXACT_MARKER.test(v) ||
    AUTH_TEMPLATE.test(v)
  );
}

const isLower = (c: string | undefined) => c !== undefined && c >= "a" && c <= "z";
const isUpper = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isAlnum = (c: string | undefined) => isLower(c) || isUpper(c) || isDigit(c);
const isIdent = (c: string | undefined) => isAlnum(c) || c === "_" || c === "-" || c === "." || c === "$";
const isBlank = (c: string | undefined) => c === " " || c === "\t";
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** A part boundary before index `i`: a non-letter, a lower→Upper camel step, or an acronym end (`DBPassword`). */
function leftBoundary(text: string, i: number): boolean {
  const prev = text[i - 1];
  const cur = text[i];
  if (!isAlnum(prev)) return true;
  if ((isLower(prev) || isDigit(prev)) && isUpper(cur)) return true;
  return isUpper(prev) && isUpper(cur) && isLower(text[i + 1]);
}

/** A part boundary at index `j` (after a word): a non-letter, or an Upper after a lower-case word end. */
function rightBoundary(text: string, j: number): boolean {
  const next = text[j];
  if (!isLower(next) && !isUpper(next)) return true;
  return isLower(text[j - 1]) && isUpper(next);
}

/** The lower-case last part of an identifier ending at `end` (split on `_ - . $` and camel steps). */
function lastPart(text: string, start: number, end: number): string {
  let i = end;
  while (i > start && (text[i - 1] === "_" || text[i - 1] === "-" || text[i - 1] === ".")) i--;
  const stop = i;
  while (i > start) {
    const c = text[i - 1];
    if (!isAlnum(c)) break;
    if (i < stop && isUpper(text[i]) && (isLower(c) || isDigit(c))) break;
    i--;
  }
  return text.slice(i, stop).toLowerCase();
}

/**
 * Whether the identifier after the credential word describes it: the last part of the name, or the last part
 * before a `.` (`tokenTtlMs`, `apiKey.prefix.length`), split on `_ - $` and camel steps. A describing part in the
 * middle (`DB_PASSWORD_ORG_ACME`, `password_at_home`) does not count (round 7).
 */
function describesAfter(text: string, from: number, end: number): boolean {
  if (end - from < 2 || end - from > 128) return false;
  return text
    .slice(from, end)
    .split(".")
    .some((seg) => {
      const parts = seg
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[\s_$-]+/)
        .filter(Boolean);
      const last = parts[parts.length - 1];
      return last !== undefined && DESCRIBES.has(last.toLowerCase());
    });
}

/** Whether the credential word at [i, j) is a credential word here (boundaries, `key` compounds), describes aside. */
function isWordAt(text: string, i: number, j: number, idStart: number): boolean {
  const word = text.slice(i, j).toLowerCase().replace(/[ _-]/g, "");
  const strong = STRONG.has(word.replace(/s$/, "")) || STRONG.has(word);
  if (!strong && !leftBoundary(text, i)) return false;
  if (!rightBoundary(text, j)) return false;
  if (word === "key" || word === "keys") {
    // `key` alone (`key: …`, `keyId`) is not a credential; `signing_key`, `X-Api-Key` and `API key` are.
    const before = text.slice(Math.max(0, i - 12), i);
    const qualifier = /([A-Za-z]+) $/.exec(before)?.[1]?.toLowerCase();
    const compound =
      i > idStart && (text[i - 1] === "_" || text[i - 1] === "-" || text[i - 1] === "." || isLower(text[i - 1]));
    // `key for prod: …`, `the key for the sendgrid account is …`, `sendgrid key …`: a `for` clause, or a
    // service name (not ordinary English and not a data-structure key such as `cache key`) right before it.
    const forClause = /^ for /i.test(text.slice(j, j + 5));
    const service =
      qualifier !== undefined &&
      text[j] !== "=" &&
      !before.slice(0, Math.max(0, before.length - qualifier.length - 1)).endsWith("<") &&
      qualifier.length >= 3 &&
      !isCommonWord(qualifier) &&
      !NOT_CREDENTIAL_KEYS.has(qualifier);
    if (!compound && !(qualifier && KEY_QUALIFIERS.has(qualifier)) && !forClause && !service) return false;
  }
  return true;
}

interface Value {
  start: number;
  end: number;
  replacement: string;
  /** The value as written, for the keep checks. */
  inner: string;
  /** An unquoted value to the end of the line: it may be a code expression (`await getToken(req)`). */
  unquoted?: boolean;
}

type Found =
  | { kind: "value"; value: Value; resumeAt: number }
  | { kind: "block"; from: number; end: number; text: string; count: number }
  | { kind: "skip"; resumeAt: number };

/**
 * Per-call scan state: the text, a memoised line-end lookup (every name on a line shares one look-up, so a line
 * with many names is scanned once) and whether the name being examined takes word lists. Created by each exported
 * rule for its own call; nothing is kept between calls.
 */
interface Scan {
  text: string;
  eol: (from: number) => number;
  /** The first index ≥ `from` of `needle` (-1 for none), memoised so repeated forward searches stay linear. */
  next: (needle: string, from: number) => number;
  wordList: boolean;
}

function scanOf(text: string): Scan {
  let memoFrom = -1;
  let memoNl = -1;
  const found = new Map<string, { from: number; at: number }>();
  return {
    text,
    wordList: false,
    next(needle: string, from: number) {
      const m = found.get(needle);
      // A remembered answer holds for any `from` between the last search start and the hit (or for every later
      // start when nothing was found).
      if (m && from >= m.from && (m.at === -1 || from <= m.at)) return m.at;
      const at = text.indexOf(needle, from);
      found.set(needle, { from, at });
      return at;
    },
    eol(from: number) {
      let nl: number;
      if (from >= memoFrom && from <= memoNl) nl = memoNl;
      else {
        const found = text.indexOf("\n", from);
        nl = found === -1 ? text.length : found;
        memoFrom = from;
        memoNl = nl;
      }
      return nl > from && text[nl - 1] === "\r" ? nl - 1 : nl;
    },
  };
}

/**
 * `‹secret›` plus the newlines `replaced` held, so a multi-line value keeps the line count; with `diff`, each
 * following line keeps its unified-diff marker (`+`, `-` or a space).
 */
function keepLines(replaced: string, diff = false): string {
  let out = S;
  for (let i = replaced.indexOf("\n"); i !== -1; i = replaced.indexOf("\n", i + 1)) {
    const c = replaced[i + 1];
    out += diff && (c === "+" || c === "-") ? `\n${c}` : "\n";
  }
  return out;
}

/** After a closing quote, only a delimiter (or a comment) may follow for the quote to end the value. */
function closesCleanly(text: string, at: number, eol: number): boolean {
  let k = at;
  while (k < eol && isBlank(text[k])) k++;
  if (k >= eol) return true;
  const c = text[k] ?? "";
  if (",;)}]>|".includes(c)) return true;
  if (c === "#" || (c === "/" && (text[k + 1] === "/" || text[k + 1] === ">"))) return true;
  // `key="a" user="b"` pairs, `"x" and token: "y"`: another assignment follows, so the quote did end the value.
  return /^(?:[A-Za-z_][\w.-]{0,63}[ \t]*[=:]|(?:and|or)[ \t])/.test(text.slice(k, Math.min(eol, k + 80)));
}

/** The end of the whitespace-delimited token at `s`, never inside a marker (a marker is taken whole). */
function tokenEnd(text: string, s: number, eol: number): number {
  let e = s;
  while (e < eol && !isSpace(text[e])) {
    if (text[e] === "‹" || text[e] === "…") {
      MARKER_AT.lastIndex = e;
      const m = MARKER_AT.exec(text);
      if (m) {
        e += m[0].length;
        continue;
      }
    }
    e++;
  }
  return e;
}

/**
 * The value starting at `from`: quoted to its closing quote, else to the end of the line. Null when empty.
 */
function readValue(sc: Scan, from: number): Value | null {
  const text = sc.text;
  const eol = sc.eol(from);
  if (from >= eol) return null;
  let k = from;
  while (text[k] === "\\" && k - from < 8) k++;
  const esc = k - from;
  const q = text[k];
  if (q === '"' || q === "'" || q === "`") {
    const triple = esc === 0 && text[k + 1] === q && text[k + 2] === q && q !== "`";
    const open = triple ? 3 : 1;
    const innerStart = k + open;
    let close = -1;
    if (triple) {
      // A triple-quoted value may span lines (TOML, Python), bounded to 50 lines and 4 KB; the search is memoised
      // per call, so many unclosed `"""` stay linear.
      const found = sc.next(q.repeat(3), innerStart);
      if (found !== -1 && found <= eol) close = found;
      else if (found !== -1 && found - innerStart <= 4096) {
        let lines = 0;
        for (
          let i = text.indexOf("\n", innerStart);
          i !== -1 && i < found && lines <= 50;
          i = text.indexOf("\n", i + 1)
        ) {
          lines++;
        }
        if (lines <= 50) {
          const inner = text.slice(innerStart, found);
          return { start: innerStart, end: found, replacement: keepLines(inner, true), inner };
        }
      }
    } else {
      // A closing quote preceded by a run of r backslashes closes the value when r % (2(esc+1)) == esc: plain
      // strings close on an even run, one level of escaped JSON on 1, 5, 9 …, two levels on 3, 11 …
      let run = 0;
      for (let p = innerStart; p < eol; p++) {
        const c = text[p];
        if (c === "\\") {
          run++;
          continue;
        }
        if (c === q && run >= esc && (run - esc) % (2 * (esc + 1)) === 0) {
          close = p - esc;
          break;
        }
        run = 0;
      }
    }
    if (close !== -1) {
      const after = close + esc + open;
      const inner = text.slice(innerStart, close);
      if (closesCleanly(text, after, eol)) return { start: innerStart, end: close, replacement: S, inner };
    }
    return { start: from, end: eol, replacement: S, inner: text.slice(from, eol) };
  }
  let end = eol;
  while (end > from && isBlank(text[end - 1])) end--;
  return { start: from, end, replacement: S, inner: text.slice(from, end), unquoted: true };
}

/**
 * Whether the name at `nameStart` is the first token of its line, the line's indentation, and a unified-diff
 * marker (`+` or `-`) in front of it (round 6: PR hunks), which is not counted as indentation.
 */
function lineHead(text: string, nameStart: number): { indent: number; first: boolean; marker: string } {
  let i = nameStart;
  while (i > 0 && /["'`[{\\]/.test(text[i - 1] ?? "")) i--;
  if (i >= 2 && text[i - 1] === " " && text[i - 2] === "-" && (i === 2 || text[i - 3] !== "\n" || isBlank(text[i]))) {
    i -= 2;
  }
  let indent = 0;
  while (i > 0 && isBlank(text[i - 1])) {
    i--;
    indent++;
  }
  const atStart = i === 0 || text[i - 1] === "\n";
  if (!atStart && (text[i - 1] === "+" || text[i - 1] === "-") && (i === 1 || text[i - 2] === "\n")) {
    return { indent, first: true, marker: text[i - 1] ?? "" };
  }
  return { indent, first: atStart, marker: "" };
}

/**
 * The more-indented lines after `from` (the end of the key's line), each replaced by `‹secret›`. `lead0` is the
 * key line's first character: when it is a unified-diff marker (`+`, `-`) or a context space, the block is read
 * as a hunk (round 7): each line may carry any one of `+`, `-` or a space first, which is kept and not counted as
 * indentation (`indent` is the key's indentation after its own marker).
 */
function indentedBlock(
  text: string,
  from: number,
  indent: number,
  lead0 = "",
): { end: number; text: string; count: number } {
  const hunk = lead0 === "+" || lead0 === "-" || lead0 === " ";
  const keyIndent = lead0 === " " ? indent - 1 : indent;
  let pos = from;
  let out = "";
  let count = 0;
  let consumed = from;
  while (pos < text.length && text[pos] === "\n") {
    const start = pos + 1;
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const c0 = text[start] ?? "";
    const mark = hunk && (c0 === "+" || c0 === "-" || c0 === " ") ? c0 : "";
    if (hunk && !mark && start < end) break;
    const line = text.slice(start + mark.length, end);
    const body = line.replace(/^[ \t]+/, "");
    if (body.replace(/\r$/, "").length === 0) {
      out += `\n${mark}${line}`;
      consumed = end;
      pos = end;
      continue;
    }
    const lead = line.length - body.length;
    if (lead <= keyIndent) break;
    const prefix = line.slice(0, lead) + (body.startsWith("- ") ? "- " : "");
    const rest = line.slice(prefix.length).replace(/\r$/, "");
    const cr = line.endsWith("\r") ? "\r" : "";
    if (EXACT_MARKER.test(rest.trim()) || rest.trim().length === 0) {
      out += `\n${mark}${line}`;
    } else {
      out += `\n${mark}${prefix}${S}${cr}`;
      count++;
    }
    consumed = end;
    pos = end;
  }
  // Trailing blank lines stay outside the block. A backward scan, not a `(?:\n[ \t\r]*)+$` regex: that one
  // retries from every newline of a long blank run and is quadratic.
  let k = out.length;
  while (k > 0 && isSpace(out[k - 1])) k--;
  const nl = out.indexOf("\n", k);
  const trimmedLength = nl === -1 ? out.length : nl;
  const trailing = out.length - trimmedLength;
  return { end: consumed - trailing, text: out.slice(0, trimmedLength), count };
}

function markerSpans(text: string): Array<[number, number]> {
  if (!text.includes("‹")) return [];
  const re = new RegExp(MARKER_PATTERN, "g");
  const out: Array<[number, number]> = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** At most `max` whitespace-delimited words from `from` to `eol`. */
function wordsFrom(
  text: string,
  from: number,
  eol: number,
  max: number,
): { raw: string; start: number; end: number }[] {
  const out: { raw: string; start: number; end: number }[] = [];
  let p = from;
  while (p < eol && out.length < max) {
    while (p < eol && isBlank(text[p])) p++;
    if (p >= eol) break;
    const e = tokenEnd(text, p, eol);
    out.push({ raw: text.slice(p, e), start: p, end: e });
    p = e;
  }
  return out;
}

const COPULA = new Set(["is", "was", "are", "were", "be"]);
const CLAUSE_BREAK = new Set(["and", "or", "but", "while", "so", "then", "if", "when", "because", "unless", "whereas"]);
const PROSE_WORDS = 12;

/**
 * A value after a prose separator at `at`: fillers skipped (`is now`, `was changed to`); a quoted value is
 * taken; an unquoted one goes to the end of the line unless `proseVerdict` says it reads as English.
 */
function proseValue(sc: Scan, at: number, eol: number): Found | null {
  const text = sc.text;
  let p = at;
  while (p < eol && (isBlank(text[p]) || text[p] === ":")) p++;
  if (p >= eol) return null;
  for (let n = 0; n < 3; n++) {
    const w = wordsFrom(text, p, eol, 1)[0];
    if (!w || !FILLERS.has(w.raw.toLowerCase()) || w.end >= eol) break;
    p = w.end;
    while (p < eol && isBlank(text[p])) p++;
  }
  const c = text[p];
  if (c === '"' || c === "'" || c === "`" || (c === "\\" && text[p + 1] === '"')) {
    const v = readValue(sc, p);
    if (v === null) return null;
    // A backticked identifier that is a credential name names a column or a variable (`is \`password_hash\``);
    // quoted strings stay values (`is "admin_password"` goes).
    if (
      c === "`" &&
      /^[A-Za-z][\w.-]{1,63}$/.test(v.inner) &&
      /[_.-]|[a-z][A-Z]/.test(v.inner) &&
      isCredentialName(v.inner) &&
      !isSecretShaped(v.inner)
    ) {
      return { kind: "skip", resumeAt: v.end };
    }
    return { kind: "value", value: v, resumeAt: p };
  }
  const words = wordsFrom(text, p, eol, PROSE_WORDS).map((w) => w.raw);
  // A value that is itself a credential name names a header or a variable (`is X-Api-Key for …`).
  const firstBare = bareWord(words[0] ?? "");
  if (
    !sc.wordList &&
    words.length > 1 &&
    firstBare.length > 0 &&
    /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(firstBare) &&
    isCredentialName(firstBare) &&
    !isSecretShaped(firstBare)
  ) {
    return { kind: "skip", resumeAt: p };
  }
  // A word-list name keeps only a whole prose word or literal (`mnemonic: none`).
  // A kept whole value is short (a prose word, a literal, a reference): longer rests are not sliced at all, so a
  // line with many names costs one look at its next words per name, not one look at the rest of the line.
  const whole = eol - p <= 200 ? text.slice(p, eol) : "\u0000";
  if (
    keepsCredentialValue(whole) ||
    isCodeExpression(whole) ||
    keepsCredentialValue(whole.replace(/[.;,]$/, "")) ||
    proseVerdict(words, sc.wordList) === "keep"
  ) {
    return { kind: "skip", resumeAt: p };
  }
  let end = eol;
  while (end > p && isBlank(text[end - 1])) end--;
  return { kind: "value", value: { start: p, end, replacement: S, inner: text.slice(p, end) }, resumeAt: p };
}

/** One token after a prose separator (a comma, a backtick, a table cell): taken unless it reads as English. */
function tokenValue(sc: Scan, at: number, eol: number, minLength = 1): Found | null {
  const text = sc.text;
  let p = at;
  while (p < eol && isBlank(text[p])) p++;
  if (p >= eol) return null;
  const e = tokenEnd(text, p, eol);
  const raw = text.slice(p, e);
  if (raw.includes("‹")) {
    const piece = secretPieces(raw)[0];
    if (!piece) return { kind: "skip", resumeAt: e };
    const [a, b] = piece;
    return { kind: "value", value: { start: p + a, end: p + b, replacement: S, inner: raw.slice(a, b) }, resumeAt: e };
  }
  const bare = bareWord(raw);
  if (bare.length < minLength || EXACT_MARKER.test(bare) || keepsCredentialValue(bare))
    return { kind: "skip", resumeAt: e };
  if (isCommonWord(bare) || isAlgorithmName(bare) || isCredentialName(bare)) return { kind: "skip", resumeAt: e };
  const a = p + raw.indexOf(bare);
  return { kind: "value", value: { start: a, end: a + bare.length, replacement: S, inner: bare }, resumeAt: e };
}

/** Variable names a comparison may hold that are not a credential's value. */
const COMPARE_KEEP = new Set(
  "other expected actual stored input value given provided candidate current previous saved hash digest result res req token password secret key x y a b s t v null undefined none nil true false nullptr empty".split(
    " ",
  ),
);

/**
 * A comparison operand: literals, member or call expressions, camelCase and snake_case variables and a few
 * common variable names stay (`token == other`, `password === null`, `token != storedToken`); a quoted operand
 * (`"…"`, `b'…'`, `r"…"`, `@"…"`), a number, or any other bare word (`hunter2`, `swordfishes`) goes.
 */
function compareValue(sc: Scan, at: number, eol: number): Found | null {
  const text = sc.text;
  let p = at;
  while (p < eol && isBlank(text[p])) p++;
  if (p >= eol) return null;
  let q = p;
  if (/[bruf@L]/i.test(text[q] ?? "") && /["'`]/.test(text[q + 1] ?? "")) q++;
  const c = text[q];
  if (c === '"' || c === "'" || c === "`" || (c === "\\" && /["']/.test(text[q + 1] ?? ""))) {
    const v = readValue(sc, q);
    if (v === null || keepsCredentialValue(v.inner)) return { kind: "skip", resumeAt: q };
    return { kind: "value", value: v, resumeAt: q };
  }
  const e = tokenEnd(text, p, eol);
  const tok = text.slice(p, e);
  const raw = tok.replace(/[);,{}\]:]+$/, "");
  if (raw.length === 0 || EXACT_MARKER.test(raw)) return { kind: "skip", resumeAt: e };
  if (raw.includes("‹")) {
    const piece = secretPieces(raw)[0];
    if (!piece) return { kind: "skip", resumeAt: e };
    return {
      kind: "value",
      value: { start: p + piece[0], end: p + piece[1], replacement: S, inner: raw.slice(piece[0], piece[1]) },
      resumeAt: e,
    };
  }
  const kept =
    COMPARE_KEEP.has(raw.toLowerCase()) ||
    /[.([]/.test(raw) ||
    /^[a-z_$][a-z0-9$]*(?:[A-Z][a-z0-9]+)+$/.test(raw) ||
    /^[a-z$]+(?:_[a-z0-9]+)+$/.test(raw) ||
    /^[A-Z][A-Z0-9_]*$/.test(raw);
  if (kept) return { kind: "skip", resumeAt: e };
  return { kind: "value", value: { start: p, end: p + raw.length, replacement: S, inner: raw }, resumeAt: e };
}

/** A code value: YAML blocks for empty values and openers, else `readValue`. */
function codeValue(sc: Scan, idStart: number, valueAt: number, eol: number): Found | null {
  const text = sc.text;
  let v = valueAt;
  while (v < eol && isBlank(text[v])) v++;
  const rest = text.slice(v, eol).trim();
  if (rest === "" || /^[|>][+-]?\d?$/.test(rest) || rest === "{" || rest === "[") {
    const head = lineHead(text, idStart);
    if (head.first && eol < text.length) {
      const c0 = text[text.lastIndexOf("\n", idStart - 1) + 1];
      const blk = indentedBlock(text, eol, head.indent, head.marker || (c0 === " " ? " " : ""));
      if (blk.count > 0) return { kind: "block", from: eol, end: blk.end, text: blk.text, count: blk.count };
    }
    if (rest === "") return null;
  }
  const value = readValue(sc, v);
  return value === null ? null : { kind: "value", value, resumeAt: valueAt };
}

/** What follows a credential name (see the file comment). */
function findValue(sc: Scan, idStart: number, idEnd: number): Found | null {
  const text = sc.text;
  const eol = sc.eol(idEnd);
  let k = idEnd;
  let question = false;
  // Closing quotes, escapes, subscripts, emphasis, `?`/`!` (`password?:`, `password!!`).
  for (let n = 0; n < 12 && k < eol && /["'`*\]\\?!]/.test(text[k] ?? ""); n++) {
    if (text[k] === "?") question = true;
    // `'s` is a possessive, not a closing quote.
    if ((text[k] === "'" || text[k] === "’") && text[k + 1] === "s" && !isAlnum(text[k + 2])) break;
    k++;
  }
  if ((text[k] === "'" || text[k] === "’") && text[k + 1] === "s" && !isAlnum(text[k + 2])) {
    return proseValue(sc, k + 2, eol);
  }
  let s = k;
  while (s < eol && isBlank(text[s])) s++;
  const spaced = s > k;
  const c = text[s];
  const c2 = text[s + 1];
  if (!spaced && c !== undefined && "はがをもの：".includes(c)) return proseValue(sc, s + 1, eol);
  if (c === ":" && c2 === "=") return codeValue(sc, idStart, s + 2, eol);
  if ((c === "?" || c === "+") && c2 === "=") return codeValue(sc, idStart, s + 2, eol);
  if (c === "=" && c2 === ">") return codeValue(sc, idStart, s + 2, eol);
  if (c === "!" && c2 === "=") return compareValue(sc, s + (text[s + 2] === "=" ? 3 : 2), eol);
  if (c === "=") {
    if (c2 === "=") return compareValue(sc, s + (text[s + 2] === "=" ? 3 : 2), eol);
    // `a secret = something that grants access`: spaced on both sides, an English value stays.
    if (spaced && isBlank(c2)) {
      const v = proseValueOrCode(sc, idStart, s + 1, eol);
      if (v) return v;
    }
    return codeValue(sc, idStart, s + 1, eol);
  }
  if (c === ":" && c2 !== ":") {
    let v = s + 1;
    while (v < eol && isBlank(text[v])) v++;
    const q = text[v];
    const rest = text.slice(v, eol).trim();
    if (q === '"' || q === "'" || q === "`" || q === "\\" || rest === "" || /^[|>{[]/.test(rest)) {
      return codeValue(sc, idStart, s + 1, eol);
    }
    return proseValue(sc, s + 1, eol);
  }
  if (c === "(") {
    let p = s + 1;
    while (isBlank(text[p])) p++;
    let b = p;
    while (text[b] === "\\") b++;
    if (text[b] === '"' || text[b] === "'" || text[b] === "`") {
      const value = readValue(sc, p);
      if (value === null) return null;
      // `verifyPassword("wrong", hash)`: one ordinary lower-case word is test data, not a credential.
      if (/^[a-z]+$/.test(value.inner) && isCommonWord(value.inner)) return { kind: "skip", resumeAt: value.end };
      return { kind: "value", value, resumeAt: s + 1 };
    }
    if (!spaced) return null;
  }
  if (c === "," && !spaced) return tokenValue(sc, s + 1, eol);
  if (c === "→" || (c === "-" && c2 === ">") || (c === "-" && isBlank(c2) && spaced)) {
    return proseValue(sc, s + (c === "-" && c2 === ">" ? 2 : 1), eol);
  }
  if (!spaced || s >= eol) return null;
  if (question) return proseValue(sc, s, eol);
  if (c === '"' || c === "'") {
    const value = readValue(sc, s);
    return value === null ? null : { kind: "value", value, resumeAt: s };
  }
  if (c === "`") return tokenValue(sc, s, eol, 8);
  if (c === "{") {
    // HCL: `variable "db_password" { default = "…" }`, or the block on the lines below.
    const rest = text.slice(s + 1, eol);
    const d = /(?:^|[\s;,])(?:default|value|sensitive_value)[ \t]*=[ \t]*/.exec(rest);
    if (d) {
      const value = readValue(sc, s + 1 + d.index + d[0].length);
      if (value === null) return null;
      if (value.end > eol || text[value.end - 1] === "}") value.end = Math.min(value.end, eol);
      return { kind: "value", value, resumeAt: s + 1 };
    }
    if (rest.trim() === "" && eol < text.length) {
      let ls = idStart;
      let n = 0;
      while (ls > 0 && text[ls - 1] !== "\n" && n++ < 200) ls--;
      const lead0 = text[ls] === "+" || text[ls] === "-" || text[ls] === " " ? (text[ls] ?? "") : "";
      if (lead0 !== " ") ls += lead0.length;
      let indent = 0;
      while (isBlank(text[ls + indent])) indent++;
      const blk = indentedBlock(text, eol, indent, lead0);
      if (blk.count > 0) return { kind: "block", from: eol, end: blk.end, text: blk.text, count: blk.count };
    }
    return null;
  }
  if (c === "|") {
    // A Markdown table row: `| DB_PASSWORD | <value> |`.
    const close = text.indexOf("|", s + 1);
    const cellEnd = close === -1 || close > eol ? eol : close;
    const cell = text.slice(s + 1, cellEnd).trim();
    const single = cell.length >= 8 && !/\s/.test(cell) && !isCommonWord(cell);
    if (cell.length === 0 || /^[-:]+$/.test(cell) || EXACT_MARKER.test(cell) || keepsCredentialValue(cell)) return null;
    if (!isSecretShaped(cell) && !single && !cell.split(/\s+/).some(isSecretShaped)) return null;
    const a = text.indexOf(cell, s + 1);
    return { kind: "value", value: { start: a, end: a + cell.length, replacement: S, inner: cell }, resumeAt: cellEnd };
  }
  const typed = /^[A-Za-z_][\w.<>[\]*|?]{0,63}[ \t]*(?::=|=(?![=>]))/.exec(text.slice(s, s + 80));
  if (typed) return codeValue(sc, idStart, s + typed[0].length, eol);
  return flagOrClause(sc, idStart, idEnd, s, eol);
}

/** ` = ` between spaces: English stays (`a secret = something that grants access`), anything else is code. */
function proseValueOrCode(sc: Scan, _idStart: number, at: number, eol: number): Found | null {
  const text = sc.text;
  let p = at;
  while (p < eol && isBlank(text[p])) p++;
  const c = text[p];
  if (p >= eol || c === '"' || c === "'" || c === "`" || c === "\\") return null;
  const words = wordsFrom(text, p, eol, PROSE_WORDS).map((w) => w.raw);
  if (words.length >= 2 && proseVerdict(words) === "keep" && isCommonWord(words[0] ?? ""))
    return { kind: "skip", resumeAt: p };
  return null;
}

/**
 * No separator right after the name: a CLI flag takes its next word (never `--no-auth` or `--token-file`), a
 * line starting with `password` takes its next word (`.netrc`, unless that word is ordinary English or a
 * label), and otherwise up to six clause words may come before a copula, a `Label:` or an arrow (`the
 * password for prod is …`, `token for the bot: …`), or `to` follows the name (`set the password to …`).
 */
function flagOrClause(sc: Scan, idStart: number, idEnd: number, s: number, eol: number): Found | null {
  const text = sc.text;
  const id = text.slice(idStart, idEnd);
  const flag = /^--?[A-Za-z]/.test(id) && (idStart === 0 || /\s/.test(text[idStart - 1] ?? ""));
  const words = wordsFrom(text, s, eol, 7);
  const first = words[0];
  if (!first) return null;
  // `Credential rotation runbook: …`, `token lifetime is 3600 seconds`: the clause names a property of the credential.
  const firstWord = bareWord(first.raw).toLowerCase();
  if (!flag && (DESCRIBES.has(firstWord) || firstWord === "hash" || firstWord === "hashes" || firstWord === "digest")) {
    return null;
  }
  const firstIsLabel = first.raw.endsWith(":") || first.raw === "->" || first.raw === "→";
  // `.netrc` keywords are lower case and the line holds just the keyword and its value.
  const netrc =
    /^(?:password|passwd|requirepass|masterauth)$/.test(id) &&
    words.length === 1 &&
    lineHead(text, idStart).first &&
    !firstIsLabel &&
    !isCommonWord(first.raw) &&
    !COPULA.has(first.raw.toLowerCase());
  if (flag || netrc) {
    if (flag && /^--?no-/i.test(id)) return null;
    if (text[s] === "-") return null;
    if (text[s] === '"' || text[s] === "'") {
      const value = readValue(sc, s);
      return value === null ? null : { kind: "value", value, resumeAt: s };
    }
    const e = tokenEnd(text, s, eol);
    const inner = text.slice(s, e);
    if (EXACT_MARKER.test(inner) || keepsCredentialValue(inner)) return { kind: "skip", resumeAt: e };
    return { kind: "value", value: { start: s, end: e, replacement: S, inner }, resumeAt: e };
  }
  for (let n = 0; n < Math.min(words.length, 7); n++) {
    const w = words[n];
    if (!w) break;
    const lower = w.raw.toLowerCase();
    if (COPULA.has(lower) || lower === "is:" || lower === "was:") return proseValue(sc, w.end, eol);
    if (w.raw === "->" || w.raw === "→" || w.raw === "-" || w.raw === "=" || w.raw === ":") {
      return proseValue(sc, w.end, eol);
    }
    if (w.raw.length > 1 && w.raw.endsWith(":") && !w.raw.endsWith("::")) return proseValue(sc, w.end, eol);
    if (/[.!?;]$/.test(w.raw)) break;
    // A conjunction starts another clause: `token_url: … and keyId: 4` is not `token … : 4`.
    if (CLAUSE_BREAK.has(lower)) break;
  }
  if (first.raw.toLowerCase() === "to" && words[1]) {
    // `renamed apiKey to foo`, `rename the accessToken field to bar`: a rename names code, not a value (L10b-4, D1204),
    // but only a code name (`apiKey`, not a bare `password`) in the same clause (`renamed the repo. password to …`
    // and `renamed the user and changed its password to …` keep their value; #92 review).
    if (renameOf(text, idStart, id) && renameTarget(words[1]?.raw ?? "", id)) return null;
    return proseValue(sc, first.end, eol);
  }
  if (first.raw.startsWith("(")) {
    // The next `)` is memoised per call (and must be on this line): many `pw (` openers stay linear.
    const close = sc.next(")", first.start);
    if (close !== -1 && close < eol) {
      const inner = text.slice(first.start + 1, close);
      // A stack frame's location (`at verifyIdToken2 (src/auth.ts:10:5)`) is not a value (L10b-4).
      if (/^[\w./@-]+:\d+(?::\d+)?$/.test(inner) && SOURCE_FILE.test(inner.replace(/(?::\d+)+$/, ""))) return null;
      const verdict = proseVerdict(inner.split(/\s+/).filter(Boolean));
      if (verdict === "redact") {
        return { kind: "value", value: { start: first.start + 1, end: close, replacement: S, inner }, resumeAt: close };
      }
    }
  }
  return null;
}

/**
 * Name-keyed credentials (see the file comment). One linear scan over the text with lookalike letters folded;
 * every credential word is checked once, never inside a marker.
 */
export function credentialAssignment(input: string): RuleResult {
  if (input.length === 0) return { text: input, count: 0 };
  const text = foldConfusables(input);
  const sc = scanOf(text);
  const spans = markerSpans(text);
  let spanAt = 0;
  let out = "";
  let last = 0;
  let count = 0;
  let cachedEnd = -1;
  let cachedLast = "";
  const re = new RegExp(WORD.source, "gi");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const i = m.index;
    let j = i + m[0].length;
    if (/s/i.test(text[j] ?? "") && !isAlnum(text[j + 1])) j++;
    while (spanAt < spans.length && (spans[spanAt]?.[1] ?? 0) <= i) spanAt++;
    const span = spans[spanAt];
    if (span && span[0] <= i && i < span[1]) {
      re.lastIndex = span[1];
      continue;
    }
    if (i < last) continue;
    let idStart = i;
    while (idStart > 0 && i - idStart < 64 && isIdent(text[idStart - 1])) idStart--;
    if (i >= cachedEnd) {
      let e = j;
      while (e < text.length && isIdent(text[e]) && text[e] !== ".") e++;
      while (text[e] === "." && isAlnum(text[e + 1])) {
        e++;
        while (e < text.length && isIdent(text[e]) && text[e] !== ".") e++;
      }
      cachedEnd = e;
      cachedLast = lastPart(text, Math.max(j - 64, idStart), e);
    }
    const idEnd = Math.max(cachedEnd, j);
    if (!isWordAt(text, i, j, idStart)) continue;
    // A source file and its line (`src/auth.ts:10:5`, `token.py:42`): a location, not a name with a value (L10b-4).
    if (SOURCE_FILE.test(text.slice(idStart, idEnd)) && /^:\d/.test(text.slice(idEnd, idEnd + 2))) {
      re.lastIndex = Math.max(re.lastIndex, idEnd);
      continue;
    }
    // A name that describes a credential (`token_url`, `tokenTtlMs`, `apiKey.prefix`): a describing part anywhere
    // after the credential word; every word of this identifier shares the verdict.
    if (DESCRIBES.has(cachedLast) || describesAfter(text, j, idEnd)) {
      re.lastIndex = Math.max(re.lastIndex, idEnd);
      continue;
    }
    re.lastIndex = Math.max(re.lastIndex, idEnd);
    sc.wordList = /mnemonic|seed|passphrase|recovery/i.test(text.slice(idStart, idEnd));
    const found = findValue(sc, idStart, idEnd);
    if (found === null) continue;
    if (found.kind === "skip") {
      re.lastIndex = Math.max(re.lastIndex, found.resumeAt);
      continue;
    }
    if (found.kind === "block") {
      out += input.slice(last, found.from) + found.text;
      last = found.end;
      count += found.count;
      re.lastIndex = Math.max(re.lastIndex, last);
      continue;
    }
    const v = found.value;
    const cookieName =
      /cookie/i.test(text.slice(i, j)) && COOKIE_NAME.test(v.inner) && !isSecretShaped(v.inner) && !/\d/.test(v.inner);
    const onlyMarker = v.inner.includes("\n") && EXACT_MARKER.test(v.inner.replace(/\n[+-]?/g, "").trim());
    if (keepsCredentialValue(v.inner) || (v.unquoted && isCodeExpression(v.inner)) || cookieName || onlyMarker) {
      re.lastIndex = Math.max(re.lastIndex, found.resumeAt);
      continue;
    }
    out += input.slice(last, v.start) + v.replacement;
    last = v.end;
    count++;
    re.lastIndex = Math.max(re.lastIndex, v.end);
    while (spanAt < spans.length && (spans[spanAt]?.[1] ?? 0) <= last) spanAt++;
  }
  return count === 0 ? { text: input, count: 0 } : { text: out + input.slice(last), count };
}

/**
 * Whether the credential name `id` at `idStart` is the thing renamed: a camel or snake code name (not a bare credential
 * word), after `rename(d|s|ing)` in the same clause (no `;`, `.`, `,`, `:` or clause break between; 80 characters).
 */
function renameOf(text: string, idStart: number, id: string): boolean {
  // A code name: camel, snake, kebab or CONSTANT case, or a capitalised type name (`Credential`); not `password`.
  if (!/[a-z][A-Z]|[A-Za-z0-9][_-][A-Za-z]|^[A-Z]+[a-z]+s?$|^[A-Z]{2,}$/.test(id)) return false;
  const ls = text.lastIndexOf("\n", Math.max(0, idStart - 1)) + 1;
  const before = text.slice(Math.max(ls, idStart - 80), idStart);
  const m = /\brenam(?:e|ed|es|ing)\b([^;.,:]*)$/i.exec(before);
  if (!m) return false;
  return !(m[1] ?? "").split(/\s+/).some((w) => CLAUSE_BREAK.has(w.toLowerCase()));
}

/**
 * The new name after `to` in a rename: itself a code name, never a quoted value or a plain word (`renamed Password to
 * sunshine`, `renamed apiKey to 'sunshine'` keep their value out; #92 review round 2): a camel or Pascal code name
 * (`codeName`: `sessionCache`, `apiTokenStore`, `ApiCredential`), CONSTANT_CASE (`DB_PASS`), or snake_case holding a word
 * of code's vocabulary (`token_store`).
 */
function renameTarget(raw: string, from = ""): boolean {
  if (/^[("'`“‘]/.test(raw)) return false;
  const t = raw.replace(/[.,;:!?)"'`”’]+$/, "");
  if (t.length === 0 || t.length > 128) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t)) return true;
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t))
    return t.split("_").some((w) => CODE_WORDS.has(w)) && !/[0-9]$/.test(t);
  if (!/[a-z][A-Z]/.test(t)) return false;
  // Pascal case reads as camel case for `codeName` (`ApiCredential` → `apiCredential`).
  const camel = t.charAt(0).toLowerCase() + t.slice(1);
  if (codeName(camel, true)) return true;
  // The old name with a word added (`renamed Credential to ApiCredential`).
  if (from.length >= 3 && t.length > from.length && t.toLowerCase().includes(from.toLowerCase())) return true;
  // A short camel name with a word of code's vocabulary and no credential word (`newName`, `sessionCache`).
  const parts = camel.match(/[A-Z]?[a-z]+/g) ?? [];
  return (
    /^[a-z]+(?:[A-Z][a-z]+)+$/.test(camel) && !CRED_WORD.test(t) && parts.some((w) => CODE_WORDS.has(w.toLowerCase()))
  );
}

/** A source file name (`auth.ts`, `token_store.py`): after it, `:<digits>` is a line number. */
const SOURCE_FILE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|ex|exs|json|ya?ml|toml|sh|sql|vue|svelte)$/;

const CODE_LINE = /^[+\- ]?[ \t]*(?:import|export|const|let|var|function|class|await|def|async|func|fn)\b/;

/** A stack frame (`    at verifyIdToken2 (src/auth.ts:10:5)`): names there may end in digits. */
const STACK_FRAME = /^[ \t]*at[ \t]+\S/;

/** A word a digit run belongs to (`sha256`, `oauth2`, `s3`, `auth0`, `base64`, `i18n`, `utf8`, `http2`, `ipv4`, `ec2`); an acronym too (`JWT2`). */
const DIGIT_WORD = /^(?:sha|md|base|oauth|auth|s|k|i|e|utf|http|ipv|ec|b|r|h|v|x|tls|ssl|web|crc)$/i;

const CRED_WORD = new RegExp(WORD.source, "i");
const BARE_CRED_WORD = new RegExp(`^(?:${WORD.source})s?$`, "i");

/** Whether every whitespace-delimited word of `line` that holds a credential word is a code name (`codeName`). */
function onlyCodeNames(line: string, frame: boolean): boolean {
  const toks = line.split(/\s+/).filter((t) => t.length > 0);
  const coreOf = (tok: string) => tok.replace(/^[("'`“«‘[{<*:,;|=]+/, "").replace(/[.,;:!?"'`”»’)\]}>*|=]+$/, "");
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k] ?? "";
    if (!CRED_WORD.test(tok)) continue;
    const core = coreOf(tok);
    // A plain word that only holds a credential word (`passed`, `keyboard`) is not one; `token`, `Passwords` are.
    if (/^[A-Za-z]+$/.test(core) && !/[a-z][A-Z]/.test(core) && !BARE_CRED_WORD.test(core)) continue;
    // A camel or snake name that is not secret-shaped (`apiKey`, `auth_token`) names code too, unless a value follows
    // it right away (`the authToken <value>`, `apiKey <value>`: the name labels it; #92 review).
    if (/[a-z][A-Z]|[a-z]_[a-z]/.test(core) && !isSecretShaped(core)) {
      // The next word that is not punctuation alone (`apiKey — <value>`, `apiKey | <value>`; #92 review round 2).
      let n = k + 1;
      while (n < toks.length && /^[^A-Za-z0-9]+$/.test(toks[n] ?? "")) n++;
      const next = coreOf(toks[n] ?? "");
      if (next.length >= 8 && !isCommonWord(next) && !/^[a-z]+$/.test(next)) return false;
      // `use <value> as the apiKey`: the name labels the value before it.
      const prev = (toks[k - 1] ?? "").toLowerCase();
      if (prev === "as" || (prev === "the" && (toks[k - 2] ?? "").toLowerCase() === "as")) return false;
      continue;
    }
    if (!codeName(core, frame)) return false;
  }
  return true;
}

/** Words of code's vocabulary: verbs and nouns names are built from (a closed list; L10b-4). */
const CODE_WORDS = new Set(
  (
    "get set use is has can should on off handle handler validate validator verify verifier refresh parse parser " +
    "decode decoder encode encoder create update delete remove load loader fetch fetcher save store read write build " +
    "builder make init check ensure resolve resolver to from with for by of in id ids url uri config options opts " +
    "client service provider manager factory helper util utils cache session request response callback hook test spec " +
    "mock custom default current next prev new old max min count size len type types value values map list item items " +
    "data info meta state status error errors result results event events listener rotation rotate expiry expire " +
    "expires ttl access scope scopes header headers cookie cookies issuer audience claims payload format sign signed " +
    "signer signature generate generator hash hasher enforce limit limits ip allow deny retry rate compare match matcher api http job queue worker task run runner " +
    "start stop open close send receive emit string json translation keys exchange revoke issue mint fn func cb ref " +
    "on is invalid valid missing expired required optional raw safe id idp oidc pkce jwt sso saml login logout"
  ).split(" "),
);

/** A single name made of words (`oauth2Callback`, `AccessKeyRotation`, `refresh_token`). */
function wordName(x: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(x) && madeOfWords(x);
}

/**
 * A code name that holds the credential word, not a value (L10b-4, D1203): a path or dotted name made of words
 * (`src/auth/oauth2Callback.test.ts`, `auth.ts:10:5`), lower-case snake_case words (`refresh_token_store`), or camel
 * case starting lower case with three or more words, a digit run counting only after a word it belongs to (`sha256`,
 * `oauth2`, `s3`), and no trailing digits outside a stack frame (`validateOAuth2Callback`, `sha256Signature`,
 * `useAuth0Session`; `mySecretPass1`, `hunter2Password`, `SuperSecret1` and `Password123` are not names).
 */
export function codeName(raw: string, frame: boolean): boolean {
  if (raw.length > 128) return false;
  if (/[/.:]/.test(raw)) {
    // A path or dotted name: every segment a name made of words, a short extension (`ts`, `json`) or a number.
    if (!/^[A-Za-z0-9_./:-]+$/.test(raw)) return false;
    const segments = raw.split(/[/.:]+/).filter((x) => x.length > 0);
    return (
      segments.some((x) => x.length >= 3) &&
      segments.every(
        (x) =>
          /^(?:[a-z]{1,4}|[0-9]{1,6}(?:[-–,][0-9]{1,6})*)$/.test(x) ||
          codeName(x, frame) ||
          // A segment holding a credential word must be a code name (`newPassWordToday.ts` is not; #92 review).
          (wordName(x) && !CRED_WORD.test(x)),
      )
    );
  }
  // A technology prefix (`s3`, `k8s`, `i18n`, `e2e`) before the words reads as a word: `s3AccessKeyRotation`.
  const piece = raw.replace(/^[a-z][0-9]{1,2}[a-z]?(?=[A-Z])/, "aws");
  // snake_case: lower-case words, or camel-case names after them (`task_test_validateOAuth2Callback`).
  if (piece.includes("_")) {
    const segs = piece.split("_");
    // A trailing digit run outside a stack frame reads as a password's (`super_secret_pass1`).
    if (!frame && /[0-9]$/.test(piece)) return false;
    return (
      /^[a-z]/.test(piece) &&
      segs.every((x) => /^[a-z][a-z0-9]*$/.test(x) || (/^[a-z][A-Za-z0-9]*$/.test(x) && codeName(x, frame)))
    );
  }
  if (!madeOfWords(piece)) return false;
  if (!/^[a-z][A-Za-z0-9]*$/.test(piece) || (!frame && /[0-9]$/.test(piece))) return false;
  const parts = piece.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [];
  let words = 0;
  // Evidence of code: a word of code's vocabulary (`get`, `validate`, `Id`, `Callback`) or an acronym, after the first
  // part, or anywhere with at most one other word that is neither code's nor a credential's (`useAuth0Session`). A
  // passphrase of nouns (`secretShadowMonkeyDragon`, `newSecretHorseFish`, `oauth2SecretOk`) has neither (#92 review).
  let code = false;
  let codeLater = false;
  let other = 0;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k] ?? "";
    if (/^[0-9]/.test(part)) {
      // Inside the name, digits belong to a word (`oauth2`, `sha256`, `s3`); `monkey12HelloSecret` is not a name.
      if (DIGIT_WORD.test(parts[k - 1] ?? "") || /^[A-Z]{2,}$/.test(parts[k - 1] ?? "")) words++;
      else if (k + 1 < parts.length) return false;
    } else if (part.length >= 2) {
      words++;
      if (CODE_WORDS.has(part.toLowerCase()) || /^[A-Z]{2,}$/.test(part)) {
        code = true;
        if (k > 0) codeLater = true;
      } else if (!BARE_CRED_WORD.test(part) && !(k === 0 && raw !== piece)) other++;
    }
  }
  return words >= 3 && code && (codeLater || other <= 1);
}

/**
 * The line sweep: on a line holding a credential word (describing names such as `token_url` included), every
 * secret-shaped word goes, wherever it stands (`use Zq81kd0Lw as the password`, `password_file:
 * /run/secrets/Zq81kd0Lw`). One pass; each line is swept once.
 */
export function credentialLineSweep(input: string): RuleResult {
  if (input.length === 0) return { text: input, count: 0 };
  const text = foldConfusables(input);
  const sc = scanOf(text);
  const spans = markerSpans(text);
  let spanAt = 0;
  let out = "";
  let last = 0;
  let count = 0;
  const re = new RegExp(WORD.source, "gi");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const i = m.index;
    let j = i + m[0].length;
    if (/s/i.test(text[j] ?? "") && !isAlnum(text[j + 1])) j++;
    while (spanAt < spans.length && (spans[spanAt]?.[1] ?? 0) <= i) spanAt++;
    const span = spans[spanAt];
    if (span && span[0] <= i && i < span[1]) {
      re.lastIndex = span[1];
      continue;
    }
    let idStart = i;
    while (idStart > 0 && i - idStart < 64 && isIdent(text[idStart - 1])) idStart--;
    if (!isWordAt(text, i, j, idStart)) continue;
    const ls = text.lastIndexOf("\n", i) + 1;
    const le = sc.eol(i);
    re.lastIndex = Math.max(re.lastIndex, le);
    if (ls < last) continue;
    // A line of code (an import, a declaration, a statement ending in `;`, `{` or `}`): every word stands where code
    // does, so clean camel case is a name there (`import { verifyIdToken } from …`).
    const codeLine =
      CODE_LINE.test(text.slice(ls, Math.min(le, ls + 200))) || /[;{}]\s*$/.test(text.slice(Math.max(ls, le - 4), le));
    // A stack frame or a rename (`renamed parseJWT2Token to decodeAccessToken3`): names there may end in digits.
    const frame =
      STACK_FRAME.test(text.slice(ls, Math.min(le, ls + 40))) || /\brenam(?:e|ed|es|ing)\b/i.test(text.slice(ls, le));
    // Code names keep their credential word only when every credential word on the line stands inside one: a bare
    // `token`, `password` or `pw` (`token monkey12HelloSecret`, `use … for the db password`) leaves none exempt.
    const names = onlyCodeNames(text.slice(ls, le), frame);
    let p = ls;
    while (p < le) {
      while (p < le && isSpace(text[p])) p++;
      if (p >= le) break;
      const e = tokenEnd(text, p, le);
      const raw = text.slice(p, e);
      // Judged piece by piece around markers and edge punctuation (`‹secret›:Zq81…`, `token,Zq81…`). A code name that
      // holds the credential word stays (`the failing test is validateOAuth2Callback`; L10b-4).
      for (const [a, b] of secretPieces(raw, codeLine)) {
        if (p + a < last) continue;
        const piece = raw.slice(a, b);
        // A path made of names stays wherever it stands (`(/app/node_modules/x/index.js:12:3)`).
        // A path of names anywhere only with a file extension or in a stack frame (`bob/oauth2SecretOk` is not one).
        const path = /[/]/.test(piece) && (names || frame || /\.[a-z]{1,5}(?::\d|$)/.test(piece));
        if ((path || (names && CRED_WORD.test(piece))) && codeName(piece, frame)) continue;
        out += input.slice(last, p + a) + S;
        last = p + b;
        count++;
      }
      p = e;
    }
  }
  return count === 0 ? { text: input, count: 0 } : { text: out + input.slice(last), count };
}

/** Whether `name` (one identifier, such as `DB_PASSWORD`, `apiKey`, `X-Api-Key`) is a credential name. */
/** Answers of `isCredentialName`, a pure function of its argument (bounded; cleared when full). */
const NAME_CACHE = new Map<string, boolean>();

export function isCredentialName(name: string): boolean {
  // A marker is never a name: `name: ‹secret›` must not make the next `value:` a credential on a later pass.
  if (name.length < 2 || name.length > 128 || name.includes("‹")) return false;
  const cached = NAME_CACHE.get(name);
  if (cached !== undefined) return cached;
  if (NAME_CACHE.size >= 4096) NAME_CACHE.clear();
  const answer = credentialNameUncached(name);
  NAME_CACHE.set(name, answer);
  return answer;
}

function credentialNameUncached(name: string): boolean {
  const n = foldConfusables(name);
  const re = new RegExp(WORD.source, "gi");
  for (let m = re.exec(n); m !== null; m = re.exec(n)) {
    let j = m.index + m[0].length;
    if (/s/i.test(n[j] ?? "") && !isAlnum(n[j + 1])) j++;
    if (isWordAt(n, m.index, j, 0) && !DESCRIBES.has(lastPart(n, 0, n.length))) return true;
  }
  return false;
}

/** A quoted literal compared with a credential name from the left: `if ("…" == password)`. */
export function reverseComparison(text: string): RuleResult {
  if (!/[=!]=/.test(text)) return { text, count: 0 };
  let out = "";
  let last = 0;
  let count = 0;
  const re = /(?<![\w"'`])[bruf@L]?(["'`])([^"'`\n]{1,256})\1[ \t]*(?:===?|!==?)[ \t]*([A-Za-z_$][\w$.]{0,127})/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const name = (m[3] ?? "").split(".").pop() ?? "";
    const inner = m[2] ?? "";
    if (!isCredentialName(name) || keepsCredentialValue(inner) || EXACT_MARKER.test(inner)) continue;
    const a = m.index + m[0].indexOf(inner);
    if (a < last) continue;
    out += text.slice(last, a) + S;
    last = a + inner.length;
    count++;
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}

/** `IDENTIFIED BY '…'` (MySQL, Oracle): the quoted password. */
export function sqlIdentifiedBy(text: string): RuleResult {
  if (!/identified/i.test(text)) return { text, count: 0 };
  const sc = scanOf(text);
  let out = "";
  let last = 0;
  let count = 0;
  const re = /\bIDENTIFIED[ \t]+(?:WITH[ \t]+\S{1,64}[ \t]+)?BY[ \t]+(?:PASSWORD[ \t]+)?/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index + m[0].length;
    const v = readValue(sc, at);
    if (v === null || keepsCredentialValue(v.inner)) continue;
    out += text.slice(last, v.start) + v.replacement;
    last = v.end;
    count++;
    re.lastIndex = Math.max(re.lastIndex, v.end);
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}

/**
 * Name/value pairs in one object (`{"name": "DB_PASSWORD", "value": "…"}`, `{name: API_TOKEN, value: …}`, SSM's
 * `"Name": "/prod/db/password", …, "Value": "…"`): when the name is a credential name (or a path whose last
 * piece is one), the value in the next 400 characters goes. Each name is looked at once.
 */
export function nameValuePair(text: string): RuleResult {
  if (!/value/i.test(text)) return { text, count: 0 };
  const sc = scanOf(text);
  // The value may start on the next line (`"value":` then `"…"`).
  const valueRe = /(["']?)\b(?:value|Value|VALUE|SecretString|ParameterValue)\1[ \t]*[:=][ \t]*(?:\r?\n[ \t]*)?/g;
  let nextValue: { from: number; m: RegExpExecArray | null } | null = null;
  let out = "";
  let last = 0;
  let count = 0;
  const nameRe =
    /(["']?)\b(?:name|Name|NAME|key|Key|ParameterKey|SecretId)\1[ \t]*[:=][ \t]*(["']?)([^"'\s,}\]]{1,200})\2/g;
  for (let m = nameRe.exec(text); m !== null; m = nameRe.exec(text)) {
    const name = m[3] ?? "";
    const piece = name.split(/[/:]/).filter(Boolean).pop() ?? "";
    if (!isCredentialName(name) && !isCredentialName(piece)) continue;
    const from = m.index + m[0].length;
    const windowEnd = Math.min(text.length, from + 400);
    // The next value keyword is memoised: many names and no value nearby stay linear.
    if (nextValue !== null && (nextValue.from > from || (nextValue.m !== null && nextValue.m.index < from))) {
      nextValue = null;
    }
    if (nextValue === null) {
      valueRe.lastIndex = from;
      nextValue = { from, m: valueRe.exec(text) };
    }
    const v = nextValue.m;
    if (!v || v.index >= windowEnd) continue;
    const at = v.index + v[0].length;
    let value: Value | null;
    if (text[at] === '"' || text[at] === "'") value = readValue(sc, at);
    else {
      let e = at;
      const eol = sc.eol(at);
      while (e < eol && !",}]".includes(text[e] ?? "") && !isSpace(text[e])) {
        MARKER_AT.lastIndex = e;
        const mk = text[e] === "‹" ? MARKER_AT.exec(text) : null;
        e += mk ? mk[0].length : 1;
      }
      value = e > at ? { start: at, end: e, replacement: S, inner: text.slice(at, e) } : null;
    }
    if (value === null || value.start < last || keepsCredentialValue(value.inner)) continue;
    out += text.slice(last, value.start) + S;
    last = value.end;
    count++;
    nameRe.lastIndex = Math.max(nameRe.lastIndex, value.end);
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}

/**
 * Credentials in prose with no credential word: `admin / <pw>`, `log in with admin:<pw>` (a user name, a colon
 * and a secret-shaped word; never a URL scheme, a digest or `host:port`).
 */
export function userPasswordProse(text: string): RuleResult {
  let out = "";
  let last = 0;
  let count = 0;
  // A run of three or more backticks with text right after it is part of the value, not its end: the value runs on
  // to the next real delimiter, so the tail after the fence is never left (#60 security review, finding 2). The value
  // never starts with a backtick (`see:```Identifier9```` is inline code, not a password).
  const pair = /(?<![\w@:/.$-])([A-Za-z][\w.-]{0,31}):([^\s:@/"'`](?:[^\s:@/"'`]|`{3,}(?=[^\s`]))*)(?=$|[\s,;)"'`])/g;
  for (let m = pair.exec(text); m !== null; m = pair.exec(text)) {
    const user = m[1] ?? "";
    const pw = m[2] ?? "";
    if (
      /^(?:https?|ftp|ssh|git|mailto|sha\d*|md5|blake\d*|tcp|udp|file|data|urn|arn|gs|s3|docker|npm|node|image|tag|v)$/i.test(
        user,
      )
    )
      continue;
    if (pw.length < 8 || pw.length > 128) continue;
    // Judged as a whole and by its pieces between fence runs: a fence must not make a secret look like prose, and a hex
    // digest stays a digest whole or in pieces (the hex exclusion applies to each piece).
    const pieces = pw.split(/`{3,}/).filter((piece) => piece.length > 0 && !/^[0-9a-f]+$/i.test(piece));
    if (pieces.length === 0) continue;
    const shaped = isSecretShaped(pw) || pieces.some((piece) => piece.length >= 8 && isSecretShaped(piece));
    if (!shaped || EXACT_MARKER.test(pw)) continue;
    const a = m.index + user.length + 1;
    out += text.slice(last, a) + S;
    last = a + pw.length;
    count++;
  }
  const once = count === 0 ? text : out + text.slice(last);
  const sc = scanOf(once);
  let out2 = "";
  let last2 = 0;
  let count2 = 0;
  const slash = /\b(?:admin|root|user(?:name)?|login)[ \t]+\/[ \t]+/gi;
  for (let m = slash.exec(once); m !== null; m = slash.exec(once)) {
    const at = m.index + m[0].length;
    const e = tokenEnd(once, at, sc.eol(at));
    const word = bareWord(once.slice(at, e));
    if (word.length < 4 || EXACT_MARKER.test(word) || isCommonWord(word)) continue;
    out2 += once.slice(last2, at) + S;
    last2 = at + word.length;
    count2++;
  }
  return { text: count2 === 0 ? once : out2 + once.slice(last2), count: count + count2 };
}

/** `key=…` / `key: …` with a secret-shaped value (a bare `key` is otherwise not a credential name). */
export function bareKeyValue(text: string): RuleResult {
  if (!/key/i.test(text)) return { text, count: 0 };
  let out = "";
  let last = 0;
  let count = 0;
  const re = /(?<![\w.$-])key[ \t]*[:=][ \t]*(["']?)([^\s"',;&]{8,256})/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const v = m[2] ?? "";
    if (!isSecretShaped(v) || EXACT_MARKER.test(v)) continue;
    const a = m.index + m[0].length - v.length;
    out += text.slice(last, a) + S;
    last = a + v.length;
    count++;
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(last), count };
}
