/**
 * Finds a repository's past sessions on this laptop (docs/10 §Backfill sources). Nothing is read beyond what is
 * needed to decide whether a file belongs to the repository (its first megabyte at most); nothing leaves the machine
 * here. Each harness has its own matching rule, and every rule fails closed: a file is a candidate only when the
 * file itself, or the filesystem, proves that it was recorded in this repository.
 *
 * - Claude Code: `~/.claude/projects/<encode(root)>*` (every non-alphanumeric → `-`, so `my_repo` and `my-repo`
 *   share a folder name, and a sub-directory's sessions live in `<encode(root)>-sub`), then **always** a `cwd`
 *   inside the file that is the root or below it and not inside a nested repository.
 * - Codex: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` whose `session_meta.payload.cwd` is inside the root
 *   (a subagent's rollout is skipped whole, as the live reader does).
 * - Cursor: `~/.cursor/projects/<encode(root)>*` /agent-transcripts/<id>/<id>.jsonl. Cursor's transcripts record no
 *   workspace path (agent CLI 2026.10.19), so only the folder named exactly `encode(root)` is used, and only when the
 *   name decodes to exactly one existing directory, the root: a look-alike (`my_repo` beside `my-repo`) makes the
 *   folder ambiguous and nothing is taken from it (D268).
 */
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { HarnessName } from "../commands/harness";
import { ownedByRoot } from "../harness/claude-code/transcript";
import { encodeCursorProject } from "../harness/cursor/transcript";
import { SESSION_ID } from "../harness/hooks";

export const DAY_MS = 86_400_000;
/** How much of a file's head is read to find its working directory and first time. */
export const HEAD_BYTES = 1024 * 1024;
/** At most this many files per harness are looked at (a very large history is cut, newest kept). */
export const MAX_FILES_PER_HARNESS = 5000;

export type Found = {
  harness: HarnessName;
  harnessSessionId: string;
  file: string;
  size: number;
  /** Last activity (file time), the window and the recent-first order use it. */
  mtimeMs: number;
  /** When the session started: the first time recorded in the file, else the file's time. */
  startedAt: number;
};

export type ScanOptions = {
  root: string;
  /** Other spellings of the root (the path the person started in before symlinks were resolved). */
  spellings?: string[];
  home: string;
  codexHome: string;
  harnesses: readonly HarnessName[];
  since: number;
};

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Claude Code's project folder name for a path (docs/10). */
export const encodeClaudeProject = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

const list = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** A regular file's size and time (never through a FIFO or a device); null otherwise. */
function fileInfo(path: string): { size: number; mtimeMs: number; birthtimeMs: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs } : null;
  } finally {
    closeSync(fd);
  }
}

