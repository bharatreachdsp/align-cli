/**
 * The uploader against the mock capture server (docs/15 §The uploader, §Guarantees 7 and 9; docs/25 §Capture):
 * batches, per-event answers, crash safety by fault injection, offline back-off, 401, conflicts, quarantine,
 * held events, the registry re-check, tokens only to their own server, notices, flush. A temporary HOME; synthetic
 * events only.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MOCK_ORG, MOCK_USER, mockSessionNotice } from "@align/core/api";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../src/credentials";
import { envelope, type Repo, type TraceEvent } from "../src/hook/events";
import { readState } from "../src/hook/state";
import { alignPaths, type Paths, repoHash } from "../src/paths";
import { setOptedIn, upsertRepo } from "../src/registry";
import { findSession, readSessionIndex, sessionFor } from "../src/sessions";
import { flush, housekeeping, upload } from "../src/upload/daemon";
import { confirmDeleted, markDeleted, readDeleted } from "../src/upload/deleted";
import { hardLinksWork, heartbeat, sweepLockLeftovers, tryLock, unlock } from "../src/upload/lock";
import type { FaultStep } from "../src/upload/send";
import { countAside, enforceCaps, listSpool, writeSpoolFile } from "../src/upload/spool";
import { loginRequired, readUploadState } from "../src/upload/state";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockServer, startMockServer } from "./mock-server";

let sb: Sandbox;
let server: MockServer;
let paths: Paths;
let clock = Date.parse("2026-10-22T09:00:00Z");
const now = () => clock;
/** A sleep that only moves the test's clock (back-off and idle waits take no real time). */
const sleep = async (ms: number) => {
  clock += ms;
};

afterEach(async () => {
  await server?.close();
  sb?.cleanup();
});

function repo(): Repo {
  return {
    root: sb.repo,
    entry: {
      repo_id: "repo_1",
      org_id: MOCK_ORG.id,
      remote_norm: "github.com/acme/checkout",
      root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
      default_branch: "main",
      opted_in: true,
      harnesses: ["claude-code"],
      installed_at: new Date(clock).toISOString(),
    },
    facts: { toplevel: sb.repo, head: null, branch: "main" },
  };
}

async function setup(o: { signedIn?: boolean } = {}) {
  sb = sandbox();
  server = await startMockServer();
  paths = alignPaths(sb.alignHome);
  upsertRepo(paths, sb.repo, repo().entry);
  if (o.signedIn !== false) signIn(server);
}

function signIn(s: MockServer, orgId: string = MOCK_ORG.id) {
  const token = `aln_mock_${Math.random().toString(16).slice(2).padEnd(16, "0")}`;
  s.tokens.add(token);
  new CredentialStore(paths, null).put(
    { org: { ...MOCK_ORG, id: orgId }, user: MOCK_USER, expires_at: "2027-01-01T00:00:00.000Z", server: s.url },
    token,
  );
  return token;
}

/** A synthetic session: session.start, then `chunks` transcript chunks of `per` lines each, `files` spool files. */
function spoolSession(o: { harnessSession?: string; chunks: number; per: number; files: number }): TraceEvent[] {
  const hsid = o.harnessSession ?? "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11";
  const sid = sessionFor(paths, "claude-code", hsid, clock);
  const r = repo();
  const common = (hook: string | null) => ({
    harness: { name: "claude-code", session_id: hsid, hook_event: hook },
    sessionId: sid,
    repo: r,
    cwd: sb.repo,
    machineId: null,
  });
  const events: TraceEvent[] = [
    envelope(
      "session.start",
      { source: "startup", transcript_mode: "hooks" },
      { ...common("SessionStart"), now: ++clock },
    ),
  ];
  let n = 1;
  for (let c = 0; c < o.chunks; c++) {
    const lines = Array.from({ length: o.per }, () => ({ n: n++, role: "user", text: `synthetic line ${n}` }));
    events.push(
      envelope("transcript.chunk", { mode: "hooks", lines, truncated: false }, { ...common(null), now: ++clock }),
    );
  }
  // As every writer spools them: redacted, with the stamp.
  for (const e of events) e.redaction = { version: 1, hits: {} };
  const per = Math.ceil(events.length / o.files);
  for (let f = 0; f < o.files; f++)
    writeSpoolFile(
      paths,
      repoHash(sb.repo),
      { root: sb.repo, repo_id: "repo_1", events: events.slice(f * per, (f + 1) * per), attempts: 0 },
      ++clock,
    );
  return events;
}

const pass = (extra: Partial<Parameters<typeof upload>[1]> = {}) =>
  upload(paths, { daemon: false, now, sleep, keychain: null, ...extra });

const spoolCount = () => listSpool(paths).length;

const contiguous = (ns: number[] | undefined, count: number) =>
  expect(ns).toEqual(Array.from({ length: count }, (_, i) => i + 1));

