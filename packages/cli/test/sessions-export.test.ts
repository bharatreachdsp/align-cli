/**
 * `align sessions` and `align export` (L17b; docs/15 §Commands, docs/11 §Export): list, show, rm (asks, deletes on the
 * server, then purges the spool, `rejected/`, `held/`, the notice file and marks), and the export in JSON and in both
 * Markdown layouts, byte-for-byte what `@align/core/export` renders. Temporary HOME, mock server, synthetic data.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOCK_ORG, MOCK_USER } from "@align/core/api";
import { buildExport, renderMarkdown } from "@align/core/export";
import { afterEach, describe, expect, it } from "vitest";
import { copy } from "../src/copy";
import { CredentialStore } from "../src/credentials";
import { alignPaths, type Paths, repoHash } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { readDeleted } from "../src/upload/deleted";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockLedger, mockLedger } from "./mock-ledger";
import { type MockServer, startMockServer } from "./mock-server";

const REPO_ID = "0192f0a0-0000-7000-8000-000000000201";
const SID = "0192f0a0-0000-7000-8000-0000000005e1";
const OTHER = "0192f0a0-0000-7000-8000-0000000005e2";

let sb: Sandbox;
let server: MockServer | null = null;
let ledger: MockLedger;
let paths: Paths;

afterEach(async () => {
  await server?.close();
  server = null;
  sb?.cleanup();
});

async function setup() {
  sb = sandbox();
  paths = alignPaths(sb.alignHome);
  ledger = mockLedger([]);
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
  const token = ["aln", "mock", "0123456789abcdef0123"].join("_");
  server.tokens.add(token);
  new CredentialStore(paths, null).put(
    { org: MOCK_ORG, user: MOCK_USER, expires_at: "2027-01-01T00:00:00.000Z", server: server.url },
    token,
  );
  for (const id of [SID, OTHER])
    ledger.sessions.set(id, {
      id,
      repo_id: REPO_ID,
      harness: "claude-code",
      source: "live",
      started_at: "2026-10-22T09:00:00.000Z",
      ended_at: null,
      lines: 12,
      proposed: 2,
      cited: 1,
    });
}

const run = (args: string[], o: { tty?: boolean; answers?: (string | null)[]; env?: Record<string, string> } = {}) => {
  const answers = [...(o.answers ?? [])];
  return cli(args, sb, {
    keychain: null,
    tty: o.tty ?? false,
    env: { ALIGN_SERVER: server?.url ?? "", ...o.env },
    ttyAsk: async () => (answers.length ? (answers.shift() ?? null) : null),
  });
};

const ev = (sid: string, n: number) => ({
  event_id: `0192f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`,
  kind: "transcript.chunk",
  harness: { name: "claude-code" },
  session: { id: sid },
});

describe("align sessions", () => {
  it("lists and shows my sessions", async () => {
    await setup();
    const list = await run(["sessions"]);
    expect(list.out.split("\n").filter(Boolean)).toEqual([
      `${SID}  claude-code live     2026-10-22 09:00  12 lines · 2 proposed · 1 cited`,
      `${OTHER}  claude-code live     2026-10-22 09:00  12 lines · 2 proposed · 1 cited`,
    ]);
    const show = await run(["sessions", "show", SID]);
    expect(show.out).toContain("branch main · compile done · ended —");
    expect((await run(["sessions", "show", "nope"])).code).toBe(2);
  });

  it("rm always asks for a y on the person's terminal (no --yes); a no deletes nothing; never from an agent's shell (R3)", async () => {
    await setup();
    expect(await run(["sessions", "rm", SID], { answers: ["n"] })).toMatchObject({
      code: 0,
      out: `${copy.sessions.kept}\n`,
    });
    expect(ledger.sessions.has(SID)).toBe(true);
    const r = await run(["sessions", "rm", SID], { answers: [null] });
    expect(r).toEqual({ code: 1, out: "", err: `${copy.person.noTty}\n` });
    // --yes is gone: it never stands in for the typed y.
    const yes = await run(["sessions", "rm", SID, "--yes"], { answers: [null] });
    expect(yes.code).not.toBe(0);
    const agent = await run(["sessions", "rm", SID], { env: { CLAUDECODE: "1" }, answers: ["y"] });
    expect(agent.err).toBe(`${copy.person.agent("Claude Code")}\n`);
    expect(ledger.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(existsSync(paths.deletedSessions)).toBe(false);
    for (const line of Object.values(copy.sessions)) if (typeof line === "string") expect(line).not.toContain("--yes");
  });

  it("rm deletes on the server, then purges this laptop's spool, rejected, held, notice and marks for that session only", async () => {
    await setup();
    const repoDir = repoHash(sb.repo);
    const spoolDir = join(paths.spool, repoDir);
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = (name: string, events: unknown[]) =>
      writeFileSync(join(spoolDir, name), JSON.stringify({ version: 1, root: sb.repo, repo_id: REPO_ID, events }));
    spoolFile("00000000000001-aaaaaaaaaaaa.json", [ev(SID, 1), ev(OTHER, 2), ev(SID, 3)]);
    spoolFile("00000000000002-bbbbbbbbbbbb.json", [ev(SID, 4)]);
    for (const side of [paths.rejected, paths.held]) {
      mkdirSync(join(side, repoDir), { recursive: true });
      writeFileSync(
        join(side, repoDir, "00000000000003-cccccccccccc.json"),
        JSON.stringify({
          version: 1,
          root: sb.repo,
          repo_id: REPO_ID,
          items: [
            { event: ev(SID, 5), code: "x" },
            { event: ev(OTHER, 6), code: "x" },
          ],
        }),
      );
    }
    mkdirSync(paths.sessions, { recursive: true });
    writeFileSync(paths.sessionNotice(SID), JSON.stringify({ id: "n-1", text: "ALIGN · 1 new proposal" }));
    writeFileSync(paths.sessionNotice(OTHER), JSON.stringify({ id: "n-2", text: "ALIGN · 1 new proposal" }));
    mkdirSync(paths.sessionMarks(SID), { recursive: true });

    const r = await run(["sessions", "rm", SID], { answers: ["y"] });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "Deleted. 2 proposals withdrawn, 1 entry's wording erased, 1 confirmed decision kept; 5 events not yet uploaded deleted from this laptop.\n",
    );
    const del = ledger.calls.find((c) => c.method === "DELETE");
    expect(del).toMatchObject({ path: `/sessions/${SID}`, idempotency: `cli-rm-${SID}` });
    const left = readdirSync(spoolDir).flatMap((f) => JSON.parse(readFileSync(join(spoolDir, f), "utf8")).events);
    expect(left.map((e: { session: { id: string } }) => e.session.id)).toEqual([OTHER]);
    for (const side of [paths.rejected, paths.held]) {
      const items = JSON.parse(readFileSync(join(side, repoDir, "00000000000003-cccccccccccc.json"), "utf8")).items;
      expect(items.map((i: { event: { session: { id: string } } }) => i.event.session.id)).toEqual([OTHER]);
    }
    expect(existsSync(paths.sessionNotice(SID))).toBe(false);
    expect(existsSync(paths.sessionNotice(OTHER))).toBe(true);
    expect(existsSync(paths.sessionMarks(SID))).toBe(false);
  });

  it("a refused delete purges nothing locally and prints the code's one line", async () => {
    await setup();
    mkdirSync(paths.sessions, { recursive: true });
    writeFileSync(paths.sessionNotice(SID), "{}");
    ledger.failNext.set(`/sessions/${SID}`, { status: 403, code: "forbidden" });
    const r = await run(["sessions", "rm", SID], { answers: ["y"] });
    expect(r).toEqual({ code: 1, out: "", err: `${copy.apiError.forbidden}\n` });
    expect(existsSync(paths.sessionNotice(SID))).toBe(true);
  });
});

describe("align sessions (round 1 fixes)", () => {
  it("a session the server no longer has is still purged here", async () => {
    await setup();
    mkdirSync(paths.sessions, { recursive: true });
    writeFileSync(paths.sessionNotice(SID), "{}");
    ledger.failNext.set(`/sessions/${SID}`, { status: 404, code: "entry_not_found" });
    const r = await run(["sessions", "rm", SID], { answers: ["y"] });
    expect(r.code).toBe(0);
    expect(existsSync(paths.sessionNotice(SID))).toBe(false);
  });

  it("while an upload holds the lock, spool files are left whole and the session is listed as deleted (R5)", async () => {
    await setup();
    const spoolDir = join(paths.spool, repoHash(sb.repo));
    mkdirSync(spoolDir, { recursive: true });
    const mixed = JSON.stringify({ version: 1, root: sb.repo, repo_id: REPO_ID, events: [ev(SID, 1), ev(OTHER, 3)] });
    writeFileSync(join(spoolDir, "00000000000001-aaaaaaaaaaaa.json"), mixed);
    writeFileSync(
      join(spoolDir, "00000000000002-bbbbbbbbbbbb.json"),
      JSON.stringify({ version: 1, root: sb.repo, repo_id: REPO_ID, events: [ev(OTHER, 2)] }),
    );
    writeFileSync(paths.uploadLock, `${process.pid} ${Date.now() + 3_600_000}\n`);
    const r = await run(["sessions", "rm", SID], { answers: ["y"] });
    expect(r.code).toBe(0);
    // OTHER's event in the mixed file is never lost; the running uploader drops SID's (upload.test.ts).
    expect(readdirSync(spoolDir).sort()).toEqual([
      "00000000000001-aaaaaaaaaaaa.json",
      "00000000000002-bbbbbbbbbbbb.json",
    ]);
    expect(readFileSync(join(spoolDir, "00000000000001-aaaaaaaaaaaa.json"), "utf8")).toBe(mixed);
    expect([...readDeleted(paths).confirmed]).toEqual([SID]);
  });

  it("the session is listed as deleted before the server is asked, and unlisted when the server refuses (R5)", async () => {
    await setup();
    let listedDuringDelete = false;
    ledger.onCall = (c) => {
      if (c.method === "DELETE") listedDuringDelete = readDeleted(paths).pending.has(SID);
    };
    expect((await run(["sessions", "rm", SID], { answers: ["y"] })).code).toBe(0);
    expect(listedDuringDelete).toBe(true);
    ledger.failNext.set(`/sessions/${OTHER}`, { status: 403, code: "forbidden" });
    expect((await run(["sessions", "rm", OTHER], { answers: ["y"] })).code).toBe(1);
    expect([...readDeleted(paths).all]).toEqual([SID]);
    expect([...readDeleted(paths).confirmed]).toEqual([SID]);
  });

  it("doctor names a corrupt deleted-session list (final round)", async () => {
    await setup();
    mkdirSync(paths.spool, { recursive: true });
    writeFileSync(paths.deletedSessions, "{not json");
    const r = await run(["doctor"]);
    expect(r.out).toContain(copy.doctor.fail(copy.doctor.deletedList, copy.doctor.deletedListFix));
  });

  it("list follows next_cursor", async () => {
    await setup();
    const page2 = "0192f0a0-0000-7000-8000-0000000005e3";
    ledger.sessions.set(page2, { ...(ledger.sessions.get(SID) as object), id: page2 });
    ledger.pageSize = 2;
    const list = await run(["sessions"]);
    expect(list.out.split("\n").filter(Boolean)).toHaveLength(3);
  });
});

describe("align export", () => {
  const data = () =>
    buildExport({
      exportedAt: "2026-10-22T12:00:00.000Z",
      org: { name: "Acme Example", prefix: "AL" },
      repo: { remote: "github.com/acme/checkout", default_branch: "main" },
      entries: [
        {
          key: "AL-12",
          kind: "decision",
          status: "confirmed",
          verification: "verified",
          created_at: "2026-09-12T10:00:00.000Z",
          confirmed_at: "2026-09-12T11:00:00.000Z",
          confirmed_by: { display_name: "Riya Example", github_login: null },
          owner: null,
          superseded_by: null,
          revisions: [
            {
              revision: 1,
              statement: "Use Postgres advisory locks for cart checkout, not Redis.",
              rationale: "No Redis ops dependency.",
              alternatives_rejected: ["Redis SETNX lock"],
              scope_paths: ["lib/cart/"],
              due_date: null,
              reason: null,
              created_at: "2026-09-12T10:00:00.000Z",
            },
          ],
          evidence: [
            {
              kind: "transcript",
              locator: "transcript lines 212–219",
              quote: "advisory locks are enough",
              url: null,
              added_in_revision: 1,
              created_at: "2026-09-12T10:00:00.000Z",
            },
          ],
          links: [],
          checks: [],
          conflicts: [],
        },
      ],
      questions: [],
    });

  it("JSON is the server's answer; Markdown matches the shared renderer in both layouts", async () => {
    await setup();
    ledger.exportBody = data();
    const json = await run(["export", "--format", "json"]);
    expect(JSON.parse(json.out)).toEqual(data());
    const single = await run(["export"]);
    expect(single.out).toBe(renderMarkdown(data(), "single")[0]?.content);
    const out = join(sb.dir, "export-adr");
    const adr = await run(["export", "--layout", "adr", "--out", out]);
    const files = renderMarkdown(data(), "adr");
    expect(adr.out).toBe(`Exported 1 entry into ${files.length} files in ${out}.\n`);
    for (const f of files) expect(readFileSync(join(out, f.path), "utf8")).toBe(f.content);
    const q = ledger.calls.find((c) => c.path === "/export");
    expect(q).toBeDefined();
  });

  it("--include-private asks for my own proposals too; bad options and the adr layout without --out fail", async () => {
    await setup();
    ledger.exportBody = data();
    await run(["export", "--format", "json", "--include-private"]);
    expect(ledger.exportQuery).toContain("include_private=true");
    expect((await run(["export", "--format", "pdf"])).code).toBe(2);
    expect((await run(["export", "--layout", "adr"])).err).toBe(`${copy.exportCmd.adrNeedsOut}\n`);
  });

  it("an answer off the contract is refused", async () => {
    await setup();
    ledger.exportBody = { format_version: 2 };
    expect((await run(["export", "--format", "json"])).code).toBe(1);
  });
});

describe("align export writes only inside --out (B3)", () => {
  const exportData = () => ({
    format_version: 1,
    exported_at: "2026-10-22T12:00:00.000Z",
    org: { name: "Acme Example", prefix: "AL" },
    repo: { remote: "github.com/acme/checkout" },
    entries: [],
    questions: [],
  });

  it("refuses a symbolic link for --out, for a directory inside it, and for a file in it", async () => {
    await setup();
    ledger.exportBody = exportData();
    const outside = join(sb.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "keep me\n");
    // --out itself a link
    symlinkSync(outside, join(sb.dir, "link-out"));
    const a = await run(["export", "--out", join(sb.dir, "link-out")]);
    expect(a.code).toBe(1);
    // a file in --out that links outside
    const out = join(sb.dir, "out");
    mkdirSync(out);
    const single = renderMarkdown(exportData() as never, "single")[0]?.path as string;
    symlinkSync(join(outside, "precious.txt"), join(out, single));
    const b = await run(["export", "--out", out]);
    expect(b.code).toBe(1);
    // a directory inside --out that links outside (adr layout)
    const out2 = join(sb.dir, "out2");
    mkdirSync(out2);
    symlinkSync(outside, join(out2, "decisions"));
    const c = await run(["export", "--layout", "adr", "--out", out2]);
    expect(c.code).toBe(1);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me\n");
    expect(readdirSync(outside)).toEqual(["precious.txt"]);
  });

  it("keeps a file that is not an earlier export unless --force; replaces its own earlier export", async () => {
    await setup();
    ledger.exportBody = exportData();
    const out = join(sb.dir, "out");
    mkdirSync(out);
    const name = renderMarkdown(exportData() as never, "single")[0]?.path as string;
    writeFileSync(join(out, name), "my notes\n");
    const r = await run(["export", "--out", out]);
    expect(r.err).toBe(`${copy.exportCmd.wouldOverwrite(join(out, name))}\n`);
    expect(readFileSync(join(out, name), "utf8")).toBe("my notes\n");
    expect((await run(["export", "--out", out, "--force"])).code).toBe(0);
    expect((await run(["export", "--out", out])).code).toBe(0);
  });

  it("--include-private files are user-only (0600); stdout to a terminal has no control characters", async () => {
    await setup();
    ledger.exportBody = { ...exportData(), org: { name: "Acme \u001b[2J Example", prefix: "AL" } };
    const out = join(sb.dir, "priv");
    await run(["export", "--format", "json", "--include-private", "--out", out]);
    expect(statSync(join(out, "ledger.json")).mode & 0o777).toBe(0o600);
    const tty = await run(["export", "--format", "json"], { tty: true });
    expect(tty.out).not.toContain("\u001b");
  });

  it("a relative --out never goes through a symbolic link in the working tree (R2)", async () => {
    await setup();
    ledger.exportBody = exportData();
    const outside = join(sb.dir, "outside");
    mkdirSync(outside);
    // A link the repository could commit: docs -> somewhere else; `--out docs/adr` would write there.
    symlinkSync(outside, join(sb.repo, "docs"));
    const r = await run(["export", "--layout", "adr", "--out", "docs/adr"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${copy.exportCmd.symlink(join(sb.repo, "docs"))}\n`);
    expect(readdirSync(outside)).toEqual([]);
    // Also when the path climbs out of the working directory first, and back into the repository.
    mkdirSync(join(sb.repo, "sub"));
    const climb = await cli(["export", "--layout", "adr", "--out", "../docs/adr"], sb, {
      keychain: null,
      cwd: join(sb.repo, "sub"),
      env: { ALIGN_SERVER: server?.url ?? "" },
    });
    expect(climb.code).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    // A plain relative directory works, created one level at a time.
    const ok = await run(["export", "--layout", "adr", "--out", "exports/adr"]);
    expect(ok.code).toBe(0);
    expect(existsSync(join(sb.repo, "exports", "adr"))).toBe(true);
  });

  it("stdout to a terminal keeps tabs (only other control characters go)", async () => {
    await setup();
    ledger.exportBody = { ...exportData(), org: { name: "Acme\tExample \u001b[2J", prefix: "AL" } };
    const tty = await run(["export", "--format", "json"], { tty: true });
    expect(tty.out).not.toContain("\u001b");
    expect(tty.out).toContain("Acme\\tExample");
    const md = await run(["export"], { tty: true });
    expect(md.out).not.toContain("\u001b");
    expect(md.out).toContain("Acme\tExample");
  });
});
