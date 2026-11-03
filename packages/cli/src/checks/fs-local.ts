/**
 * The laptop adapters for the deterministic checks (docs/13 §Deterministic checks; ticket L15b; D406, D423): the same
 * pure matchers as the worker (`@align/core/checks` `runCheck`) over this repository's files, from one of two sources:
 *
 * - `head` (what is **reported**): the blobs of the commit the results are reported under (`git ls-tree` +
 *   `git cat-file --batch` at HEAD), so a result says only what the commit already says to everyone with the
 *   repository. Uncommitted edits, local configuration and files kept out of commits never reach a posted result.
 * - `worktree` (shown on this laptop only, never posted): the tracked files as they are on disk now.
 *
 * Both: tracked paths only; never an entry marked skip-worktree or assume-unchanged (`git ls-files -v`: `S` or a
 * lower-case tag; such files are local by intent); never a path matching the deny globs (defaults, the committed
 * `.aligndeny`, the personal deny file); only regular files (no symbolic links, submodules or special files), at most
 * 1 MB; on disk, never through a symbolically linked parent directory that leaves the repository, and `O_NOFOLLOW`
 * reads. Every line is redacted with the laptop's text rules (secrets, credential and environment assignments,
 * identities) before any matcher sees it, line numbers kept, so a secret's value can never decide a result (an
 * oracle a teammate could read from `last_run`). Matches leave only when their path is a plain repository path the
 * deny globs allow and the path rules would not change (report.ts sends them; `safeMatches` here decides).
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  type CheckFile,
  type CheckLimits,
  type CheckMatch,
  type CheckResult,
  DEFAULT_CHECK_LIMITS,
  runCheck,
} from "@align/core/checks";
import {
  effectiveDenyGlobs,
  isDenied,
  type RedactionContext,
  redactText,
  type TextContext,
  toSafeRelative,
} from "@align/core/redact";
import { normalizeRemote } from "@align/core/remote";
import { readDenyFile } from "../hook/events";
import { gitBinary, gitEnv, HOOK_GIT_CONFIG } from "../hook/home";
import type { Paths } from "../paths";

/** `git` output is read up to this much (about 300,000 paths); more → no files (the checks report error). */
const LIST_MAX_BYTES = 64 * 1024 * 1024;
const GIT_LIST_TIMEOUT_MS = 30_000;
const RULE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** C0 and C1 controls, DEL, bidi controls and marks: never in a path that leaves (as `@align/core/redact` refuses). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f]/;
/** Redacted file text kept between checks of one run, up to this much. */
const CACHE_BYTES = 64 * 1024 * 1024;
/** The git binaries trusted when the shim recorded none (never one found on PATH, D276). */
const GIT_FALLBACKS = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

export type Source = "head" | "worktree";

export type LocalCheck = { check_id: string; entry_key: string; kind: string; spec: Record<string, unknown> };

export type LocalResult = {
  check_id: string;
  entry_key: string;
  kind: string;
  result: CheckResult;
  matches: CheckMatch[];
  duration_ms: number;
  reason?: string;
};

const gitPath = (env: NodeJS.ProcessEnv) => gitBinary(env, GIT_FALLBACKS);
/** The sanitised environment, and never a fetch from a promisor remote for a missing object (a partial clone). */
const checksGitEnv = (env: NodeJS.ProcessEnv) => ({
  ...gitEnv(env),
  GIT_NO_LAZY_FETCH: "1",
  // A `refs/replace/` object would let a local ref swap what a reported commit's tree says.
  GIT_NO_REPLACE_OBJECTS: "1",
});

function gitOut(root: string, args: string[], env: NodeJS.ProcessEnv): Promise<Buffer | null> {
  const git = gitPath(env);
  if (!git) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      git,
      [...HOOK_GIT_CONFIG, "-c", "core.quotepath=off", ...args],
      {
        cwd: root,
        timeout: GIT_LIST_TIMEOUT_MS,
        maxBuffer: LIST_MAX_BYTES,
        windowsHide: true,
        env: checksGitEnv(env),
        encoding: "buffer",
      },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

const nulList = (b: Buffer) =>
  b
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);

