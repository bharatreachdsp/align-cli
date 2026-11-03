/**
 * In-session serving (L16; docs/14 §The pack and §Delivery, docs/19 budgets): the session-start output per harness
 * (golden files), the 10,000-character caps, the cache and its stale fallback on a timeout, the paths hint, Cursor's
 * rule file, `align pack`, the `/align` command, and the Stop notice budget. A temporary HOME, the mock server on
 * 127.0.0.1, synthetic data only.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { MOCK_ORG, MOCK_USER } from "@align/core/api";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../src/credentials";
import { readState } from "../src/hook/state";
import { type CacheKey, readPackCache, writePackCache } from "../src/pack/cache";
import { HARNESS_TEXT_CAP } from "../src/pack/check";
import { RULE_REL, ruleText } from "../src/pack/cursor-rule";
import { cleanHint, parseStatusZ } from "../src/pack/hint";
import { alignPaths, type Paths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { findSession } from "../src/sessions";
import { setLoginRequired } from "../src/upload/state";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockServer, startMockServer } from "./mock-server";
import { testPack } from "./pack-fixture";

const SRC = join(import.meta.dirname, "..", "src", "harness");
const GOLDEN = join(import.meta.dirname, "__golden__", "session-start");
const FIX = {
  "claude-code": join(SRC, "claude-code", "__fixtures__", "claude-code-2.1.307"),
  codex: join(SRC, "codex", "__fixtures__", "codex-0.163.0"),
  cursor: join(SRC, "cursor", "__fixtures__", "cursor-2026.10.19"),
} as const;
type H = keyof typeof FIX;
const START_EVENT: Record<H, string> = { "claude-code": "SessionStart", codex: "SessionStart", cursor: "sessionStart" };
const REPO_ID = "0192f0a0-0000-7000-8000-000000000201";

let sb: Sandbox;
let server: MockServer | null = null;
let paths: Paths;
let clock = Date.parse("2026-10-22T09:00:00Z");

afterEach(async () => {
  await server?.close();
  server = null;
  sb?.cleanup();
});

function payload(h: H, over: Record<string, unknown> = {}): Record<string, unknown> {
  const all = JSON.parse(readFileSync(join(FIX[h], "payloads.json"), "utf8").replaceAll("__ROOT__", sb.repo));
  return { ...all[START_EVENT[h]], transcript_path: null, ...over };
}

async function setup(o: { harnesses?: H[]; signedIn?: boolean; pack?: unknown } = {}) {
  sb = sandbox();
  paths = alignPaths(sb.alignHome);
  server = await startMockServer();
  server.capture.pack = o.pack === undefined ? testPack() : o.pack;
  upsertRepo(paths, sb.repo, {
    repo_id: REPO_ID,
    org_id: MOCK_ORG.id,
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses: o.harnesses ?? ["claude-code", "codex", "cursor"],
    installed_at: new Date(clock).toISOString(),
  });
  if (o.signedIn !== false) {
    const token = ["aln", "mock", "0123456789abcdef0123"].join("_");
    server.tokens.add(token);
    new CredentialStore(paths, null).put(
      { org: MOCK_ORG, user: MOCK_USER, expires_at: "2027-01-01T00:00:00.000Z", server: server.url },
      token,
    );
  }
}

async function start(h: H, over: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  clock += 5000;
  const stdin = Buffer.from(JSON.stringify(payload(h, over)));
  return cli(["hook", "session-start", "--harness", h], sb, {
    internalHome: sb.alignHome,
    readStdin: async () => stdin,
    spawnUploader: () => {},
    now: () => clock,
    keychain: null,
    env,
  });
}

const srv = (): MockServer => {
  if (!server) throw new Error("no server");
  return server;
};
/** The cache key of this sandbox's repository (organisation and server of the signed-in record). */
const ck = (branch = "main", over: Partial<CacheKey> = {}): CacheKey => ({
  root: sb.repo,
  repoId: REPO_ID,
  orgId: MOCK_ORG.id,
  server: srv().url,
  branch,
  ...over,
});
const packRequests = () => (server?.requests ?? []).filter((r) => r.path === "/pack");

