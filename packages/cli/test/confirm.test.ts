/**
 * `align confirm`, `decide`, `ask` (L17; docs/15 §Confirm TUI, docs/19 §CLI: align confirm): card snapshots at 80 and
 * 120 columns, the TUI's keys through a fake terminal (each key, a pasted burst, keys while a request runs, Ctrl-C,
 * resize, `$EDITOR`), the non-TTY modes, laptop redaction of every typed string, and one line per API error code.
 * A temporary HOME, the mock server on 127.0.0.1, synthetic data and secrets built at run time.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOCK_ORG, MOCK_USER } from "@align/core/api";
import { afterEach, describe, expect, it } from "vitest";
import { renderCard } from "../src/confirm/card";
import type { Term } from "../src/confirm/term";
import { copy } from "../src/copy";
import { CredentialStore } from "../src/credentials";
import type { Entry } from "../src/ledger/api";
import { apiErrorLine } from "../src/ledger/errors";
import { alignPaths, type Paths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockLedger, mockEntry, mockLedger } from "./mock-ledger";
import { type MockServer, startMockServer } from "./mock-server";

const GOLDEN = join(import.meta.dirname, "__golden__", "cards");
const REPO_ID = "0192f0a0-0000-7000-8000-000000000201";
/** A synthetic AWS-style access key id, assembled at run time so no secret-shaped literal is committed. */
const SECRET = ["AKIA", "QX7T", "LMNO", "PRST", "UV23"].join("");

let sb: Sandbox;
let server: MockServer | null = null;
let ledger: MockLedger;
let paths: Paths;

afterEach(async () => {
  await server?.close();
  server = null;
  sb?.cleanup();
});

const contradicted = () =>
  mockEntry({
    key: "P-7",
    open_conflicts: 1,
    evidence: [
      ...mockEntry().evidence,
      {
        kind: "commit",
        locator: "commit 4c1e9 · lib/cart/lock.ts",
        quote: "checkout: advisory lock around cart finalisation",
        url: null,
        added_in_revision: 1,
        created_at: "2026-09-12T10:00:00.000Z",
      },
    ],
    conflicts: [
      {
        id: "0192f0a0-0000-7000-8000-00000000c001",
        entry_key: "P-7",
        origin: "pr",
        pr_number: 91,
        sha: "a".repeat(40),
        method: "check",
        summary: "lib/cart/lock.ts now imports ioredis",
        status: "open",
        created_at: "2026-10-02T10:00:00.000Z",
        resolved_at: null,
      },
    ],
    checks: [
      {
        id: "0192f0a0-0000-7000-8000-00000000c101",
        entry_key: "P-7",
        kind: "forbid_import",
        spec: { modules: ["ioredis", "redis"], paths: ["lib/cart/**"] },
        status: "proposed",
        revision: 1,
        last_run: null,
      },
    ],
  });
const supersedes = () =>
  mockEntry({
    key: "P-8",
    statement: "Checkout API returns 409 on a stale cart version, never 500.",
    rationale: null,
    alternatives_rejected: [],
    links: [{ relation: "supersedes", direction: "out", key: "AL-3" }],
    created_at: "2026-09-19T10:00:00.000Z",
  });
const plain = () =>
  mockEntry({
    key: "P-9",
    kind: "commitment",
    statement: "Refund flow ships before the 15 Oct release.",
    rationale: null,
    alternatives_rejected: [],
    evidence: [],
    private: false,
    created_at: "2026-09-24T10:00:00.000Z",
  });