/**
 * The commit results are reported under (D409, D411): the newest commit HEAD shares with **the repository's own
 * remote** (the remote whose URL normalises to the registered `remote_norm`), so a result never describes a commit
 * only this laptop, or a personal fork, has. The branch's upstream counts only when it is a remote-tracking ref of
 * that remote (`git branch -u main` makes a local branch the upstream, which proves nothing); otherwise the newest of
 * HEAD's merge-bases with that remote's refs (at most 100, newest commits first). Null when no remote matches or HEAD
 * shares no commit with it: then nothing is reported.
 */
export async function reportCommit(
  root: string,
  remoteNorm: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const text = async (args: string[]) => (await gitOut(root, args, env))?.toString("utf8").trim() ?? null;
  const sha = (v: string | null) => (v && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v : null);
  const names = ((await text(["remote"])) ?? "").split("\n").filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n));
  const ours: string[] = [];
  for (const name of names) {
    const url = await text(["remote", "get-url", "--", name]);
    if (url && normalizeRemote(url) === remoteNorm) ours.push(name);
  }
  if (ours.length === 0) return null;
  const upstream = await text(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (upstream && ours.some((r) => upstream.startsWith(`refs/remotes/${r}/`))) {
    const up = sha(await text(["merge-base", "HEAD", upstream]));
    if (up) return up;
  }
  const refs: string[] = [];
  for (const r of ours) {
    const out = await text([
      "for-each-ref",
      "--sort=-committerdate",
      "--count=100",
      "--format=%(objectname)",
      `refs/remotes/${r}/`,
    ]);
    for (const line of (out ?? "").split("\n")) {
      const v = sha(line.trim());
      if (v) refs.push(v);
    }
  }
  const bases = new Set<string>();
  for (const ref of new Set(refs)) {
    if (bases.size >= 100) break;
    const b = sha(await text(["merge-base", "HEAD", ref]));
    if (b) bases.add(b);
  }
  if (bases.size === 0) return null;
  if (bases.size === 1) return [...bases][0] ?? null;
  return sha(await text(["rev-list", "-n", "1", "--date-order", ...bases]));
}

