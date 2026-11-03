/**
 * `~/.align/repos/<hash>/backfill.json` (docs/15 §Files): per harness session, the ALIGN id, the file's size and
 * time when it was read, whether its events were spooled and whether the server was asked to compile it. A rerun
 * skips a session whose file has not changed since it was handed over, and a crash resumes: spooled sessions are
 * sent by the uploader, and sessions not yet handed over are posted on the next run. Counts and ids only; never text.
 * A corrupt file is moved aside (the event ids are derived, so starting again stores nothing twice).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInt, isNumber, isRecord, isString, recordOf } from "../check";
import { CorruptFileError, moveAside, readJsonFile, writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export type BackfillEntry = {
  id: string;
  harness: string;
  size: number;
  mtime: number;
  /** Nothing in the file belonged to the repository: never uploaded, skipped until it changes. */
  empty: boolean;
  spooled: boolean;
  posted: boolean;
  /** The server refused its events with a final code, or some were held back (`spool/rejected/`, `spool/held/`). */
  refused?: boolean;
  /** The uploader reported at least one of its events stored (or already stored) by the server. */
  sent?: boolean;
};

export type BackfillFile = {
  version: 1;
  sessions: Record<string, BackfillEntry>;
  last: { backfill_id: string; at: number } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const parseEntry = (x: unknown): BackfillEntry | null =>
  isRecord(x) &&
  isString(x.id) &&
  UUID.test(x.id) &&
  isString(x.harness) &&
  isInt(x.size, 0) &&
  isNumber(x.mtime) &&
  isBoolean(x.empty) &&
  isBoolean(x.spooled) &&
  isBoolean(x.posted)
    ? {
        id: x.id,
        harness: x.harness,
        size: x.size,
        mtime: x.mtime,
        empty: x.empty,
        ...(x.refused === true ? { refused: true } : {}),
        ...(x.sent === true ? { sent: true } : {}),
        spooled: x.spooled,
        posted: x.posted,
      }
    : null;

const parse = (v: unknown): BackfillFile | null => {
  if (!isRecord(v) || v.version !== 1) return null;
  const sessions = recordOf(v.sessions, parseEntry);
  if (!sessions) return null;
  const last =
    isRecord(v.last) && isString(v.last.backfill_id) && isNumber(v.last.at)
      ? { backfill_id: v.last.backfill_id, at: v.last.at }
      : null;
  return { version: 1, sessions, last };
};

const empty = (): BackfillFile => ({ version: 1, sessions: {}, last: null });

export const backfillKey = (harness: string, harnessSessionId: string) => `${harness}:${harnessSessionId}`;

export function readBackfill(paths: Paths, root: string): BackfillFile {
  try {
    return readJsonFile(paths.backfill(root), parse, empty);
  } catch (e) {
    if (!(e instanceof CorruptFileError)) throw e;
    moveAside(paths.backfill(root));
    return empty();
  }
}

export function writeBackfill(paths: Paths, root: string, file: BackfillFile): void {
  writeJsonAtomic(paths.backfill(root), file);
}

/** How long a backfill lock is honoured without a heartbeat (each save refreshes it). */
export const BACKFILL_LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * One backfill per repository at a time (`backfill.json.lock`, created exclusively, refreshed by each save). A lock
 * older than 15 minutes is a crashed run's and is taken over. Returns a release function, or null when another
 * backfill holds it.
 */
export function lockBackfill(paths: Paths, root: string, now: number): { touch(): void; release(): void } | null {
  const lock = paths.backfillLock(root);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const nonce = `${process.pid} ${randomBytes(6).toString("hex")}`;
  const take = () => {
    try {
      writeFileSync(lock, nonce, { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    try {
      if (now - statSync(lock).mtimeMs < BACKFILL_LOCK_STALE_MS) return null;
      rmSync(lock, { force: true });
    } catch {
      // gone meanwhile
    }
    if (!take()) return null;
  }
  const mine = () => {
    try {
      return readFileSync(lock, "utf8") === nonce;
    } catch {
      return false;
    }
  };
  return {
    touch() {
      try {
        if (mine()) {
          const t = new Date();
          utimesSync(lock, t, t);
        }
      } catch {
        // gone or unwritable meanwhile: the run carries on; a stale lock is taken over after 15 minutes
      }
    },
    release() {
      if (mine()) rmSync(lock, { force: true });
    },
  };
}
