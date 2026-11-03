/**
 * One uploader at a time (docs/15 §The hook fast path step 6, §The uploader): `spool/upload.lock` holds
 * `<pid> <heartbeat ms>`. A lock whose heartbeat is older than 60 s, or whose process is gone, is taken over; the
 * hooks spawn `align upload --daemon` only when no live uploader holds it, and a second daemon started in the same
 * moment finds the lock taken and exits at once.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, PRIVATE_MODE } from "../fsx";
import { accountHome } from "../hook/home";
import type { Paths } from "../paths";

export const HEARTBEAT_STALE_MS = 60_000;

type LockInfo = { pid: number; at: number };

/** A takeover mutex older than this was left by a process that died inside its few-millisecond critical section. */
export const TAKEOVER_STALE_MS = 5_000;

/** Leftover private files (`.new`, `.stale`, `.tmp`) of a process that died mid-step are swept after this. */
export const LEFTOVER_MS = 60_000;

function parseLock(text: string): LockInfo | null {
  const [pid, at] = text.trim().split(" ").map(Number);
  return pid && at ? { pid, at } : null;
}

/** The lock's text; null when there is no lock (or it cannot be read). */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readLock(paths: Paths, file = paths.uploadLock): LockInfo | null {
  const t = readText(file);
  return t === null ? null : parseLock(t);
}

const privateName = (base: string, kind: "new" | "stale" | "tmp") =>
  `${base}.${process.pid}.${randomBytes(4).toString("hex")}.${kind}`;

