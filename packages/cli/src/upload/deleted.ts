/**
 * Sessions the person deleted with `align sessions rm` (L17 review round 2, R5, and the final round; D278):
 * `~/.align/spool/deleted.json`, session id → `{at, confirmed}`. `sessions rm` lists a session as pending before it asks
 * the server, marks it confirmed once the server deleted it (or no longer has it), and unlists it when the server
 * refuses. The uploader never sends a listed session's events, nor sets them aside; it leaves a pending session's
 * events in the spool (the delete may still be refused) and drops a confirmed session's. A list that does not parse
 * stops one upload pass, then is moved aside and rewritten with the ids it still holds, as confirmed (a delete the
 * person asked for wins). Entries go after 90 days or beyond the newest 5,000.
 */
import { readFileSync } from "node:fs";
import { CorruptFileError, moveAside, readJsonFile, withLock, writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_IDS = 5000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Mark = { at: number; confirmed: boolean };
type DeletedFile = { version: 2; sessions: Record<string, Mark> };

const parse = (v: unknown): DeletedFile | null => {
  if (typeof v !== "object" || v === null) return null;
  const f = v as { version?: unknown; sessions?: unknown };
  if (f.version !== 2 || typeof f.sessions !== "object" || f.sessions === null || Array.isArray(f.sessions))
    return null;
  for (const m of Object.values(f.sessions)) {
    const x = m as Partial<Mark> | null;
    if (typeof x !== "object" || x === null || typeof x.at !== "number" || typeof x.confirmed !== "boolean")
      return null;
  }
  return f as DeletedFile;
};

const empty = (): DeletedFile => ({ version: 2, sessions: {} });

export type Deleted = { pending: Set<string>; confirmed: Set<string>; all: Set<string> };

/** The listed sessions. A list that exists but cannot be read throws `CorruptFileError` (never "nothing listed"). */
export function readDeleted(paths: Paths): Deleted {
  const out: Deleted = { pending: new Set(), confirmed: new Set(), all: new Set() };
  for (const [id, m] of Object.entries(readJsonFile(paths.deletedSessions, parse, empty).sessions)) {
    (m.confirmed ? out.confirmed : out.pending).add(id);
    out.all.add(id);
  }
  return out;
}

function write(paths: Paths, sessions: Record<string, Mark>, now: number): void {
  const kept = Object.entries(sessions)
    .filter(([, m]) => now - m.at < KEEP_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_IDS);
  writeJsonAtomic(paths.deletedSessions, { version: 2, sessions: Object.fromEntries(kept) });
}

/** The ids still readable in a list that does not parse, every one as confirmed. */
function salvage(paths: Paths, now: number): Record<string, Mark> {
  let raw = "";
  try {
    raw = readFileSync(paths.deletedSessions, "utf8");
  } catch {
    return {};
  }
  return Object.fromEntries([...new Set(raw.match(UUID) ?? [])].map((id) => [id, { at: now, confirmed: true }]));
}

function change(paths: Paths, fn: (s: Record<string, Mark>) => void, now: number): void {
  withLock(paths.deletedSessionsLock, () => {
    let sessions: Record<string, Mark>;
    try {
      sessions = readJsonFile(paths.deletedSessions, parse, empty).sessions;
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e;
      sessions = salvage(paths, now);
      moveAside(paths.deletedSessions);
    }
    fn(sessions);
    write(paths, sessions, now);
  });
}

/** Listed before the server is asked: the uploader stops sending the session at once and keeps its events. */
export function markDeleted(paths: Paths, sid: string, now: number): void {
  change(
    paths,
    (s) => {
      s[sid] = { at: now, confirmed: false };
    },
    now,
  );
}

/** The server deleted it (or never had it): its events may go from the spool. */
export function confirmDeleted(paths: Paths, sid: string, now: number): void {
  change(
    paths,
    (s) => {
      s[sid] = { at: now, confirmed: true };
    },
    now,
  );
}

/** The server refused the delete: the session uploads again as before. */
export function unmarkDeleted(paths: Paths, sid: string, now: number): void {
  change(
    paths,
    (s) => {
      delete s[sid];
    },
    now,
  );
}

/** After an upload pass stopped on a corrupt list: moved aside, the readable ids kept (as confirmed). */
export function repairDeleted(paths: Paths, now: number): void {
  change(paths, () => {}, now);
}
