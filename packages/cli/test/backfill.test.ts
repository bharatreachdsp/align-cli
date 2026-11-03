/**
 * Backfill (L15a; docs/10 §Backfill sources, docs/15 `align init` step 8 and `align backfill`) against the mock server,
 * with fixture homes for each harness built in a temporary HOME: matching rules (the sub-directory probe, the
 * `my_repo` / `my-repo` look-alike), window and caps, consent, the chosen harnesses, opt-in, redaction and deny files,
 * held events, chunk limits, resume and idempotency, `busy_kind`, progress and the 404 of a server without L23b.
 * Synthetic data only; the fake secret is assembled at run time.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableEventId } from "../src/backfill/build";
import { LOCK_REFRESH_MS, limitsFor } from "../src/backfill/run";
import { decodeCursorProject, encodeClaudeProject } from "../src/backfill/scan";
import { lockBackfill } from "../src/backfill/state";
import { encodeCursorProject } from "../src/harness/cursor/transcript";
import { newState, updateState } from "../src/hook/state";
import { alignPaths, repoHash } from "../src/paths";
import { readRegistry, setOptedIn, updateRegistry } from "../src/registry";
import { readSessionIndex, sessionFor } from "../src/sessions";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockOptions, type MockServer, startMockServer } from "./mock-server";

const SRC = join(import.meta.dirname, "..", "src", "harness");
const CC = join(SRC, "claude-code", "__fixtures__", "claude-code-2.1.307");
const CODEX = join(SRC, "codex", "__fixtures__", "codex-0.163.0");
const CURSOR = join(SRC, "cursor", "__fixtures__", "cursor-2026.10.19");
const DAY = 86_400_000;
/** A synthetic AWS-style key id, assembled at run time (hard rule 12). */
const SECRET = ["AKIA", "BFIL", "X7LM", "2PRT", "8VNE"].join("");

let sb: Sandbox;
let server: MockServer;
let root: string;
let clock = Date.now();

afterEach(async () => {
  await server?.close();
  sb?.cleanup();
});

/** A repository named `my-repo` (its look-alike `my_repo` encodes to the same Claude Code and Cursor folder). */
async function setup(o: MockOptions & { harnesses?: string } = {}) {
  sb = sandbox();
  server = await startMockServer(o);
  root = join(sb.dir, "work", "my-repo");
  mkdirSync(root, { recursive: true });
  gitIn(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "synthetic\n");
  gitIn(root, "add", ".");
  gitIn(root, "commit", "-q", "-m", "first");
  gitIn(root, "remote", "add", "origin", "git@github.com:acme/my-repo.git");
  clock = Date.now();
  const r = await run(["init", "--yes", "--no-backfill", "--harness", o.harnesses ?? "claude-code,cursor,codex"]);
  expect(r.code, r.err).toBe(0);
}

const env = () => ({ ALIGN_SERVER: server.url, PATH: "/usr/bin:/bin" });
const run = (argv: string[], extra: Parameters<typeof cli>[2] = {}) =>
  cli(argv, sb, {
    cwd: root,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ttyAsk: async () => "y",
    ...extra,
    env: { ...env(), ...extra.env },
  });
const paths = () => alignPaths(sb.alignHome);

const touch = (file: string, at: number) => utimesSync(file, new Date(at), new Date(at));
const write = (file: string, text: string, at = clock - 3600_000) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  touch(file, at);
  return file;
};
const fixture = (dir: string, name: string, cwd: string) =>
  readFileSync(join(dir, name), "utf8").replaceAll("__ROOT__", cwd);

/** A Claude Code session file in `~/.claude/projects/<encode(folderFor)>/<id>.jsonl`, entries in `cwd`. */
const claude = (id: string, cwd: string, o: { folderFor?: string; text?: string; at?: number } = {}) =>
  write(
    join(sb.home, ".claude", "projects", encodeClaudeProject(o.folderFor ?? root), `${id}.jsonl`),
    o.text ?? fixture(CC, "normal.jsonl", cwd),
    o.at,
  );

