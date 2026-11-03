/**
 * The spool on disk (docs/15 §Files): `spool/<repo hash>/<time>-<random>.json`, each `{version, root, repo_id,
 * events, attempts?}` written atomically by the hooks, the git hooks and the transcript reader, already redacted.
 * The uploader lists them oldest first, rewrites a file with the events still to send, and deletes it when none
 * remain. Events refused with a final code move to `spool/rejected/` with their code; events whose redaction did
 * not settle move to `spool/held/` and are never uploaded (L10's follow-up). Both keep the repository's folder name.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isRecord, isString } from "../check";
import { writeJsonAtomic } from "../fsx";
import type { TraceEvent } from "../hook/events";
import { logCount } from "../hook/log";
import type { Paths } from "../paths";

/** docs/15 §The uploader: spool cap 50 MB, oldest dropped with a logged count. */
export const SPOOL_CAP_BYTES = 50 * 1024 * 1024;
/** `rejected/` and `held/` keep at most this much each (oldest dropped, counted). */
export const SIDE_CAP_BYTES = 5 * 1024 * 1024;

const REPO_DIR = /^[0-9a-f]{16}$/;
const FILE = /^\d{14}-[0-9a-f]{12}\.json$/;

export type SpoolEntry = { path: string; repoDir: string; name: string };

export type SpoolFile = { version: 1; root: string; repo_id: string; events: TraceEvent[]; attempts: number };

const eventOk = (e: unknown): e is TraceEvent =>
  isRecord(e) && isString(e.event_id) && isString(e.kind) && isRecord(e.harness) && isRecord(e.session);

/** Every spool file, oldest first (the name starts with the time it was written). */
export function listSpool(paths: Paths): SpoolEntry[] {
  const out: SpoolEntry[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(paths.spool);
  } catch {
    return out;
  }
  for (const repoDir of dirs) {
    if (!REPO_DIR.test(repoDir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(join(paths.spool, repoDir));
    } catch {
      continue;
    }
    for (const name of names) if (FILE.test(name)) out.push({ path: join(paths.spool, repoDir, name), repoDir, name });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A spool file, or null when it is gone, unreadable or not the shape the writers produce. */
export function readSpoolFile(path: string): SpoolFile | null | "gone" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "gone";
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isRecord(v) || v.version !== 1 || !isString(v.root) || !isString(v.repo_id) || !Array.isArray(v.events))
      return null;
    if (!v.events.every(eventOk)) return null;
    const attempts = typeof v.attempts === "number" && Number.isSafeInteger(v.attempts) ? v.attempts : 0;
    return { version: 1, root: v.root, repo_id: v.repo_id, events: v.events, attempts };
  } catch {
    return null;
  }
}

const fileName = (now: number) => `${String(now).padStart(14, "0")}-${randomBytes(6).toString("hex")}.json`;

/** Writes events as a new spool file in a repository's folder (tmp + rename); returns its path. */
export function writeSpoolFile(
  paths: Paths,
  repoDir: string,
  body: Omit<SpoolFile, "version">,
  now: number,
): string | null {
  if (body.events.length === 0) return null;
  const file = join(paths.spool, repoDir, fileName(now));
  writeJsonAtomic(file, { version: 1, ...body });
  return file;
}

/** Replaces a spool file with the events still to send, or deletes it when none remain. */
export function rewriteSpoolFile(entry: SpoolEntry, file: SpoolFile, remaining: TraceEvent[]): void {
  if (remaining.length === 0) {
    rmSync(entry.path, { force: true });
    return;
  }
  if (remaining.length === file.events.length) return;
  // A file deleted meanwhile (`align off`, `uninstall`, the cap) stays deleted: never written back.
  if (!existsSync(entry.path)) return;
  writeJsonAtomic(entry.path, { ...file, events: remaining });
}

export type SideKind = "rejected" | "held";

/** Keeps events aside (`rejected/` with each one's code, or `held/`), never to be uploaded again. */
export function setAside(
  paths: Paths,
  kind: SideKind,
  entry: SpoolEntry,
  file: Pick<SpoolFile, "root" | "repo_id">,
  items: { event: unknown; code: string }[],
  now: number,
): void {
  if (items.length === 0) return;
  const dir = join(kind === "rejected" ? paths.rejected : paths.held, entry.repoDir);
  writeJsonAtomic(join(dir, fileName(now)), { version: 1, root: file.root, repo_id: file.repo_id, items });
}

/** A spool file that does not parse is moved to `rejected/` whole, as it is (never sent, never lost silently). */
export function quarantineUnreadable(paths: Paths, entry: SpoolEntry): void {
  try {
    const dir = join(paths.rejected, entry.repoDir);
    writeJsonAtomic(join(dir, `${basename(entry.name, ".json")}.unreadable`), { version: 1, unreadable: true });
    renameSync(entry.path, join(dir, `${entry.name}.raw`));
  } catch {
    rmSync(entry.path, { force: true });
  }
}

type Sized = { path: string; size: number; at: number };

function filesUnder(dir: string, depth: number): Sized[] {
  const out: Sized[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (depth > 0) {
      if (REPO_DIR.test(n)) out.push(...filesUnder(p, depth - 1));
      continue;
    }
    if (!n.endsWith(".json") && !n.endsWith(".raw") && !n.endsWith(".unreadable")) continue;
    try {
      const st = statSync(p);
      if (st.isFile()) out.push({ path: p, size: st.size, at: st.mtimeMs });
    } catch {
      // gone
    }
  }
  return out;
}

/** Files and bytes under the spool (or `rejected/`, `held/`), and the oldest file's time. */
export function spoolStats(dir: string): { files: number; bytes: number; oldest: number | null } {
  const files = filesUnder(dir, 1);
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    oldest: files.reduce<number | null>((m, f) => (m === null || f.at < m ? f.at : m), null),
  };
}

/** Events kept aside in `rejected/` or `held/` (doctor and status count them). */
export function countAside(dir: string): number {
  let n = 0;
  for (const f of filesUnder(dir, 1)) {
    try {
      const v = JSON.parse(readFileSync(f.path, "utf8")) as { items?: unknown[] };
      n += Array.isArray(v.items) ? v.items.length : 1;
    } catch {
      n += 1;
    }
  }
  return n;
}

function dropOldest(files: Sized[], cap: number): number {
  let total = files.reduce((n, f) => n + f.size, 0);
  let dropped = 0;
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= cap) break;
    rmSync(f.path, { force: true });
    total -= f.size;
    dropped++;
  }
  return dropped;
}

/** Applies the caps: 50 MB of spool, 5 MB each of `rejected/` and `held/`; drops are counted in the log. */
export function enforceCaps(paths: Paths, caps = { spool: SPOOL_CAP_BYTES, side: SIDE_CAP_BYTES }): void {
  const dropped = dropOldest(filesUnder(paths.spool, 1), caps.spool);
  if (dropped > 0) logCount(paths.logs, "spool", "dropped_over_cap", dropped);
  for (const kind of ["rejected", "held"] as const) {
    const n = dropOldest(filesUnder(kind === "rejected" ? paths.rejected : paths.held, 1), caps.side);
    if (n > 0) logCount(paths.logs, "spool", `${kind}_dropped_over_cap`, n);
  }
}
