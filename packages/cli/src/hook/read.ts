/**
 * Turns a session's new transcript lines into spooled `transcript.chunk` events (docs/10 §Transcript modes,
 * §Line numbers; docs/15 §The uploader). Runs in the detached `align upload` process, never in a hook.
 *
 * Each pass holds the session's lock, reads at most 1 MB of complete lines from the cursor, converts them with
 * the harness reader, redacts, writes the spool file, and only then saves the cursor `{byte_offset, line_no,
 * next_n}`: a crash between the two re-reads the same lines with the same `n`, and the server's `on conflict do
 * nothing` drops the duplicates. A transcript that shrank, was replaced, or no longer parses switches the session
 * to hooks mode for later turns (`mode_reason`, reported by `align doctor`).
 */
import { effectiveDenyGlobs, isDenied, type RedactionContext, TRUNCATED_MARKER } from "@align/core/redact";
import type { Line } from "../harness/claude-code/transcript";
import { readerFor } from "../harness/readers";
import type { Paths } from "../paths";
import { lookupRepo, readRegistry } from "../registry";
import { readDelta } from "../transcripts/reader";
import { envelope, machineIdFor, type Repo, redactAll, redactionContext, spool, type TraceEvent } from "./events";
import { repoFacts } from "./home";
import { logCount } from "./log";
import { MAX_SESSION_TEXT_BYTES, readState, type SessionState, updateState } from "./state";

export const MAX_LINES_PER_CHUNK = 500;
/**
 * Ingest rejects an event over 256 KB serialized, finally (`payload_too_large`, docs/25): chunks are kept at or under
 * 192 KB after redaction. Lines are grouped by an estimate first (their text as redaction will cap it, 8,000
 * characters, plus their paths), and a redacted chunk that is still over is split in two until it fits.
 */
export const MAX_EVENT_BYTES = 192 * 1024;
const CHUNK_ESTIMATE_BYTES = 128 * 1024;
const LINE_TEXT_CAP = 8000;
export const PASS_BYTES = 1024 * 1024;
/** Complete lines without a single recognisable entry: the format changed under us. */
const PARSER_OUTDATED_AFTER = 20;

export type ReadOutcome = { lines: number; spooled: number; more: boolean; switched: string | null };

/** The repository a session belongs to, only while it is registered and opted in (hard rule 6). */
export async function repoForState(paths: Paths, state: SessionState): Promise<Repo | null> {
  const found = lookupRepo(readRegistry(paths), state.root);
  if (!found?.entry.opted_in) return null;
  const facts = (await repoFacts(found.root)) ?? { toplevel: found.root, head: null, branch: null };
  return { root: found.root, entry: found.entry, facts };
}

/** Applies the 2 MB per-session text cap: lines past it are dropped and the session is marked truncated. */
export function capText(lines: Line[], usedBytes: number): { kept: Line[]; bytes: number; truncated: boolean } {
  const kept: Line[] = [];
  let bytes = usedBytes;
  for (const l of lines) {
    const b = Buffer.byteLength(l.text, "utf8");
    if (bytes + b > MAX_SESSION_TEXT_BYTES) return { kept, bytes, truncated: true };
    bytes += b;
    kept.push(l);
  }
  return { kept, bytes, truncated: false };
}

const lineEstimate = (l: Line) =>
  Buffer.byteLength(l.text.length > LINE_TEXT_CAP ? l.text.slice(0, LINE_TEXT_CAP) : l.text, "utf8") +
  (l.tool ? l.tool.paths.reduce((n, p) => n + Buffer.byteLength(p, "utf8") + 4, 0) : 0) +
  128;

const eventBytes = (e: TraceEvent) => Buffer.byteLength(JSON.stringify(e), "utf8");

type ChunkOptions = Parameters<typeof chunkEvents>[1];