/** Writes `body` to a fresh private file next to `base` and returns its path. */
function writePrivate(base: string, body: string, kind: "new" | "tmp"): string {
  const tmp = privateName(base, kind);
  const fd = openSync(tmp, "wx", PRIVATE_MODE);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** Errors that mean this filesystem cannot make hard links at all (FAT, some network and FUSE mounts). */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/**
 * Creates `file` with `body` in one step, only if it does not exist: the body is written to a private file, then
 * linked in place (`link` fails if the target exists). An `open(wx)` and a write would show other processes an
 * empty file for a moment, which they would judge stale and take over: two daemons (seen on a slow CI machine;
 * D1240). On a filesystem without hard links it falls back to `open(wx)` and a write (`align doctor` says so, D1242).
 */
function createExclusive(file: string, body: string): boolean {
  let tmp: string | null = null;
  try {
    tmp = writePrivate(file, body, "new");
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (!NO_LINKS.has((e as NodeJS.ErrnoException).code ?? "")) return false;
    try {
      const fd = openSync(file, "wx", PRIVATE_MODE);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

/** Replaces `file` with `body` by one atomic rename: `file` never stops existing. */
function replaceAtomic(file: string, body: string): boolean {
  let tmp: string | null = null;
  try {
    tmp = writePrivate(file, body, "tmp");
    renameSync(tmp, file);
    tmp = null;
    return true;
  } catch {
    return false;
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const live = (l: LockInfo | null, now: number) => l !== null && now - l.at < HEARTBEAT_STALE_MS && alive(l.pid);

/** True when a live uploader holds the lock (fresh heartbeat, process still there). */
export function uploaderRunning(paths: Paths, now = Date.now()): boolean {
  return live(readLock(paths), now);
}

const takeoverPath = (paths: Paths) => `${paths.uploadLock}.takeover`;

/**
 * The takeover mutex (`upload.lock.takeover`, `<pid> <ms> <nonce>`): every takeover of a stale lock runs under it,
 * so two takeovers never interleave (D1242). It is held for a few milliseconds. A mutex whose holder is gone, or
 * that is older than TAKEOVER_STALE_MS, is broken by renaming it aside and checking that what moved is the one judged
 * stale; a fresh one moved by mistake is linked back. Only a holder that died inside the critical section leaves a
 * stale mutex, so the remaining race (three processes at that same moment) needs a crash first; and even then each
 * re-reads the lock under the mutex, so unless their steps interleave exactly, the second finds the first's fresh
 * lock and stops.
 */
function takeMutex(paths: Paths, now: number): string | null {
  const file = takeoverPath(paths);
  const body = `${process.pid} ${now} ${randomBytes(6).toString("hex")}\n`;
  if (createExclusive(file, body)) return body;
  const judged = readText(file);
  if (judged === null) return createExclusive(file, body) ? body : null;
  const held = parseLock(judged);
  if (held !== null && now - held.at < TAKEOVER_STALE_MS && alive(held.pid)) return null;
  const aside = privateName(file, "stale");
  try {
    renameSync(file, aside);
  } catch {
    return null;
  }
  const moved = readText(aside);
  if (moved !== judged) {
    try {
      linkSync(aside, file);
    } catch {
      // another process created a mutex meanwhile: theirs stays
    }
    rmSync(aside, { force: true });
    return null;
  }
  rmSync(aside, { force: true });
  return createExclusive(file, body) ? body : null;
}

function releaseMutex(paths: Paths, body: string): void {
  if (readText(takeoverPath(paths)) === body) rmSync(takeoverPath(paths), { force: true });
}

/**
 * Takes the lock for this process; false when a live uploader holds it. A free lock is created by link (one winner).
 * A stale one is taken over under the takeover mutex: the lock is read again there, replaced only if it is still the
 * very lock judged stale, and replaced by one rename, so the lock never disappears and no third process can slip in
 * between a takeover's steps (D1242; before, a takeover moved the lock aside and put a fresh one back, which left a
 * moment with no lock).
 */
export function tryLock(paths: Paths, now: number): boolean {
  ensureDir(dirname(paths.uploadLock));
  const body = `${process.pid} ${now}\n`;
  if (createExclusive(paths.uploadLock, body)) return true;
  const judged = readText(paths.uploadLock);
  if (judged === null) return createExclusive(paths.uploadLock, body);
  if (live(parseLock(judged), now)) return false;
  const mutex = takeMutex(paths, now);
  if (mutex === null) return false;
  try {
    const current = readText(paths.uploadLock);
    if (current === null) return createExclusive(paths.uploadLock, body);
    if (current !== judged || live(parseLock(current), now)) return false;
    if (!replaceAtomic(paths.uploadLock, body)) return false;
  } finally {
    releaseMutex(paths, mutex);
  }
  // Belt and braces: only the process whose pid is in the file goes on.
  return readLock(paths)?.pid === process.pid;
}

/**
 * Refreshes the heartbeat; false when the lock is not (or no longer) this process's (taken over: stop). The new
 * content replaces the lock by one atomic rename, so the lock never stops existing: moving it aside first (as this
 * did before D1240) left a moment with no lock, in which a daemon started at the same time took it, and both started.
 * Between the read and the rename only a takeover can intervene, and a takeover needs this heartbeat to be 60 s old
 * already (or this process gone); then the other holder's next heartbeat finds this pid and stops, so one stays.
 */
export function heartbeat(paths: Paths, now: number): boolean {
  if (readLock(paths)?.pid !== process.pid) return false;
  return replaceAtomic(paths.uploadLock, `${process.pid} ${now}\n`);
}

/**
 * Removes the private files (`upload.lock.*.new`, `.stale`, `.tmp`) a process left when it died mid-step, once they
 * are older than LEFTOVER_MS by the file system's clock (the uploader's housekeeping; never the hook, which never
 * lists the spool).
 */
export function sweepLockLeftovers(paths: Paths): number {
  const dir = dirname(paths.uploadLock);
  const prefix = `${basename(paths.uploadLock)}.`;
  const cutoff = Date.now() - LEFTOVER_MS;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!n.startsWith(prefix) || !/\.\d+\.[0-9a-f]{8}\.(new|stale|tmp)$/.test(n)) continue;
    const f = join(dir, n);
    try {
      if (statSync(f).mtimeMs < cutoff) {
        rmSync(f, { force: true });
        removed++;
      }
    } catch {
      // gone meanwhile
    }
  }
  return removed;
}

/** Whether the file system holding `dir` (which must exist) can make hard links (the lock's create; `align doctor`). */
export function hardLinksWork(dir: string): boolean {
  let src: string | null = null;
  const dst = join(dir, `.align-link-probe.${process.pid}.${randomBytes(4).toString("hex")}`);
  try {
    src = writePrivate(join(dir, ".align-link-probe"), "", "tmp");
    linkSync(src, dst);
    return true;
  } catch {
    return false;
  } finally {
    if (src) rmSync(src, { force: true });
    rmSync(dst, { force: true });
  }
}

export function unlock(paths: Paths): void {
  if (readLock(paths)?.pid === process.pid) rmSync(paths.uploadLock, { force: true });
}

/**
 * The only variables the detached uploader inherits. `HOME` is not one: it is set from the password database
 * (hook/home.ts `accountHome`), never passed on from a harness (L16 review round 4, D276).
 */
export const UPLOADER_ENV = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;

/**
 * Starts `align upload --daemon` detached from the hook (stdio ignored, own process group) unless one is running.
 * Only an installed bundle is spawned; the child finds its home from its own location (hook/home.ts) and gets no
 * `ALIGN_*` or `GIT_*` variable from the hook's environment.
 */
export function spawnUploader(paths: Paths, bundlePath: string | null, nodePath = process.execPath): boolean {
  if (!bundlePath || uploaderRunning(paths)) return false;
  try {
    // An allow-list, not a deny-list: a harness can set NODE_OPTIONS, NODE_EXTRA_CA_CERTS or proxy variables for its
    // hooks, and none of them may reach the process that holds the tokens.
    const env: NodeJS.ProcessEnv = {};
    for (const k of UPLOADER_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const home = accountHome();
    if (home) env.HOME = home;
    const child = spawn(nodePath, [bundlePath, "upload", "--daemon"], {
      detached: true,
      stdio: "ignore",
      env,
      cwd: paths.home,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
