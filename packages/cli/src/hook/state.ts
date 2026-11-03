/**
 * Per-session state, `~/.align/sessions/<id>.json` (docs/15 §Files): which harness session and repository the
 * ALIGN session belongs to, its transcript mode, the reader's cursor `{byte_offset, line_no, next_n, ino}`, whether
 * a read is pending (set by the Stop and SessionEnd hooks, cleared by the reader), the text sent so far (the 2 MB
 * cap, docs/10 §Kinds and payloads) and the notices already shown. Every change holds the session's lock.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isInt, isNumber, isRecord, isString, isStringArray } from "../check";
import { readJsonFile, withLock, writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";

export const MAX_SESSION_TEXT_BYTES = 2 * 1024 * 1024;

export type SessionState = {
  version: 1;
  id: string;
  harness: string;
  harness_session_id: string;
  root: string;
  mode: "jsonl" | "hooks";
  /** Set when the session left jsonl mode because the transcript could not be read (doctor reports it). */
  mode_reason: string | null;
  transcript_path: string | null;
  harness_version: string | null;
  /** `ino` and `dev` together name the transcript file read so far (`dev` absent in state written before it). */
  cursor: { byte_offset: number; line_no: number; next_n: number; ino: number | null; dev?: number | null };
  /** The transcript reader's state carried between reads (whose working directory the last lines were in). */
  carry: { owned: boolean; subagent?: boolean; thread?: string; cwd?: string } | null;
  pending: boolean;
  ended_at: number | null;
  started_at: number;
  last_seen: number;
  text_bytes: number;
  truncated: boolean;
  /** The notices shown, with the proposal keys each one named (only new proposals are shown again, docs/19). */
  notices_shown: { id: string; at: number; keys?: string[] }[];
};

const strOrNull = (v: unknown): v is string | null => v === null || v === undefined || isString(v);
const numOrNull = (v: unknown): v is number | null => v === null || v === undefined || isNumber(v);

function parseState(v: unknown): SessionState | null {
  if (!isRecord(v) || v.version !== 1) return null;
  const c = v.cursor;
  if (!isString(v.id) || !isString(v.harness) || !isString(v.harness_session_id) || !isString(v.root)) return null;
  if (v.mode !== "jsonl" && v.mode !== "hooks") return null;
  if (!strOrNull(v.mode_reason) || !strOrNull(v.transcript_path) || !strOrNull(v.harness_version)) return null;
  if (!isRecord(c) || !isInt(c.byte_offset, 0) || !isInt(c.line_no, 0) || !isInt(c.next_n, 1) || !numOrNull(c.ino))
    return null;
  if (!numOrNull(c.dev)) return null;
  if (!isNumber(v.started_at) || !isNumber(v.last_seen) || !numOrNull(v.ended_at)) return null;
  if (v.text_bytes !== undefined && !isInt(v.text_bytes, 0)) return null;
  const shown = v.notices_shown ?? [];
  if (!Array.isArray(shown) || !shown.every((x) => isRecord(x) && isString(x.id) && isNumber(x.at))) return null;
  return {
    version: 1,
    id: v.id,
    harness: v.harness,
    harness_session_id: v.harness_session_id,
    root: v.root,
    mode: v.mode,
    mode_reason: v.mode_reason ?? null,
    transcript_path: v.transcript_path ?? null,
    harness_version: v.harness_version ?? null,
    cursor: {
      byte_offset: c.byte_offset,
      line_no: c.line_no,
      next_n: c.next_n,
      ino: c.ino ?? null,
      dev: c.dev ?? null,
    },
    carry:
      isRecord(v.carry) && typeof v.carry.owned === "boolean"
        ? {
            owned: v.carry.owned,
            ...(v.carry.subagent === true ? { subagent: true } : {}),
            ...(typeof v.carry.thread === "string" ? { thread: v.carry.thread } : {}),
            ...(typeof v.carry.cwd === "string" && v.carry.cwd.startsWith("/") && v.carry.cwd.length <= 4096
              ? { cwd: v.carry.cwd }
              : {}),
          }
        : null,
    pending: v.pending === true,
    ended_at: v.ended_at ?? null,
    started_at: v.started_at,
    last_seen: v.last_seen,
    text_bytes: (v.text_bytes as number | undefined) ?? 0,
    truncated: v.truncated === true,
    notices_shown: (shown as { id: string; at: number; keys?: unknown }[]).map((x) => ({
      id: x.id,
      at: x.at,
      ...(isStringArray(x.keys) ? { keys: x.keys.slice(0, 100) } : {}),
    })),
  };
}