/** Lines grouped into redacted `transcript.chunk` events of at most 500 lines and 192 KB each (in order). */
export function redactedChunks(lines: Line[], o: ChunkOptions, rctx: RedactionContext): TraceEvent[] {
  const groups: Line[][] = [];
  let cur: Line[] = [];
  let bytes = 0;
  for (const l of lines) {
    const b = lineEstimate(l);
    if (cur.length > 0 && (cur.length >= MAX_LINES_PER_CHUNK || bytes + b > CHUNK_ESTIMATE_BYTES)) {
      groups.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(l);
    bytes += b;
  }
  if (cur.length > 0 || (groups.length === 0 && o.truncated)) groups.push(cur);
  const out: TraceEvent[] = [];
  groups.forEach((g, i) => {
    out.push(...fit(g, { ...o, truncated: o.truncated && i === groups.length - 1 }, rctx));
  });
  return out;
}

function fit(lines: Line[], o: ChunkOptions, rctx: RedactionContext): TraceEvent[] {
  const events = redactAll(chunkEvents(lines, o), rctx);
  if (events.every((e) => eventBytes(e) <= MAX_EVENT_BYTES)) return events;
  if (lines.length > 1) {
    const half = Math.ceil(lines.length / 2);
    return [...fit(lines.slice(0, half), { ...o, truncated: false }, rctx), ...fit(lines.slice(half), o, rctx)];
  }
  // One line still over the cap (a very long multi-line text): its *redacted* text is cut to 1,000 characters (at a
  // space or line break when there is one near the end, never inside a surrogate pair) and marked as docs/10 marks an
  // oversized line, its paths kept to ten, and the result redacted again. Cutting the raw text instead would leave
  // part of a secret that straddled the cut, which no rule recognises any more (L12 review round 4).
  const [l] = lines;
  const redacted = (events[0]?.payload as { lines?: Line[] } | undefined)?.lines?.[0];
  if (!l || !redacted) return events;
  const smaller: Line = {
    ...l,
    text: l.role === "tool" ? l.text : `${cutText(redacted.text, LAST_RESORT_CHARS)}${TRUNCATED_MARKER}`,
    ...(l.tool ? { tool: { ...l.tool, paths: l.tool.paths.slice(0, 10) } } : {}),
  };
  return redactAll(chunkEvents([smaller], o), rctx).map((e) => withEarlierHits(e, events[0]));
}

const LAST_RESORT_CHARS = 1000;

/** The first `max` UTF-16 units of `text`, ending at whitespace in its last fifth when there is some, never splitting a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  const head = text.slice(0, end);
  const ws = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf("\t"));
  return ws >= Math.floor(max * 0.8) ? head.slice(0, ws) : head;
}

/** The hits of the first redaction (the secrets found before the cut) are kept on the event that is sent. */
function withEarlierHits(e: TraceEvent, earlier: TraceEvent | undefined): TraceEvent {
  const before = (earlier as { redaction?: { hits?: Record<string, number> } } | undefined)?.redaction?.hits;
  const now = (e as { redaction?: { version: number; hits?: Record<string, number> } }).redaction;
  if (!before || !now) return e;
  const hits: Record<string, number> = { ...(now.hits ?? {}) };
  for (const [k, n] of Object.entries(before)) hits[k] = Math.max(hits[k] ?? 0, n);
  return { ...e, redaction: { ...now, hits } } as TraceEvent;
}

export function chunkEvents(
  lines: Line[],
  o: {
    state: SessionState;
    repo: Repo;
    mode: "jsonl" | "hooks";
    truncated: boolean;
    now: number;
    machineId: string | null;
    /** Backfill (L15): every event is marked `capture: 'backfill'`, timed by its lines (docs/10 §Backfill sources). */
    capture?: "backfill";
    tsOf?: (lines: Line[]) => number;
  },
): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let i = 0; i < lines.length || (i === 0 && o.truncated); i += MAX_LINES_PER_CHUNK) {
    const slice = lines.slice(i, i + MAX_LINES_PER_CHUNK);
    const last = i + MAX_LINES_PER_CHUNK >= lines.length;
    const e = envelope(
      "transcript.chunk",
      { mode: o.mode, lines: slice, truncated: last && o.truncated },
      {
        harness: {
          name: o.state.harness,
          version: o.state.harness_version,
          session_id: o.state.harness_session_id,
          hook_event: null,
        },
        sessionId: o.state.id,
        repo: o.repo,
        cwd: null,
        now: o.tsOf ? o.tsOf(slice) : o.now,
        machineId: o.machineId,
      },
    );
    if (o.capture) e.capture = o.capture;
    events.push(e);
  }
  return events;
}

const sameCursor = (a: SessionState, b: SessionState) =>
  a.mode === b.mode &&
  a.transcript_path === b.transcript_path &&
  a.truncated === b.truncated &&
  a.text_bytes === b.text_bytes &&
  a.cursor.byte_offset === b.cursor.byte_offset &&
  a.cursor.line_no === b.cursor.line_no &&
  a.cursor.next_n === b.cursor.next_n &&
  a.cursor.ino === b.cursor.ino &&
  (a.cursor.dev ?? null) === (b.cursor.dev ?? null);