/** Claude Code entries: one user prompt and one assistant reply per pair, in `cwd`. */
function claudeEntries(cwd: string, pairs: { user: string; assistant?: string; tool?: Record<string, unknown> }[]) {
  const out: string[] = [];
  let t = clock - 7200_000;
  const tick = () => {
    t += 1000;
    return new Date(t).toISOString();
  };
  for (const p of pairs) {
    const base = { isSidechain: false, cwd, version: "2.1.307", sessionId: "x" };
    out.push(
      JSON.stringify({
        ...base,
        type: "user",
        timestamp: tick(),
        message: { role: "user", content: p.user },
      }),
    );
    const content: unknown[] = [];
    if (p.assistant) content.push({ type: "text", text: p.assistant });
    if (p.tool) content.push({ type: "tool_use", id: "t", ...p.tool });
    if (content.length)
      out.push(
        JSON.stringify({
          ...base,
          type: "assistant",
          timestamp: tick(),
          message: { role: "assistant", content },
        }),
      );
  }
  return `${out.join("\n")}\n`;
}

const codexDay = (at: number) => new Date(at).toISOString().slice(0, 10).split("-");
const codex = (thread: string, cwd: string, o: { name?: string; at?: number } = {}) => {
  const at = o.at ?? clock - 3600_000;
  const [y, m, d] = codexDay(at);
  const text = fixture(CODEX, o.name ?? "paginated.jsonl", cwd).replaceAll(
    "0192f6a8-1111-7000-8000-00000000c0de",
    thread,
  );
  return write(join(sb.home, ".codex", "sessions", y ?? "", m ?? "", d ?? "", `rollout-x-${thread}.jsonl`), text, at);
};
const cursor = (id: string, folderFor = root, at?: number) =>
  write(
    join(sb.home, ".cursor", "projects", encodeCursorProject(folderFor), "agent-transcripts", id, `${id}.jsonl`),
    fixture(CURSOR, "normal.jsonl", root),
    at ?? Date.now(),
  );

type Ev = {
  event_id: string;
  kind: string;
  ts: string;
  capture?: string;
  harness: { name: string; session_id: string };
  session: { id: string };
  payload: { lines?: { n: number; role: string; text: string; tool?: { paths: string[] } }[] };
};
const stored = () => [...server.store.events.values()] as unknown as Ev[];
const storedText = () => JSON.stringify(stored());
const eventPosts = () => server.requests.filter((r) => r.path === "/events");
const spoolFiles = () => {
  const dir = join(sb.alignHome, "spool", repoHash(root));
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
};
const sessionsOf = (harness: string) =>
  new Set(
    stored()
      .filter((e) => e.harness.name === harness)
      .map((e) => e.harness.session_id),
  );