describe("align upload: sending the spool", () => {
  it("a session listed for deletion is never sent; its events stay until the server confirmed the delete (R5, final round)", async () => {
    await setup();
    const gone = spoolSession({ harnessSession: "deleted-session", chunks: 3, per: 1, files: 1 });
    const goneId = gone[0]?.session.id as string;
    markDeleted(paths, goneId, clock);
    // A held event of the listed session is not set aside either (its redaction did not settle).
    const heldOne = { ...(gone[1] as TraceEvent), event_id: "0192f0a0-0000-7000-8000-00000000beef" };
    heldOne.redaction = { version: 1, hits: { unsettled: 1 } };
    writeSpoolFile(
      paths,
      repoHash(sb.repo),
      { root: sb.repo, repo_id: "repo_1", events: [heldOne], attempts: 0 },
      ++clock,
    );
    // Another session over two batches; it is listed after the first batch arrives.
    const late = spoolSession({ harnessSession: "late-session", chunks: 700, per: 1, files: 2 });
    const lateId = late[0]?.session.id as string;
    const other = spoolSession({ harnessSession: "other-session", chunks: 2, per: 1, files: 1 });
    let batches = 0;
    server.capture.onEvents = () => {
      if (++batches === 1) markDeleted(paths, lateId, clock);
    };
    await pass();
    const sentOf = (id: string) =>
      ([...server.store.events.values()] as { session: { id: string } }[]).filter((e) => e.session.id === id).length;
    expect(sentOf(goneId)).toBe(0);
    const lateSent = sentOf(lateId);
    expect(lateSent).toBeLessThanOrEqual(500);
    expect(sentOf(other[0]?.session.id as string)).toBe(other.length);
    // Only listed: nothing of the two sessions is dropped yet (the server may still refuse the delete).
    const spooled = () =>
      listSpool(paths).flatMap((e) =>
        (JSON.parse(readFileSync(e.path, "utf8")).events as TraceEvent[]).map((x) => x.session.id),
      );
    expect(spooled().filter((id) => id === goneId)).toHaveLength(gone.length + 1);
    expect(spooled().filter((id) => id === lateId)).toHaveLength(late.length - lateSent);
    expect(countAside(paths.held)).toBe(0);
    // The server confirmed both deletes: the next pass drops what is left, still sending none of it.
    confirmDeleted(paths, goneId, clock);
    confirmDeleted(paths, lateId, clock);
    await pass();
    expect(sentOf(goneId)).toBe(0);
    expect(sentOf(lateId)).toBe(lateSent);
    expect(spoolCount()).toBe(0);
    expect(countAside(paths.held)).toBe(0);
    expect(countAside(paths.rejected)).toBe(0);
  });

  it("a corrupt deleted-session list stops one pass, is moved aside, and keeps the ids it could read (final round)", async () => {
    await setup();
    const gone = spoolSession({ harnessSession: "deleted-session", chunks: 2, per: 1, files: 1 });
    const goneId = gone[0]?.session.id as string;
    const other = spoolSession({ harnessSession: "other-session", chunks: 2, per: 1, files: 1 });
    mkdirSync(paths.spool, { recursive: true });
    writeFileSync(
      paths.deletedSessions,
      `{"version":2,"sessions":{"${goneId}":{"at":1,"confirmed":true},"0192f0a0-0000-7000`,
    );
    await pass();
    expect(server.store.events.size).toBe(0);
    expect(readdirSync(paths.spool).some((f) => f.startsWith("deleted.json.corrupt-"))).toBe(true);
    expect([...readDeleted(paths).all]).toEqual([goneId]);
    await pass();
    const sent = [...server.store.events.values()] as { session: { id: string } }[];
    expect(sent.some((e) => e.session.id === goneId)).toBe(false);
    expect(sent.filter((e) => e.session.id === other[0]?.session.id)).toHaveLength(other.length);
    expect(spoolCount()).toBe(0);
  });

  it("drains the spool in batches of at most 500 events, gzip, with the organisation's token", async () => {
    await setup();
    const events = spoolSession({ chunks: 700, per: 2, files: 14 });
    await pass();
    expect(spoolCount()).toBe(0);
    expect(server.store.events.size).toBe(events.length);
    expect(Math.max(...server.store.sizes)).toBeLessThanOrEqual(500);
    expect(server.store.sizes.length).toBeGreaterThanOrEqual(2);
    contiguous(server.store.lines.get(events[0]?.session.id as string), 1400);
    const posts = server.requests.filter((r) => r.path === "/events");
    expect(posts.every((r) => r.authorized)).toBe(true);
    expect(readUploadState(paths).last_upload).toBe(clock);
  });

  it("a crash at any step loses nothing and stores nothing twice (fault injection)", async () => {
    const steps: FaultStep[] = ["loaded", "before_send", "after_send", "after_aside", "after_rewrite"];
    for (const step of steps) {
      for (const occurrence of [1, 2]) {
        await setup();
        // 640 events over 8 files: two batches; one event refused finally and one conflicting, so every write path runs.
        const events = spoolSession({ chunks: 639, per: 1, files: 8 });
        const refused = events[10]?.event_id;
        server.capture.rejectWhen = (e) => (e.event_id === refused ? "not_opted_in" : null);
        const conflicted = spoolSession({ harnessSession: "conflict-session", chunks: 3, per: 1, files: 1 });
        server.store.sessions.set("claude-code:conflict-session", "0192f6a7-0000-7000-8000-00000000c0de");
        let seen = 0;
        const fault = (s: FaultStep) => {
          if (s === step && ++seen === occurrence) throw new Error(`killed at ${s} #${occurrence}`);
        };
        const outcome = await pass({ fault }).then(
          () => "finished",
          (e: Error) => e.message,
        );
        // Every step is reached at least once per pass; a second occurrence only where the pass loops (batches).
        if (occurrence === 1 || step !== "loaded") expect(outcome, `${step} #${occurrence}`).toMatch(/killed/);
        // The killed process is gone; its lock is stale. A fresh uploader finishes the job.
        unlock(paths);
        for (let i = 0; i < 3 && spoolCount() > 0; i++) await pass();
        expect(spoolCount(), `${step} #${occurrence}`).toBe(0);
        const want = new Set([...events, ...conflicted].map((e) => e.event_id).filter((id) => id !== refused));
        expect(new Set(server.store.events.keys()), `${step} #${occurrence}`).toEqual(want);
        // Every line arrived once, except the one in the refused event (kept in rejected/).
        const lineNs = (es: TraceEvent[]) =>
          es.flatMap((e) =>
            e.kind === "transcript.chunk" ? (e.payload.lines as { n: number }[]).map((l) => l.n) : [],
          );
        const refusedN = lineNs(events.filter((e) => e.event_id === refused));
        expect(server.store.lines.get(events[0]?.session.id as string)).toEqual(
          lineNs(events).filter((n) => !refusedN.includes(n)),
        );
        contiguous(server.store.lines.get("0192f6a7-0000-7000-8000-00000000c0de"), 3);
        expect(countAside(paths.rejected)).toBeGreaterThanOrEqual(1);
        // A crash after the server stored a batch replays it: the server answers duplicates and stores nothing twice.
        if (step === "after_send" || step === "after_aside") expect(server.store.duplicates).toBeGreaterThan(0);
        await server.close();
        sb.cleanup();
      }
    }
  }, 60_000);

  it("offline for 10 minutes: backs off for at most 5, keeps everything, and drains when the network returns", async () => {
    await setup();
    const events = spoolSession({ chunks: 20, per: 3, files: 3 });
    server.capture.down = true;
    const start = clock;
    const waits: number[] = [];
    await upload(paths, {
      daemon: true,
      now,
      keychain: null,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect(clock - start).toBeLessThanOrEqual(5 * 60 * 1000 + 60_000);
    // 1, 2, 4, 8 … 60 s (each wait is slept in pieces of at most 10 s, so the heartbeat stays fresh).
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(10_000);
    expect(spoolCount()).toBe(3);
    expect(server.store.events.size).toBe(0);
    clock += 5 * 60 * 1000; // still offline for the rest of the 10 minutes; then the network returns
    server.capture.down = false;
    await upload(paths, { daemon: true, now, sleep, keychain: null });
    expect(spoolCount()).toBe(0);
    expect(server.store.events.size).toBe(events.length);
  });

  it("401: stops, records 'login required' for status and the next session-start line; a good batch clears it", async () => {
    await setup();
    spoolSession({ chunks: 5, per: 1, files: 2 });
    server.tokens.clear();
    await pass();
    expect(spoolCount()).toBe(2);
    expect(loginRequired(paths, MOCK_ORG.id)).toBe(true);
    const st = await cli(["status"], sb, { fetch: undefined, env: { ALIGN_SERVER: server.url } });
    expect(st.out).toContain("sign-in expired: run align login");
    const p = {
      session_id: "new-session",
      transcript_path: null,
      cwd: sb.repo,
      hook_event_name: "SessionStart",
      source: "startup",
    };
    const hook = await cli(["hook", "session-start", "--harness", "claude-code"], sb, {
      internalHome: sb.alignHome,
      readStdin: async () => Buffer.from(JSON.stringify(p)),
      spawnUploader: () => {},
    });
    expect(hook.out).toBe(
      `${JSON.stringify({ systemMessage: "ALIGN · capture on, uploads paused: your sign-in expired. Run align login." })}\n`,
    );
    signIn(server);
    await pass();
    expect(spoolCount()).toBe(0);
    expect(loginRequired(paths, MOCK_ORG.id)).toBe(false);
  });

  it("final codes go to rejected/ with their code; rate_limited stays in the spool", async () => {
    await setup();
    const events = spoolSession({ chunks: 6, per: 1, files: 1 });
    const [a, b] = [events[2]?.event_id, events[4]?.event_id];
    server.capture.rejectWhen = (e) =>
      e.event_id === a ? "redaction_outdated" : e.event_id === b ? "rate_limited" : null;
    await pass();
    expect(server.store.events.size).toBe(events.length - 2);
    expect(countAside(paths.rejected)).toBe(1);
    const dir = join(paths.rejected, repoHash(sb.repo));
    const kept = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), "utf8"));
    expect(kept.items[0]).toMatchObject({ code: "redaction_outdated", event: { event_id: a } });
    expect(spoolCount()).toBe(1);
    server.capture.rejectWhen = null;
    await pass();
    expect(spoolCount()).toBe(0);
    expect(server.store.events.has(b as string)).toBe(true);
    expect(server.store.events.has(a as string)).toBe(false);
  });

  it("session_conflict with the server's id: the index and the session state follow it, the events are re-sent", async () => {
    await setup();
    const events = spoolSession({ chunks: 4, per: 1, files: 2 });
    const mine = events[0]?.session.id as string;
    writeFileSync(paths.sessionState(mine), JSON.stringify({ placeholder: true }));
    const { newState } = await import("../src/hook/state");
    writeFileSync(
      paths.sessionState(mine),
      JSON.stringify(
        newState({
          id: mine,
          harness: "claude-code",
          harness_session_id: "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11",
          root: sb.repo,
          mode: "hooks",
          transcript_path: null,
          now: clock,
        }),
      ),
    );
    const theirs = "0192f6a7-0000-7000-8000-0000000000aa";
    server.store.sessions.set("claude-code:5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11", theirs);
    await pass();
    await pass();
    expect(spoolCount()).toBe(0);
    expect(findSession(paths, "claude-code", "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11")).toBe(theirs);
    expect(readState(paths, theirs)?.id).toBe(theirs);
    expect(existsSync(paths.sessionState(mine))).toBe(false);
    contiguous(server.store.lines.get(theirs), 4);
    expect([...server.store.events.values()].every((e) => (e.session as { id: string }).id === theirs)).toBe(true);
  });

  it("session_conflict without an id mints a new one; a conflict that never ends is given up after 3 tries", async () => {
    await setup();
    const events = spoolSession({ chunks: 2, per: 1, files: 1 });
    const first = events[0]?.session.id as string;
    let once = true;
    server.capture.rejectWhen = (e) => {
      if ((e.session as { id: string }).id === first && once) return "session_conflict";
      return null;
    };
    await pass();
    once = false;
    await pass();
    const minted = findSession(paths, "claude-code", "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11");
    expect(minted).not.toBe(first);
    expect(server.store.lines.get(minted as string)).toEqual([1, 2]);

    // Always refused: after three re-spools the events are rejected instead of looping.
    server.capture.rejectWhen = (e) => (e.kind === "transcript.chunk" ? "session_conflict" : null);
    spoolSession({ harnessSession: "loop-session", chunks: 1, per: 1, files: 1 });
    for (let i = 0; i < 6; i++) await pass();
    expect(spoolCount()).toBe(0);
    expect(countAside(paths.rejected)).toBe(1);
  });

  it("a too_slow 429 waits Retry-After and halves the batch; a 413 halves down to one event, then rejects it", async () => {
    await setup();
    spoolSession({ chunks: 399, per: 1, files: 1 });
    server.capture.batchStatus = {
      status: 429,
      code: "rate_limited",
      times: 1,
      retryAfterS: 7,
      details: { busy_kind: "too_slow" },
    };
    const waits: number[] = [];
    await pass({ sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([7000]);
    expect(server.store.sizes).toEqual([200, 200]);
    expect(spoolCount()).toBe(0);

    spoolSession({ harnessSession: "big", chunks: 3, per: 1, files: 1 });
    server.capture.batchStatus = { status: 413, code: "payload_too_large", times: 3 };
    await pass();
    // 4 events → 2 → 1 (rejected) → the rest go through.
    expect(countAside(paths.rejected)).toBe(1);
    expect(spoolCount()).toBe(0);
  });

  it("events whose redaction did not settle are held on the laptop and never sent", async () => {
    await setup();
    const events = spoolSession({ chunks: 3, per: 1, files: 1 });
    const file = listSpool(paths)[0]?.path as string;
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.events[2].redaction = { version: 1, hits: { unsettled: 1 } };
    writeFileSync(file, JSON.stringify(body));
    await pass();
    expect(server.store.events.size).toBe(events.length - 1);
    expect(server.store.events.has(events[2]?.event_id as string)).toBe(false);
    expect(countAside(paths.held)).toBe(1);
    expect(JSON.stringify(server.requests)).not.toContain(events[2]?.event_id);
  });

  it("only a repository still registered under the same id and opted in is uploaded", async () => {
    await setup();
    spoolSession({ chunks: 2, per: 1, files: 1 });
    setOptedIn(paths, sb.repo, false);
    await pass();
    expect(spoolCount()).toBe(0);
    expect(server.requests.filter((r) => r.path === "/events")).toHaveLength(0);

    setOptedIn(paths, sb.repo, true);
    writeSpoolFile(
      paths,
      repoHash(sb.repo),
      { root: sb.repo, repo_id: "another_repo", events: spoolSession({ chunks: 1, per: 1, files: 1 }), attempts: 0 },
      ++clock,
    );
    // the session's own file (repo_1) goes; the file naming another repository id is dropped unsent
    await pass();
    expect(spoolCount()).toBe(0);
    expect(server.store.events.size).toBe(2);
  });

  it("sends each organisation's events only to the server its token came from, never ALIGN_SERVER", async () => {
    await setup({ signedIn: false });
    const other = await startMockServer();
    try {
      signIn(other);
      spoolSession({ chunks: 2, per: 1, files: 1 });
      // A repository's harness configuration can set ALIGN_SERVER for its hooks; the uploader never reads it.
      process.env.ALIGN_SERVER = server.url;
      await pass();
      expect(other.store.events.size).toBe(3);
      expect(server.requests).toHaveLength(0);
    } finally {
      delete process.env.ALIGN_SERVER;
      await other.close();
    }
  });

  it("no token for the organisation: nothing is sent and the spool stays", async () => {
    await setup({ signedIn: false });
    spoolSession({ chunks: 2, per: 1, files: 1 });
    await pass();
    expect(spoolCount()).toBe(1);
    expect(server.requests).toHaveLength(0);
  });

  it("a corrupt session index stops uploads (no id is ever minted twice)", async () => {
    await setup();
    spoolSession({ chunks: 2, per: 1, files: 1 });
    writeFileSync(paths.sessionsIndex, "{not json");
    await pass();
    expect(server.requests).toHaveLength(0);
    expect(spoolCount()).toBe(1);
    expect(() => readSessionIndex(paths)).toThrow();
  });

  it("spool cap: the oldest files go first, counted in the log", async () => {
    await setup();
    spoolSession({ chunks: 30, per: 20, files: 10 });
    enforceCaps(paths, { spool: 30_000, side: 1000 });
    expect(spoolCount()).toBeLessThan(10);
    const names = listSpool(paths).map((e) => e.name);
    expect(names).toEqual([...names].sort());
    expect(readFileSync(join(paths.logs, "align.log"), "utf8")).toMatch(/spool dropped_over_cap \d+/);
    housekeeping(paths, clock); // the real caps keep what is left
    expect(listSpool(paths).map((e) => e.name)).toEqual(names);
  });

  it("notices: written for a running Claude Code session after its events upload; 404 means none", async () => {
    await setup();
    const events = spoolSession({ chunks: 1, per: 1, files: 1 });
    const id = events[0]?.session.id as string;
    const { newState } = await import("../src/hook/state");
    writeFileSync(
      paths.sessionState(id),
      JSON.stringify(
        newState({
          id,
          harness: "claude-code",
          harness_session_id: "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11",
          root: sb.repo,
          mode: "hooks",
          transcript_path: null,
          now: clock,
        }),
      ),
    );
    await pass();
    expect(existsSync(paths.sessionNotice(id))).toBe(false);
    server.capture.notices.set(
      id,
      mockSessionNotice({
        new_proposals: [
          { key: "P-1", kind: "decision", statement: "Use Postgres advisory locks for the cart, not Redis." },
          { key: "P-2", kind: "decision", statement: "Return 409 on a stale cart." },
        ],
      }),
    );
    spoolSession({ chunks: 1, per: 1, files: 1 });
    clock += 61_000;
    await pass();
    const notice = JSON.parse(readFileSync(paths.sessionNotice(id), "utf8"));
    expect(notice.id).toMatch(/^n-[0-9a-f]{16}$/);
    expect(notice.text).toBe(
      'ALIGN · 2 new proposals from this session: "Use Postgres advisory locks for the cart, not Redis." and 1 more. Confirm with align confirm, or in your PR.',
    );
  });

  it("a growing transcript read in three passes reaches the server with contiguous n", async () => {
    await setup();
    const FIX = join(import.meta.dirname, "..", "src", "harness", "claude-code", "__fixtures__", "claude-code-2.1.307");
    const fixture = (name: string) => readFileSync(join(FIX, name), "utf8").replaceAll("__ROOT__", sb.repo);
    const payloads = JSON.parse(fixture("payloads.json"));
    const transcript = join(sb.dir, "t.jsonl");
    mkdirSync(sb.dir, { recursive: true });
    const all = [...fixture("normal.jsonl").split("\n"), ...fixture("resumed.jsonl").split("\n")].filter(Boolean);
    const hook = (event: string, p: unknown) =>
      cli(["hook", event, "--harness", "claude-code"], sb, {
        internalHome: sb.alignHome,
        readStdin: async () => Buffer.from(JSON.stringify(p)),
        spawnUploader: () => {},
        now: () => (clock += 5000),
      });
    const p = (k: string) => ({ ...payloads[k], transcript_path: transcript });
    writeFileSync(transcript, "");
    await hook("session-start", p("SessionStart"));
    const thirds = [all.slice(0, 3), all.slice(3, 6), all.slice(6)];
    for (const [i, part] of thirds.entries()) {
      appendFileSync(transcript, `${part.join("\n")}\n`);
      await hook("stop", { ...p("Stop"), last_assistant_message: `turn ${i}` });
      await cli(["upload"], sb, { internalHome: sb.alignHome, now: () => (clock += 5000), keychain: null });
    }
    expect(spoolCount()).toBe(0);
    const sid = findSession(paths, "claude-code", payloads.SessionStart.session_id) as string;
    const ns = server.store.lines.get(sid) ?? [];
    expect(ns.length).toBeGreaterThanOrEqual(6);
    contiguous(ns, ns.length);
  });
});

describe("one uploader at a time", () => {
  it("a second daemon started while one runs exits at once", async () => {
    await setup();
    expect(tryLock(paths, clock)).toBe(true);
    const t0 = Date.now();
    await upload(paths, { daemon: true, now, sleep, keychain: null });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(paths.uploadLock)).toBe(true);
    unlock(paths);
  });
});