describe("session start serves the pack", () => {
  for (const h of ["claude-code", "codex", "cursor"] as const) {
    it(`${h}: prints the documented JSON (golden file) and stays within the 10,000-character caps`, async () => {
      await setup();
      const r = await start(h);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      if (process.env.UPDATE_GOLDEN) writeGolden(`${h}.out`, r.out);
      const golden = readFileSync(join(GOLDEN, `${h}.out`), "utf8");
      expect(r.out).toBe(golden);
      const o = JSON.parse(r.out);
      for (const v of [o.hookSpecificOutput?.additionalContext, o.systemMessage, o.additional_context])
        if (v !== undefined) expect((v as string).length).toBeLessThanOrEqual(HARNESS_TEXT_CAP);
      // One request, with the contract's keys, carrying the ALIGN session id and the harness.
      const [req] = packRequests();
      expect(req?.authorized).toBe(true);
      const body = req?.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["branch", "harness", "head", "paths", "repo_id", "session_id"]);
      expect(body).toMatchObject({ repo_id: REPO_ID, branch: "main", harness: h });
      expect(body.head).toMatch(/^[0-9a-f]{40}$/);
      expect(body.session_id).toBe(findSession(paths, h, String(payload(h).session_id)));
    });
  }

  it("a known session's resume or compact gets the pack again, but no second line", async () => {
    await setup();
    await start("claude-code");
    const again = JSON.parse((await start("claude-code", { source: "compact" })).out);
    expect(again.hookSpecificOutput.additionalContext).toBe(testPack().markdown);
    expect(again.systemMessage).toBeUndefined();
  });

  it("caps an oversized pack at a whole line under 10,000 characters, marker first", async () => {
    const long = `${testPack().markdown}${"- AL-99 · decision · A very long synthetic statement for the cap test.\n".repeat(300)}`;
    await setup({ pack: testPack({ markdown: long, notice_line: `ALIGN · ${"x".repeat(2000)}` }) });
    const o = JSON.parse((await start("claude-code")).out);
    const ctx = o.hookSpecificOutput.additionalContext as string;
    expect(ctx.length).toBeLessThanOrEqual(HARNESS_TEXT_CAP);
    expect(ctx.startsWith("<!-- align-pack v1 -->\n")).toBe(true);
    expect(ctx.endsWith("\n")).toBe(true);
    expect(long.startsWith(ctx)).toBe(true);
    expect((o.systemMessage as string).length).toBeLessThanOrEqual(500);
  });

  it("a pack that does not match the contract (no marker) is never delivered", async () => {
    await setup({ pack: testPack({ markdown: "## Team decisions without the marker\n" }) });
    expect((await start("claude-code")).out).toBe("");
    expect(existsSync(paths.packCache(sb.repo, "main"))).toBe(false);
  });

  it("the line follows the budget: nothing when nothing applies; proposals waiting count; uploads paused", async () => {
    await setup({
      pack: testPack({ items: [], notice_line: "ALIGN · No team decisions apply here yet." }),
    });
    const quiet = JSON.parse((await start("claude-code")).out);
    expect(quiet.systemMessage).toBeUndefined();
    expect(quiet.hookSpecificOutput.additionalContext).toContain("align-pack");

    srv().capture.pack = testPack({
      items: [],
      notice_line: "ALIGN · No team decisions apply here yet. 3 proposals wait for you: align confirm",
    });
    rmCache();
    const waiting = JSON.parse((await start("claude-code", { session_id: "s-proposals" })).out);
    expect(waiting.systemMessage).toBe(
      "ALIGN · No team decisions apply here yet. 3 proposals wait for you: align confirm",
    );

    setLoginRequired(paths, MOCK_ORG.id, clock);
    rmCache();
    const paused = JSON.parse((await start("claude-code", { session_id: "s-paused" })).out);
    expect(paused.systemMessage).toBe("ALIGN · capture on, uploads paused: your sign-in expired. Run align login.");
    // A refused token is not used again: no request, nothing cached, so no pack.
    expect(paused.hookSpecificOutput).toBeUndefined();
  });

  it("not signed in: no request, nothing printed", async () => {
    await setup({ signedIn: false });
    expect((await start("claude-code")).out).toBe("");
    expect(packRequests()).toEqual([]);
  });
});

function writeGolden(name: string, text: string) {
  mkdirSync(GOLDEN, { recursive: true });
  writeFileSync(join(GOLDEN, name), text);
}