describe("align backfill: finding sessions (docs/10 §Backfill sources)", () => {
  it("counts per harness, uploads with capture 'backfill', hands them over and shows progress", async () => {
    await setup();
    const lookalike = join(sb.dir, "work", "my_repo"); // not on disk here, so Cursor's folder is unambiguous
    claude("a1111111-0000-4000-8000-000000000001", root);
    claude("a1111111-0000-4000-8000-000000000002", join(root, "lib"), { folderFor: join(root, "lib") });
    claude("a1111111-0000-4000-8000-000000000003", lookalike); // same folder name as my-repo; cwd says otherwise
    claude("a1111111-0000-4000-8000-000000000004", join(sb.dir, "work", "my-repo-two"), {
      folderFor: join(sb.dir, "work", "my-repo-two"),
    });
    mkdirSync(join(root, "lib"), { recursive: true });
    codex("c2222222-0000-4000-8000-000000000001", root);
    codex("c2222222-0000-4000-8000-000000000002", lookalike);
    codex("c2222222-0000-4000-8000-000000000003", root, { name: "subagent.jsonl" });
    codex("c2222222-0000-4000-8000-000000000004", root, { at: clock - 40 * DAY });
    cursor("d3333333-0000-4000-8000-000000000001");

    const r = await run(["backfill", "--yes"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Found        Claude Code 2 · Cursor 1 · Codex 1 sessions from the last 30 days");
    expect(r.out).toMatch(
      /Backfill {5}Claude Code 2 · Cursor 1 · Codex 1 sessions · redacted locally · \d+ KB uploaded/,
    );
    expect(r.out).toContain("3 proposals · 1 looks contradicted by the current code");
    expect(r.out).not.toContain("Uploading"); // no terminal: no progress bar

    expect(sessionsOf("claude-code")).toEqual(
      new Set(["a1111111-0000-4000-8000-000000000001", "a1111111-0000-4000-8000-000000000002"]),
    );
    expect(sessionsOf("codex")).toEqual(new Set(["c2222222-0000-4000-8000-000000000001"]));
    expect(sessionsOf("cursor")).toEqual(new Set(["d3333333-0000-4000-8000-000000000001"]));
    expect(stored().every((e) => e.capture === "backfill")).toBe(true);
    expect(storedText()).not.toContain("my_repo");
    const kinds = stored().filter((e) => e.harness.session_id === "a1111111-0000-4000-8000-000000000001");
    expect(kinds.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["session.start", "transcript.chunk", "session.end"]),
    );

    const [post] = server.capture.backfill.posts;
    expect(post?.window_days).toBe(30);
    expect(new Set(post?.session_ids)).toEqual(new Set(stored().map((e) => e.session.id)));
    expect(spoolFiles()).toHaveLength(0);
  });

  it("a look-alike folder on disk (my_repo beside my-repo) makes Cursor's folder ambiguous: nothing taken from it", async () => {
    await setup();
    mkdirSync(join(sb.dir, "work", "my_repo"), { recursive: true });
    expect(decodeCursorProject(encodeCursorProject(root)).sort()).toEqual(
      [root, join(sb.dir, "work", "my_repo")].sort(),
    );
    cursor("d3333333-0000-4000-8000-000000000001");
    claude("a1111111-0000-4000-8000-000000000001", root);
    claude("a1111111-0000-4000-8000-000000000003", join(sb.dir, "work", "my_repo"));
    const r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("Claude Code 1 · Cursor 0 · Codex 0 sessions from the last 30 days");
    expect(sessionsOf("cursor").size).toBe(0);
    expect(sessionsOf("claude-code")).toEqual(new Set(["a1111111-0000-4000-8000-000000000001"]));
  });

  it("look-alikes through segments that encode to nothing (`_`, CJK) are found too: ambiguous, nothing taken", async () => {
    await setup();
    for (const odd of ["_", "项目"]) {
      const twin = join(sb.dir, odd, "work", "my-repo");
      mkdirSync(twin, { recursive: true });
      // /…/_/work/my-repo and /…/项目/work/my-repo encode exactly like /…/work/my-repo
      expect(encodeCursorProject(twin)).toBe(encodeCursorProject(root));
      expect(decodeCursorProject(encodeCursorProject(root)).length).toBeGreaterThan(1);
      rmSync(join(sb.dir, odd), { recursive: true, force: true });
    }
    mkdirSync(join(sb.dir, "项目", "work", "my-repo"), { recursive: true });
    cursor("d3333333-0000-4000-8000-000000000001");
    const r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("no earlier sessions");
    expect(sessionsOf("cursor").size).toBe(0);
  });

  it("a Cursor transcript older than the repository's .git, or a symbolic link, is not taken", async () => {
    await setup();
    cursor("d3333333-0000-4000-8000-000000000001", root, Date.now() - 2 * DAY);
    const outside = write(join(sb.dir, "elsewhere.jsonl"), fixture(CURSOR, "normal.jsonl", root));
    const link = join(sb.home, ".cursor", "projects", encodeCursorProject(root), "agent-transcripts", "d4", "d4.jsonl");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(outside, link);
    const r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("no earlier sessions");
    expect(sessionsOf("cursor").size).toBe(0);
  });

  it("only the harnesses chosen for the repository, narrowed by --harness (D95 (h))", async () => {
    await setup({ harnesses: "claude-code" });
    claude("a1111111-0000-4000-8000-000000000001", root);
    codex("c2222222-0000-4000-8000-000000000001", root);
    cursor("d3333333-0000-4000-8000-000000000001");
    let r = await run(["backfill", "--yes", "--harness", "codex"]);
    expect(r.out).toContain("no earlier sessions of this repository in the last 30 days");
    expect(eventPosts()).toHaveLength(0);
    r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("Found        Claude Code 1 sessions from the last 30 days");
    expect(sessionsOf("codex").size + sessionsOf("cursor").size).toBe(0);
  });

  it("window, the plan's cap and the server's session cap, most recent first", async () => {
    await setup({ limits: { monthly_llm_usd: 5, backfill_sessions: 2 } });
    for (let i = 1; i <= 4; i++)
      claude(`a1111111-0000-4000-8000-00000000000${i}`, root, { at: clock - i * DAY + 1000 });
    claude("a1111111-0000-4000-8000-000000000009", root, { at: clock - 45 * DAY });
    let r = await run(["backfill", "--yes", "--days", "60"]);
    // free plan: 30 days at most; the organisation's cap: 2 sessions, the newest
    expect(r.out).toContain("Claude Code 2 · Cursor 0 · Codex 0 sessions from the last 30 days");
    expect(sessionsOf("claude-code")).toEqual(
      new Set(["a1111111-0000-4000-8000-000000000001", "a1111111-0000-4000-8000-000000000002"]),
    );
    r = await run(["backfill", "--yes", "--days", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--days must be a whole number of days from 1 to 90.");
  });

  it("limits: beta 90 days and 300 sessions; free 30 and 60; --days narrows", () => {
    const state = (plan: string, limits: Record<string, number | null> = {}) =>
      ({ plan, limits }) as unknown as Parameters<typeof limitsFor>[0];
    expect(limitsFor(state("beta"))).toEqual({ days: 90, sessions: 300 });
    expect(limitsFor(state("free"))).toEqual({ days: 30, sessions: 60 });
    expect(limitsFor(state("free"), "7")).toEqual({ days: 7, sessions: 60 });
    expect(limitsFor(state("team", { backfill_sessions: 40 }), "120".slice(0, 2))).toEqual({ days: 12, sessions: 40 });
  });

  it("a session the index knows but backfill never recorded was captured live: skipped, even after its state is pruned", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    claude("a1111111-0000-4000-8000-000000000002", root);
    claude("a1111111-0000-4000-8000-000000000003", root);
    const live = sessionFor(paths(), "claude-code", "a1111111-0000-4000-8000-000000000001");
    updateState(paths(), live, () =>
      newState({
        id: live,
        harness: "claude-code",
        harness_session_id: "x",
        root,
        mode: "jsonl",
        transcript_path: null,
        now: clock,
      }),
    );
    // Captured live 31–90 days ago: the index still has it, its state file was pruned after 30 days.
    sessionFor(paths(), "claude-code", "a1111111-0000-4000-8000-000000000002");
    await run(["backfill", "--yes"]);
    expect(sessionsOf("claude-code")).toEqual(new Set(["a1111111-0000-4000-8000-000000000003"]));
  });
});

describe("align backfill: consent, opt-in and quiet output", () => {
  it("declining consent reads, mints, spools and uploads nothing", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    const before = JSON.stringify(readSessionIndex(paths()));
    const r = await run(["backfill"], { tty: true, answers: ["n"] });
    expect(r.out).toContain("? Read your recent agent sessions for this repository");
    expect(r.out).toContain("ALIGN reads up to 30 days.");
    expect(r.out).toContain("Nothing was uploaded. Run align backfill when you want to.");
    expect(eventPosts()).toHaveLength(0);
    expect(server.capture.backfill.posts).toHaveLength(0);
    expect(spoolFiles()).toHaveLength(0);
    expect(JSON.stringify(readSessionIndex(paths()))).toBe(before);
    expect(existsSync(paths().backfill(root))).toBe(false);
  });

  it("without a terminal: a y typed on /dev/tty, even with --yes; no terminal at all → nothing uploaded", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    const asked: string[] = [];
    let r = await run(["backfill", "--yes"], { ttyAsk: async () => null });
    expect(r.out).toContain("There is no terminal to ask you on, so nothing was uploaded.");
    r = await run(["backfill", "--yes"], {
      ttyAsk: async (q) => {
        asked.push(q);
        return "";
      },
    });
    expect(asked).toHaveLength(1); // an empty answer is not a typed y
    expect(r.out).toContain("Nothing was uploaded.");
    expect(eventPosts()).toHaveLength(0);
    expect(existsSync(paths().backfill(root))).toBe(false);
    r = await run(["backfill"], { ttyAsk: async () => "y" });
    expect(server.capture.backfill.posts).toHaveLength(1);
  });

  it("refused inside an agent's shell, --yes or not; init skips its backfill step there (D405)", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    for (const agentEnv of [{ CLAUDECODE: "1" }, { CURSOR_AGENT: "1" }, { CODEX_SANDBOX: "seatbelt" }]) {
      const r = await run(["backfill", "--yes"], { env: agentEnv });
      expect(r.code).toBe(1);
      expect(r.err).toContain("Only you can agree to upload your past sessions");
    }
    const r = await run(["init", "--yes", "--harness", "claude-code"], { env: { CLAUDECODE: "1" } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Only you can agree to upload your past sessions");
    expect(r.out).not.toContain("Found");
    expect(eventPosts()).toHaveLength(0);
    expect(existsSync(paths().backfill(root))).toBe(false);
  });

  it("init checks --days before anything else; a second backfill waits for the first", async () => {
    await setup();
    let r = await run(["init", "--yes", "--days", "500"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--days must be a whole number of days from 1 to 90.");
    expect(server.requests.filter((q) => q.path === "/repos/resolve")).toHaveLength(1); // setup's only
    claude("a1111111-0000-4000-8000-000000000001", root);
    mkdirSync(join(paths().backfill(root), ".."), { recursive: true });
    writeFileSync(paths().backfillLock(root), "4242 abcdef");
    r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("A backfill is already running for this repository.");
    expect(eventPosts()).toHaveLength(0);
  });

  it("the backfill lock is refreshed while the person thinks (a timer for the whole run); touch never throws", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let refreshed = false;
    try {
      const r = await run(["backfill"], {
        ttyAsk: async () => {
          const lock = paths().backfillLock(root);
          const old = new Date(Date.now() - 3600_000);
          utimesSync(lock, old, old);
          vi.advanceTimersByTime(LOCK_REFRESH_MS);
          refreshed = Date.now() - statSync(lock).mtimeMs < 10_000;
          return "y";
        },
      });
      expect(r.code).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(refreshed).toBe(true);
    const held = lockBackfill(paths(), root, Date.now());
    rmSync(paths().backfillLock(root), { force: true });
    expect(() => held?.touch()).not.toThrow();
    held?.release();
  });

  it("a poll that fails is not a failure: the background line, exit 0", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.backfill.failPolls = true;
    const r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Older sessions are still compiling in the background");
  });

  it("an opted-out or unregistered repository is never read (hard rule 6)", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    setOptedIn(paths(), root, false);
    const r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("This repository is not connected. Run align init.");
    expect(eventPosts()).toHaveLength(0);
  });

  it("on a terminal: the upload and compile progress bars; after ten minutes the background line", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.backfill.polls = Array.from({ length: 400 }, () => ({
      status: "running" as const,
      sessions_total: 1,
      sessions_compiled: 0,
      proposals: 0,
      contradicted: 0,
    }));
    const r = await run(["backfill"], { tty: true, answers: [""] });
    expect(r.out).toContain("Uploading    ████████████████████████  1/1 sessions");
    expect(r.out).toContain("Compiling    ░░░░░░░░░░░░░░░░░░░░░░░░  0/1");
    expect(r.out).toContain(
      "Older sessions are still compiling in the background; `align confirm` shows them as they arrive.",
    );
    const polls = server.requests.filter((q) => q.path.startsWith("/backfill/"));
    expect(polls.length).toBeGreaterThan(100);
    expect(polls.length).toBeLessThanOrEqual(201); // 10 minutes at one poll every 3 s
  });

  it("after compiling, the proposed checks run on the working tree: contradicted counted locally, Next lines", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    writeFileSync(join(root, "lock.ts"), 'import Redis from "ioredis";\n');
    gitIn(root, "add", "lock.ts");
    gitIn(root, "commit", "-q", "-m", "lock");
    gitIn(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const check = (n: number, entry: string, module: string) => ({
      check_id: `0192f0a0-0000-7000-8000-00000000c0${n}0`,
      entry_key: entry,
      kind: "forbid_import" as const,
      spec: { module, paths: ["**"] },
    });
    server.capture.backfill.polls = [
      {
        status: "done",
        proposals: 3,
        contradicted: 0,
        checks_to_run: [check(1, "AL-7", "ioredis"), check(2, "AL-8", "left-pad")],
      },
    ];
    const r = await run(["init", "--yes", "--harness", "claude-code"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("3 proposals · 1 looks contradicted by the current code");
    expect(r.out).toContain("Next: align confirm   review the proposals (about two minutes)");
    expect(r.out).toContain(`${server.url}/app`);
    const [body] = server.capture.checks.results as { results: { check_id: string; result: string }[] }[];
    expect(body?.results.map((x) => x.result)).toEqual(["fail", "pass"]);
    expect(JSON.stringify(server.capture.checks.results)).not.toContain("ioredis");
  });

  it("a local run that fails keeps the server's count", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.checks.resultsDown = true;
    server.capture.backfill.polls = [
      {
        status: "done",
        proposals: 2,
        contradicted: 2,
        checks_to_run: [
          {
            check_id: "0192f0a0-0000-7000-8000-00000000c010",
            entry_key: "AL-7",
            kind: "path_exists",
            spec: { glob: "README.md" },
          },
        ],
      },
    ];
    const r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 proposals · 2 look contradicted by the current code");
  });

  it("align init runs backfill as step 8; --no-backfill skips it", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    let r = await run(["init", "--yes", "--no-backfill", "--harness", "claude-code"]);
    expect(r.out).not.toContain("Found");
    r = await run(["init", "--yes", "--harness", "claude-code"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Found        Claude Code 1 sessions");
    expect(r.out).toContain("Done in");
    expect(server.capture.backfill.posts).toHaveLength(1);
  });
});

describe("align backfill: what leaves the laptop", () => {
  it("secrets, code blocks, denied and outside paths are removed on the laptop (hard rule 5)", async () => {
    await setup();
    writeFileSync(join(root, ".aligndeny"), "lib/private/**\n");
    const text = claudeEntries(root, [
      { user: `Use the key ${SECRET} for the staging bucket.` },
      { user: "Keep this:\n```ts\nconst SYNTHETIC_CODE = 1;\n```\nthanks", assistant: "Noted." },
      { user: "Read them", tool: { name: "Read", input: { file_path: join(root, ".env.local") } } },
      { user: "And this", tool: { name: "Read", input: { file_path: join(root, "lib", "private", "x.ts") } } },
      { user: "And outside", tool: { name: "Read", input: { file_path: "/etc/hosts" } } },
      { user: "And this one", tool: { name: "Edit", input: { file_path: join(root, "lib", "cart.ts") } } },
    ]);
    claude("a1111111-0000-4000-8000-000000000001", root, { text });
    await run(["backfill", "--yes"]);
    const all = storedText();
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("SYNTHETIC_CODE");
    expect(all).toContain("‹code: ");
    const paths = stored().flatMap((e) => (e.payload.lines ?? []).flatMap((l) => l.tool?.paths ?? []));
    expect(paths).toEqual(["lib/cart.ts"]);
  });

  it("chunks stay at or under 500 lines and 192 KB; the 2 MB text cap marks the session truncated", async () => {
    await setup();
    const long = "word ".repeat(1500);
    const pairs = Array.from({ length: 700 }, (_, i) => ({ user: `${i} ${long}` }));
    claude("a1111111-0000-4000-8000-000000000001", root, { text: claudeEntries(root, pairs) });
    await run(["backfill", "--yes"]);
    const chunks = stored().filter((e) => e.kind === "transcript.chunk");
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(Buffer.byteLength(JSON.stringify(c), "utf8")).toBeLessThanOrEqual(192 * 1024);
      expect(c.payload.lines?.length ?? 0).toBeLessThanOrEqual(500);
    }
    const text = chunks.flatMap((c) => c.payload.lines ?? []).reduce((n, l) => n + Buffer.byteLength(l.text), 0);
    expect(text).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(chunks.some((c) => (c.payload as { truncated?: boolean }).truncated === true)).toBe(true);
  });

  it("a session with an event held back (redaction did not settle) is not handed over", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.onEvents = () => {
      const id = readSessionIndex(paths()).sessions["claude-code:a1111111-0000-4000-8000-000000000001"]?.id;
      write(
        join(sb.alignHome, "spool", "held", repoHash(root), "00000000000002-000000000000.json"),
        JSON.stringify({ version: 1, root, repo_id: "x", items: [{ event: { session: { id } }, code: "unsettled" }] }),
      );
    };
    const r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("1 session was refused by the server");
    expect(server.capture.backfill.posts).toHaveLength(0);
  });

  it("events whose redaction did not settle are held on the laptop, never sent", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    // A backfill event already in the spool whose redaction did not settle (as L10 marks it).
    const spoolDir = join(sb.alignHome, "spool", repoHash(root));
    const entry = readRegistry(paths()).repos[root];
    const event = {
      schema_version: 2,
      event_id: stableEventId(clock, ["held"]),
      ts: new Date(clock).toISOString(),
      kind: "transcript.chunk",
      harness: { name: "claude-code", session_id: "held-session", hook_event: null },
      session: { id: sessionFor(paths(), "claude-code", "held-session") },
      repo: { remote_norm: entry?.remote_norm, root_commit: entry?.root_commit, branch: null, head: null },
      cwd_rel: null,
      machine_id: null,
      capture: "backfill",
      payload: { mode: "jsonl", truncated: false, lines: [{ n: 1, role: "user", text: "synthetic" }] },
      redaction: { version: 1, hits: { unsettled: 1 } },
    };
    write(
      join(spoolDir, "00000000000001-000000000000.json"),
      JSON.stringify({ version: 1, root, repo_id: entry?.repo_id, events: [event] }),
    );
    await run(["backfill", "--yes"]);
    expect(server.store.events.has(event.event_id)).toBe(false);
    expect(readdirSync(join(sb.alignHome, "spool", "held", repoHash(root)))).toHaveLength(1);
    expect(sessionsOf("claude-code")).toEqual(new Set(["a1111111-0000-4000-8000-000000000001"]));
  });
});