describe("uploader lock races (D1240)", () => {
  it("eight processes racing for a free lock: exactly one wins, and no empty lock is ever judged stale", async () => {
    await setup();
    const { spawn } = await import("node:child_process");
    const lockModule = join(dirname(new URL(import.meta.url).pathname), "..", "src", "upload", "lock.ts");
    const pathsModule = join(dirname(new URL(import.meta.url).pathname), "..", "src", "paths.ts");
    // The same moment for every child: each spins until it, then calls tryLock once.
    const at = Date.now() + 3000;
    const child = [
      `import { tryLock } from ${JSON.stringify(lockModule)};`,
      `import { alignPaths } from ${JSON.stringify(pathsModule)};`,
      `while (Date.now() < ${at}) {}`,
      `const won = tryLock(alignPaths(${JSON.stringify(sb.alignHome)}), Date.now());`,
      "process.stdout.write(won ? 'won' : 'lost');",
      // Hold the lock a moment, as a daemon would, so a late loser cannot find it gone.
      "if (won) { const e = Date.now() + 1500; while (Date.now() < e) {} }",
    ].join("\n");
    const script = join(sb.dir, "race.mts");
    writeFileSync(script, child);
    const cliRoot = join(dirname(new URL(import.meta.url).pathname), "..");
    const run = () =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, ["--import", "tsx", script], {
          cwd: cliRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        c.stdout.on("data", (d) => {
          out += d;
        });
        c.on("close", () => resolve(out));
      });
    for (let round = 0; round < 3; round++) {
      rmSync(paths.uploadLock, { force: true });
      const results = await Promise.all(Array.from({ length: 8 }, run));
      expect(
        results.filter((r) => r === "won"),
        `round ${round + 1}: ${results.join(",")}`,
      ).toHaveLength(1);
      expect(results.filter((r) => r === "lost")).toHaveLength(7);
    }
    expect(readdirSync(dirname(paths.uploadLock)).filter((n) => /\.(new|stale)$/.test(n))).toEqual([]);
  }, 60_000);

  it("a live holder's heartbeat never leaves the lock free: a contender trying all the while never gets it", async () => {
    await setup();
    const { spawn } = await import("node:child_process");
    const here = dirname(new URL(import.meta.url).pathname);
    const imports = [
      `import { heartbeat, tryLock } from ${JSON.stringify(join(here, "..", "src", "upload", "lock.ts"))};`,
      `import { alignPaths } from ${JSON.stringify(join(here, "..", "src", "paths.ts"))};`,
      `const paths = alignPaths(${JSON.stringify(sb.alignHome)});`,
    ];
    const holder = join(sb.dir, "holder.mts");
    const contender = join(sb.dir, "contender.mts");
    const ready = join(sb.dir, "holder-ready");
    writeFileSync(
      holder,
      [
        ...imports,
        "if (!tryLock(paths, Date.now())) { process.stdout.write('no lock'); process.exit(0); }",
        `(await import("node:fs")).writeFileSync(${JSON.stringify(ready)}, "");`,
        "let beats = 0, lost = 0; const end = Date.now() + 2500;",
        "while (Date.now() < end) { if (heartbeat(paths, Date.now())) beats++; else lost++; }",
        "process.stdout.write(`beats ${beats} lost ${lost}`);",
      ].join("\n"),
    );
    writeFileSync(
      contender,
      [
        ...imports,
        `const fs = await import("node:fs"); while (!fs.existsSync(${JSON.stringify(ready)})) {}`,
        "let won = 0, tries = 0; const end = Date.now() + 2000;",
        "while (Date.now() < end) { tries++; if (tryLock(paths, Date.now())) { won++; break; } }",
        "process.stdout.write(`won ${won} tries ${tries}`);",
      ].join("\n"),
    );
    const run = (script: string) =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, ["--import", "tsx", script], {
          cwd: join(here, ".."),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        c.stdout.on("data", (d) => {
          out += d;
        });
        c.on("close", () => resolve(out));
      });
    rmSync(paths.uploadLock, { force: true });
    const [h, c] = await Promise.all([run(holder), run(contender)]);
    expect(h).toMatch(/^beats [1-9]\d* lost 0$/);
    expect(c).toMatch(/^won 0 tries [1-9]/);
    rmSync(paths.uploadLock, { force: true });
  }, 60_000);

  it("a stale lock and an unreadable one are taken over; a live one is not", async () => {
    await setup();
    mkdirSync(dirname(paths.uploadLock), { recursive: true });
    writeFileSync(paths.uploadLock, `${process.pid} ${clock - 120_000}\n`);
    expect(tryLock(paths, clock)).toBe(true);
    expect(readFileSync(paths.uploadLock, "utf8")).toBe(`${process.pid} ${clock}\n`);
    expect(tryLock(paths, clock + 1)).toBe(false); // live: this process, fresh heartbeat
    writeFileSync(paths.uploadLock, "");
    expect(tryLock(paths, clock + 2)).toBe(true);
    expect(readFileSync(paths.uploadLock, "utf8")).toBe(`${process.pid} ${clock + 2}\n`);
    unlock(paths);
  });
});