describe("cards", () => {
  for (const [name, entry] of [
    ["contradicted", contradicted],
    ["supersedes", supersedes],
    ["plain", plain],
  ] as const) {
    for (const width of [80, 120]) {
      it(`${name} at ${width} columns matches its snapshot and fits the width`, () => {
        const text = renderCard(
          entry(),
          { index: 0, total: 3, width, color: false },
          name === "contradicted" ? { acceptChecks: true } : {},
        );
        const file = join(GOLDEN, `${name}-${width}.txt`);
        if (process.env.UPDATE_GOLDEN) {
          mkdirSync(GOLDEN, { recursive: true });
          writeFileSync(file, text);
        }
        expect(text).toBe(readFileSync(file, "utf8"));
        for (const line of text.split("\n")) expect([...line].length).toBeLessThanOrEqual(width);
      });
    }
  }

  it("never prints a terminal escape from server text, and colours only on request", () => {
    const e = mockEntry({ statement: "Use locks \u001b[2J\u001b]0;evil\u0007 everywhere please." });
    const plainText = renderCard(e, { index: 0, total: 1, width: 80, color: false });
    expect(plainText).not.toContain("\u001b");
    const colour = renderCard(e, { index: 0, total: 1, width: 80, color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping our own colour codes to look for others
    expect(colour.replace(/\u001b\[[0-9;]*m/g, "")).not.toContain("\u001b");
  });
});

/** A fake terminal: scripted input chunks, each delivered after the TUI draws (as a person reads, then presses). */
class FakeTerm implements Term {
  color = false;
  width = 80;
  out = "";
  rawOn = false;
  rawChanges: boolean[] = [];
  restored = 0;
  /** What was written after `restore()`: the real terminal is closed by then, so it never reaches the person. */
  lost = "";
  draws = 0;
  prompts: string[] = [];
  /** Virtual time: a person reads each card for half a second before pressing a key. */
  clock = 1_000_000;
  now() {
    return this.clock;
  }
  private onDataCb: ((c: string) => void) | null = null;
  private onResizeCb: (() => void) | null = null;
  constructor(
    private script: (string | string[] | "RESIZE" | { key: string; held: number })[],
    private answers: (string | null)[] = [],
    private edited: string | null = null,
  ) {}
  columns() {
    return this.width;
  }
  write(t: string) {
    if (this.restored > 0) {
      this.lost += t;
      return;
    }
    this.out += t;
    if (t.startsWith("\u001b[2J")) {
      this.draws++;
      const next = this.script.shift();
      if (next === undefined) return;
      setTimeout(() => {
        this.clock += 500;
        if (next === "RESIZE") {
          this.width = 120;
          // The TUI redraws; that draw delivers the next scripted input.
          this.onResizeCb?.();
          return;
        }
        // An array: several chunks in a row, the later ones while the first one's request runs (or, as
        // `{ held }`, a key held down: the same key every 30 ms).
        if (typeof next === "object" && !Array.isArray(next)) {
          for (let i = 0; i < next.held; i++) {
            this.onDataCb?.(next.key);
            this.clock += 30;
          }
          return;
        }
        for (const c of [next].flat()) this.onDataCb?.(c);
      }, 0);
    }
  }
  raw(on: boolean) {
    this.rawOn = on;
    this.rawChanges.push(on);
  }
  onData(cb: (c: string) => void) {
    this.onDataCb = cb;
    return () => {
      this.onDataCb = null;
    };
  }
  onResize(cb: () => void) {
    this.onResizeCb = cb;
    return () => {
      this.onResizeCb = null;
    };
  }
  async prompt(q: string) {
    this.prompts.push(q);
    return this.answers.shift() ?? null;
  }
  async edit() {
    return this.edited;
  }
  restore() {
    this.restored++;
    this.rawOn = false;
  }
}

async function setup(entries: Entry[], signedIn = true) {
  ttyAnswers = [];
  ttyQuestions = [];
  sb = sandbox();
  paths = alignPaths(sb.alignHome);
  ledger = mockLedger(entries);
  server = await startMockServer({ ledger });
  upsertRepo(paths, sb.repo, {
    repo_id: REPO_ID,
    org_id: MOCK_ORG.id,
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses: ["claude-code"],
    installed_at: new Date().toISOString(),
  });
  if (signedIn) {
    const token = ["aln", "mock", "0123456789abcdef0123"].join("_");
    server.tokens.add(token);
    new CredentialStore(paths, null).put(
      { org: MOCK_ORG, user: MOCK_USER, expires_at: "2027-01-01T00:00:00.000Z", server: server.url },
      token,
    );
  }
}

/** What the person types on `/dev/tty` when asked (null: no controlling terminal). */
let ttyAnswers: (string | null)[] = [];
let ttyQuestions: string[] = [];
const run = (args: string[], o: { term?: FakeTerm | null; tty?: boolean; env?: Record<string, string> } = {}) =>
  cli(args, sb, {
    keychain: null,
    tty: o.tty ?? o.term !== undefined,
    env: { ALIGN_SERVER: server?.url ?? "", ...o.env },
    confirmTerm: () => (o.term === undefined ? null : o.term),
    ttyAsk: async (q) => {
      ttyQuestions.push(q);
      return ttyAnswers.length ? (ttyAnswers.shift() ?? null) : null;
    },
  });
const posts = () => ledger.calls.filter((c) => c.method === "POST");

describe("align confirm (TUI)", () => {
  it("c confirms, k skips, q quits; every write carries an idempotency key and via cli", async () => {
    await setup([contradicted(), supersedes(), plain()]);
    const term = new FakeTerm(["c", "k", "q"]);
    const r = await run(["confirm"], { term });
    expect(r.code).toBe(0);
    expect(posts()).toEqual([
      {
        method: "POST",
        path: "/entries/P-7/confirm",
        body: { via: "cli" },
        idempotency: expect.stringMatching(/^cli-/),
      },
    ]);
    expect(ledger.entries.get("P-7")?.status).toBe("confirmed");
    expect(ledger.entries.get("P-8")?.status).toBe("proposed");
    expect(term.out).toContain("Confirmed 1 · rejected 0 · superseded 0 · shared 0 · skipped 1.");
    expect(term.lost).toBe("");
    expect(term.out).toContain(copy.confirm.header(3));
    expect(term.rawOn).toBe(false);
    expect(term.restored).toBeGreaterThan(0);
  });

  it("a pasted burst acts on its first key only; keys typed while a request runs are dropped", async () => {
    await setup([contradicted(), supersedes(), plain()]);
    // "cccc" in one chunk on card 1; on card 2 a "c" then three more while its confirmation is in flight.
    const term = new FakeTerm(["cccc", ["c", "c", "c", "c"], "q"]);
    await run(["confirm"], { term });
    expect(posts().map((c) => c.path)).toEqual(["/entries/P-7/confirm", "/entries/P-8/confirm"]);
    expect(ledger.entries.get("P-9")?.status).toBe("proposed");
  });

  it("e edits the wording (sent, redacted, with the confirmation); a toggles the proposed checks", async () => {
    await setup([contradicted()]);
    const term = new FakeTerm(
      ["e", "a", "c"],
      [],
      `Use Postgres advisory locks for checkout; key ${SECRET} is not used.`,
    );
    await run(["confirm"], { term });
    const body = posts()[0]?.body as { edits: { statement: string }; accept_checks: string[] };
    expect(body.edits.statement).not.toContain(SECRET);
    expect(body.edits.statement).toContain("‹");
    expect(body.accept_checks).toEqual(["0192f0a0-0000-7000-8000-00000000c101"]);
    expect(ledger.entries.get("P-7")?.checks[0]?.status).toBe("active");
  });

  it("e without an editor asks for one line; a statement out of 12–280 characters is refused", async () => {
    await setup([contradicted()]);
    const term = new FakeTerm(["e", "q"], ["too short"], null);
    await run(["confirm"], { term });
    expect(term.prompts).toEqual([copy.confirm.askWording]);
    expect(term.out).toContain(copy.confirm.badLength);
    expect(posts()).toEqual([]);
  });

  it("r rejects with the reason typed, redacted on the laptop; an empty reason changes nothing", async () => {
    await setup([contradicted(), supersedes()]);
    const term = new FakeTerm(["r", "r", "q"], ["", `not a decision, see ${SECRET}`]);
    await run(["confirm"], { term });
    expect(posts()).toHaveLength(1);
    const reason = (posts()[0]?.body as { reason: string } | undefined)?.reason ?? "";
    expect(reason).toContain("not a decision");
    expect(reason).not.toContain(SECRET);
    expect(term.out).toContain(copy.confirm.cancelled);
  });

  it("s supersedes the entry the proposal names (no target asked) and asks for the reason", async () => {
    await setup([supersedes(), mockEntry({ key: "AL-3", status: "confirmed" })]);
    const term = new FakeTerm(["s", "q"], ["409 is what clients retry on"]);
    await run(["confirm"], { term });
    expect(term.prompts).toEqual([copy.confirm.askSupersedeReason("AL-3")]);
    expect(posts()).toEqual([
      {
        method: "POST",
        path: "/entries/AL-3/supersede",
        body: { by_key: "P-8", reason: "409 is what clients retry on" },
        idempotency: expect.any(String),
      },
    ]);
  });

  it("s without a named target asks for its key and refuses one that is not a key", async () => {
    await setup([contradicted()]);
    const term = new FakeTerm(["s", "q"], ["not-a-key"]);
    await run(["confirm"], { term });
    expect(term.out).toContain(copy.confirm.badKey("NOT-A-KEY"));
    expect(posts()).toEqual([]);
  });

  it("h shares the proposal with the repository without confirming it", async () => {
    await setup([contradicted()]);
    const term = new FakeTerm(["h"]);
    await run(["confirm"], { term });
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/entries/share", { keys: ["P-7"] }]]);
    expect(ledger.entries.get("P-7")?.status).toBe("proposed");
  });

  it("Ctrl-C leaves at once with 130 and the terminal restored; resize redraws at the new width", async () => {
    await setup([contradicted(), supersedes()]);
    const term = new FakeTerm(["RESIZE", "\u0003"]);
    const r = await run(["confirm"], { term });
    expect(r.code).toBe(130);
    expect(term.draws).toBeGreaterThanOrEqual(2);
    expect(term.rawChanges.at(-1)).toBe(false);
    expect(term.restored).toBeGreaterThan(0);
    expect(posts()).toEqual([]);
  });

  it("an API error is one line under the card and the card stays", async () => {
    await setup([contradicted()]);
    ledger.failNext.set("/entries/P-7/confirm", { status: 409, code: "invalid_transition" });
    const term = new FakeTerm(["c", "q"]);
    await run(["confirm"], { term });
    expect(term.out.replace(/\s+/g, " ")).toContain(copy.apiError.invalid_transition);
    expect(ledger.entries.get("P-7")?.status).toBe("proposed");
  });

  it("nothing waiting: one line", async () => {
    await setup([]);
    const term = new FakeTerm([]);
    await run(["confirm"], { term });
    expect(term.out).toBe(`${copy.confirm.nothing}\n`);
  });
});

describe("align confirm (no terminal)", () => {
  it("--list prints the waiting proposals; keys confirm; --reject rejects with a reason", async () => {
    await setup([contradicted(), supersedes(), plain()]);
    const list = await run(["confirm", "--list"], { tty: false });
    expect(list.out.split("\n")[1]).toBe(
      `P-7      decision   CONTRADICTED  “Use Postgres advisory locks for cart checkout, not Redis.”`,
    );
    ttyAnswers = ["y", "yes"];
    expect((await run(["confirm", "P-7", "p-8"], { tty: false })).out).toBe("Confirmed P-7.\nConfirmed P-8.\n");
    expect((await run(["confirm", "P-9", "--reject", "not a commitment"], { tty: false })).out).toBe("Rejected P-9.\n");
    expect(ttyQuestions).toEqual([copy.person.askConfirm(["P-7", "P-8"]), copy.person.askReject(["P-9"])]);
    expect(ledger.entries.get("P-9")?.status).toBe("rejected");
  });

  it("without a controlling terminal and without keys it confirms nothing and names no shortcut", async () => {
    await setup([contradicted()]);
    const r = await run(["confirm"], { tty: false });
    expect(r).toEqual({ code: 1, out: "", err: `${copy.confirm.noTerminal}\n` });
    expect(posts()).toEqual([]);
  });

  it("a key that fails prints its one line and exits 1; the others still go", async () => {
    await setup([contradicted()]);
    ttyAnswers = ["y"];
    const r = await run(["confirm", "P-404", "P-7"], { tty: false });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`P-404: ${copy.apiError.entry_not_found}\n`);
    expect(r.out).toBe("Confirmed P-7.\n");
  });
});

describe("align decide and align ask", () => {
  it("every string argument is redacted before it leaves the laptop; --owner goes as owner_email", async () => {
    await setup([]);
    ttyAnswers = ["y"];
    const r = await run(
      [
        "decide",
        `Rotate the deploy key ${SECRET} out of CI by Friday.`,
        "--why",
        `the old key ${SECRET} leaked`,
        "--rejected",
        `keep ${SECRET}`,
        "--paths",
        "infra/ci,deploy",
        "--commitment",
        "--owner",
        "riya@acme.example",
        "--due",
        "2026-11-15",
      ],
      { tty: false },
    );
    expect(r).toEqual({ code: 0, out: "Recorded AL-1.\n", err: "" });
    const body = posts()[0]?.body as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body).toMatchObject({
      repo_id: REPO_ID,
      kind: "commitment",
      scope_paths: ["infra/ci", "deploy"],
      owner_email: "riya@acme.example",
      due_date: "2026-11-15",
      via: "cli",
    });
    const ask = await run(["ask", `Which lock timeout, 5 s or 30 s? (${SECRET})`, "--owner", "arjun@acme.example"], {
      tty: false,
    });
    expect(ask.out).toBe("Asked Q-1. It is visible to the repository.\n");
    const q = posts()[1]?.body as Record<string, unknown>;
    expect(String(q.text)).not.toContain(SECRET);
    expect(q.owner_email).toBe("arjun@acme.example");
    // No terminal: an agent's question (L43, F9, D514).
    expect(q.via).toBe("agent");
  });

  it("L43: `align ask` on a person's terminal is a person's question; inside an agent's shell it is an agent's", async () => {
    await setup([]);
    ttyAnswers.push("y");
    await run(["ask", "Which lock timeout should the cart use here?"], { tty: true });
    expect(ttyQuestions.at(-1)).toContain("Type y to ask");
    expect(((posts().at(-1)?.body ?? {}) as Record<string, unknown>).via).toBe("person");
    await run(["ask", "Which lock timeout should the cart use here?"], { tty: true, env: { CLAUDECODE: "1" } });
    expect(((posts().at(-1)?.body ?? {}) as Record<string, unknown>).via).toBe("agent");
  });

  it("refuses bad arguments before sending anything (exit 2)", async () => {
    await setup([]);
    for (const [args, line] of [
      [["decide", "too short"], copy.decide.badLength],
      [["decide", "A long enough statement here.", "--owner", "riya@acme.example"], copy.decide.ownerNeedsCommitment],
      [["decide", "A long enough statement here.", "--commitment", "--due", "15 Nov"], copy.decide.badDue],
      [["decide", "A long enough statement here.", "--paths", "/etc,../x"], copy.decide.badPaths],
      [["ask", "A long enough question here?", "--owner", "not-an-email"], copy.decide.badOwner],
    ] as const) {
      const r = await run([...args], { tty: false });
      expect({ code: r.code, err: r.err }).toEqual({ code: 2, err: `${line}\n` });
    }
    expect(posts()).toEqual([]);
  });

  it("not signed in: the sign-in line", async () => {
    await setup([], false);
    const r = await run(["decide", "A long enough statement here."], { tty: false });
    expect(r).toEqual({ code: 1, out: "", err: `${copy.loginRequired}\n` });
  });
});

describe("API errors", () => {
  it("every code maps to one line; an unknown code to the generic line with its code", () => {
    // docs/25 §Conventions, the 19 codes (a fixed list: a code dropped from copy.ts fails here).
    const DOCS_25 = [
      "unauthorized",
      "token_expired",
      "forbidden",
      "not_opted_in",
      "terms_required",
      "repo_not_connected",
      "repo_other_org",
      "entry_not_found",
      "session_conflict",
      "identity_conflict",
      "invalid_request",
      "invalid_transition",
      "quote_mismatch",
      "redaction_outdated",
      "payload_too_large",
      "rate_limited",
      "plan_limit",
      "spend_cap",
      "internal",
    ];
    expect(Object.keys(copy.apiError).sort()).toEqual([...DOCS_25].sort());
    for (const [code, line] of Object.entries(copy.apiError)) {
      expect(apiErrorLine(code)).toBe(line);
      expect(line).not.toContain("\n");
      expect(line.length).toBeLessThan(160);
    }
    expect(apiErrorLine("brand_new_code")).toBe(copy.serverError("brand_new_code"));
    expect(apiErrorLine("x\u001b[2Jy")).toBe(copy.serverError("xy"));
  });

  it("the server's message is never printed, only the code's line", async () => {
    await setup([contradicted()]);
    ledger.failNext.set("/entries/P-7/confirm", { status: 429, code: "rate_limited" });
    ttyAnswers = ["y"];
    const r = await run(["confirm", "P-7"], { tty: false });
    expect(r.err).toBe(`P-7: ${copy.apiError.rate_limited}\n`);
  });
});

describe("only a person confirms (D404, hard rule 3)", () => {
  const AGENT_ENVS: [string, Record<string, string>][] = [
    ["Claude Code", { CLAUDECODE: "1" }],
    ["Claude Code", { CLAUDE_CODE_ENTRYPOINT: "cli" }],
    ["Cursor", { CURSOR_AGENT: "1" }],
    ["Codex", { CODEX_SANDBOX: "seatbelt" }],
    // Codex 0.163 sets these for every command its agent runs, full access and pty mode included (L17 round 2, R1).
    ["Codex", { CODEX_THREAD_ID: "0199a1b2-thread" }],
    ["Codex", { CODEX_TOOL_CALL_ID: "call_1" }],
    ["Codex", { CODEX_CI: "1" }],
    ["Cursor", { CURSOR_CONVERSATION_ID: "c-1" }],
    // Cursor's agent runs long commands in its own tmux server (`-L cursor-agent`), whose panes get no CURSOR_* at all.
    ["Cursor", { TMUX: "/tmp/tmux-1000/cursor-agent,4242,0" }],
  ];
  for (const [harness, env] of AGENT_ENVS) {
    it(`inside ${harness}'s agent shell (${Object.keys(env)[0]}) confirm, --reject, the TUI and decide refuse`, async () => {
      await setup([contradicted()]);
      ttyAnswers = ["y", "y", "y", "y"];
      const line = `${copy.person.agent(harness)}\n`;
      for (const args of [
        ["confirm", "P-7"],
        ["confirm", "P-7", "--reject", "no"],
        ["decide", "A long enough statement here."],
      ]) {
        const r = await run(args, { tty: false, env });
        expect({ code: r.code, err: r.err }).toEqual({ code: 1, err: line });
      }
      const tui = await run(["confirm"], { term: new FakeTerm(["c"]), env });
      expect(tui.err).toBe(line);
      expect(posts()).toEqual([]);
      expect(ttyQuestions).toEqual([]);
    });
  }

  it("a person's own tmux is not an agent", async () => {
    await setup([contradicted()]);
    ttyAnswers = ["y"];
    expect((await run(["confirm", "P-7"], { tty: false, env: { TMUX: "/tmp/tmux-1000/default,77,0" } })).code).toBe(0);
  });

  it("decide shows the statement flattened and refuses control characters before sending (R4)", async () => {
    await setup([]);
    for (const bad of [
      "Use integer cents \u001b[2J\u001b[1;1Hfor money everywhere.",
      "Use integer cents for money \u202eeverywhere.",
      "Use integer cents\u0007 for money everywhere.",
    ]) {
      ttyAnswers = ["y"];
      const r = await run(["decide", bad], { tty: false });
      expect({ code: r.code, err: r.err }).toEqual({ code: 2, err: `${copy.decide.badControl}\n` });
      const why = await run(["decide", "A long enough statement here.", "--why", bad], { tty: false });
      expect(why.err).toBe(`${copy.decide.badControl}\n`);
      const rej = await run(["decide", "A long enough statement here.", "--rejected", bad], { tty: false });
      expect(rej.err).toBe(`${copy.decide.badControl}\n`);
      const q = await run(["ask", bad], { tty: false });
      expect(q.err).toBe(`${copy.decide.badControl}\n`);
    }
    expect(posts()).toEqual([]);
    expect(ttyQuestions).toEqual([]);
    // Tabs and newlines are only spacing: the question shows one line.
    ttyAnswers = ["y"];
    const ok = await run(["decide", "Use integer cents\n\tfor money everywhere."], { tty: false });
    expect(ok.code).toBe(0);
    expect(ttyQuestions).toEqual([copy.person.askRecord("Use integer cents for money everywhere.")]);
  });

  it("an emoji joined with U+200D is text, not a control character; a lone U+200D is refused", async () => {
    await setup([]);
    ttyAnswers = ["y"];
    const ok = await run(["decide", "Ship the 👨\u200d💻 onboarding guide this week."], { tty: false });
    expect(ok.code).toBe(0);
    // (Redaction then removes default-ignorable code points, the joiner included: D201.)
    expect(JSON.stringify(posts()[0]?.body)).toMatch(/👨\u200d?💻/u);
    for (const bad of [
      "Ship the onboarding\u200d guide this week.",
      "Ship the 👨\u200d onboarding guide.",
      "Ship the\u200d💻 onboarding guide.",
    ]) {
      const r = await run(["decide", bad], { tty: false });
      expect(r.err).toBe(`${copy.decide.badControl}\n`);
    }
    expect(posts()).toHaveLength(1);
  });

  it("the TUI refuses control characters in edited wording and in typed reasons, before anything is sent", async () => {
    await setup([contradicted()]);
    const edit = new FakeTerm(["e", "c", "q"], [], "Checkout returns 409\u001b[2J on a stale cart version.");
    await run(["confirm"], { term: edit });
    expect(edit.out).toContain(copy.decide.badControl);
    // The confirmation that followed carries the card's own wording, not the refused edit.
    expect(posts().map((c) => c.body)).toEqual([expect.not.objectContaining({ statement: expect.anything() })]);
    await setup([contradicted()]);
    // Both on the first card: the refused reason leaves it on screen; `s` then asks the target, then the reason.
    const reasons = new FakeTerm(["r", "s", "q"], ["not \u202edecided", "AL-3", "older \u0007wording"]);
    await run(["confirm"], { term: reasons });
    expect(reasons.out.split(copy.decide.badControl).length - 1).toBe(2);
    expect(posts()).toEqual([]);
  });

  it("CODEX_HOME alone (a person's own setting) is not an agent", async () => {
    await setup([contradicted()]);
    ttyAnswers = ["y"];
    expect((await run(["confirm", "P-7"], { tty: false, env: { CODEX_HOME: "/x" } })).code).toBe(0);
  });

  it("keys and decide need a y typed on the controlling terminal: no terminal, or anything but y, sends nothing", async () => {
    await setup([contradicted()]);
    ttyAnswers = [null];
    expect(await run(["confirm", "P-7"], { tty: false })).toEqual({ code: 1, out: "", err: `${copy.person.noTty}\n` });
    ttyAnswers = ["n"];
    expect((await run(["confirm", "P-7"], { tty: false })).err).toBe(`${copy.confirm.cancelled}\n`);
    ttyAnswers = [""];
    expect((await run(["decide", "A long enough statement here."], { tty: false })).err).toBe(
      `${copy.confirm.cancelled}\n`,
    );
    ttyAnswers = [null];
    expect((await run(["decide", "A long enough statement here."], { tty: false })).err).toBe(`${copy.person.noTty}\n`);
    expect(posts()).toEqual([]);
  });

  it("a held key confirms once: repeats within 150 ms and input within 300 ms of a card are ignored (B2)", async () => {
    await setup([contradicted(), supersedes(), plain()]);
    const term = new FakeTerm([{ key: "c", held: 80 }, "q"]);
    await run(["confirm"], { term });
    expect(posts().map((c) => c.path)).toEqual(["/entries/P-7/confirm"]);
  });

  it("a bracketed paste is ignored, also when it is split over chunks", async () => {
    await setup([contradicted(), supersedes()]);
    const term = new FakeTerm([["\u001b[200~ccc", "c\u001b[201~", "\u001b[200~c\u001b[201~", "q"]]);
    await run(["confirm"], { term });
    expect(posts()).toEqual([]);
  });

  it("a reason over 500 characters is refused, not cut", async () => {
    await setup([contradicted()]);
    const term = new FakeTerm(["r", "q"], ["x".repeat(501)]);
    await run(["confirm"], { term });
    expect(term.out).toContain(copy.confirm.reasonTooLong);
    expect(posts()).toEqual([]);
  });

  it("a retried confirmation of the same card reuses its idempotency key; another act gets its own", async () => {
    await setup([contradicted(), supersedes()]);
    ledger.failNext.set("/entries/P-7/confirm", { status: 500, code: "internal" });
    const term = new FakeTerm(["c", "c", "h"]);
    await run(["confirm"], { term });
    const calls = posts();
    expect(calls.map((c) => c.path)).toEqual(["/entries/P-7/confirm", "/entries/P-7/confirm", "/entries/share"]);
    expect(calls[0]?.idempotency).toBe(calls[1]?.idempotency);
    expect(calls[2]?.idempotency).not.toBe(calls[0]?.idempotency);
  });
});
