/**
 * The Claude Code transcript reader (docs/10 §Transcript readers). The format is internal to Claude Code and
 * changes between versions, so every field is checked and anything unexpected is dropped, never passed on.
 *
 * Kept: entries with `type` `user` or `assistant` — a string `message.content`, `text` blocks, and `tool_use`
 * blocks as a tool line (`name`, the input's size in bytes, paths from `input.file_path`, `input.path`,
 * `input.notebook_path`, `input.paths[]`; never the input itself). Dropped: `tool_result` blocks, `thinking` and
 * `redacted_thinking` blocks, images, sidechain (subagent) entries, meta entries, compact summaries, API error
 * entries, every other entry type (`system`, `attachment`, `api-request*`, `queue-operation`, …), user strings that
 * are harness wrappers (`<command-name>`, `<local-command-stdout>`, `<task-notification>`, `<bash-input>`, and any
 * string that is wholly one tag), entries whose `cwd` is outside the repository or in a nested repository, and any text carrying the pack marker. Fenced code blocks are
 * replaced (`keepText`). Shapes recorded from 2.1.307 are in `__fixtures__/claude-code-2.1.307/`.
 *
 * Each emitted line gets the session's next `n` and `src: jsonl:<line number in the file>`; one entry can give
 * several lines (text, then a tool line), all with the same `src` (docs/10 §Line numbers).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RawLine } from "../../transcripts/reader";
import { carriesPack, isWrapper, keepText } from "../../transcripts/text";

export type ToolInfo = { name: string; bytes: number; paths: string[] };

export type Line = {
  n: number;
  src: string;
  role: "user" | "assistant" | "tool";
  text: string;
  ts?: string;
  tool?: ToolInfo;
};

export type ConvertStats = { entries: number; kept: number; dropped: number; malformed: number };

export type ConvertResult = {
  lines: Line[];
  nextN: number;
  stats: ConvertStats;
  /** Claude Code's version, from the entries' `version` field. */
  version: string | null;
  /** Entries that had a recognisable `type` (zero over many lines means the format changed). */
  recognised: number;
  /** Reader state carried to the next read of the same file (which working directory the last lines were in). */
  carry: Carry;
};

/** Whether the lines read last belong to the repository (from the last working directory seen), and whether the
 * file is a subagent's. Saved with the cursor so a read that starts mid-file judges its first lines the same way. */
export type Carry = { owned: boolean; subagent?: boolean; thread?: string; cwd?: string };

export type ConvertOptions = {
  root: string;
  nextN: number;
  carry?: Carry;
  /** Whether a repository-relative path is denied (`.aligndeny` and the defaults), for tool paths reached through links. */
  denied?: (rel: string) => boolean;
};

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION = /^[\w.+-]{1,64}$/;
const MAX_PATHS = 50;

/**
 * Claude Code's built-in file tools: only their inputs name repository paths. Any other tool (MCP tools, Bash, web
 * tools, a plugin's tools) can put anything in a field called `path` — a note title, a URL, a query — so its line
 * keeps only the name and the byte count (L12 security review).
 */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
]);

/** Paths from a tool input's documented path fields only; at most 50, strings only. */
export function toolPaths(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && v.length <= 1024 && out.length < MAX_PATHS && !out.includes(v))
      out.push(v);
  };
  add(input.file_path);
  add(input.path);
  add(input.notebook_path);
  if (Array.isArray(input.paths)) for (const p of input.paths) add(p);
  return out;
}

export function inputBytes(input: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(input ?? null), "utf8");
  } catch {
    return 0;
  }
}

/** True when `cwd` is the repository root or inside it (exact path prefix; the root is already resolved). */
export function insideRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * True when `cwd` belongs to this repository: inside the root (also after resolving symlinks) and not inside a
 * nested repository (no `.git` in any directory between the root, exclusive, and `cwd`, inclusive). A nested clone
 * or submodule is its own repository (D81, hard rule 6); its lines are never this repository's.
 */
export function ownedByRoot(cwd: string, root: string): boolean {
  // Resolved first, so a symlinked path is judged by where it really is (and the `.git` walk follows real folders).
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    dir = cwd;
  }
  if (!insideRoot(dir, root)) return false;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  while (dir.length > base.length) {
    if (existsSync(join(dir, ".git"))) return false;
    dir = dirname(dir);
  }
  return true;
}

/**
 * A tool path written through a symlinked spelling of the repository (`/tmp/x` for `/private/tmp/x`, a linked home)
 * is mapped onto the real root, so it stays a repository path instead of being dropped as outside. Paths already
 * under the root, relative paths and paths that resolve elsewhere are returned as they are.
 */
export function realUnderRoot(path: string, root: string): string {
  if (!path.startsWith("/") || insideRoot(path, root)) return path;
  let head = path;
  const tail: string[] = [];
  while (head !== "/" && head.length > 0) {
    try {
      const real = realpathSync(head);
      const mapped = tail.length ? join(real, ...tail.reverse()) : real;
      return insideRoot(mapped, root) ? mapped : path;
    } catch {
      tail.push(head.slice(head.lastIndexOf("/") + 1));
      head = dirname(head);
    }
  }
  return path;
}

/** Where `path` really is: symlinks resolved, also for a file not yet written under a linked folder; null when nothing resolves. */
function realOf(path: string): string | null {
  let head = path;
  const tail: string[] = [];
  while (head !== "/" && head.length > 0) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...[...tail].reverse()) : real;
    } catch {
      tail.push(basename(head));
      head = dirname(head);
    }
  }
  return null;
}