describe("uploader lock takeovers (D1242)", () => {
  const here = dirname(new URL(import.meta.url).pathname);
  const runScript = (script: string, ...args: string[]) =>
    new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["--import", "tsx", script, ...args], {
        cwd: join(here, ".."),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      c.stdout.on("data", (d) => {
        out += d;
      });
      c.on("close", () => resolve(out));
    });
  const imports = () => [
    `import { tryLock } from ${JSON.stringify(join(here, "..", "src", "upload", "lock.ts"))};`,
    `import { alignPaths } from ${JSON.stringify(join(here, "..", "src", "paths.ts"))};`,
    `import * as fs from "node:fs";`,
    `const paths = alignPaths(${JSON.stringify(sb.alignHome)});`,
  ];

  it("three processes taking over one stale lock: one wins, and the lock never goes missing meanwhile", async () => {
    await setup();
    mkdirSync(dirname(paths.uploadLock), { recursive: true });
    const contender = join(sb.dir, "takeover.mts");
    const watcher = join(sb.dir, "watcher.mts");
    const go = join(sb.dir, "go");
    const done = join(sb.dir, "done");
    // D3103: every child says it is ready (after its imports, which take seconds on a busy machine) before the start
    // time is set, and the watcher looks until the contenders have all exited, so a slow start can neither make a
    // contender miss the race nor leave the watcher with no look at all ("missing 0 looks 0").
    const ready = (i: string) => `fs.writeFileSync(${JSON.stringify(join(sb.dir, "ready."))} + ${i}, "");`;
    writeFileSync(
      contender,
      [
        ...imports(),
        ready("process.argv[2]"),
        `while (!fs.existsSync(${JSON.stringify(go)})) {}`,
        `const at = Number(fs.readFileSync(${JSON.stringify(go)}, "utf8")); while (Date.now() < at) {}`,
        "const won = tryLock(paths, Date.now());",
        "process.stdout.write(won ? 'won' : 'lost');",
        // Hold the lock a moment, as a daemon would, so a late contender judges it live.
        "if (won) { const e = Date.now() + 800; while (Date.now() < e) {} }",
      ].join("\n"),
    );
    // Counts the moments with no lock at all while the takeovers run (the gap D1242 closes): from the start time
    // until the parent says every contender has exited.
    writeFileSync(
      watcher,
      [
        ...imports(),
        ready("process.argv[2]"),
        `while (!fs.existsSync(${JSON.stringify(go)})) {}`,
        `const at = Number(fs.readFileSync(${JSON.stringify(go)}, "utf8")); while (Date.now() < at) {}`,
        "let missing = 0, looks = 0;",
        `while (looks === 0 || !fs.existsSync(${JSON.stringify(done)})) { looks++; if (!fs.existsSync(paths.uploadLock)) missing++; }`,
        "process.stdout.write(`missing ${missing} looks ${looks}`);",
      ].join("\n"),
    );
    const allReady = async () => {
      const names = ["0", "1", "2", "3"].map((i) => join(sb.dir, `ready.${i}`));
      for (let t = 0; t < 1200 && !names.every((n) => existsSync(n)); t++) await new Promise((r) => setTimeout(r, 50));
      expect(
        names.every((n) => existsSync(n)),
        "every child started within 60 s",
      ).toBe(true);
    };
    for (let round = 0; round < 5; round++) {
      for (const f of [go, done, ...["0", "1", "2", "3"].map((i) => join(sb.dir, `ready.${i}`))])
        rmSync(f, { force: true });
      // Stale: this test process's pid, but a heartbeat two minutes old.
      writeFileSync(paths.uploadLock, `${process.pid} ${Date.now() - 120_000}\n`);
      const takersRun = Promise.all([runScript(contender, "0"), runScript(contender, "1"), runScript(contender, "2")]);
      const watching = runScript(watcher, "3");
      await allReady();
      writeFileSync(go, String(Date.now() + 200));
      const takers = await takersRun;
      writeFileSync(done, "");
      const w = await watching;
      expect(
        takers.filter((r) => r === "won"),
        `round ${round + 1}: ${takers.join(",")}`,
      ).toHaveLength(1);
      expect(takers.filter((r) => r === "lost")).toHaveLength(2);
      expect(w, `round ${round + 1}`).toMatch(/^missing 0 looks [1-9]/);
    }
    expect(existsSync(`${paths.uploadLock}.takeover`)).toBe(false);
    expect(readdirSync(dirname(paths.uploadLock)).filter((n) => /\.(new|stale|tmp)$/.test(n))).toEqual([]);
    rmSync(paths.uploadLock, { force: true });
  }, 400_000);

  it("a live takeover mutex blocks a takeover; one left by a dead process is broken", async () => {
    await setup();
    mkdirSync(dirname(paths.uploadLock), { recursive: true });
    const mutex = `${paths.uploadLock}.takeover`;
    writeFileSync(paths.uploadLock, `${process.pid} ${clock - 120_000}\n`);
    writeFileSync(mutex, `${process.pid} ${clock} 0123456789ab\n`); // live (this process), fresh
    expect(tryLock(paths, clock)).toBe(false);
    expect(readFileSync(paths.uploadLock, "utf8")).toBe(`${process.pid} ${clock - 120_000}\n`);
    writeFileSync(mutex, `${process.pid} ${clock - 10_000} 0123456789ab\n`); // older than 5 s
    expect(tryLock(paths, clock)).toBe(true);
    expect(readFileSync(paths.uploadLock, "utf8")).toBe(`${process.pid} ${clock}\n`);
    expect(existsSync(mutex)).toBe(false);
    unlock(paths);
  });

  it("housekeeping sweeps a dead process's private lock files after 60 s and leaves fresh ones", async () => {
    await setup();
    mkdirSync(dirname(paths.uploadLock), { recursive: true });
    const old = ["new", "stale", "tmp"].map((k) => `${paths.uploadLock}.4242.deadbeef.${k}`);
    const fresh = `${paths.uploadLock}.4243.cafef00d.tmp`;
    for (const f of [...old, fresh]) writeFileSync(f, "1 2\n");
    const past = new Date(Date.now() - 120_000);
    for (const f of old) utimesSync(f, past, past);
    writeFileSync(paths.uploadLock, `${process.pid} ${Date.now()}\n`);
    expect(sweepLockLeftovers(paths)).toBe(3);
    for (const f of old) expect(existsSync(f)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(paths.uploadLock)).toBe(true);
    rmSync(fresh);
    housekeeping(paths, clock); // the uploader's housekeeping runs the sweep
    rmSync(paths.uploadLock, { force: true });
  });

  it("hard links work in a test home (align doctor shows the links check only when they do not)", async () => {
    await setup();
    mkdirSync(paths.spool, { recursive: true });
    expect(hardLinksWork(paths.spool)).toBe(true);
    expect(readdirSync(paths.spool).filter((n) => n.includes("link-probe"))).toEqual([]);
    expect(hardLinksWork(join(sb.dir, "no-such-dir"))).toBe(false);
  });
});