/** The complete lines in the first `max` bytes of a file, parsed; unparseable ones skipped. */
export function headEntries(path: string, max = HEAD_BYTES): Rec[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    if (!fstatSync(fd).isFile()) return [];
    const buf = Buffer.alloc(max);
    let got = 0;
    while (got < max) {
      const n = readSync(fd, buf, got, max - got, got);
      if (n === 0) break;
      got += n;
    }
    const end = got < max ? got : buf.lastIndexOf(0x0a, got - 1) + 1;
    const out: Rec[] = [];
    for (const line of buf.toString("utf8", 0, end).split("\n")) {
      if (line.trim() === "") continue;
      try {
        const v = JSON.parse(line) as unknown;
        if (isRecord(v)) out.push(v);
      } catch {
        // a malformed line: skipped
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

const tsOf = (v: unknown): number | null => {
  if (typeof v !== "string" || !ISO_TS.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

function scanClaudeCode(o: ScanOptions): Found[] {
  const projects = join(o.home, ".claude", "projects");
  const prefixes = [...new Set([o.root, ...(o.spellings ?? [])])].map(encodeClaudeProject);
  const out: Found[] = [];
  for (const d of list(projects)) {
    if (!d.isDirectory() || !prefixes.some((p) => d.name.startsWith(p))) continue;
    const dir = join(projects, d.name);
    for (const f of list(dir)) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = join(dir, f.name);
      const info = fileInfo(file);
      if (!info || info.mtimeMs < o.since) continue;
      const id = basename(f.name, ".jsonl");
      if (!SESSION_ID.test(id)) continue;
      // Always confirmed from inside the file: the folder name alone cannot tell my_repo from my-repo.
      const head = headEntries(file);
      const owned = head.some((e) => typeof e.cwd === "string" && ownedByRoot(e.cwd, o.root));
      if (!owned) continue;
      const first = head.map((e) => tsOf(e.timestamp)).find((t) => t !== null) ?? null;
      out.push({
        harness: "claude-code",
        harnessSessionId: id,
        file,
        size: info.size,
        mtimeMs: info.mtimeMs,
        startedAt: first ?? info.mtimeMs,
      });
    }
  }
  return out;
}

function scanCodex(o: ScanOptions): Found[] {
  const sessions = join(o.codexHome, "sessions");
  const out: Found[] = [];
  // Day folders older than the window (a day of margin for time zones) are not opened.
  const oldestDay = new Date(o.since - DAY_MS).toISOString().slice(0, 10);
  for (const y of list(sessions)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const m of list(join(sessions, y.name))) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      for (const d of list(join(sessions, y.name, m.name))) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        if (`${y.name}-${m.name}-${d.name}` < oldestDay) continue;
        const dir = join(sessions, y.name, m.name, d.name);
        for (const f of list(dir)) {
          if (!f.isFile() || !/^rollout-.*\.jsonl$/.test(f.name)) continue;
          const file = join(dir, f.name);
          const info = fileInfo(file);
          if (!info || info.mtimeMs < o.since) continue;
          const meta = headEntries(file, 256 * 1024).find((e) => e.type === "session_meta");
          const p = meta && isRecord(meta.payload) ? meta.payload : null;
          if (!p || typeof p.cwd !== "string" || !ownedByRoot(p.cwd, o.root)) continue;
          // A subagent's rollout (a thread spawned by another) is skipped whole, as live capture skips it.
          if (isRecord(p.source) && ("subagent" in p.source || "sub_agent" in p.source)) continue;
          const id = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : null;
          if (!id || !SESSION_ID.test(id)) continue;
          out.push({
            harness: "codex",
            harnessSessionId: id,
            file,
            size: info.size,
            mtimeMs: info.mtimeMs,
            startedAt: tsOf(p.timestamp) ?? tsOf(meta?.timestamp) ?? info.mtimeMs,
          });
        }
      }
    }
  }
  return out;
}

/** Directories listed while decoding one name; past it the name counts as ambiguous (fails closed). */
export const DECODE_MAX_LISTINGS = 4000;

/**
 * Every existing directory whose path Cursor would encode as `name` (at most `limit` distinct real paths), found by
 * walking down from `/` one encoded segment at a time. A segment that encodes to nothing (only punctuation or
 * non-Latin letters: `_`, `-`, `项目`) is transparent to the encoding, so the walk also goes into it with the same
 * remaining name. Two answers mean the name is ambiguous on this disk; so does a walk that grows too large (it returns
 * a second, impossible answer rather than guessing).
 */
export function decodeCursorProject(name: string, limit = 4): string[] {
  const real = new Set<string>();
  let listings = 0;
  let exhausted = false;
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const found = (p: string) => {
    try {
      real.add(realpathSync(p));
    } catch {
      // gone meanwhile
    }
  };
  const walk = (dir: string, rest: string, depth: number) => {
    if (real.size >= limit || exhausted || depth > 64) return;
    if (++listings > DECODE_MAX_LISTINGS) {
      exhausted = true;
      return;
    }
    for (const e of list(dir)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      if (e.isSymbolicLink() && !isDir(path)) continue;
      // The name as stored and in both Unicode forms (a filesystem may keep either; Cursor encodes what it was
      // given): a form that encodes to nothing makes the segment transparent, and every other form is tried as a match.
      const forms = new Set([e.name, e.name.normalize("NFC"), e.name.normalize("NFD")].map(encodeCursorProject));
      for (const enc of forms) {
        if (enc === "") walk(path, rest, depth + 1);
        else if (rest === enc) found(path);
        else if (rest.startsWith(`${enc}-`)) walk(path, rest.slice(enc.length + 1), depth + 1);
        if (real.size >= limit || exhausted) return;
      }
    }
  };
  walk("/", name, 0);
  if (exhausted) real.add("\0too-many-candidates");
  return [...real];
}

/**
 * When the root's `.git` was created: its birth time, or, on a filesystem that records none, the time of
 * `.git/description` (written once by `git init` and `git clone`, rarely touched after). Never the inode change time,
 * which any later change to `.git` moves. Null when neither is known. `stat` is replaceable for tests.
 */
export function gitBirth(
  root: string,
  stat: (p: string) => { birthtimeMs: number; mtimeMs: number } = statSync,
): number | null {
  try {
    const born = stat(join(root, ".git")).birthtimeMs;
    if (Number.isFinite(born) && born > 0) return born;
  } catch {
    return null;
  }
  try {
    const t = stat(join(root, ".git", "description")).mtimeMs;
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

function scanCursor(o: ScanOptions): Found[] {
  const projects = join(o.home, ".cursor", "projects");
  const exact = encodeCursorProject(o.root);
  const out: Found[] = [];
  for (const d of list(projects)) {
    if (!d.isDirectory() || d.name !== exact) continue;
    const decoded = decodeCursorProject(d.name);
    if (decoded.length !== 1 || decoded[0] !== o.root) continue;
    // A transcript older than the repository's `.git` was recorded in an earlier directory at this path (a deleted
    // clone of something else): never this repository's.
    const born = gitBirth(o.root);
    const transcripts = join(projects, d.name, "agent-transcripts");
    for (const c of list(transcripts)) {
      if (!c.isDirectory() || !SESSION_ID.test(c.name)) continue;
      const file = join(transcripts, c.name, `${c.name}.jsonl`);
      const info = fileInfo(file);
      if (!info || info.mtimeMs < o.since || (born !== null && info.mtimeMs < born)) continue;
      out.push({
        harness: "cursor",
        harnessSessionId: c.name,
        file,
        size: info.size,
        mtimeMs: info.mtimeMs,
        startedAt: info.birthtimeMs > 0 && info.birthtimeMs <= info.mtimeMs ? info.birthtimeMs : info.mtimeMs,
      });
    }
  }
  return out;
}

/** The repository's sessions in the chosen harnesses within the window, most recent first. */
export function scanHistory(o: ScanOptions): Found[] {
  const out: Found[] = [];
  const pick = (found: Found[]) =>
    out.push(...found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES_PER_HARNESS));
  if (o.harnesses.includes("claude-code")) pick(scanClaudeCode(o));
  if (o.harnesses.includes("codex")) pick(scanCodex(o));
  if (o.harnesses.includes("cursor")) pick(scanCursor(o));
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
