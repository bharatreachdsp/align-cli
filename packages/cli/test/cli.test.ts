/**
 * The CLI end to end in-process against the mock server, with a temporary HOME (never the real one).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/version";
import { cli, fakeBundle, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockOptions, type MockServer, startMockServer } from "./mock-server";

let sb: Sandbox;
let server: MockServer;

async function setup(opts: MockOptions = {}, remote?: string | null) {
  sb = sandbox(remote);
  server = await startMockServer(opts);
}

afterEach(async () => {
  await server?.close();
  sb?.cleanup();
});

const env = () => ({ ALIGN_SERVER: server.url });
const mode = (p: string) => statSync(p).mode & 0o777;
const leaked = (text: string) => [...server.tokens].some((t) => text.includes(t)) || /aln_mock_[0-9a-f]{8}/.test(text);

describe("align init (steps 1-5)", () => {
  it("signs in, claims, opts in and self-installs; the token is stored 0600 and never printed", async () => {
    await setup({ pendingPolls: 2 });
    const bundle = fakeBundle(sb.dir);
    const r = await cli(["init", "--yes", "--no-backfill"], sb, {
      env: env(),
      bundlePath: bundle,
      nodePath: "/usr/bin/node",
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Repository   github.com/acme/checkout  (main)");
    expect(r.out).toMatch(/Sign in {6}open http:\/\/127\.0\.0\.1:\d+\/device and enter WDJB-MJHT/);
    expect(r.out).toContain("✓ Riya Example");
    expect(r.out).toContain("(you are the first on this repository)");
    expect(r.out).toContain("What ALIGN captures from this repository");
    expect(r.out).toContain("Opted in     github.com/acme/checkout");
    expect(leaked(r.out + r.err)).toBe(false);

    // three polls: two pending, one approved
    expect(server.requests.filter((q) => q.path === "/device/token")).toHaveLength(3);
    expect(server.requests.every((q) => q.client === VERSION)).toBe(true);
    const claim = server.requests.find((q) => q.path === "/repos/claim");
    expect(claim?.body).toMatchObject({
      remote_norm: "github.com/acme/checkout",
      provider: "github",
      default_branch: "main",
    });

    const creds = join(sb.alignHome, "credentials.json");
    expect(mode(sb.alignHome)).toBe(0o700);
    expect(mode(creds)).toBe(0o600);
    expect(mode(join(sb.alignHome, "repos.json"))).toBe(0o600);
    expect(mode(join(sb.alignHome, "config.json"))).toBe(0o600);
    const stored = JSON.parse(readFileSync(creds, "utf8"));
    expect(server.tokens.has(stored.orgs[Object.keys(stored.orgs)[0] as string].token)).toBe(true);

    const registry = JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8"));
    expect(registry.repos[sb.repo]).toMatchObject({ remote_norm: "github.com/acme/checkout", opted_in: true });
    const config = JSON.parse(readFileSync(join(sb.alignHome, "config.json"), "utf8"));
    expect(Object.values(config.orgs)).toEqual([expect.objectContaining({ email_domains: ["acme.example"] })]);

    expect(mode(join(sb.alignHome, "bin", "align"))).toBe(0o755);
    expect(readlinkSync(join(sb.alignHome, "lib", "align.mjs"))).toBe(`align-${VERSION}.mjs`);
    expect(readFileSync(join(sb.alignHome, "bin", "align"), "utf8")).toContain("NODE='/usr/bin/node'");
  });

  it("is idempotent: a second run signs in silently, does not claim again and does not ask", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    const before = server.requests.length;
    const r = await cli(["init"], sb, { env: env() });
    expect(r.code).toBe(0);
    const again = server.requests.slice(before).map((q) => `${q.method} ${q.path}`);
    expect(again).not.toContain("POST /device/code");
    expect(again).not.toContain("POST /repos/claim");
    expect(again.filter((k) => k.startsWith("PUT"))).toEqual([]);
    expect(r.out).not.toContain("What ALIGN captures");
  });

  it("D517: a first opt-in is confirmed in the console, on a terminal too; nothing is PUT", async () => {
    await setup({ optin: { confirmAfterPolls: 2 } });
    const r = await cli(["init", "--no-backfill"], sb, { env: env(), tty: true, ttyAsk: async () => "y" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("What ALIGN captures from this repository");
    expect(r.out).toMatch(/Confirm {6}open http:\/\/127\.0\.0\.1:\d+\/optin\/[0-9a-f-]{36} and confirm there\./);
    expect(r.out).toContain("Opted in     github.com/acme/checkout");
    expect(server.optinRequests).toEqual([expect.objectContaining({ via: "person", polls: 3, confirmed: true })]);
    expect(server.requests.some((q) => q.method === "PUT")).toBe(false);
    const registry = JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8"));
    expect(registry.repos[sb.repo].opted_in).toBe(true);
  });

  it("D517: --yes does not opt in by itself, and an expired confirmation opts in nothing (exit 1)", async () => {
    await setup({ optin: { outcome: "expire" } });
    const r = await cli(["init", "--yes", "--no-backfill"], sb, { env: env() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("The confirmation expired, so nothing was opted in.");
    expect(server.requests.some((q) => q.method === "PUT")).toBe(false);
    expect([...server.repos.values()][0]?.opted_in).toBe(false);
  });

  it("D517: a beta organisation's terms are linked and accepted only by the console confirmation", async () => {
    await setup({ plan: "beta" });
    const r = await cli(["init", "--yes", "--accept-pilot-terms", "--no-backfill"], sb, { env: env() });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Opting in accepts the pilot data terms: http:\/\/127\.0\.0\.1:\d+\/legal\/pilot-terms/);
    expect(r.out).toContain("(confirming accepts the pilot data terms)");
    expect(server.requests.some((q) => q.method === "PUT")).toBe(false);
    expect([...server.repos.values()][0]).toMatchObject({ opted_in: true, pilot_accepted: true });
  });

  it("stops at another organisation's repository, with the auto-join line when offered", async () => {
    await setup({
      repos: { "github.com/acme/checkout": { owner: "Globex", auto_join_url: "http://127.0.0.1:9/join/x" } },
    });
    const r = await cli(["init", "--yes"], sb, { env: env() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("github.com/acme/checkout is connected to Globex's ALIGN.");
    expect(r.out).toContain("open http://127.0.0.1:9/join/x and choose Join");
    expect(existsSync(join(sb.alignHome, "repos.json"))).toBe(false);
  });

  it("explains preflight failures", async () => {
    await setup({}, null);
    expect((await cli(["init", "--yes"], sb, { env: env() })).err).toContain("has no remote");
    const outside = await cli(["init", "--yes"], sb, { env: env(), cwd: sb.home });
    expect(outside.err).toContain("not a git repository");
    const win = await cli(["init", "--yes"], sb, { env: env(), platform: "win32" });
    expect(win.err).toContain("use WSL");
    const old = await cli(["init", "--yes"], sb, { env: env(), nodeVersion: "20.11.0" });
    expect(old.err).toContain("Node 22.14.0 or later");
  });

  it("refuses a plain-http server that is not loopback", async () => {
    await setup();
    const r = await cli(["init", "--yes", "--server", "http://example.com"], sb, { env: env() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("https://");
    expect(server.requests).toHaveLength(0);
  });
});

describe("D517: every opt-in the server does not hold live goes through the console", () => {
  const asker = (answers: (string | null)[]) => {
    const asked: string[] = [];
    return {
      asked,
      ttyAsk: async (q: string) => {
        asked.push(q);
        return answers.length > 0 ? (answers.shift() as string | null) : null;
      },
    };
  };
  const puts = () => server.requests.filter((q) => q.method === "PUT");

  it("an agent's shell gets the console link (via agent) whatever it passes, and is never asked on the terminal", async () => {
    await setup();
    const a = asker(["y"]);
    const r = await cli(["init", "--yes", "--accept-pilot-terms", "--no-backfill"], sb, {
      env: { ...env(), CLAUDECODE: "1" },
      ttyAsk: a.ttyAsk,
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Claude Code's agent running the command: only you can opt in, in your browser.");
    expect(a.asked).toEqual([]);
    expect(server.optinRequests.map((q) => q.via)).toEqual(["agent"]);
    expect(puts()).toEqual([]);
  });

  it("a return after align off goes through the console again, from a terminal or an agent's shell; no PUT turns it on", async () => {
    await setup();
    await cli(["init", "--no-backfill"], sb, { env: env() });
    expect((await cli(["off"], sb, { env: env() })).code).toBe(0);
    const a = asker(["y"]);
    const on = await cli(["on"], sb, { env: env(), tty: true, ttyAsk: a.ttyAsk });
    expect(on.code, on.err).toBe(0);
    expect(a.asked).toEqual([]);
    expect(on.out).toContain("What ALIGN captures from this repository");
    expect(on.out).toMatch(/Confirm {6}open http:\/\/127\.0\.0\.1:\d+\/optin\//);
    await cli(["off"], sb, { env: env() });
    const agent = await cli(["on"], sb, { env: { ...env(), CODEX_THREAD_ID: "t" } });
    expect(agent.code).toBe(0);
    expect(server.optinRequests.map((q) => q.via)).toEqual(["person", "person", "agent"]);
    expect(puts().filter((q) => (q.body as { opted_in?: boolean }).opted_in === true)).toEqual([]);
  });

  it("a live opt-in on the server (another laptop): init here starts capturing and asks nothing", async () => {
    await setup({ repos: { "github.com/acme/checkout": { owner: "mine", opted_in: true } } });
    const a = asker(["n"]);
    const r = await cli(["init", "--no-backfill"], sb, { env: env(), tty: true, ttyAsk: a.ttyAsk });
    expect(r.code, r.err).toBe(0);
    expect(a.asked).toEqual([]);
    expect(server.optinRequests).toEqual([]);
    expect(puts()).toEqual([]);
    expect(r.out).toContain("Opted in     github.com/acme/checkout");
  });

  it("align off never asks, from an agent's shell too", async () => {
    await setup();
    await cli(["init", "--no-backfill"], sb, { env: env() });
    const a = asker([]);
    expect((await cli(["off"], sb, { env: { ...env(), CLAUDECODE: "1" }, ttyAsk: a.ttyAsk })).code).toBe(0);
    expect(a.asked).toEqual([]);
    expect([...server.repos.values()][0]?.opted_in).toBe(false);
  });
});

describe("align login", () => {
  it("backs off on slow_down and reports a denied or expired code", async () => {
    await setup({ slowDownOnce: true });
    const sleeps: number[] = [];
    const ok = await cli(["login"], sb, { env: env(), sleep: async (ms) => void sleeps.push(ms) });
    expect(ok.code).toBe(0);
    // the CLI waits at least 5 s; poll 1 → slow_down (+5 s), poll 2 → approved
    expect(sleeps).toEqual([5000, 10000]);
    await server.close();
    server = await startMockServer({ deviceOutcome: "deny" });
    expect((await cli(["login"], sb, { env: env() })).err).toContain("cancelled");
    await server.close();
    server = await startMockServer({ deviceOutcome: "expire" });
    expect((await cli(["login"], sb, { env: env() })).err).toContain("expired");
  });

  it("never sends a token to a server other than the one that issued it", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    const other = await startMockServer();
    try {
      const r = await cli(["doctor"], sb, { env: { ALIGN_SERVER: other.url } });
      expect(r.code).toBe(1);
      // D209: no Authorization header at all reached the second server, not even a rejected one
      expect(other.requests.length).toBeGreaterThan(0);
      expect(other.requests.every((q) => !q.bearer)).toBe(true);
    } finally {
      await other.close();
    }
  });
});

describe("status, doctor, on/off, logout, uninstall", () => {
  it("status works online and offline and exits 0 either way", async () => {
    await setup({ latest: "0.2.0" });
    await cli(["init", "--yes"], sb, { env: env() });
    const on = await cli(["status"], sb, { env: env() });
    expect(on.code).toBe(0);
    expect(on.out).toContain("Repository   github.com/acme/checkout");
    expect(on.out).toContain("Opt-in       on");
    expect(on.out).toContain("· reachable");
    expect(on.out).toContain("0.2.0 is available");
    const json = JSON.parse((await cli(["status", "--json"], sb, { env: env() })).out);
    expect(json.repository.opted_in).toBe(true);
    const url = server.url;
    await server.close();
    const off = await cli(["status"], sb, { env: { ALIGN_SERVER: url } });
    expect(off.code).toBe(0);
    expect(off.out).toContain("unreachable");
    server = await startMockServer();
  });

  it("doctor is green after init and names a fix for each failure", async () => {
    await setup();
    const bundle = fakeBundle(sb.dir);
    const before = await cli(["doctor"], sb, { env: env(), bundlePath: bundle });
    expect(before.code).toBe(1);
    expect(before.out).toContain("fix: run align init");
    await cli(["init", "--yes"], sb, { env: env(), bundlePath: bundle });
    const after = await cli(["doctor"], sb, { env: env(), bundlePath: bundle });
    expect(after.out).toContain("All checks passed.");
    expect(after.code).toBe(0);
    const skewed = await startMockServer({ clockSkewMs: 10 * 60 * 1000 });
    try {
      const json = JSON.parse(
        (await cli(["doctor", "--json"], sb, { env: { ALIGN_SERVER: skewed.url }, bundlePath: bundle })).out,
      );
      expect(json.checks.find((c: { id: string }) => c.id === "clock").ok).toBe(false);
    } finally {
      await skewed.close();
    }
  });

  it("off stops capture locally even when the server is unreachable; on needs the server", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    const registry = () => JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos[sb.repo];
    expect((await cli(["off"], sb, { env: env() })).code).toBe(0);
    expect(registry().opted_in).toBe(false);
    expect([...server.repos.values()][0]?.opted_in).toBe(false);
    expect((await cli(["on"], sb, { env: env() })).code).toBe(0);
    expect(registry().opted_in).toBe(true);
    const url = server.url;
    await server.close();
    const off = await cli(["off"], sb, { env: { ALIGN_SERVER: url } });
    expect(off.code).toBe(0);
    expect(off.out).toContain("capture stopped on this laptop already");
    expect(registry().opted_in).toBe(false);
    const on = await cli(["on"], sb, { env: { ALIGN_SERVER: url } });
    expect(on.code).toBe(1);
    expect(registry().opted_in).toBe(false);
    server = await startMockServer();
  });

  it("logout revokes the token on the server and removes it locally", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    expect(server.tokens.size).toBe(1);
    const r = await cli(["logout"], sb, { env: env() });
    expect(r.out).toContain("Signed out of Acme Example.");
    expect(server.tokens.size).toBe(0);
    const stored = JSON.parse(readFileSync(join(sb.alignHome, "credentials.json"), "utf8"));
    expect(stored.orgs).toEqual({});
  });

  it("uninstall removes the registry entry; --purge needs --yes and deletes ~/.align", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    expect((await cli(["uninstall", "--purge"], sb, { env: env() })).code).toBe(1);
    const r = await cli(["uninstall"], sb, { env: env() });
    expect(r.out).toContain("Removed github.com/acme/checkout");
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos).toEqual({});
    await cli(["uninstall", "--purge", "--yes"], sb, { env: env() });
    expect(existsSync(sb.alignHome)).toBe(false);
    expect(server.tokens.size).toBe(0);
  });

  it("prints the upgrade line once when the server says this version is too old", async () => {
    await setup({ upgradeRequired: true });
    const r = await cli(["init", "--yes"], sb, { env: env() });
    expect(r.code).toBe(0);
    expect(r.err.match(/no longer supported/g)).toHaveLength(1);
  });
});

describe("review round 1 (PR #26)", () => {
  it("a nested clone never inherits its parent's opt-in", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    const nested = join(sb.repo, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    gitIn(nested, "init", "-q", "-b", "main");
    const r = await cli(["status", "--json"], sb, { env: env(), cwd: nested });
    expect(JSON.parse(r.out).repository).toBeNull();
    expect((await cli(["off"], sb, { env: env(), cwd: nested })).code).toBe(1);
    const parent = JSON.parse((await cli(["status", "--json"], sb, { env: env(), cwd: join(sb.repo) })).out);
    expect(parent.repository.opted_in).toBe(true);
    // a subdirectory of the same repository is the same repository
    mkdirSync(join(sb.repo, "src"), { recursive: true });
    const sub = JSON.parse((await cli(["status", "--json"], sb, { env: env(), cwd: join(sb.repo, "src") })).out);
    expect(sub.repository.opted_in).toBe(true);
  });

  it("another organisation's repository removes an earlier registry entry", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    const repo = [...server.repos.values()][0];
    if (repo) repo.owner = "Globex";
    const r = await cli(["init", "--yes"], sb, { env: env() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Capture is off for github.com/acme/checkout on this laptop.");
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos).toEqual({});
  });

  it("refuses a sign-in page on another origin", async () => {
    await setup({ foreignVerification: true });
    const opened: string[] = [];
    const r = await cli(["login"], sb, { env: env(), tty: true, openBrowser: (u) => void opened.push(u) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("another site");
    expect(opened).toEqual([]);
    expect(r.out).not.toContain("evil.example");
  });

  it("--purge deletes only ALIGN's own entries, and refuses a directory not named .align", async () => {
    await setup();
    await cli(["init", "--yes"], sb, { env: env() });
    writeFileSync(join(sb.alignHome, "mine.txt"), "not ALIGN's");
    await cli(["uninstall", "--purge", "--yes"], sb, { env: env() });
    expect(readdirSync(sb.alignHome)).toEqual(["mine.txt"]);
    const odd = join(sb.dir, "elsewhere");
    mkdirSync(odd);
    writeFileSync(join(odd, "keep"), "x");
    const r = await cli(["uninstall", "--purge", "--yes"], sb, { env: { ...env(), ALIGN_HOME: odd } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing was deleted");
    expect(existsSync(join(odd, "keep"))).toBe(true);
  });

  it("doctor says where tokens are kept, and names a corrupt registry", async () => {
    await setup();
    const bundle = fakeBundle(sb.dir);
    await cli(["init", "--yes"], sb, { env: env(), bundlePath: bundle });
    const ok = await cli(["doctor"], sb, { env: env(), bundlePath: bundle });
    expect(ok.out).toContain("✓ tokens in ~/.align/credentials.json (plain text, 0600)");
    writeFileSync(join(sb.alignHome, "repos.json"), "{corrupt");
    const bad = await cli(["doctor", "--json"], sb, { env: env(), bundlePath: bundle });
    expect(JSON.parse(bad.out).checks.find((c: { id: string }) => c.id === "files").ok).toBe(false);
    const on = await cli(["init", "--yes"], sb, { env: env(), bundlePath: bundle });
    expect(on.code).toBe(1);
    expect(on.err).toContain("is unreadable");
  });

  it("prints no bidirectional or zero-width characters from the server", async () => {
    const { stripControl } = await import("../src/context");
    expect(stripControl("a\u202eb\u200bc\u2066d")).toBe("abcd");
  });

  describe("connected without access (L20 contract, PR #30)", () => {
    const remote = "github.com/acme/checkout";
    it("an owner on a teammate-claimed repository opts in directly (access 'owner' from the role; no claim)", async () => {
      await setup({
        role: "owner",
        repos: { [remote]: { owner: "mine", access: false, root_commit: "0".repeat(40) } },
      });
      const r = await cli(["init", "--yes"], sb, { env: env() });
      expect(r.code).toBe(0);
      expect(server.requests.map((q) => `${q.method} ${q.path}`)).not.toContain("POST /repos/claim");
      expect(server.repos.get(remote)).toMatchObject({ opted_in: true });
    });
    it("a member with the clone proof (matching root commit) claims and opts in", async () => {
      sb = sandbox();
      const root = gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD");
      server = await startMockServer({
        role: "member",
        repos: { [remote]: { owner: "mine", access: false, root_commit: root } },
      });
      const r = await cli(["init", "--yes"], sb, { env: env() });
      expect(r.code).toBe(0);
      expect(server.repos.get(remote)).toMatchObject({ access: "clone", opted_in: true });
    });
    it("a member without the proof gets the ask-an-admin line and nothing is registered", async () => {
      await setup({
        role: "member",
        repos: { [remote]: { owner: "mine", access: false, root_commit: "0".repeat(40) } },
      });
      const r = await cli(["init", "--yes"], sb, { env: env() });
      expect(r.code).toBe(1);
      expect(r.out).toContain("you do not have access to it yet. Ask an admin of Acme Example");
      expect(server.requests.some((q) => q.method === "PUT")).toBe(false);
      expect(existsSync(join(sb.alignHome, "repos.json"))).toBe(false);
    });
  });
});

describe("align init steps 6-7: Claude Code and git hooks (L12)", () => {
  it("installs the hook entries, the git hooks and the exclude line; git status stays clean; uninstall removes them", async () => {
    await setup();
    const hooksBefore = readdirSync(join(sb.repo, ".git", "hooks")).sort();
    const excludeBefore = readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8");
    const r = await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installing");
    expect(r.out).toContain("✓ Claude Code            hooks in .claude/settings.local.json (merged)");
    expect(r.out).toContain("✓ git hooks              prepare-commit-msg (Align-Session trailer) · post-commit");
    expect(r.out).toContain("✓ local ignore           .git/info/exclude updated — your git status stays clean");
    expect(r.out).toContain("✓ Claude Code            /align command in ~/.claude/commands/align.md");
    const shim = join(sb.alignHome, "bin", "align");
    expect(readFileSync(join(sb.home, ".claude", "commands", "align.md"), "utf8")).toBe(
      [
        "---",
        "description: Show the team decisions that apply here",
        `allowed-tools: Bash(${shim} pack --format md)`,
        "---",
        "",
        `!\`${shim} pack --format md\``,
        "",
      ].join("\n"),
    );
    const settings = JSON.parse(readFileSync(join(sb.repo, ".claude", "settings.local.json"), "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `${join(sb.alignHome, "bin", "align")} hook stop --harness claude-code`,
    );
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).toContain("/.claude/settings.local.json");
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos[sb.repo].harnesses).toEqual([
      "claude-code",
    ]);

    // Re-running changes nothing.
    const again = await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() });
    expect(again.code).toBe(0);
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8").match(/settings\.local\.json/g)).toHaveLength(
      1,
    );

    const doctor = await cli(["doctor"], sb, { env: env() });
    expect(doctor.out).toContain("✓ Claude Code hooks point at the shim");
    expect(doctor.out).toContain("✓ Claude Code /align command in ~/.claude/commands/align.md");
    expect(doctor.out).toContain("✓ git hooks installed (prepare-commit-msg, post-commit)");

    const u = await cli(["uninstall"], sb, { env: env() });
    expect(u.code).toBe(0);
    expect(existsSync(join(sb.repo, ".claude"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude", "commands", "align.md"))).toBe(false);
    expect(readdirSync(join(sb.repo, ".git", "hooks")).sort()).toEqual(hooksBefore);
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
  });

  it("leaves someone else's ~/.claude/commands/align.md alone, at install and uninstall", async () => {
    await setup();
    mkdirSync(join(sb.home, ".claude", "commands"), { recursive: true });
    writeFileSync(join(sb.home, ".claude", "commands", "align.md"), "my own command\n");
    const r = await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() });
    expect(r.out).toContain("~/.claude/commands/align.md is someone else's file; it was left alone");
    await cli(["uninstall"], sb, { env: env() });
    expect(readFileSync(join(sb.home, ".claude", "commands", "align.md"), "utf8")).toBe("my own command\n");
  });

  it("doctor reports a deny file it cannot use exactly", async () => {
    await setup();
    await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() });
    writeFileSync(join(sb.repo, ".aligndeny"), `${"*a".repeat(20)}\n`);
    expect((await cli(["doctor"], sb, { env: env() })).out).toContain(
      ".aligndeny: 1 glob is too long, too complex or not valid",
    );
    writeFileSync(join(sb.repo, ".aligndeny"), "clients/straße/\n");
    expect((await cli(["doctor"], sb, { env: env() })).out).toContain("a glob with ß matches ß only, not ss");
    writeFileSync(join(sb.repo, ".aligndeny"), "x".repeat(70 * 1024));
    expect((await cli(["doctor"], sb, { env: env() })).out).toContain(".aligndeny cannot be used");
  });

  it("leaves a committed settings file alone", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".claude"), { recursive: true });
    writeFileSync(join(sb.repo, ".claude", "settings.local.json"), "{}\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-m", "settings");
    const r = await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() });
    expect(r.code).toBe(0);
    expect(r.out).toContain(".claude/settings.local.json is committed to the repository; nothing was changed");
    expect(readFileSync(join(sb.repo, ".claude", "settings.local.json"), "utf8")).toBe("{}\n");
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
  });

  it("leaves core.hooksPath alone and prints the lines to add", async () => {
    await setup();
    gitIn(sb.repo, "config", "core.hooksPath", ".husky");
    const r = await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("core.hooksPath is set (.husky)");
    expect(r.out).toContain("git-hook prepare-commit-msg");
    expect(existsSync(join(sb.repo, ".husky"))).toBe(false);
    expect(existsSync(join(sb.repo, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("asks before configuring a detected harness on a terminal, and a no installs no hook entries", async () => {
    await setup();
    mkdirSync(join(sb.home, ".claude"), { recursive: true });
    const r = await cli(["init"], sb, { env: { ...env(), PATH: "/nonexistent" }, tty: true, answers: ["n"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("? Capture Claude Code sessions in this repository? [Y/n]");
    expect(existsSync(join(sb.repo, ".claude", "settings.local.json"))).toBe(false);
  });
});

describe("align init for Cursor and Codex (L13)", () => {
  it("installs user-level hooks, prints the /hooks instruction, and removes them with the last repository", async () => {
    await setup();
    const r = await cli(["init", "--yes", "--harness", "cursor,codex"], sb, { env: env() });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "✓ Cursor                 hooks in ~/.cursor/hooks.json (merged; inactive outside opted-in repositories)",
    );
    expect(r.out).toContain("→ run /hooks once in Codex and trust the ALIGN hooks");
    expect(existsSync(join(sb.home, ".cursor", "hooks.json"))).toBe(true);
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(true);
    // Cursor's rule file: written (no pack yet), excluded, so git status stays clean.
    expect(r.out).toContain(
      "✓ Cursor                 rule file .cursor/rules/align.mdc (always applied; refreshed with the pack)",
    );
    const rule = readFileSync(join(sb.repo, ".cursor", "rules", "align.mdc"), "utf8");
    expect(
      rule.startsWith(
        "---\ndescription: Team decisions for this repository from ALIGN\nalwaysApply: true\n---\n<!-- align-pack v1 -->\n",
      ),
    ).toBe(true);
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).toContain("/.cursor/rules/align.mdc");
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
    const doctor = await cli(["doctor"], sb, { env: env() });
    expect(doctor.out).toContain("✓ Cursor rule file .cursor/rules/align.mdc");
    expect(doctor.out).toContain("✓ Cursor hooks in ~/.cursor/hooks.json point at the shim");
    expect(doctor.out).toContain("✓ Codex hooks in ~/.codex/hooks.json point at the shim");
    // init's MCP table created config.toml (no codex binary on this PATH), so trust is read and not found yet.
    expect(doctor.out).toContain("Codex trust for the ALIGN hooks not found in ~/.codex/config.toml");
    const u = await cli(["uninstall"], sb, { env: env() });
    expect(u.code).toBe(0);
    expect(existsSync(join(sb.home, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(sb.repo, ".cursor"))).toBe(false);
  });

  it("uninstall and --purge still stop capture and delete ~/.align when a user hooks file is broken", async () => {
    await setup();
    await cli(["init", "--yes", "--harness", "cursor,codex"], sb, { env: env() });
    writeFileSync(join(sb.home, ".cursor", "hooks.json"), "{ broken");
    const u = await cli(["uninstall"], sb, { env: env() });
    expect(u.code).toBe(0);
    expect(u.out).toContain("~/.cursor/hooks.json could not be read");
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos).toEqual({});
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    writeFileSync(join(sb.home, ".codex", "hooks.json"), "{ broken");
    const p = await cli(["uninstall", "--purge", "--yes"], sb, { env: env() });
    expect(p.code).toBe(0);
    expect(existsSync(sb.alignHome)).toBe(false);
  });

  it("a second uninstall finishes what a broken file stopped; CODEX_HOME is named in the copy; trust is a line, not a failure", async () => {
    await setup();
    const codexHome = join(sb.dir, "codex-home");
    const e = { ...env(), CODEX_HOME: codexHome };
    const r = await cli(["init", "--yes", "--harness", "cursor,codex"], sb, { env: e });
    expect(r.out).toContain(`hooks in ${codexHome}/hooks.json (merged)`);
    writeFileSync(join(codexHome, "config.toml"), 'model = "x"\n');
    const doctor = await cli(["doctor"], sb, { env: e });
    expect(doctor.out).toContain(`Codex trust for the ALIGN hooks not found in ${codexHome}/config.toml`);
    expect(doctor.out).not.toContain("× Codex trust");
    const good = readFileSync(join(sb.home, ".cursor", "hooks.json"), "utf8");
    writeFileSync(join(sb.home, ".cursor", "hooks.json"), "{ broken");
    expect((await cli(["uninstall"], sb, { env: e })).out).toContain("could not be read");
    writeFileSync(join(sb.home, ".cursor", "hooks.json"), good);
    const again = await cli(["uninstall"], sb, { env: e });
    expect(again.out).toContain("Removed what was left from an earlier uninstall.");
    expect(existsSync(join(sb.home, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });

  it("a failed uninstall then a re-init for Claude Code only never brings back the declined harnesses", async () => {
    await setup();
    await cli(["init", "--yes", "--harness", "cursor,codex"], sb, { env: env() });
    writeFileSync(join(sb.home, ".codex", "hooks.json"), "{ broken");
    expect((await cli(["uninstall"], sb, { env: env() })).out).toContain("~/.codex/hooks.json could not be read");
    expect((await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos[sb.repo].harnesses).toEqual([
      "claude-code",
    ]);
    // Codex's (still present, broken-file-adjacent) user-level hook fires here: nothing is captured.
    const stdin = Buffer.from(
      JSON.stringify({
        session_id: "codex-1",
        cwd: sb.repo,
        hook_event_name: "UserPromptSubmit",
        prompt: "p",
        transcript_path: null,
      }),
    );
    await cli(["hook", "prompt", "--harness", "codex"], sb, {
      internalHome: sb.alignHome,
      readStdin: async () => stdin,
      spawnUploader: () => {},
    });
    expect(existsSync(join(sb.alignHome, "spool"))).toBe(false);
  });

  it("a re-run of init that says no to Cursor stops Cursor's capture here (hooks may stay on disk)", async () => {
    await setup();
    await cli(["init", "--yes", "--harness", "cursor,claude-code"], sb, { env: env() });
    expect((await cli(["init", "--yes", "--harness", "claude-code"], sb, { env: env() })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos[sb.repo].harnesses).toEqual([
      "claude-code",
    ]);
    const stdin = Buffer.from(
      JSON.stringify({
        conversation_id: "c-1",
        workspace_roots: [sb.repo],
        hook_event_name: "beforeSubmitPrompt",
        prompt: "p",
      }),
    );
    await cli(["hook", "prompt", "--harness", "cursor"], sb, {
      internalHome: sb.alignHome,
      readStdin: async () => stdin,
      spawnUploader: () => {},
    });
    expect(existsSync(join(sb.alignHome, "spool"))).toBe(false);
  });

  it("answering no to Cursor on a terminal re-run is honoured too", async () => {
    await setup();
    await cli(["init", "--yes", "--harness", "cursor"], sb, { env: env() });
    const r = await cli(["init"], sb, { env: { ...env(), PATH: "/usr/bin:/bin" }, tty: true, answers: ["n"] });
    expect(r.out).toContain("? Capture Cursor sessions in this repository? [Y/n]");
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos[sb.repo].harnesses).toEqual([]);
  });

  it("detects Cursor and Codex from their folders", async () => {
    await setup();
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const r = await cli(["init", "--yes"], sb, { env: { ...env(), PATH: "/usr/bin:/bin" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.alignHome, "repos.json"), "utf8")).repos[sb.repo].harnesses).toEqual([
      "cursor",
      "codex",
    ]);
  });
});