function rmCache() {
  writeFileSync(paths.packCache(sb.repo, "main"), "{}");
}

describe("the pack cache", () => {
  it("is fresh for ten minutes per repository and branch; then the pack is fetched again", async () => {
    await setup();
    await start("claude-code", { session_id: "a" });
    expect(packRequests()).toHaveLength(1);
    const cached = readPackCache(paths, ck(), clock);
    expect(cached !== null && cached !== "expired" && cached.fresh).toBe(true);
    expect(lstatSync(paths.packCache(sb.repo, "main")).mode & 0o777).toBe(0o600);
    clock += 5 * 60 * 1000;
    await start("claude-code", { session_id: "b" });
    expect(packRequests()).toHaveLength(1);
    // Another branch has its own entry.
    gitIn(sb.repo, "switch", "-q", "-c", "feature");
    await start("claude-code", { session_id: "c" });
    expect(packRequests()).toHaveLength(2);
    expect((packRequests()[1]?.body as { branch: string } | undefined)?.branch).toBe("feature");
    gitIn(sb.repo, "switch", "-q", "main");
    clock += 6 * 60 * 1000;
    await start("claude-code", { session_id: "d" });
    expect(packRequests()).toHaveLength(3);
  });

  it("a server that does not answer within 1.2 s: the stale cache is served, marked, within the budget", async () => {
    await setup();
    writePackCache(paths, ck(), testPack(), clock - 45 * 60 * 1000);
    srv().capture.packDelayMs = 3000;
    const t0 = performance.now();
    const r = await start("claude-code");
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    expect(ms).toBeGreaterThanOrEqual(1100);
    const lines = (JSON.parse(r.out).hookSpecificOutput.additionalContext as string).split("\n");
    expect(lines[0]).toBe("<!-- align-pack v1 -->");
    expect(lines[1]).toBe(
      "ALIGN · This pack may be out of date: the server did not answer, so this is the one fetched 45 minutes ago.",
    );
    // A stand-in pack is the agent's; the person gets no "decisions apply" line on old information (N5).
    expect(JSON.parse(r.out).systemMessage).toBeUndefined();
    expect(lines.slice(2).join("\n")).toBe(testPack().markdown.split("\n").slice(1).join("\n"));
  });

  it("offline with nothing cached, or a cache older than a day: nothing is printed and the session goes on", async () => {
    await setup();
    srv().capture.packDelayMs = 3000;
    expect((await start("claude-code", { session_id: "x" })).out).toBe("");
    writePackCache(paths, ck(), testPack(), clock - 25 * 60 * 60 * 1000);
    expect((await start("claude-code", { session_id: "y" })).out).toBe("");
    // Older than a day: purged, not kept around.
    expect(existsSync(paths.packCacheDir(sb.repo))).toBe(false);
  });

  it("a cache is read only for its own repository id, organisation and server", async () => {
    await setup();
    for (const over of [
      { repoId: "another-repo" },
      { orgId: "another-org" },
      { server: "https://elsewhere.example" },
    ]) {
      writePackCache(paths, ck("main", over), testPack(), clock);
      expect(readPackCache(paths, ck(), clock)).toBeNull();
    }
  });
});

