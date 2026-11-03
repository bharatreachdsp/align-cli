/**
 * docs/10 §Paths and docs/17 §Redaction rule 3: every path is made repository-relative; paths outside the
 * repository (absolute paths not under the root, `..` escapes, `~` outside the root, another person's home)
 * are dropped and counted; paths matching a deny glob are removed. Deny globs follow `.gitignore`
 * conventions: a pattern without a slash matches any path segment (`.env*` denies `apps/web/.env.local`), a
 * pattern with a slash is anchored at the root, `**` crosses directories, a denied directory denies
 * everything under it, and matching ignores case (macOS and Windows file systems do). Negations
 * (`!pattern`) are ignored: a deny list only ever adds. An invalid glob is reported (`invalidDenyGlobs`) and
 * fails closed (it denies everything under its literal prefix) rather than being ignored.
 */

/** The defaults from docs/17, always applied in addition to `.aligndeny` and the personal deny file. */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
  ".env*",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/id_dsa*",
  "**/*.ppk",
  "**/*.p8",
  "**/.git-credentials",
  "**/*kubeconfig*",
  "**/.vault-token",
  "**/.htpasswd",
  "**/*.kdbx",
  "**/.terraformrc",
  "**/*.p12",
  "**/*.pfx",
  "**/.npmrc",
  "**/.aws/credentials",
  "**/.ssh/**",
  "**/*service-account*.json",
  "**/*service_account*.json",
  "**/credentials.json",
  "**/key.json",
  "**/*-key.json",
  "**/*_key.json",
  "**/secret.json",
  "**/secrets.json",
  "**/secret.yaml",
  "**/secret.yml",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/*.gpg",
  "**/wallet.dat",
  "**/*.asc",
  "**/.dockercfg",
  "**/application_default_credentials.json",
  "**/.config/gcloud/**",
  "**/firebase-adminsdk-*.json",
  "**/credentials.yml.enc",
  "**/.*_history",
  "**/.netrc",
  "**/.pgpass",
  "**/.pypirc",
  "**/.docker/config.json",
  "**/.kube/config",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.jks",
  "**/*.keystore",
  "**/node_modules/**",
  "**/.git/**",
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f]/;

/** Parses a deny file (`.aligndeny`, `~/.align/repos/<hash>/deny`): one glob per line, `#` comments, blanks and negations skipped. */
export function parseDenyGlobs(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
}

/** Strips `file://` (and the slash before a Windows drive) and decodes percent escapes. */
function stripFileUrl(p: string): string {
  if (!/^file:\/\//i.test(p)) return p;
  let rest = p.slice(7);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep the raw text: a malformed escape is not a reason to accept or reject the path
  }
  return /^\/[A-Za-z]:[\\/]/.test(rest) ? rest.slice(1) : rest;
}