/** The state, or null when missing or unreadable. */
export function readState(paths: Paths, id: string): SessionState | null {
  try {
    return readJsonFile<SessionState | null>(paths.sessionState(id), parseState, () => null);
  } catch {
    return null;
  }
}

/**
 * Read-modify-write under the session's lock. `create` builds the first state when there is none; `change`
 * returns the new state (or the same object, mutated). The result is written atomically and returned.
 */
export function updateState(
  paths: Paths,
  id: string,
  create: () => SessionState,
  change: (s: SessionState) => SessionState | undefined = (s) => s,
  waitMs = 1000,
): SessionState {
  return withLock(
    paths.sessionStateLock(id),
    () => {
      const current = readState(paths, id) ?? create();
      const next = change(current) ?? current;
      writeJsonAtomic(paths.sessionState(id), next);
      return next;
    },
    { waitMs },
  );
}

/** A hook's flags left as a file when the session's lock was busy, applied by the reader (never lost). */
export type Mark = { pending: boolean; ended_at: number | null; last_seen: number };

export function writeMark(paths: Paths, id: string, mark: Mark): void {
  writeJsonAtomic(join(paths.sessionMarks(id), `${mark.last_seen}-${randomBytes(4).toString("hex")}.json`), mark);
}

/** Folds every mark of a session into its state (under the lock) and removes the marks applied. */
export function applyMarks(paths: Paths, id: string): void {
  const dir = paths.sessionMarks(id);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length === 0) return;
  const marks: Mark[] = [];
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as Mark;
      if (typeof m.last_seen === "number") marks.push(m);
    } catch {
      // unreadable: dropped below
    }
  }
  const current = readState(paths, id);
  if (!current) return;
  updateState(
    paths,
    id,
    () => current,
    (st) => {
      for (const m of marks) {
        if (m.pending && st.mode === "jsonl") st.pending = true;
        if (typeof m.ended_at === "number") st.ended_at = Math.max(st.ended_at ?? 0, m.ended_at);
        st.last_seen = Math.max(st.last_seen, m.last_seen);
      }
      return st;
    },
  );
  for (const n of names) rmSync(join(dir, n), { force: true });
}

/** Every session state on this laptop (the reader and the git hooks scan them). */
export function listStates(paths: Paths): SessionState[] {
  let names: string[] = [];
  try {
    names = readdirSync(paths.sessions);
  } catch {
    return [];
  }
  const out: SessionState[] = [];
  for (const name of names) {
    const m = /^([0-9a-f-]{36})\.json$/.exec(name);
    if (!m?.[1]) continue;
    const s = readState(paths, m[1]);
    if (s) out.push(s);
  }
  return out;
}

export function newState(fields: {
  id: string;
  harness: string;
  harness_session_id: string;
  root: string;
  mode: "jsonl" | "hooks";
  transcript_path: string | null;
  now: number;
}): SessionState {
  return {
    version: 1,
    id: fields.id,
    harness: fields.harness,
    harness_session_id: fields.harness_session_id,
    root: fields.root,
    mode: fields.mode,
    mode_reason: null,
    transcript_path: fields.transcript_path,
    harness_version: null,
    cursor: { byte_offset: 0, line_no: 0, next_n: 1, ino: null },
    carry: null,
    pending: false,
    ended_at: null,
    started_at: fields.now,
    last_seen: fields.now,
    text_bytes: 0,
    truncated: false,
    notices_shown: [],
  };
}