/** The repository's tracked paths (`git ls-files -z`), or null when git fails. */
export async function trackedPaths(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string[] | null> {
  const out = await gitOut(root, ["ls-files", "-z", "--cached", "--full-name"], env);
  return out ? [...new Set(nulList(out))].sort() : null;
}

/**
 * Entries marked skip-worktree (`S`) or assume-unchanged (a lower-case tag) in `git ls-files -v`: kept local by intent
 * (a developer's own configuration), so no check ever reads them. Null when git fails (the caller then reads nothing).
 */
export async function hiddenPaths(root: string, env: NodeJS.ProcessEnv = process.env): Promise<Set<string> | null> {
  const out = await gitOut(root, ["ls-files", "-v", "-z", "--cached", "--full-name"], env);
  if (!out) return null;
  const hidden = new Set<string>();
  for (const item of nulList(out)) {
    const tag = item.slice(0, 1);
    if (tag === "S" || (tag >= "a" && tag <= "z")) hidden.add(item.slice(2));
  }
  return hidden;
}

/** The deny globs capture uses for this repository: defaults, `.aligndeny` (read defensively) and the personal file. */
export function denyGlobsFor(paths: Paths, root: string): string[] {
  return effectiveDenyGlobs([...readDenyFile(join(root, ".aligndeny")).globs, ...readDenyFile(paths.deny(root)).globs]);
}

export const repoPathOk = (p: string) =>
  p.length > 0 &&
  p.length <= 1024 &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !p.split("/").includes("..") &&
  !CONTROL.test(p);

/**
 * A key that names a secret (D409): password, passphrase, secret, token, credentials, auth, API, access, private,
 * client, signing or encryption keys, JWT, certificates, salts, connection strings and DSNs. Used only to decide
 * whether the lines after a key with no value on its own line hold its value.
 */
export const SECRET_KEY =
  /(pass(word|wd|phrase)?|secret|token|credential|auth|api[-_.]?key|access[-_.]?key|private[-_.]?key|client[-_.]?key|signing|encryption|jwt|cert(ificate)?|salt|dsn|conn(ection)?[-_.]?str(ing)?|key[-_.]?pair|keystore)/i;

type Block =
  | { kind: "indent"; indent: number }
  | { kind: "tag"; close: string }
  | { kind: "until"; close: string }
  | { kind: "continued" };

const indentOf = (line: string) => line.length - line.trimStart().length;
const SECRET = "‹secret›";
const hide = (line: string) => (line.trim() === "" ? line : `${line.slice(0, indentOf(line))}${SECRET}`);

/** `key:` / `key =` with what may follow it on the key's own line: anchors, tags, a block or flow marker. */
const KEY_LINE =
  /^(\s*)(?:-\s+)?["']?([A-Za-z0-9_.-]{1,128})["']?\s*[:=]\s*((?:[&!][^\s#]*\s*)*)([|>][-+0-9]*|\[|\{|"""|'''|)?\s*(?:#.*)?$/;
const TAG_OPEN = /^\s*<([A-Za-z_][A-Za-z0-9_.:-]{0,127})(?:\s[^>]*)?>\s*(?:<!\[CDATA\[.*)?$/;
const TAG_INLINE = /^(\s*<([A-Za-z_][A-Za-z0-9_.:-]{0,127})(?:\s[^>]*)?>)(.*?)(<\/\2>.*)$/;

/**
 * Whether `line` (as written, before any redaction) opens a value carried on the lines after it, under a
 * secret-like key: YAML or properties with an empty value, anchors or tags only, or a block or flow marker
 * (`password:`, `token: |`, `key: &k !!str >-`, `secret: [`, `key = """`); a line ending in `\` (a continued value);
 * or an XML element opened alone, CDATA included (`<password>`, `<secret><![CDATA[`). Returns what ends the block.
 */
function opener(line: string, forced = false): Block | null {
  const kv = KEY_LINE.exec(line);
  if (kv && (forced || SECRET_KEY.test(kv[2] ?? ""))) {
    const marker = kv[4] ?? "";
    if (marker === '"""' || marker === "'''") return { kind: "until", close: marker };
    return { kind: "indent", indent: (kv[1] ?? "").length };
  }
  const assign = /^\s*(?:export\s+)?["']?([A-Za-z0-9_.-]{1,128})["']?\s*[:=].*\\$/.exec(line);
  if (assign && (forced || SECRET_KEY.test(assign[1] ?? ""))) return { kind: "continued" };
  const tag = TAG_OPEN.exec(line);
  if (tag && (forced || SECRET_KEY.test(tag[1] ?? "")) && !line.includes(`</${tag[1]}>`))
    return { kind: "tag", close: `</${tag[1]}>` };
  return null;
}

/**
 * Pair rules, before the line pass: a Kubernetes `name: <secret-like>` makes the sibling `value:` within two lines
 * secret; an XML `<name>…secret-like…</name>` makes the next `<value>` (within three lines) secret; in a manifest
 * with `kind: Secret`, every value under `data:` and `stringData:` is secret. Returns lines whose value must be
 * hidden inline, and lines that open a block whatever their key says.
 */
function pairs(lines: readonly string[]): { inline: Set<number>; forced: Set<number> } {
  const inline = new Set<number>();
  const forced = new Set<number>();
  const secretManifest = lines.some((l) => /^kind:\s*["']?Secret["']?\s*(?:#.*)?$/.test(l.trimEnd()));
  lines.forEach((l, i) => {
    const name = /^\s*-?\s*name:\s*["']?([A-Za-z0-9_.-]{1,128})["']?\s*$/.exec(l);
    if (name && SECRET_KEY.test(name[1] ?? "")) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        if (j === i || !/^\s*-?\s*value:/.test(lines[j] ?? "")) continue;
        if (opener(lines[j] ?? "", true)) forced.add(j);
        else inline.add(j);
      }
    }
    const xname = /<name>([^<]{1,256})<\/name>/.exec(l);
    if (xname && SECRET_KEY.test(xname[1] ?? "")) {
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
        const t = lines[j] ?? "";
        if (/<value>[^<]*<\/value>/.test(t)) {
          inline.add(j);
          break;
        }
        if (/^\s*<value>\s*$/.test(t)) {
          forced.add(j);
          break;
        }
      }
    }
    if (secretManifest && /^(\s*)(data|stringData):\s*(?:#.*)?$/.test(l)) forced.add(i);
  });
  return { inline, forced };
}

/** The value of a key line, or an element's text, replaced by `‹secret›` (the key and the tags kept). */
function hideValue(line: string): string {
  const v = /^(\s*-?\s*value:\s*)(.+)$/.exec(line);
  if (v) return `${v[1]}${SECRET}`;
  const t = TAG_INLINE.exec(line);
  if (t) return `${t[1]}${SECRET}${t[4]}`;
  return hide(line);
}

/**
 * Each line redacted with the laptop's text rules, line numbers kept (a line that could not settle becomes empty).
 * One line of state is carried: after a secret-like key whose value starts on the next line (`password:`, `key: |`,
 * `key: [`, `key = """`, a value continued with `\`, `<secret>`), the lines of that value are replaced by `‹secret›`
 * (indentation kept) until the block ends: a line indented no deeper than the key (a `- ` item at the key's own indent
 * still belongs to it), the closing quotes or tag, or a line that is not continued. A one-line element under a
 * secret-like tag (`<password>x</password>`) has its text hidden, and the pair rules (`pairs`) cover values named by a
 * sibling. A secret's value therefore never reaches a matcher.
 */
export function redactLines(text: string, ctx: TextContext): string {
  let block: Block | null = null;
  const lines = text.split("\n");
  const bare = lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const pair = pairs(bare);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const cr = raw.endsWith("\r");
    const line = bare[i] ?? "";
    let out: string | null = null;
    if (block?.kind === "indent") {
      const deeper = indentOf(line) > block.indent;
      const item = indentOf(line) === block.indent && /^\s*-(\s|$)/.test(line);
      if (line.trim() === "") out = line;
      else if (deeper || item) out = hide(line);
      else block = null;
    } else if (block?.kind === "tag" || block?.kind === "until") {
      const at = line.indexOf(block.close);
      if (at < 0) out = hide(line);
      else {
        out = `${line.slice(0, indentOf(line))}${SECRET}${line.slice(at)}`;
        block = null;
      }
    } else if (block?.kind === "continued") {
      out = hide(line);
      if (!line.endsWith("\\")) block = null;
    }
    if (out === null) {
      const tag = TAG_INLINE.exec(line);
      if (pair.inline.has(i) || (tag && SECRET_KEY.test(tag[2] ?? ""))) out = hideValue(line);
      else if (line.length === 0) out = line;
      else {
        const r = redactText(line, ctx);
        out = (r.hits.unsettled ?? 0) > 0 ? "" : r.text.replace(/\n/g, " ");
      }
      block = opener(line, pair.forced.has(i));
    }
    lines[i] = cr ? `${out}\r` : out;
  }
  return lines.join("\n");
}

/** One `git cat-file --batch` process for a run; reads are queued, one at a time. */
export class BlobReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private waiting: ((b: Buffer) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const git = gitPath(this.env);
    if (!git) throw new Error("no git");
    const proc = spawn(git, [...HOOK_GIT_CONFIG, "cat-file", "--batch"], {
      cwd: this.root,
      env: checksGitEnv(this.env),
      windowsHide: true,
    });
    proc.stdout.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (const w of this.waiting.splice(0)) w(this.buf);
    });
    const fail = () => {
      this.failed = true;
      for (const w of this.waiting.splice(0)) w(this.buf);
    };
    proc.on("error", fail);
    proc.on("close", fail);
    proc.stdin.on("error", fail);
    this.proc = proc;
    return proc;
  }

  private async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.failed) throw new Error("cat-file ended");
      await new Promise<Buffer>((r) => this.waiting.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) return (await this.take(i + 1)).toString("utf8").slice(0, -1);
      if (this.failed) throw new Error("cat-file ended");
      await new Promise<Buffer>((r) => this.waiting.push(r));
    }
  }

  read(oid: string): Promise<string> {
    const job = this.queue.then(async () => {
      const proc = this.start();
      proc.stdin.write(`${oid}\n`);
      const header = (await this.line()).split(" ");
      const size = Number(header[2]);
      if (header[0] !== oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
        // The stream can no longer be trusted to line up with the requests: nothing more is read from it.
        this.fail();
        throw new Error("unexpected cat-file answer");
      }
      const body = await this.take(size + 1);
      return body.subarray(0, size).toString("utf8");
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Marks the reader failed and stops the process: every pending and later read fails. */
  fail(): void {
    this.failed = true;
    this.proc?.kill();
    for (const w of this.waiting.splice(0)) w(this.buf);
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
  }
}

/** HEAD's regular blobs: `git ls-tree -r -z --long --full-tree HEAD` (`<mode> <type> <oid> <size>\t<path>`). */
async function headEntries(
  root: string,
  env: NodeJS.ProcessEnv,
  commit: string,
): Promise<{ path: string; oid: string; size: number }[] | null> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return null;
  const out = await gitOut(root, ["ls-tree", "-r", "-z", "--long", "--full-tree", commit], env);
  if (!out) return null;
  const entries: { path: string; oid: string; size: number }[] = [];
  for (const item of nulList(out)) {
    const tab = item.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid, size] = item.slice(0, tab).trim().split(/\s+/);
    // Regular files only: never a symbolic link (120000) or a submodule (160000).
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !oid || !/^[0-9a-f]{40,64}$/.test(oid)) continue;
    entries.push({ path: item.slice(tab + 1), oid, size: Number(size) });
  }
  return entries;
}