describe("align backfill: resumable and idempotent", () => {
  it("a rerun skips sessions handed over; a file that grew is read again; ids are stable", async () => {
    await setup();
    const file = claude("a1111111-0000-4000-8000-000000000001", root);
    await run(["backfill", "--yes"]);
    const first = new Set(server.store.events.keys());
    const requests = eventPosts().length;
    let r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("no earlier sessions of this repository");
    expect(eventPosts()).toHaveLength(requests);

    // What backfill remembered about the file forgotten (its entry back to "never read"): read and sent again, with
    // the same ids, so the server stores nothing twice.
    const bf = JSON.parse(readFileSync(paths().backfill(root), "utf8"));
    for (const e of Object.values(bf.sessions) as Record<string, unknown>[])
      Object.assign(e, { size: 0, spooled: false, posted: false, sent: false });
    writeFileSync(paths().backfill(root), JSON.stringify(bf));
    r = await run(["backfill", "--yes"]);
    expect(new Set(server.store.events.keys())).toEqual(first);
    expect(server.store.duplicates).toBe(first.size);

    // The session continued: read again, only the new lines are new.
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}${claudeEntries(root, [{ user: "One more decision: keep the TTL." }])}`,
    );
    touch(file, clock - 60_000);
    r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("Claude Code 1 · Cursor 0 · Codex 0 sessions");
    expect(storedText()).toContain("One more decision");
    expect(server.capture.backfill.posts).toHaveLength(3);
  });

  it("offline: the events wait in the spool and nothing is handed over; the next run sends and hands over", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.down = true;
    let r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 session wait to upload; run align backfill again to compile them.");
    expect(server.capture.backfill.posts).toHaveLength(0);
    expect(spoolFiles().length).toBeGreaterThan(0);
    server.capture.down = false;
    r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(0);
    expect(server.capture.backfill.posts).toHaveLength(1);
    expect(spoolFiles()).toHaveLength(0);
    expect(server.store.duplicates).toBe(0);
  });

  it("off and on again while events waited: the emptied spool is read again, never handed over empty", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.down = true;
    let r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(1);
    // align off: the uploader drops this repository's spool; then align on.
    setOptedIn(paths(), root, false);
    server.capture.down = false;
    await cli(["upload"], sb, { internalHome: sb.alignHome, now: () => clock });
    expect(spoolFiles()).toHaveLength(0);
    expect(server.store.events.size).toBe(0);
    setOptedIn(paths(), root, true);
    r = await run(["backfill", "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(sessionsOf("claude-code")).toEqual(new Set(["a1111111-0000-4000-8000-000000000001"]));
    expect(server.capture.backfill.posts).toHaveLength(1);
  });

  it("a busy server (429 in_flight) is waited for, never split, and the backfill completes", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.batchStatus = {
      status: 429,
      code: "rate_limited",
      times: 2,
      retryAfterS: 2,
      details: { busy_kind: "in_flight" },
    };
    const r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(0);
    expect(server.capture.backfill.posts).toHaveLength(1);
  });

  it("a server without the backfill routes (before L23b): uploaded, not handed over; a later run hands over", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    server.capture.backfill.enabled = false;
    let r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Your sessions are uploaded; the server does not compile them yet.");
    const sent = eventPosts().length;
    server.capture.backfill.enabled = true;
    r = await run(["backfill", "--yes"]);
    expect(server.capture.backfill.posts).toHaveLength(1);
    expect(eventPosts()).toHaveLength(sent); // nothing read or sent again
  });

  it("a session the server refuses (final code) is not handed over, and not retried while unchanged", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root);
    claude("a1111111-0000-4000-8000-000000000002", root);
    server.capture.rejectWhen = (e) =>
      (e.harness as { session_id?: string }).session_id === "a1111111-0000-4000-8000-000000000002"
        ? "session_unavailable"
        : null;
    let r = await run(["backfill", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "1 session was refused by the server (kept in ~/.align/spool/rejected); it is not compiled.",
    );
    expect(r.out).toContain("Backfill     Claude Code 1 · Cursor 0 · Codex 0 sessions");
    expect(server.capture.backfill.posts).toHaveLength(1);
    expect(server.capture.backfill.posts[0]?.session_ids).toHaveLength(1);
    const sent = eventPosts().length;
    r = await run(["backfill", "--yes"]);
    expect(r.out).toContain("no earlier sessions of this repository");
    expect(eventPosts()).toHaveLength(sent);
  });

  it("an opt-out during the backfill stops it before the next session", async () => {
    await setup();
    claude("a1111111-0000-4000-8000-000000000001", root, { at: clock - 1000 });
    claude("a1111111-0000-4000-8000-000000000002", root, { at: clock - 2000 });
    let first = true;
    server.capture.onEvents = () => {
      if (first)
        updateRegistry(paths(), (reg) => {
          const e = reg.repos[root];
          if (e) e.opted_in = false;
        });
      first = false;
    };
    await run(["backfill", "--yes"]);
    expect(server.capture.backfill.posts).toHaveLength(0);
  });

  it("stable ids are UUID v7-shaped", () => {
    const id = stableEventId(Date.parse("2026-10-22T09:00:00Z"), ["s", "transcript.chunk", "{}"]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableEventId(Date.parse("2026-10-22T09:00:00Z"), ["s", "transcript.chunk", "{}"])).toBe(id);
    expect(stableEventId(Date.parse("2026-10-22T09:00:00Z"), ["s", "transcript.chunk", "{ }"])).not.toBe(id);
  });
});
