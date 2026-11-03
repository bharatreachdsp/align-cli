/**
 * `~/.align/sessions/index.json`: harness session id → ALIGN session id (docs/15 §Files, docs/10). An id is
 * minted once under the lock and reused forever after, so hooks, the uploader and backfill (L12–L15) agree.
 */
import { uuidv7 } from "@align/core/ids";
import { isNumber, isRecord, isString, recordOf, versionOk } from "./check";
import { readJsonFile, withLock, writeJsonAtomic } from "./fsx";
import type { Paths } from "./paths";

export type SessionIndex = { version: 1; sessions: Record<string, { id: string; created_at: number }> };

const emptyIndex = (): SessionIndex => ({ version: 1, sessions: {} });

const key = (harness: string, harnessSessionId: string) => `${harness}:${harnessSessionId}`;

const parseIndex = (v: unknown): SessionIndex | null => {
  if (!isRecord(v) || !versionOk(v)) return null;
  const sessions = recordOf(v.sessions, (x) =>
    isRecord(x) && isString(x.id) && isNumber(x.created_at) ? { id: x.id, created_at: x.created_at } : null,
  );
  return sessions ? { version: 1, sessions } : null;
};

/**
 * The index. A corrupt file throws `CorruptFileError` and is never rewritten: starting a fresh index would mint
 * a second id for sessions already uploaded (the hook path counts the error and exits 0).
 */
export function readSessionIndex(paths: Paths): SessionIndex {
  return readJsonFile(paths.sessionsIndex, parseIndex, emptyIndex);
}

export function findSession(paths: Paths, harness: string, harnessSessionId: string): string | null {
  return readSessionIndex(paths).sessions[key(harness, harnessSessionId)]?.id ?? null;
}

/** The ALIGN session id for a harness session, minted on first sight and never again. */
export function sessionFor(paths: Paths, harness: string, harnessSessionId: string, now = Date.now()): string {
  if (!harness || !harnessSessionId) throw new RangeError("harness and session id are required");
  return withLock(paths.sessionsLock, () => {
    const index = readSessionIndex(paths);
    const k = key(harness, harnessSessionId);
    const existing = index.sessions[k];
    if (existing) return existing.id;
    const id = uuidv7(now);
    index.sessions[k] = { id, created_at: now };
    writeJsonAtomic(paths.sessionsIndex, index);
    return id;
  });
}

/** Points a harness session at the server's id (a `session_conflict` answer, docs/15 §The uploader). */
export function setSessionId(paths: Paths, harness: string, harnessSessionId: string, id: string): void {
  withLock(paths.sessionsLock, () => {
    const index = readSessionIndex(paths);
    const k = key(harness, harnessSessionId);
    index.sessions[k] = { id, created_at: index.sessions[k]?.created_at ?? Date.now() };
    writeJsonAtomic(paths.sessionsIndex, index);
  });
}

/**
 * Points a harness session at a newly minted id only if the index still names `expected` (compare and set): a
 * conflict answered without an id must not overwrite an id another pass already chose. Returns the id the index
 * names afterwards.
 */
export function replaceSessionIdIf(
  paths: Paths,
  harness: string,
  harnessSessionId: string,
  expected: string,
  id: string,
): string {
  return withLock(paths.sessionsLock, () => {
    const index = readSessionIndex(paths);
    const k = key(harness, harnessSessionId);
    const current = index.sessions[k]?.id;
    if (current !== undefined && current !== expected) return current;
    index.sessions[k] = { id, created_at: index.sessions[k]?.created_at ?? Date.now() };
    writeJsonAtomic(paths.sessionsIndex, index);
    return id;
  });
}