/** Reads a regular file without following a symbolic link; at most `max` bytes (the caller skips larger files). */
function readNoFollow(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const size = Math.min(st.size, max);
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.toString("utf8", 0, got);
  } finally {
    closeSync(fd);
  }
}

/** The file's path relative to the resolved root after resolving its directory, or null when that fails or leaves. */
export function resolvedRelative(root: string, abs: string): string | null {
  try {
    const rel = relative(realpathSync(root), join(realpathSync(dirname(abs)), basename(abs)));
    return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
  } catch {
    return null;
  }
}

/** True when the file's directory, resolved, is the root or inside it (a symbolically linked parent never leads out). */
export function parentInside(root: string, abs: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const dir = realpathSync(dirname(abs));
    return dir === realRoot || dir.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);
  } catch {
    return false;
  }
}

/** Wraps a file's reader: every line redacted first, the redacted text kept for later checks while the cache allows. */
function redacting(
  path: string,
  read: () => Promise<string>,
  ctx: TextContext,
  cache: { map: Map<string, string>; bytes: number },
): () => Promise<string> {
  return async () => {
    const hit = cache.map.get(path);
    if (hit !== undefined) return hit;
    const text = redactLines(await read(), ctx);
    if (cache.bytes + text.length <= CACHE_BYTES) {
      cache.map.set(path, text);
      cache.bytes += text.length;
    }
    return text;
  };
}