describe("the paths hint", () => {
  it("working directory, git status and the branch's changes; deny-listed and invalid paths removed", async () => {
    await setup();
    mkdirSync(join(sb.repo, "lib", "money"), { recursive: true });
    writeFileSync(join(sb.repo, "lib", "money", "cents.ts"), "synthetic\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-m", "money");
    // origin/main is the first commit: the branch changed lib/money/cents.ts.
    gitIn(sb.repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    writeFileSync(join(sb.repo, "README.md"), "changed\n");
    writeFileSync(join(sb.repo, ".env.local"), "synthetic\n");
    mkdirSync(join(sb.repo, "secrets"));
    writeFileSync(join(sb.repo, "secrets", "key.txt"), "synthetic\n");
    writeFileSync(join(sb.repo, ".aligndeny"), "private/**\n");
    mkdirSync(join(sb.repo, "private"));
    writeFileSync(join(sb.repo, "private", "notes.md"), "synthetic\n");
    await start("claude-code", { cwd: join(sb.repo, "lib", "money") });
    const body = packRequests()[0]?.body as { paths: string[] };
    expect(body.paths).toEqual(["lib/money", "README.md", ".aligndeny", "lib/money/cents.ts"]);
  });

  it("parses porcelain -z records (renames carry the old path) and caps at 200", () => {
    expect(parseStatusZ(" M a.ts\0R  new.ts\0old.ts\0?? dir/\0")).toEqual(["a.ts", "new.ts", "dir/"]);
    const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
    expect(cleanHint(many, [])).toHaveLength(200);
    expect(cleanHint(["/abs", "../up", "a/../b", "back\\slash", "ok/x.ts", "ok/x.ts", "dir/", "c\u0007"], [])).toEqual([
      "ok/x.ts",
      "dir",
    ]);
  });
});

describe("Cursor's rule file", () => {
  /** What init leaves: the file with the pending text, its exclude line recorded in installed.json. */
  function initRule() {
    mkdirSync(join(sb.repo, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(sb.repo, RULE_REL), ruleText(null));
    mkdirSync(dirname(paths.installed(sb.repo)), { recursive: true });
    writeFileSync(paths.installed(sb.repo), JSON.stringify({ version: 1, exclude_added: [`/${RULE_REL}`] }));
  }

  it("is refreshed with the pack where init wrote it; someone else's file is never touched", async () => {
    await setup();
    initRule();
    await start("cursor");
    const text = readFileSync(join(sb.repo, RULE_REL), "utf8");
    if (process.env.UPDATE_GOLDEN) writeGolden("align.mdc", text);
    expect(text).toBe(readFileSync(join(GOLDEN, "align.mdc"), "utf8"));
    expect(lstatSync(join(sb.repo, RULE_REL)).mode & 0o777).toBe(0o600);

    writeFileSync(join(sb.repo, RULE_REL), "my own rule\n");
    rmCache();
    await start("cursor", { session_id: "other" });
    expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe("my own rule\n");
  });

  it("the hook never creates it, and leaves a rule init did not record (a committed one) alone (S3)", async () => {
    await setup();
    await start("cursor");
    expect(existsSync(join(sb.repo, ".cursor"))).toBe(false);
    mkdirSync(join(sb.repo, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(sb.repo, RULE_REL), ruleText(null));
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-m", "a committed rule");
    rmCache();
    await start("cursor", { session_id: "committed" });
    expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe(ruleText(null));
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
  });

  it("init's explicit record counts without its exclude line; a rule committed after init is never rewritten (round 3)", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(sb.repo, RULE_REL), ruleText(null));
    mkdirSync(dirname(paths.installed(sb.repo)), { recursive: true });
    // A second worktree, or an exclude line that was already there: init records the rule itself.
    writeFileSync(paths.installed(sb.repo), JSON.stringify({ version: 1, exclude_added: [], cursor_rule: true }));
    await start("cursor");
    expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toContain("AL-12");
    // Committed afterwards: the repository's file now.
    gitIn(sb.repo, "add", "-f", RULE_REL);
    gitIn(sb.repo, "commit", "-q", "-m", "commit the rule");
    const committed = readFileSync(join(sb.repo, RULE_REL), "utf8");
    clock += 11 * 60 * 1000;
    srv().capture.pack = testPack({
      notice_line: "ALIGN · other",
      markdown: testPack().markdown.replace("AL-12", "AL-99"),
    });
    await start("cursor", { session_id: "after-commit" });
    expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe(committed);
  });

  it("never writes through a symbolic link a repository could commit", async () => {
    await setup();
    const outside = join(sb.dir, "outside");
    mkdirSync(join(outside, "rules"), { recursive: true });
    writeFileSync(join(outside, "rules", "align.mdc"), ruleText(null));
    symlinkSync(outside, join(sb.repo, ".cursor"));
    mkdirSync(dirname(paths.installed(sb.repo)), { recursive: true });
    writeFileSync(paths.installed(sb.repo), JSON.stringify({ version: 1, exclude_added: [`/${RULE_REL}`] }));
    await start("cursor");
    expect(readFileSync(join(outside, "rules", "align.mdc"), "utf8")).toBe(ruleText(null));
  });

  describe("a refusal or an expired pack forgets the pack (S2)", () => {
    for (const status of [401, 403, 404] as const) {
      it(`${status}: caches purged, the rule back to the pending text, nothing served`, async () => {
        await setup();
        initRule();
        await start("cursor");
        expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toContain("AL-12");
        clock += 11 * 60 * 1000;
        srv().capture.packStatus = status;
        const r = await start("cursor", { session_id: `refused-${status}` });
        expect(r.out).toBe("");
        expect(existsSync(paths.packCacheDir(sb.repo))).toBe(false);
        expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe(ruleText(null));
      });
    }

    it("a 5xx serves the stale pack (the server did not answer) and keeps the rule", async () => {
      await setup();
      initRule();
      await start("claude-code");
      clock += 11 * 60 * 1000;
      srv().capture.packStatus = 503;
      const o = JSON.parse((await start("claude-code", { session_id: "five" })).out);
      expect(o.hookSpecificOutput.additionalContext).toContain("may be out of date");
      expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toContain("AL-12");
    });

    it("a refused token (login required) or a missing credential record purges at once, without a request", async () => {
      await setup();
      initRule();
      await start("cursor");
      const before = packRequests().length;
      setLoginRequired(paths, MOCK_ORG.id, clock);
      expect((await start("cursor", { session_id: "paused" })).out).toBe("");
      expect(packRequests()).toHaveLength(before);
      expect(existsSync(paths.packCacheDir(sb.repo))).toBe(false);
      expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe(ruleText(null));
    });

    it("a cache older than a day resets the rule", async () => {
      await setup();
      initRule();
      await start("cursor");
      writePackCache(paths, ck(), testPack(), clock - 25 * 60 * 60 * 1000);
      srv().capture.packDelayMs = 3000;
      await start("cursor", { session_id: "old" });
      expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe(ruleText(null));
    });

    it("align logout purges the organisation's packs and resets its rule files", async () => {
      await setup();
      initRule();
      await start("cursor");
      const r = await cli(["logout"], sb, { keychain: null, env: { ALIGN_SERVER: srv().url } });
      expect(r.code).toBe(0);
      expect(existsSync(paths.packCacheDir(sb.repo))).toBe(false);
      expect(readFileSync(join(sb.repo, RULE_REL), "utf8")).toBe(ruleText(null));
    });
  });
});

describe("Stop notices", () => {
  it("only new proposals: a notice naming only proposals already shown is not shown again", async () => {
    await setup({ harnesses: ["claude-code"] });
    await start("claude-code");
    const id = findSession(paths, "claude-code", String(payload("claude-code").session_id)) as string;
    const stop = (text: string) => {
      clock += 11 * 60 * 1000;
      return cli(["hook", "stop", "--harness", "claude-code"], sb, {
        internalHome: sb.alignHome,
        readStdin: async () =>
          Buffer.from(
            JSON.stringify({
              session_id: payload("claude-code").session_id,
              transcript_path: null,
              cwd: sb.repo,
              hook_event_name: "Stop",
              last_assistant_message: text,
              stop_hook_active: false,
            }),
          ),
        spawnUploader: () => {},
        now: () => clock,
      });
    };
    const notice = (nid: string, keys: string[]) =>
      writeFileSync(paths.sessionNotice(id), JSON.stringify({ id: nid, text: `ALIGN · ${keys.join(", ")}`, keys }));
    notice("n1", ["AL-1"]);
    expect((await stop("a")).out).toBe('{"systemMessage":"ALIGN · AL-1"}\n');
    notice("n2", ["AL-1"]);
    expect((await stop("b")).out).toBe("");
    notice("n3", ["AL-1", "AL-2"]);
    expect((await stop("c")).out).toBe('{"systemMessage":"ALIGN · AL-1, AL-2"}\n');
    expect(readState(paths, id)?.notices_shown.map((s) => s.keys)).toEqual([["AL-1"], ["AL-1", "AL-2"]]);
    // The third is over the budget of two per session.
    notice("n4", ["AL-3"]);
    expect((await stop("d")).out).toBe("");
  });
});

describe("align pack and /align", () => {
  async function pack(args: string[] = [], env: Record<string, string> = {}, cwd?: string) {
    return cli(["pack", ...args], sb, {
      internalHome: sb.alignHome,
      now: () => clock,
      keychain: null,
      env,
      ...(cwd ? { cwd } : {}),
    });
  }

  it("prints the pack as Markdown or JSON, caches it, and serves the stale cache when the server does not answer", async () => {
    await setup();
    const md = await pack();
    expect(md).toEqual({ code: 0, out: testPack().markdown, err: "" });
    const json = JSON.parse((await pack(["--format", "json"])).out);
    expect(json).toMatchObject({ items: testPack().items, stale: false, notice_line: testPack().notice_line });
    expect(packRequests()).toHaveLength(1);
    clock += 30 * 60 * 1000;
    srv().capture.down = true;
    const stale = await pack();
    expect(stale.code).toBe(0);
    expect(stale.out.split("\n")[1]).toContain("may be out of date");
  });

  it("--paths asks for those paths and leaves the cache alone; unknown format and unconnected repository fail", async () => {
    await setup();
    expect((await pack(["--paths", "lib/money", ".env", "../x"])).code).toBe(0);
    expect((packRequests()[0]?.body as { paths: string[] } | undefined)?.paths).toEqual(["lib/money"]);
    expect(existsSync(paths.packCache(sb.repo, "main"))).toBe(false);
    expect((await pack(["--format", "html"])).code).toBe(2);
    const sb2 = sandbox();
    try {
      const r = await pack([], {}, sb2.repo);
      expect(r).toEqual({ code: 1, out: "", err: "This repository is not connected. Run align init.\n" });
    } finally {
      sb2.cleanup();
    }
  });

  it("--help prints its usage", async () => {
    await setup();
    const r = await pack(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: align pack [--format md|json]");
  });

  it("not signed in and nothing cached: one line saying so", async () => {
    await setup({ signedIn: false });
    expect(await pack()).toEqual({
      code: 1,
      out: "",
      err: "Not signed in to this repository's organisation. Run align login.\n",
    });
  });

  it("a hostile session environment cannot redirect it: ALIGN_HOME, HOME, ALIGN_SERVER, ALIGN_CREDENTIAL_STORE and GIT_* are ignored (S1)", async () => {
    await setup();
    const evil = await startMockServer();
    try {
      // A home the repository wrote: the same organisation id, a server of its own, a token of its own.
      const planted = alignPaths(join(sb.dir, "evil", ".align"));
      const plantedToken = ["aln", "evil", "0123456789abcdef0123"].join("_");
      new CredentialStore(planted, null).put(
        { org: MOCK_ORG, user: MOCK_USER, expires_at: "2027-01-01T00:00:00.000Z", server: evil.url },
        plantedToken,
      );
      evil.tokens.add(plantedToken);
      evil.capture.pack = testPack({ notice_line: "ALIGN · planted" });
      const other = sandbox("git@github.com:evil/other.git");
      try {
        const r = await pack([], {
          ALIGN_HOME: planted.home,
          HOME: join(sb.dir, "evil"),
          ALIGN_SERVER: evil.url,
          ALIGN_CREDENTIAL_STORE: "file",
          GIT_DIR: join(other.repo, ".git"),
          GIT_WORK_TREE: other.repo,
        });
        expect(r).toEqual({ code: 0, out: testPack().markdown, err: "" });
        expect(evil.requests.filter((q) => q.path === "/pack")).toEqual([]);
        expect((packRequests()[0]?.body as { repo_id: string } | undefined)?.repo_id).toBe(REPO_ID);
      } finally {
        other.cleanup();
      }
    } finally {
      await evil.close();
    }
  });
});

describe("what the request carries", () => {
  it("the branch and hint paths pass identity redaction: this laptop's username never leaves (docs/17 §Identity)", async () => {
    await setup();
    const user = userInfo().username;
    gitIn(sb.repo, "switch", "-q", "-c", `${user}/redis-lock`);
    mkdirSync(join(sb.repo, user), { recursive: true });
    writeFileSync(join(sb.repo, user, "notes.md"), "synthetic\n");
    await start("claude-code", { cwd: join(sb.repo, user) });
    const body = packRequests()[0]?.body as { branch: string; paths: string[] } | undefined;
    expect(body?.branch).not.toContain(user);
    expect(body?.branch).toContain("redis-lock");
    expect(JSON.stringify(body?.paths)).not.toContain(user);
  });
});
