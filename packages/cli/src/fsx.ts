/**
 * File helpers for `~/.align`: user-only directories (0700), atomic writes (tmp + rename) with an explicit
 * mode, JSON reads that survive a missing or corrupt file, and an exclusive lock file.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const DIR_MODE = 0o700;
export const PRIVATE_MODE = 0o600;

/** Creates a directory (and parents) and makes it user-only, also when it already existed. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

/** Writes a file atomically with the given mode; the parent directory is created user-only. */
export function writeFileAtomic(path: string, data: string, mode = PRIVATE_MODE): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Writes a file in a directory that belongs to the person (their repository), atomically, keeping the
 * directory's own permissions: missing parents are created with the default mode, existing ones are not chmodded.
 */
export function writeUserFileAtomic(path: string, data: string, mode: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // The directory as it resolves now; if it resolves elsewhere by the time of the rename (a symbolic link swapped in),
  // nothing is renamed into it (L16 review).
  const before = realpathSync(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    if (realpathSync(dir) !== before) throw new Error("directory moved");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeJsonAtomic(path: string, value: unknown, mode = PRIVATE_MODE): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Reads JSON; a missing, unreadable or corrupt file gives `undefined` (callers validate the shape). */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A JSON file that exists but does not parse or does not match its schema. */
export class CorruptFileError extends Error {
  override readonly name = "CorruptFileError";
  constructor(readonly path: string) {
    super("corrupt file");
  }
}

/**
 * Reads a JSON file against a parser: missing → `fallback`; present and valid → the value; present and invalid
 * → `CorruptFileError` (the caller decides: refuse to write, or move the file aside with `moveAside`).
 */
export function readJsonFile<T>(path: string, parse: (v: unknown) => T | null, fallback: () => T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw new CorruptFileError(path);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CorruptFileError(path);
  }
  const v = parse(json);
  if (v === null) throw new CorruptFileError(path);
  return v;
}

/** Renames a corrupt file to `<path>.corrupt-<time>` (kept, user-only) so a fresh one can be written. */
export function moveAside(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    // already gone
  }
}

export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` while holding `lockPath` (created with O_EXCL). A lock older than `staleMs` is taken over (a
 * crashed process); waiting longer than `waitMs` throws. Synchronous on purpose: the guarded sections are a
 * read-modify-write of a small JSON file.
 */
export function withLock<T>(lockPath: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  const waitMs = opts.waitMs ?? 3000;
  const staleMs = opts.staleMs ?? 10_000;
  ensureDir(dirname(lockPath));
  const deadline = Date.now() + waitMs;
  const nonce = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", PRIVATE_MODE);
      writeSync(fd, nonce);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      takeOverIfStale(lockPath, staleMs);
      if (Date.now() > deadline) throw new Error("lock busy");
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    // Only our own lock is removed: if it was taken over meanwhile, the other holder's file stays.
    if (readText(lockPath) === nonce) rmSync(lockPath, { force: true });
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Takes over a stale lock: the stale file is renamed to a unique name (atomic; only one process wins) and
 * removed only if it still holds the content judged stale, else it is put back (another process took the
 * lock in between).
 */
function takeOverIfStale(lockPath: string, staleMs: number): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return;
    const judged = readText(lockPath);
    const aside = `${lockPath}.${randomBytes(4).toString("hex")}.stale`;
    renameSync(lockPath, aside);
    if (readText(aside) === judged) rmSync(aside, { force: true });
    else renameSync(aside, lockPath);
  } catch {
    // removed or renamed by another process meanwhile
  }
}