/**
 * The working tree's files a check may see: tracked, not hidden, regular, allowed by the deny globs, inside the root
 * after resolving their directory, with their sizes (so `runCheck` skips an over-limit file unread). Shown locally only.
 */
export function localFiles(
  root: string,
  tracked: readonly string[],
  deny: readonly string[],
  o: { hidden?: ReadonlySet<string>; ctx?: TextContext } = {},
): CheckFile[] {
  const out: CheckFile[] = [];
  const cache = { map: new Map<string, string>(), bytes: 0 };
  for (const path of tracked) {
    if (!repoPathOk(path) || isDenied(path, deny) || o.hidden?.has(path)) continue;
    const abs = join(root, path);
    let size: number;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) continue; // symbolic links, submodules (directories), sockets: never read
      size = st.size;
    } catch {
      continue; // deleted in the working tree
    }
    if (!parentInside(root, abs)) continue;
    // Matched again on where the file really is (a directory renamed through a link inside the repository).
    const real = resolvedRelative(root, abs);
    if (real === null || !repoPathOk(real) || isDenied(real, deny) || o.hidden?.has(real)) continue;
    const raw = async () => readNoFollow(abs, DEFAULT_CHECK_LIMITS.maxFileBytes + 1);
    out.push({ path, size, read: o.ctx ? redacting(path, raw, o.ctx, cache) : raw });
  }
  return out;
}