/**
 * One read pass for one session. Reading, converting and redacting happen outside the session's lock, from a
 * snapshot of the state; the lock is taken only to check that the cursor is still the snapshot's and to write the
 * spool file and the new cursor, so a hook never waits behind a slow read (L12 security review). A cursor that moved
 * meanwhile means another reader got there first: this pass writes nothing and the next one starts from the new one.
 */
export async function readSessionPass(paths: Paths, id: string, now: number): Promise<ReadOutcome> {
  const none: ReadOutcome = { lines: 0, spooled: 0, more: false, switched: null };
  const snapshot = readState(paths, id);
  if (snapshot?.mode !== "jsonl" || !snapshot.transcript_path || snapshot.truncated) return none;
  const repo = await repoForState(paths, snapshot);
  if (!repo) return none;
  const machineId = await machineIdFor(paths);
  const rctx = redactionContext(paths, repo);

  // A Cursor transcript is never followed through a link (its path came from a payload, D519), as backfill reads it.
  const delta = readDelta(snapshot.transcript_path, snapshot.cursor, PASS_BYTES, {
    noFollow: snapshot.harness === "cursor",
  });
  let switchTo: string | null = null;
  let events: TraceEvent[] = [];
  let next: SessionState = snapshot;
  let lines = 0;
  if (!delta.ok) {
    if (delta.reason === "missing") return none; // not written yet (Claude Code writes it asynchronously)
    switchTo = delta.reason;
  } else {
    const reader = readerFor(snapshot.harness);
    const deny = effectiveDenyGlobs(rctx.denyGlobs);
    const converted = reader
      ? reader(delta.lines, {
          root: repo.root,
          nextN: snapshot.cursor.next_n,
          carry: snapshot.carry ?? undefined,
          denied: (rel) => isDenied(rel, deny),
        })
      : null;
    if (!converted) switchTo = "parser";
    if (converted && converted.stats.malformed > 0)
      logCount(paths.logs, "reader", "malformed", converted.stats.malformed);
    const total = snapshot.cursor.line_no + delta.lines.length;
    if (!converted) {
      // no reader for this harness
    } else if (converted.recognised === 0 && snapshot.cursor.next_n === 1 && total >= PARSER_OUTDATED_AFTER) {
      switchTo = "parser";
    } else {
      const capped = capText(converted.lines, snapshot.text_bytes);
      const withVersion = { ...snapshot, harness_version: snapshot.harness_version ?? converted.version };
      events = redactedChunks(
        capped.kept,
        { state: withVersion, repo, mode: "jsonl", truncated: capped.truncated, now, machineId },
        rctx,
      );
      const lastN = capped.kept.length > 0 ? (capped.kept[capped.kept.length - 1]?.n ?? 0) + 1 : snapshot.cursor.next_n;
      lines = capped.kept.length;
      next = {
        ...withVersion,
        cursor: {
          byte_offset: delta.cursor.byte_offset,
          line_no: delta.cursor.line_no,
          ino: delta.cursor.ino,
          dev: delta.cursor.dev ?? null,
          next_n: capped.truncated ? lastN : converted.nextN,
        },
        text_bytes: capped.bytes,
        truncated: capped.truncated,
        carry: converted.carry,
      };
    }
  }

  let outcome: ReadOutcome = none;
  updateState(
    paths,
    id,
    () => snapshot,
    (state) => {
      if (!sameCursor(state, snapshot)) {
        outcome = { ...none, more: true };
        return state;
      }
      if (switchTo !== null) {
        logCount(paths.logs, "reader", `switch_${switchTo}`);
        outcome = { ...none, switched: switchTo };
        return { ...state, mode: "hooks", mode_reason: switchTo };
      }
      // Spool first, then the cursor (saved with the state when this function returns). Flags the hooks set since
      // the snapshot (pending, ended, last seen, notices) are kept from the current state.
      spool(paths, repo, events, now);
      outcome = { lines, spooled: events.length, more: delta.ok && delta.more, switched: null };
      return {
        ...state,
        harness_version: next.harness_version,
        cursor: next.cursor,
        text_bytes: next.text_bytes,
        truncated: next.truncated,
        carry: next.carry,
      };
    },
  );
  return outcome;
}

/** Reads a session until its transcript has nothing new (at most `maxPasses` passes). */
export async function readSession(paths: Paths, id: string, now: number, maxPasses = 64): Promise<number> {
  let lines = 0;
  for (let i = 0; i < maxPasses; i++) {
    const r = await readSessionPass(paths, id, now);
    lines += r.lines;
    if (!r.more) break;
  }
  return lines;
}