/**
 * A tool path inside the repository that reaches its file through a symlink is matched by both names: when the target
 * is denied (`notes.txt` → `.env.production`, `cfg/` → `deploy/secrets/`), the target's spelling is returned so the
 * deny globs remove it; a target outside the repository is returned too, so the path is dropped as outside. Otherwise
 * the name the agent used is kept (a denied link name is still denied by it). L12 review round 4.
 */
export function throughLinks(path: string, root: string, denied?: (rel: string) => boolean): string {
  if (!path.startsWith("/")) return path;
  const lexical = resolve(path);
  if (!insideRoot(lexical, root) || lexical === root) return path;
  const real = realOf(lexical);
  if (real === null || real === lexical) return path;
  if (real !== root && !insideRoot(real, root)) return real;
  const rel = real === root ? "." : real.slice((root.endsWith("/") ? root : `${root}/`).length);
  return denied?.(rel) ? real : path;
}

export function convertLines(raw: RawLine[], o: ConvertOptions): ConvertResult {
  const lines: Line[] = [];
  const stats: ConvertStats = { entries: 0, kept: 0, dropped: 0, malformed: 0 };
  let n = o.nextN;
  let version: string | null = null;
  let recognised = 0;
  const cwdCache = new Map<string, boolean>();
  const owned = (cwd: string) => {
    let v = cwdCache.get(cwd);
    if (v === undefined) {
      v = ownedByRoot(cwd, o.root);
      cwdCache.set(cwd, v);
    }
    return v;
  };
  // An entry without a cwd takes the verdict (and the cwd) of the last entry that had one; none seen yet → dropped.
  // The verdict and the cwd carry over from the previous chunk (L13; the cwd since the #43 chain re-review), so a pass
  // that starts mid-file resolves relative tool paths as the earlier pass would; without either, against the root.
  let lastVerdict = o.carry?.owned ?? false;
  let lastCwd: string | null = o.carry?.cwd ?? null;
  const pathCache = new Map<string, string>();
  // A relative tool path is resolved against its entry's cwd first, so links on its way are seen too (round 5).
  const mapPath = (p: string) => {
    const key = `${lastCwd ?? ""}\u0000${p}`;
    let v = pathCache.get(key);
    if (v === undefined) {
      const base = lastCwd?.startsWith("/") ? lastCwd : o.root;
      const abs = !p.startsWith("/") && !p.startsWith("~") ? resolve(base, p) : p;
      v = throughLinks(realUnderRoot(abs, o.root), o.root, o.denied);
      pathCache.set(key, v);
    }
    return v;
  };

  for (const { text: rawText, lineNo } of raw) {
    if (rawText.trim() === "") continue;
    stats.entries++;
    let entry: unknown;
    try {
      entry = JSON.parse(rawText);
    } catch {
      stats.malformed++;
      continue;
    }
    if (!isRecord(entry) || typeof entry.type !== "string") {
      stats.malformed++;
      continue;
    }
    recognised++;
    if (version === null && typeof entry.version === "string" && VERSION.test(entry.version)) version = entry.version;
    if (typeof entry.cwd === "string") {
      lastVerdict = owned(entry.cwd);
      lastCwd = entry.cwd;
    } else if (entry.cwd !== undefined) {
      lastVerdict = false;
      lastCwd = null;
    }
    const out = lastVerdict ? entryLines(entry, mapPath) : [];
    if (out.length === 0) {
      stats.dropped++;
      continue;
    }
    stats.kept++;
    const ts = typeof entry.timestamp === "string" && ISO_TS.test(entry.timestamp) ? entry.timestamp : undefined;
    for (const l of out) {
      lines.push({ n: n++, src: `jsonl:${lineNo}`, ...l, ...(ts ? { ts } : {}) });
    }
  }
  return {
    lines,
    nextN: n,
    stats,
    version,
    recognised,
    carry: { owned: lastVerdict, ...(lastCwd?.startsWith("/") && lastCwd.length <= 4096 ? { cwd: lastCwd } : {}) },
  };
}

type Partial = Omit<Line, "n" | "src" | "ts">;

function entryLines(entry: Rec, mapPath: (p: string) => string): Partial[] {
  if (entry.type !== "user" && entry.type !== "assistant") return [];
  if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) return [];
  if (entry.isApiErrorMessage === true || entry.isVisibleInTranscriptOnly === true) return [];
  const message = entry.message;
  if (!isRecord(message)) return [];
  const role = entry.type;
  if (message.role !== undefined && message.role !== role) return [];
  const content = message.content;
  const out: Partial[] = [];

  const pushText = (value: unknown) => {
    if (typeof value !== "string") return;
    if (role === "user" && isWrapper(value)) return;
    const kept = keepText(value);
    if (kept !== null) out.push({ role, text: kept });
  };

  if (typeof content === "string") {
    pushText(content);
    return out;
  }
  if (!Array.isArray(content)) return [];
  if (carriesPack(content)) return [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") pushText(block.text);
    else if (block.type === "tool_use" && role === "assistant") {
      const name = typeof block.name === "string" && TOOL_NAME.test(block.name) ? block.name : "unknown";
      const bytes = inputBytes(block.input);
      out.push({
        role: "tool",
        text: `‹tool: ${name}, ${bytes} bytes›`,
        tool: {
          name,
          bytes,
          paths: FILE_TOOLS.has(name) ? toolPaths(block.input).map(mapPath) : [],
        },
      });
    }
    // tool_result, thinking, redacted_thinking, image, document and anything new: dropped.
  }
  return out;
}