const HOME_PREFIX =
  /^(?:(?:\/mnt\/[A-Za-z]|\/var)?\/(?:Users|home)\/(?!Shared(?:[/\\]|$))[^/\\]+|\/root|[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+)(?=[/\\]|$)/i;

/** Replaces a leading home directory (`/Users/<name>`, `/home/<name>`, `/var/home/<name>`, `/root`, `/mnt/c/Users/<name>`, `C:\Users\<name>`, also as a `file://` URL) with `~`. */
export function normalizeHome(path: string): string {
  return stripFileUrl(path).replace(HOME_PREFIX, "~");
}

/** The home directory a path lives under (`/Users/riya` for `/Users/riya/code`), or null. */
function homeOf(path: string): string | null {
  return HOME_PREFIX.exec(path)?.[0] ?? null;
}

/** Resolves `.` and `..` segments of a `/`-separated path; null when `..` climbs above its first segment. */
function resolveSegments(path: string): string | null {
  const leading = path.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return leading + out.join("/");
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:\//.test(p);
}

function canonical(p: string): string {
  return stripFileUrl(p).replace(/\\/g, "/");
}

/**
 * Makes `path` relative to `repoRoot` (`.` for the root itself). Absolute paths are compared as they are, so
 * another person's home (`/Users/bob/…` beside a root under `/Users/riya`) is outside; `~` expands to the
 * root's own home. Relative paths resolve against `repoRoot/cwdRel`. Returns null for anything outside the
 * repository and for paths with control characters.
 */
export function toRepoRelative(path: string, repoRoot: string, cwdRel?: string | null): string | null {
  if (path.length === 0 || CONTROL.test(path) || CONTROL.test(repoRoot)) return null;
  const root = resolveSegments(canonical(repoRoot));
  if (root === null || root === "" || root === "/" || root.startsWith("~")) return null;
  let p = canonical(path);
  if (p === "~" || p.startsWith("~/")) {
    const home = homeOf(root);
    if (home === null) return null;
    p = home + p.slice(1);
  } else if (p.startsWith("~")) {
    return null;
  }
  let abs: string | null;
  if (isAbsoluteLike(p)) {
    abs = resolveSegments(p);
  } else {
    const cwdCanon = cwdRel ? canonical(cwdRel) : "";
    if (cwdCanon && (isAbsoluteLike(cwdCanon) || CONTROL.test(cwdCanon))) return null;
    const cwd = cwdCanon ? resolveSegments(cwdCanon) : "";
    if (cwd === null) return null;
    abs = resolveSegments(`${root}/${cwd}/${p}`);
  }
  if (abs === null) return null;
  const windows = /^[A-Za-z]:\//.test(root);
  const a = windows ? abs.toLowerCase() : abs;
  const r = windows ? root.toLowerCase() : root;
  if (a === r) return ".";
  if (!a.startsWith(`${r}/`)) return null;
  const rel = abs.slice(root.length + 1);
  // A relative path that would read as a home directory (`~…`), an absolute path (`A:/…`, `//…`), a drive-like
  // folder (`A:`) or a URL (`file:`) the next time is dropped as ambiguous, so redacting the output again changes
  // nothing.
  return rel.startsWith("~") || isAbsoluteLike(rel) || /^[A-Za-z]:/.test(rel) || /^file:/i.test(rel) ? null : rel;
}

/**
 * The server's path rule, with no repository root: a path must already be relative, with no `..` segment,
 * no `~`, no drive letter, no `file://` and no control characters. Returns the normalised path or null.
 */
export function toSafeRelative(path: string): string | null {
  if (path.length === 0 || CONTROL.test(path)) return null;
  const p = path.replace(/\\/g, "/");
  if (isAbsoluteLike(p) || /^file:/i.test(p) || /^[A-Za-z]:/.test(p)) return null;
  if (p.split("/").includes("..")) return null;
  const r = resolveSegments(p);
  if (r === null) return null;
  if (r === "") return ".";
  // `./~` resolves to `~`, `./C:/x` to `C:/x`: each would read differently the next time, so it is dropped.
  return isAbsoluteLike(r) || /^[A-Za-z]:/.test(r) ? null : r;
}

/**
 * Deny globs come from a repository's committed `.aligndeny`, so they are untrusted input. They are compiled to a
 * small token list and matched by dynamic programming over (token, position) — time is bounded by tokens × path
 * length whatever the pattern, so no glob can make matching slow (L12 security review). A glob ALIGN cannot use
 * exactly — over 256 characters, more than eight wildcards, or a bracket class that is not a plain set or range
 * (a reversed range, a POSIX `[[:digit:]]`, an empty `[]`) — fails closed: it denies everything that starts with its
 * literal prefix, keeping its own anchoring (in any folder when it has no slash), and is reported.
 */
export const MAX_GLOB_LENGTH = 256;
/** Longer paths are dropped from events before any rule runs on them (`field_dropped`; the reader keeps ≤ 1,024 too). */
export const MAX_PATH_CHARS = 1024;
export const MAX_GLOB_WILDCARDS = 8;

type Token =
  | { t: "lit"; c: string }
  | { t: "one" }
  | { t: "star" }
  | { t: "all" }
  | { t: "dirs" }
  | { t: "class"; re: RegExp };

/** `runs`: the glob's maximal runs of literal characters; a path that lacks one of them cannot match (prefilter). */
type Compiled = { tokens: Token[]; anchored: boolean; valid: boolean; exact?: string; runs?: string[] };

const compiled = new Map<string, Compiled>();

function compileGlob(glob: string): Compiled {
  const cached = compiled.get(glob);
  if (cached) return cached;
  const out = compileUncached(glob);
  out.runs = literalRuns(out.tokens);
  compiled.set(glob, out);
  return out;
}

function literalRuns(tokens: readonly Token[]): string[] {
  const runs: string[] = [];
  let cur = "";
  for (const t of tokens) {
    if (t.t === "lit") {
      cur += t.c;
      continue;
    }
    if (cur) runs.push(cur);
    cur = "";
  }
  if (cur) runs.push(cur);
  return runs;
}

/**
 * Characters a file system shows as nothing, removed from paths and globs alike before matching: every Unicode
 * default-ignorable code point (soft hyphen, zero-width characters, variation selectors, tag characters, Hangul
 * fillers, …) and the bidirectional controls, the Arabic letter mark included (#43 chain re-review).
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|[\u202a-\u202e\u2066-\u2069\u061c]/gu;

/**
 * Lower case for matching, the same for globs and paths: the whole string at once, then the final sigma folded into
 * the ordinary one (`ς` → `σ`), because whole-string lower-casing picks it by context and a glob's context (`ΑΣ*`)
 * differs from the path's (`ΑΣΑ`).
 */
const fold = (s: string) => s.toLowerCase().replace(/ς/g, "σ");

function compileUncached(glob: string): Compiled {
  // The glob gets the path's normalisation (NFKC, invisible characters removed) before anything else, so `ﬁle`,
  // `ｓecret/`, `secret／x` and a decomposed `café` mean what they show (L12 review round 5).
  // Each segment also loses what Windows ignores (trailing dots and spaces, `::$DATA`), as the path's segments do, so
  // `secret.` still denies `secret.`; a segment of dots only (`.`, `..`) is left as it is.
  // Composed again once the invisibles are gone: one between a letter and its mark (`e\u200b\u0301`) or between
  // Hangul jamo kept them apart (#67 security review).
  const normal = glob
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .split("/")
    .map((seg) => (/^\.*$/.test(seg) ? seg : seg.replace(/:+\$[A-Za-z_]+$/, "").replace(/(?<=[^. ])[. ]+$/, "")))
    .join("/");
  // Runs of three or more stars mean the same as `**`; a run of `**/` segments the same as one.
  let g = normal
    .trim()
    .replace(/\\/g, "/")
    .replace(/\*{3,}/g, "**")
    .replace(/(?:\*\*\/){2,}/g, "**/");
  const anchored = g.startsWith("/") || g.replace(/\/+$/, "").includes("/");
  g = g.replace(/^\/+/, "").replace(/\/+$/, "");
  if (g.length === 0 || CONTROL.test(g))
    return { tokens: [], anchored: true, valid: false, exact: fold(normal.trim()) };
  // Lower-cased as a whole, like the path. A glob whose length changes (`İ` → `i̇`) cannot be matched character for
  // character: it fails closed below.
  const lowered = fold(g);
  const lengthChanged = lowered.length !== g.length;
  g = lowered;
  // Fail closed: everything that starts with the literal prefix before the first wildcard is denied (all paths when
  // there is none), with the glob's own anchoring, and the glob is reported as one ALIGN could not use exactly.
  const prefixDeny = (): Compiled => {
    const first = g.search(/[*?[]/);
    const prefix = Array.from(g.slice(0, first === -1 ? g.length : first)).slice(0, MAX_GLOB_LENGTH);
    return { tokens: [...prefix.map((c): Token => ({ t: "lit", c })), { t: "all" }], anchored, valid: false };
  };
  const wildcards = (g.match(/\*+|\?|\[/g) ?? []).length;
  if (lengthChanged || g.length > MAX_GLOB_LENGTH || wildcards > MAX_GLOB_WILDCARDS) return prefixDeny();
  // Tokens are code points: `?` and a class match one character, also outside the Basic Multilingual Plane.
  const cs = Array.from(g);
  const tokens: Token[] = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] ?? "";
    if (c === "*") {
      if (cs[i + 1] === "*") {
        const before = i === 0 || cs[i - 1] === "/";
        const after = i + 2 === cs.length || cs[i + 2] === "/";
        if (before && after) {
          if (i + 2 === cs.length) {
            // `dir/**`: the trailing `(?:/.*)?` every match allows already covers it; drop the slash before.
            const last = tokens[tokens.length - 1];
            if (last?.t === "lit" && last.c === "/") tokens.pop();
            else tokens.push({ t: "all" });
          } else {
            tokens.push({ t: "dirs" });
            i++;
          }
          i++;
          continue;
        }
        tokens.push({ t: "star" });
        i++;
        continue;
      }
      tokens.push({ t: "star" });
    } else if (c === "?") {
      tokens.push({ t: "one" });
    } else if (c === "[") {
      const close = cs.indexOf("]", i + 1);
      if (close === -1) {
        tokens.push({ t: "lit", c: "[" });
      } else {
        const raw = cs.slice(i + 1, close).join("");
        const set = raw.replace(/^[!^]/, "");
        // Only plain sets and ranges are compiled. An empty class (`[]`, `[!]`: `.gitignore` would read the `]` as a
        // literal), POSIX, equivalence and collating classes (`[[:digit:]]`, `[[=a=]]`, `[[.a.]]`) and a reversed
        // range (`[z-a]`) fail closed.
        // A character outside the Basic Multilingual Plane in a class fails closed too.
        if (set.length === 0 || /\[[:=.]/.test(raw) || /[\u{10000}-\u{10ffff}]/u.test(raw)) return prefixDeny();
        const body = `${raw.startsWith("!") || raw.startsWith("^") ? "^" : ""}${set.replace(/[\\\]^[]/g, "\\$&")}`;
        try {
          // `u`: the class is tested against one code point, so a negated class matches a non-BMP character too.
          tokens.push({ t: "class", re: new RegExp(`^[${body}]$`, "iu") });
        } catch {
          return prefixDeny();
        }
        i = close;
      }
    } else {
      tokens.push({ t: "lit", c });
    }
  }
  return { tokens, anchored, valid: true };
}

/**
 * Matching budgets, in steps of the matcher (about 0.1 µs each). Every path gets its own `PATH_MATCH_STEPS`, far above
 * what an honest path costs (the default globs on a 1,024-character path take a few thousand: most globs are skipped by
 * the literal prefilter); an event's paths together get at most `EVENT_MATCH_STEPS`, above an honest 1,000-file commit
 * many times over. Either one spent, the path counts as denied (fails closed), so a hostile deny file makes one event
 * cost at most about a second, and an honest event never loses a path to the budget (D94, D228).
 */
export type MatchBudget = { steps: number };
export const PATH_MATCH_STEPS = 200_000;
export const EVENT_MATCH_STEPS = 10_000_000;

class BudgetSpent extends Error {}

/** Whether `p` (lower case, in match form) matches the glob: the body anchored at the start (or after any directory when not anchored), then the end or a slash. */
function globMatch(c: Compiled, text: string, p: readonly string[], budget: MatchBudget): boolean {
  if (c.exact !== undefined) return text === c.exact;
  // A literal run the path lacks rules the glob out without running the matcher (cost charged by length).
  for (const run of c.runs ?? []) {
    budget.steps -= 1 + (text.length >> 4);
    if (budget.steps < 0) throw new BudgetSpent();
    if (!text.includes(run)) return false;
  }
  const tokens: Token[] = c.anchored ? c.tokens : [{ t: "dirs" }, ...c.tokens];
  const T = tokens.length;
  const P = p.length;
  // memo[k]: 0 unknown, 1 false, 2 true; two layers (normal, inside a `dirs` token). Its allocation is charged too.
  const cells = (T + 1) * (P + 1) * 2;
  budget.steps -= cells >> 6;
  if (budget.steps < 0) throw new BudgetSpent();
  const memo = new Uint8Array(cells);
  const stack: Array<[number, number, number, number]> = [];
  const key = (ti: number, pi: number, inside: number) => ((ti * (P + 1) + pi) << 1) | inside;
  // Iterative evaluation of the recursive definition, so no recursion depth limit applies.
  const solve = (ti0: number, pi0: number): boolean => {
    const visit = (ti: number, pi: number, inside: number): number => memo[key(ti, pi, inside)] ?? 0;
    stack.push([ti0, pi0, 0, 0]);
    while (stack.length > 0) {
      if (--budget.steps < 0) throw new BudgetSpent();
      const top = stack[stack.length - 1] as [number, number, number, number];
      const [ti, pi, inside] = top;
      const k = key(ti, pi, inside);
      if (memo[k]) {
        stack.pop();
        continue;
      }
      // Each state's alternatives, in order; `need` lists children not yet known.
      const alts: Array<[number, number, number] | boolean> = [];
      if (inside) {
        if (pi < P && p[pi] === "/") alts.push([ti + 1, pi + 1, 0]);
        if (pi < P) alts.push([ti, pi + 1, 1]);
      } else if (ti === T) {
        alts.push(pi === P || p[pi] === "/");
      } else {
        const tok = tokens[ti] as Token;
        const ch = p[pi];
        switch (tok.t) {
          case "lit":
            if (pi < P && ch === tok.c) alts.push([ti + 1, pi + 1, 0]);
            break;
          case "one":
            if (pi < P && ch !== "/") alts.push([ti + 1, pi + 1, 0]);
            break;
          case "class":
            // A class test costs several plain steps; charged so, the budget stays a bound on time.
            budget.steps -= 4;
            if (pi < P && tok.re.test(ch ?? "")) alts.push([ti + 1, pi + 1, 0]);
            break;
          case "star":
            alts.push([ti + 1, pi, 0]);
            if (pi < P && ch !== "/") alts.push([ti, pi + 1, 0]);
            break;
          case "all":
            alts.push([ti + 1, pi, 0]);
            if (pi < P) alts.push([ti, pi + 1, 0]);
            break;
          case "dirs":
            alts.push([ti + 1, pi, 0]);
            alts.push([ti, pi, 1]);
            break;
        }
      }
      let result: boolean | null = false;
      for (const a of alts) {
        if (typeof a === "boolean") {
          if (a) {
            result = true;
            break;
          }
          continue;
        }
        const v = visit(a[0], a[1], a[2]);
        if (v === 2) {
          result = true;
          break;
        }
        if (v === 0) {
          stack.push([a[0], a[1], a[2], 0]);
          result = null;
          break;
        }
      }
      if (result === null) continue;
      memo[k] = result ? 2 : 1;
      stack.pop();
    }
    return memo[key(ti0, pi0, 0)] === 2;
  };
  return solve(0, 0);
}

const isRule = (g: string) => {
  const t = g.trim();
  return t.length > 0 && !t.startsWith("#") && !t.startsWith("!");
};

/** The globs ALIGN cannot match exactly (they fail closed on their literal prefix); callers report them. */
export function invalidDenyGlobs(globs: readonly string[]): string[] {
  return globs.filter((g) => isRule(g) && !compileGlob(g.trim()).valid);
}

/**
 * The form a path is matched in: compatibility-normalised (`ｅnv` → `env`), invisible characters removed, and
 * each segment stripped of what Windows ignores (trailing dots and spaces, an alternate data stream such as
 * `::$DATA`), so `x.pem.`, `x.pem ` and `.e\u200bnv` are denied like `x.pem` and `.env`.
 */
function matchForm(path: string): string {
  return path
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .map((seg) => seg.replace(/:+\$[A-Za-z_]+$/, "").replace(/[. ]+$/, ""))
    .join("/");
}

/**
 * Whether a repository-relative path matches any of `globs` (the defaults are not added here; see `effectiveDenyGlobs`).
 * The path is matched within its own `PATH_MATCH_STEPS`, also charged to `event` (an event's shared budget) when given.
 */
export function isDenied(path: string, globs: readonly string[], event?: MatchBudget): boolean {
  const form = matchForm(path);
  const p = fold(form);
  if (p === "" || p === ".") return false;
  // Lower case can make a path longer (`İ` → `i̇`), so a plain glob (`izmir/`) would miss `İzmir/`: such a path is also
  // matched in two spellings that keep its length, each code point lower-cased only where that keeps it one code
  // point, and with the dot above dropped (`i̇` → `i`). Denied when any spelling matches.
  const forms = [p];
  if (p.length !== form.length) {
    forms.push(
      Array.from(form)
        .map((c) => (c.toLowerCase().length === c.length ? fold(c) : c))
        .join(""),
    );
  }
  // Also whenever the path spells an i with a combining dot above itself (#67 security review).
  if (p.includes("i\u0307")) forms.push(p.replace(/i\u0307/g, "i"));
  // Fails closed: a path whose matching would exceed either budget (an adversarial `.aligndeny`) is denied.
  const start = Math.min(PATH_MATCH_STEPS, event ? event.steps : PATH_MATCH_STEPS);
  const b: MatchBudget = { steps: start };
  try {
    if (start <= 0) return true;
    return forms.some((f) => {
      // Matched by code point, as the globs are tokenised.
      const points = Array.from(f);
      return globs.some((g) => isRule(g) && globMatch(compileGlob(g.trim()), f, points, b));
    });
  } catch (e) {
    if (e instanceof BudgetSpent) return true;
    throw e;
  } finally {
    if (event) event.steps -= start - b.steps;
  }
}

/** The defaults plus the repository's and the person's own globs. */
export function effectiveDenyGlobs(globs: readonly string[]): string[] {
  return [...new Set([...DEFAULT_DENY_GLOBS, ...globs])];
}

/** `machine_id`: `sha256:` + the hex SHA-256 of `salt` and the raw machine identifier (Web Crypto, isomorphic). */
export async function machineId(raw: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}\u0000${raw}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