describe("align flush", () => {
  it("prints progress and exits 0 when everything went; 1 when the server cannot be reached", async () => {
    await setup();
    spoolSession({ chunks: 3, per: 1, files: 2 });
    const out: string[] = [];
    expect(await flush(paths, { daemon: false, now, sleep, keychain: null, out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(["Uploading · 4 of 4 events\n", "Uploaded 4 events.\n"]);

    spoolSession({ harnessSession: "s2", chunks: 1, per: 1, files: 1 });
    server.capture.down = true;
    out.length = 0;
    expect(
      await flush(paths, { daemon: false, now, sleep, keychain: null, out: (l) => out.push(l), backoffBudgetMs: 3000 }),
    ).toBe(1);
    expect(out.at(-1)).toBe(
      "2 events wait in the spool: the server could not be reached. They upload when the network returns.\n",
    );
  });
});

describe("review round 1 (L14a)", () => {
  it("align off during a back-off: nothing more is sent, the rest of the spool is dropped (D241)", async () => {
    await setup();
    spoolSession({ chunks: 10, per: 1, files: 2 });
    server.capture.down = true;
    let waits = 0;
    await pass({
      sleep: async (ms) => {
        clock += ms;
        // The person runs `align off` while the uploader waits for the network to come back.
        if (++waits === 2) {
          setOptedIn(paths, sb.repo, false);
          server.capture.down = false;
        }
      },
    });
    expect(server.store.events.size).toBe(0);
    expect(spoolCount()).toBe(0);
  });

  it("align off and uninstall delete the repository's spool at once", async () => {
    await setup();
    spoolSession({ chunks: 2, per: 1, files: 1 });
    const off = await cli(["off"], sb, { env: { ALIGN_SERVER: server.url } });
    expect(off.code).toBe(0);
    expect(spoolCount()).toBe(0);
    setOptedIn(paths, sb.repo, true);
    spoolSession({ harnessSession: "s2", chunks: 2, per: 1, files: 1 });
    expect((await cli(["uninstall"], sb, { env: { ALIGN_SERVER: server.url } })).code).toBe(0);
    expect(spoolCount()).toBe(0);
  });

  it("a conflict without an id plus a late event under the old id keeps one session (no split, no second id)", async () => {
    for (const crash of [null, "after_aside", "after_rewrite"] as const) {
      await setup();
      const first = spoolSession({ chunks: 2, per: 1, files: 1 });
      const old = first[0]?.session.id as string;
      // The server refuses the old id, without naming another (it is taken).
      server.capture.rejectWhen = (e) => ((e.session as { id: string }).id === old ? "session_conflict" : null);
      let seen = false;
      const fault = (s: FaultStep) => {
        if (crash && s === crash && !seen) {
          seen = true;
          throw new Error("killed");
        }
      };
      await pass({ fault }).catch(() => {});
      unlock(paths);
      // A hook that read the index before it moved spools a late event under the old id.
      const late = spoolSession({ chunks: 1, per: 1, files: 1 });
      expect(late[0]?.session.id).not.toBe(old); // the index moved: new hooks use the new id
      writeSpoolFile(
        paths,
        repoHash(sb.repo),
        { root: sb.repo, repo_id: "repo_1", events: [{ ...late[1], session: { id: old } } as TraceEvent], attempts: 0 },
        ++clock,
      );
      for (let i = 0; i < 4 && spoolCount() > 0; i++) await pass();
      const now = findSession(paths, "claude-code", "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11");
      const ids = new Set([...server.store.events.values()].map((e) => (e.session as { id: string }).id));
      expect(ids, String(crash)).toEqual(new Set([now]));
      expect(countAside(paths.rejected), String(crash)).toBe(0);
      await server.close();
      sb.cleanup();
    }
  });

  it("a lock taken over mid-pass stops the pass before its next request", async () => {
    await setup();
    spoolSession({ chunks: 1200, per: 1, files: 3 });
    server.capture.onEvents = () => {
      // Another uploader judged this one dead and took the lock.
      writeFileSync(paths.uploadLock, "999999 " + String(Date.now()) + "\n");
    };
    const before = spoolCount();
    await pass();
    expect(server.store.batches).toBe(1);
    // The answer arrived after the takeover: nothing of the batch was applied, every file is still there.
    expect(spoolCount()).toBe(before);
  });

  it("an in_flight 429 waits and never splits; an exhausted wait is busy, not offline", async () => {
    await setup();
    spoolSession({ chunks: 399, per: 1, files: 1 });
    server.capture.batchStatus = { status: 429, code: "rate_limited", times: 2, details: { busy_kind: "in_flight" } };
    await pass();
    expect(server.store.sizes).toEqual([400]);
    spoolSession({ harnessSession: "s2", chunks: 3, per: 1, files: 1 });
    server.capture.batchStatus = { status: 429, code: "rate_limited", times: 100, retryAfterS: 30 };
    const out: string[] = [];
    expect(
      await flush(paths, {
        daemon: false,
        now,
        sleep,
        keychain: null,
        out: (l) => out.push(l),
        backoffBudgetMs: 60_000,
      }),
    ).toBe(1);
    expect(out.at(-1)).toBe("4 events wait in the spool; the uploader tries again later.\n");
  });

  it("a conflict 429 (a deadlock on the server) is retried whole, never split", async () => {
    await setup();
    spoolSession({ chunks: 299, per: 1, files: 1 });
    server.capture.batchStatus = { status: 429, code: "rate_limited", times: 1, details: { busy_kind: "conflict" } };
    await pass();
    expect(server.store.sizes).toEqual([300]);
    expect(spoolCount()).toBe(0);
  });

  it("after a too_slow halving the batch does not double straight back", async () => {
    await setup();
    spoolSession({ chunks: 999, per: 1, files: 1 });
    server.capture.batchStatus = { status: 429, code: "rate_limited", times: 1, details: { busy_kind: "too_slow" } };
    await pass();
    expect(server.store.sizes.slice(0, 3)).toEqual([250, 250, 250]);
  });

  it("a whole-batch 400 on one event keeps it in the spool (no quarantine on an envelope error)", async () => {
    await setup();
    spoolSession({ chunks: 0, per: 1, files: 1 });
    server.capture.batchStatus = { status: 400, code: "invalid_request", times: 1 };
    await pass();
    expect(spoolCount()).toBe(1);
    expect(countAside(paths.rejected)).toBe(0);
  });

  it("Cursor and Codex events count only where that harness was chosen; unstamped events are held", async () => {
    await setup();
    const events = spoolSession({ chunks: 3, per: 1, files: 1 });
    const file = listSpool(paths)[0]?.path as string;
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.events[1].harness.name = "cursor";
    delete body.events[2].redaction;
    writeFileSync(file, JSON.stringify(body));
    await pass();
    expect(server.store.events.has(events[1]?.event_id as string)).toBe(false);
    expect(server.store.events.has(events[2]?.event_id as string)).toBe(false);
    expect(server.store.events.size).toBe(2);
    expect(countAside(paths.held)).toBe(1);
  });

  it("a corrupt registry stops the pass and deletes nothing", async () => {
    await setup();
    spoolSession({ chunks: 2, per: 1, files: 1 });
    writeFileSync(paths.repos, "{broken");
    await pass();
    expect(spoolCount()).toBe(1);
    expect(server.requests).toHaveLength(0);
    expect(readFileSync(paths.repos, "utf8")).toBe("{broken");
  });
});

describe("review round 2 (L14a): align off while a batch is in flight", () => {
  const off = () => {
    // What `align off` does: the opt-out, then the repository's spool deleted.
    setOptedIn(paths, sb.repo, false);
    rmSync(paths.spoolFor(sb.repo), { recursive: true, force: true });
  };

  it("nothing in flight is written back, and a later align on sends none of it", async () => {
    await setup();
    spoolSession({ chunks: 599, per: 1, files: 2 });
    let first = true;
    server.capture.onEvents = () => {
      if (first) off();
      first = false;
    };
    await pass();
    expect(existsSync(paths.spoolFor(sb.repo))).toBe(false);
    expect(server.store.batches).toBe(1);
    server.capture.onEvents = null;
    setOptedIn(paths, sb.repo, true);
    await pass();
    expect(server.store.batches).toBe(1);
    expect(server.store.events.size).toBe(500);
  });

  it("a conflict answered after align off is not re-spooled", async () => {
    await setup();
    const events = spoolSession({ chunks: 2, per: 1, files: 1 });
    const old = events[0]?.session.id as string;
    server.capture.rejectWhen = (e) => ((e.session as { id: string }).id === old ? "session_conflict" : null);
    server.capture.onEvents = off;
    await pass();
    expect(existsSync(paths.spoolFor(sb.repo))).toBe(false);
  });

  it("opting in again clears whatever the spool still holds (init and align on)", async () => {
    await setup();
    setOptedIn(paths, sb.repo, false);
    writeSpoolFile(
      paths,
      repoHash(sb.repo),
      { root: sb.repo, repo_id: "repo_1", events: spoolSession({ chunks: 1, per: 1, files: 1 }), attempts: 0 },
      ++clock,
    );
    expect(spoolCount()).toBeGreaterThan(0);
    setOptedIn(paths, sb.repo, true);
    expect(spoolCount()).toBe(0);
    setOptedIn(paths, sb.repo, false);
    writeSpoolFile(
      paths,
      repoHash(sb.repo),
      { root: sb.repo, repo_id: "repo_1", events: spoolSession({ chunks: 1, per: 1, files: 1 }), attempts: 0 },
      ++clock,
    );
    upsertRepo(paths, sb.repo, repo().entry);
    expect(spoolCount()).toBe(0);
  });
});

describe("heartbeat is compare-and-set", () => {
  it("refreshes only this process's lock and never replaces another's", async () => {
    await setup();
    expect(heartbeat(paths, clock)).toBe(false); // no lock
    expect(tryLock(paths, clock)).toBe(true);
    expect(heartbeat(paths, clock + 5)).toBe(true);
    expect(readFileSync(paths.uploadLock, "utf8")).toBe(`${process.pid} ${clock + 5}\n`);
    writeFileSync(paths.uploadLock, "999999 1\n");
    expect(heartbeat(paths, clock + 9)).toBe(false);
    expect(readFileSync(paths.uploadLock, "utf8")).toBe("999999 1\n");
    expect(readdirSync(dirname(paths.uploadLock)).filter((n) => n.includes(".hb") || n.endsWith(".tmp"))).toEqual([]);
  });
});