/** HEAD's files a check may see (the same rules), read from the object store, never from the disk. */
function headFiles(
  entries: readonly { path: string; oid: string; size: number }[],
  reader: BlobReader,
  deny: readonly string[],
  hidden: ReadonlySet<string>,
  ctx: TextContext,
): CheckFile[] {
  const cache = { map: new Map<string, string>(), bytes: 0 };
  return entries
    .filter((e) => repoPathOk(e.path) && !isDenied(e.path, deny) && !hidden.has(e.path))
    .map((e) => ({
      path: e.path,
      size: Number.isSafeInteger(e.size) ? e.size : DEFAULT_CHECK_LIMITS.maxFileBytes + 1,
      read: redacting(e.path, () => reader.read(e.oid), ctx, cache),
    }));
}

/**
 * Only what may leave: a plain repository path the deny globs allow and that the laptop's path rules would leave as it
 * is (no username, hostname, email or secret in it: such a match is dropped rather than rewritten), a line number,
 * a rule name.
 */
export function safeMatches(matches: readonly CheckMatch[], deny: readonly string[], ctx?: TextContext): CheckMatch[] {
  return matches
    .filter(
      (m) =>
        repoPathOk(m.path) &&
        toSafeRelative(m.path) === m.path &&
        !isDenied(m.path, deny) &&
        (!ctx || redactText(m.path, ctx).text === m.path) &&
        Number.isInteger(m.line) &&
        m.line >= 0 &&
        m.line <= 10_000_000 &&
        RULE.test(m.rule),
    )
    .slice(0, 100)
    .map((m) => ({ path: m.path, line: m.line, rule: m.rule }));
}

/** The text rules of a redaction context (what `redactText` needs). */
export const textContext = (r: RedactionContext): TextContext => ({
  orgDomains: r.orgDomains,
  hostnames: r.hostnames,
  usernames: r.usernames,
});

/**
 * Runs each check over HEAD's blobs (`source: "head"`, the default: what is reported) or the working tree
 * (`"worktree"`: shown locally only), one at a time, each within its own 10 s and within the run's `deadline`.
 */
export async function runLocalChecks(
  root: string,
  checks: readonly LocalCheck[],
  o: {
    paths: Paths;
    ctx: TextContext;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    source?: Source;
    /** `head` source: the commit to read (from `reportCommit`); required for it. */
    commit?: string;
    /** Wall-clock time (ms, `Date.now()` scale) after which the remaining checks are `error` (`timeout`). */
    deadline?: number;
  },
): Promise<LocalResult[]> {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const source = o.source ?? "head";
  const deny = denyGlobsFor(o.paths, root);
  const hidden = await hiddenPaths(root, env);
  let files: CheckFile[] | null = null;
  let reader: BlobReader | null = null;
  if (hidden) {
    if (source === "head") {
      const entries = o.commit ? await headEntries(root, env, o.commit) : null;
      if (entries) {
        reader = new BlobReader(root, env);
        files = headFiles(entries, reader, deny, hidden, o.ctx);
      }
    } else {
      const tracked = await trackedPaths(root, env);
      if (tracked) files = localFiles(root, tracked, deny, { hidden, ctx: o.ctx });
    }
  }
  const out: LocalResult[] = [];
  try {
    for (const c of checks) {
      const started = now();
      if (!files) {
        out.push({ ...pick(c), result: "error", matches: [], duration_ms: 0, reason: "read_failed" });
        continue;
      }
      const left = o.deadline === undefined ? DEFAULT_CHECK_LIMITS.timeoutMs : o.deadline - Date.now();
      if (left <= 0) {
        out.push({ ...pick(c), result: "error", matches: [], duration_ms: 0, reason: "timeout" });
        continue;
      }
      const limits: Partial<CheckLimits> = { timeoutMs: Math.min(DEFAULT_CHECK_LIMITS.timeoutMs, left) };
      const r = await runCheck({ kind: c.kind, spec: c.spec }, files, limits);
      const matches = safeMatches(r.matches, deny, o.ctx);
      // A failing check whose every match was a path it may not name reports nothing it may not name: skipped.
      const result: CheckResult =
        r.result === "fail" && r.matches.length > 0 && matches.length === 0 ? "skipped" : r.result;
      out.push({
        ...pick(c),
        result,
        matches,
        duration_ms: Math.max(0, Math.min(600_000, Math.round(now() - started))),
        ...(r.reason ? { reason: r.reason } : {}),
      });
    }
  } finally {
    reader?.close();
  }
  return out;
}

const pick = (c: LocalCheck) => ({ check_id: c.check_id, entry_key: c.entry_key, kind: c.kind });
