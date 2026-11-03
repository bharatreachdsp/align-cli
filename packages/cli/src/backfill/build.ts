/**
 * One past session → the events a backfill uploads (docs/10 §Backfill sources): `session.start`, the transcript as
 * `transcript.chunk` events, `session.end`, every one with `capture: 'backfill'` and its time from the file. The
 * same reader, code-block stripping, path rules, 2 MB text cap, chunk limits (≤ 500 lines, ≤ 192 KB after
 * redaction) and `redactEvent` as live capture (hook/read.ts); nothing here bypasses them.
 *
 * Event ids are derived, not random: a UUID v7 shape whose time is the session's start and whose other bits are a
 * hash of the ALIGN session id, the kind and the redacted payload. A rerun over the same file produces the same ids,
 * so the server's de-duplication on `event_id` makes a repeated or resumed backfill store nothing twice (D269).
 */
import { createHash } from "node:crypto";
import type { RedactionContext } from "@align/core/redact";
import type { Line } from "../harness/claude-code/transcript";
import { readerFor } from "../harness/readers";
import { envelope, type Repo, redactAll, type TraceEvent } from "../hook/events";
import { capText, PASS_BYTES, redactedChunks } from "../hook/read";
import { newState } from "../hook/state";
import { type Cursor, readDelta } from "../transcripts/reader";
import { DAY_MS, type Found } from "./scan";

/** At most this many 1 MB passes per file (64 MB); the 2 MB text cap normally stops far earlier. */
const MAX_PASSES = 64;
/** Ingest refuses events older than 90 days; times are kept a little inside that. */
const OLDEST_MS = 89 * DAY_MS;

export type Built = { events: TraceEvent[]; lines: number; version: string | null; truncated: boolean };

/** A UUID v7-shaped id from a time and a hash (version 7, RFC 9562 variant). */
export function stableEventId(timeMs: number, parts: string[]): string {
  const h = createHash("sha256")
    .update(["align-backfill", ...parts].join("\0"))
    .digest();
  const b = Buffer.alloc(16);
  b.writeUIntBE(Math.max(0, Math.min(Math.floor(timeMs), 2 ** 48 - 1)), 0, 6);
  h.copy(b, 6, 0, 10);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Reads a whole transcript with its harness reader, carrying the reader's state between 1 MB passes. */
export function readTranscript(
  f: Found,
  root: string,
): { lines: Line[]; version: string | null; truncated: boolean } | null {
  const reader = readerFor(f.harness);
  if (!reader) return null;
  let cursor: Cursor = { byte_offset: 0, line_no: 0, ino: null };
  let nextN = 1;
  let carry: Parameters<typeof reader>[1]["carry"];
  let version: string | null = null;
  const lines: Line[] = [];
  let bytes = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const delta = readDelta(f.file, cursor, PASS_BYTES, { noFollow: true });
    if (!delta.ok) return pass === 0 ? null : { lines, version, truncated: false };
    const r = reader(delta.lines, { root, nextN, carry });
    version ??= r.version;
    const capped = capText(r.lines, bytes);
    lines.push(...capped.kept);
    bytes = capped.bytes;
    if (capped.truncated) return { lines, version, truncated: true };
    nextN = r.nextN;
    carry = r.carry;
    cursor = delta.cursor;
    if (!delta.more) break;
  }
  return { lines, version, truncated: false };
}

/**
 * The session's redacted events, or null when nothing of it belongs to the repository (no line kept: an empty
 * session is never uploaded).
 */
export function buildSession(
  f: Found,
  o: { id: string; repo: Repo; rctx: RedactionContext; machineId: string | null; now: number },
): Built | null {
  const read = readTranscript(f, o.repo.root);
  if (!read || read.lines.length === 0) return null;
  const floor = o.now - OLDEST_MS;
  const at = (t: number) => Math.min(o.now, Math.max(floor, t));
  const lineTs = (ls: Line[]) => {
    for (let i = ls.length - 1; i >= 0; i--) {
      const t = Date.parse(ls[i]?.ts ?? "");
      if (Number.isFinite(t)) return t;
    }
    return f.startedAt;
  };
  const state = {
    ...newState({
      id: o.id,
      harness: f.harness,
      harness_session_id: f.harnessSessionId,
      root: o.repo.root,
      mode: "jsonl",
      transcript_path: null,
      now: f.startedAt,
    }),
    harness_version: read.version,
  };
  const harness = { name: f.harness, version: read.version, session_id: f.harnessSessionId, hook_event: null };
  const common = { harness, sessionId: o.id, repo: o.repo, cwd: null, machineId: o.machineId };
  const start = envelope(
    "session.start",
    { source: "unknown", transcript_mode: "jsonl" },
    { ...common, now: at(f.startedAt) },
  );
  const end = envelope("session.end", { reason: "backfill" }, { ...common, now: at(Math.max(f.mtimeMs, f.startedAt)) });
  for (const e of [start, end]) e.capture = "backfill";
  const chunks = redactedChunks(
    read.lines,
    {
      state,
      repo: o.repo,
      mode: "jsonl",
      truncated: read.truncated,
      now: o.now,
      machineId: o.machineId,
      capture: "backfill",
      tsOf: (ls) => at(lineTs(ls)),
    },
    o.rctx,
  );
  const events = [...redactAll([start], o.rctx), ...chunks, ...redactAll([end], o.rctx)];
  for (const e of events) {
    e.event_id = stableEventId(f.startedAt, [o.id, e.kind, JSON.stringify(e.payload)]);
  }
  return { events, lines: read.lines.length, version: read.version, truncated: read.truncated };
}
