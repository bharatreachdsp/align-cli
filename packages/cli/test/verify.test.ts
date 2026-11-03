/**
 * Local checks (L15b; docs/13 §Deterministic checks, docs/15 `align verify` and `init` step 8): the working-tree adapter
 * over fixture repositories (tracked only, deny globs, symbolic links, the 1 MB cap), every check kind, and network
 * capture on the mock server asserting that `/check-results` carries paths, line numbers and rule names only. A
 * temporary HOME; synthetic files only.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckResultsRequest } from "@align/core/api";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCursorProject, gitBirth } from "../src/backfill/scan";
import {
  BlobReader,
  denyGlobsFor,
  hiddenPaths,
  localFiles,
  parentInside,
  redactLines,
  reportCommit,
  runLocalChecks,
  SECRET_KEY,
  safeMatches,
  trackedPaths,
} from "../src/checks/fs-local";
import { contradicted, RESULTS_PER_REQUEST, resultBodies } from "../src/checks/report";
import { encodeCursorProject } from "../src/harness/cursor/transcript";
import { alignPaths } from "../src/paths";
import { setOptedIn } from "../src/registry";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";
import { type MockServer, startMockServer } from "./mock-server";

let sb: Sandbox;
let server: MockServer;
let clock = Date.now();

afterEach(async () => {
  await server?.close();
  sb?.cleanup();
});

/** File content that must never leave the laptop (assembled at run time). */
const CONTENT = ["SYNTHETIC", "CONTENT", "TOKEN", "9f3"].join("_");
/** The laptop's text rules for the tests: the org's domain, and a known username and hostname. */
const TCTX = { orgDomains: ["acme.example"], hostnames: ["build-host"], usernames: ["riya"] };
const uuid = (n: number) => `0192f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;

const put = (rel: string, text: string) => {
  const p = join(sb.repo, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

/** The registered remote of the sandbox repository (`git@github.com:acme/checkout.git`). */
const REMOTE = "github.com/acme/checkout";
/** HEAD, and a remote-tracking ref at it (as after `git push`): the commit results are reported under (D409). */
const headSha = () => gitIn(sb.repo, "rev-parse", "HEAD");
const pushed = () => gitIn(sb.repo, "update-ref", "refs/remotes/origin/main", "HEAD");

/** A fixture repository: tracked, untracked, denied, oversized and linked files that all import `ioredis`. */
function fixtureRepo() {
  put("lib/cart/lock.ts", `import Redis from "ioredis";\nconst ${CONTENT} = 1;\n`);
  put("lib/cart/ttl.ts", "export const TTL_SECONDS = 30;\n");
  put("secrets/conf.ts", `import Redis from "ioredis";\n`);
  put("lib/private/x.ts", `import Redis from "ioredis";\n`);
  put(".aligndeny", "lib/private/**\n");
  put("big.ts", `import Redis from "ioredis";\n${"// filler\n".repeat(120_000)}`);
  put("package.json", JSON.stringify({ name: "fixture", dependencies: { "left-pad": "1.3.0" } }, null, 2));
  symlinkSync(join(sb.repo, "lib", "cart", "lock.ts"), join(sb.repo, "link.ts"));
  gitIn(sb.repo, "add", "-A");
  gitIn(sb.repo, "commit", "-q", "-m", "fixture");
  pushed();
  put("lib/cart/untracked.ts", `import Redis from "ioredis";\n`);
}

const CHECKS = [
  { id: uuid(1), entry_key: "AL-1", kind: "forbid_import", spec: { module: "ioredis", paths: ["**"] } },
  { id: uuid(2), entry_key: "AL-1", kind: "forbid_dependency", spec: { package: "left-pad" } },
  {
    id: uuid(3),
    entry_key: "AL-2",
    kind: "require_pattern",
    spec: { pattern: "TTL_SECONDS", paths: ["lib/**"], description: "the TTL is named" },
  },
  { id: uuid(4), entry_key: "AL-3", kind: "path_exists", spec: { glob: "README.md" } },
  { id: uuid(5), entry_key: "AL-4", kind: "path_absent", spec: { glob: "lib/legacy/**" } },
  {
    id: uuid(6),
    entry_key: "AL-5",
    kind: "forbid_pattern",
    spec: { pattern: "SYNTHETIC", paths: ["docs/**"], description: "no synthetic markers in docs" },
  },
].map((c) => ({ ...c, status: "active", revision: 1, last_run: null }));

async function setup() {
  sb = sandbox();
  server = await startMockServer();
  fixtureRepo();
  clock = Date.now();
  const r = await run(["init", "--yes", "--no-backfill", "--harness", "claude-code"]);
  expect(r.code, r.err).toBe(0);
}

const run = (argv: string[], extra: Parameters<typeof cli>[2] = {}) =>
  cli(argv, sb, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ttyAsk: async () => "y",
    ...extra,
    env: { ALIGN_SERVER: server.url, PATH: "/usr/bin:/bin", ...extra.env },
  });

describe("the working-tree adapter (checks/fs-local.ts)", () => {
  it("tracked regular files only; denied, linked and untracked files never seen", async () => {
    sb = sandbox();
    fixtureRepo();
    const tracked = (await trackedPaths(sb.repo)) ?? [];
    expect(tracked).toContain("link.ts");
    expect(tracked).not.toContain("lib/cart/untracked.ts");
    const files = localFiles(sb.repo, tracked, denyGlobsFor(alignPaths(sb.alignHome), sb.repo));
    const seen = files.map((f) => f.path).sort();
    expect(seen).toEqual([".aligndeny", "README.md", "big.ts", "lib/cart/lock.ts", "lib/cart/ttl.ts", "package.json"]);
    expect(files.find((f) => f.path === "big.ts")?.size).toBeGreaterThan(1024 * 1024);
  });

  it("every check kind gives the worker's answer; matches are paths, lines and rules only", async () => {
    sb = sandbox();
    fixtureRepo();
    const results = await runLocalChecks(
      sb.repo,
      CHECKS.map((c) => ({ check_id: c.id, entry_key: c.entry_key, kind: c.kind, spec: c.spec })),
      { paths: alignPaths(sb.alignHome), ctx: TCTX, commit: headSha() },
    );
    const by = Object.fromEntries(results.map((r) => [r.check_id, r]));
    expect(by[uuid(1)]).toMatchObject({ result: "fail", matches: [{ path: "lib/cart/lock.ts", line: 1 }] });
    expect(by[uuid(2)]).toMatchObject({ result: "fail", matches: [{ path: "package.json" }] });
    expect(by[uuid(3)]?.result).toBe("pass");
    expect(by[uuid(4)]?.result).toBe("pass");
    expect(by[uuid(5)]?.result).toBe("pass");
    expect(by[uuid(6)]?.result).toBe("pass");
    for (const r of results) for (const m of r.matches) expect(Object.keys(m).sort()).toEqual(["line", "path", "rule"]);
    expect(JSON.stringify(results)).not.toContain(CONTENT);
    expect(contradicted(results)).toBe(1); // two failing checks, one decision
  });

  it("a match on a denied or malformed path never leaves", () => {
    const kept = safeMatches(
      [
        { path: "lib/a.ts", line: 3, rule: "import" },
        { path: ".env.local", line: 1, rule: "pattern" },
        { path: "../outside.ts", line: 1, rule: "pattern" },
        { path: "lib/b.ts", line: 2, rule: "Bad Rule!" },
      ],
      [".env*"],
    );
    expect(kept).toEqual([{ path: "lib/a.ts", line: 3, rule: "import" }]);
  });

  it("result bodies carry exactly the contracted keys, 200 results a request", () => {
    const results = Array.from({ length: 450 }, (_, i) => ({
      check_id: uuid(i + 1),
      entry_key: `AL-${i}`,
      kind: "forbid_pattern",
      result: "pass" as const,
      matches: [],
      duration_ms: 3,
      reason: "files_skipped",
    }));
    const bodies = resultBodies(uuid(999), "a".repeat(40), results);
    expect(bodies.map((b) => (b as { results: unknown[] }).results.length)).toEqual([200, 200, 50]);
    expect(RESULTS_PER_REQUEST).toBe(200);
    for (const b of bodies) {
      expect(CheckResultsRequest.safeParse(b).success).toBe(true);
      expect(JSON.stringify(b)).not.toMatch(/entry_key|reason|forbid_pattern/);
    }
  });
});

describe("round 2: results never act as an oracle on files (D423)", () => {
  const one = (kind: string, spec: Record<string, unknown>) => [{ check_id: uuid(1), entry_key: "AL-1", kind, spec }];
  const runOn = (source: "head" | "worktree", kind: string, spec: Record<string, unknown>) =>
    runLocalChecks(sb.repo, one(kind, spec), {
      paths: alignPaths(sb.alignHome),
      ctx: TCTX,
      source,
      commit: headSha(),
    }).then((r) => r[0]);

  it("(a) reported results come from HEAD's blobs; uncommitted edits count only on the working tree", async () => {
    sb = sandbox();
    fixtureRepo();
    put("lib/cart/ttl.ts", 'import Redis from "ioredis";\n'); // uncommitted
    const spec = { module: "ioredis", paths: ["lib/cart/ttl.ts"] };
    expect((await runOn("head", "forbid_import", spec))?.result).toBe("pass");
    expect((await runOn("worktree", "forbid_import", spec))?.result).toBe("fail");
  });

  it("(b) a secret's value never decides a result: lines are redacted before matching, line numbers kept", async () => {
    sb = sandbox();
    const key = ["AKIA", "Q7ZX", "M2PL", "8VNE", "4RTY"].join("");
    put("config/database.yml", `production:\n  aws_key: ${key}\n  password: s3cr3t-Hunter-42\n`);
    put("config/app.ts", 'const x = 1;\nconst y = "AKIA";\n');
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "config");
    for (const source of ["head", "worktree"] as const) {
      const prefix = await runOn(source, "forbid_pattern", {
        pattern: `${key.slice(0, 8)}`,
        paths: ["config/**"],
        description: "probe",
      });
      expect(prefix?.result).toBe("pass");
      const password = await runOn(source, "forbid_pattern", {
        pattern: "s3cr3t-H",
        paths: ["config/**"],
        description: "probe",
      });
      expect(password?.result).toBe("pass");
      // ordinary code still matches, on its own line number
      const plain = await runOn(source, "forbid_pattern", {
        pattern: "const y",
        paths: ["config/**"],
        description: "x",
      });
      expect(plain?.matches).toEqual([{ path: "config/app.ts", line: 2, rule: "pattern" }]);
    }
    expect(redactLines(`a\nkey ${key}\r\nb`, TCTX).split("\n")).toHaveLength(3);
  });

  it("(c) skip-worktree and assume-unchanged entries are never read", async () => {
    sb = sandbox();
    put("config/local.json", '{"dependencies": {"left-pad": "1.0.0"}}\n');
    put("config/package.json", '{"dependencies": {"left-pad": "1.0.0"}}\n');
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "local config");
    gitIn(sb.repo, "update-index", "--skip-worktree", "config/package.json");
    expect((await hiddenPaths(sb.repo))?.has("config/package.json")).toBe(true);
    for (const source of ["head", "worktree"] as const)
      expect((await runOn(source, "forbid_dependency", { package: "left-pad" }))?.result).toBe("pass");
    gitIn(sb.repo, "update-index", "--no-skip-worktree", "config/package.json");
    gitIn(sb.repo, "update-index", "--assume-unchanged", "config/package.json");
    expect((await runOn("head", "forbid_dependency", { package: "left-pad" }))?.result).toBe("pass");
    gitIn(sb.repo, "update-index", "--no-assume-unchanged", "config/package.json");
    expect((await runOn("head", "forbid_dependency", { package: "left-pad" }))?.result).toBe("fail");
  });

  it("(d) only active checks and the person's own private proposals' checks run", async () => {
    await setup();
    server.capture.checks.items = [
      { ...CHECKS[3], id: uuid(1), entry_key: "AL-1", status: "active" },
      { ...CHECKS[3], id: uuid(2), entry_key: "AL-2", status: "proposed" }, // someone else's, or shared: not run
      { ...CHECKS[3], id: uuid(3), entry_key: "AL-3", status: "proposed" }, // the caller's own private proposal
    ];
    server.capture.checks.proposals = [
      { key: "AL-2", private: false },
      { key: "AL-3", private: true },
    ];
    const r = await run(["verify", "--json"]);
    const out = JSON.parse(r.out) as { results: { check_id: string }[] };
    expect(out.results.map((x) => x.check_id).sort()).toEqual([uuid(1), uuid(3)]);
  });

  it("B2: a symbolically linked parent directory that leaves the repository is never followed", async () => {
    sb = sandbox();
    put("vendor/x.ts", "export const ok = 1;\n");
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "vendor");
    const outside = join(sb.dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "x.ts"), 'import Redis from "ioredis";\n');
    rmSync(join(sb.repo, "vendor"), { recursive: true });
    symlinkSync(outside, join(sb.repo, "vendor"));
    expect(parentInside(sb.repo, join(sb.repo, "vendor", "x.ts"))).toBe(false);
    const tracked = (await trackedPaths(sb.repo)) ?? [];
    expect(localFiles(sb.repo, tracked, []).map((f) => f.path)).not.toContain("vendor/x.ts");
    expect((await runOn("worktree", "forbid_import", { module: "ioredis", paths: ["**"] }))?.result).toBe("pass");
  });

  it("B3: a match whose path the laptop's rules would change (email, username) is dropped; nothing nameable → skipped", async () => {
    sb = sandbox();
    put("notes/riya/plan.ts", 'import Redis from "ioredis";\n');
    put("notes/ops@acme-corp.example/plan.ts", 'import Redis from "ioredis";\n');
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "notes");
    const r = await runOn("head", "forbid_import", { module: "ioredis", paths: ["notes/**"] });
    expect(r?.matches).toEqual([]);
    expect(r?.result).toBe("skipped");
    expect(safeMatches([{ path: "lib/ok.ts", line: 1, rule: "pattern" }], [], TCTX)).toHaveLength(1);
    expect(safeMatches([{ path: "lib/\u0085x.ts", line: 1, rule: "pattern" }], [], TCTX)).toHaveLength(0);
    expect(safeMatches([{ path: "lib/\u202ex.ts", line: 1, rule: "pattern" }], [], TCTX)).toHaveLength(0);
  });

  it("an overall deadline: checks past it are errors (timeout), never fail or pass", async () => {
    sb = sandbox();
    const r = await runLocalChecks(
      sb.repo,
      [{ check_id: uuid(1), entry_key: "AL-1", kind: "path_exists", spec: { glob: "README.md" } }],
      { paths: alignPaths(sb.alignHome), ctx: TCTX, deadline: Date.now() - 1, commit: headSha() },
    );
    expect(r[0]).toMatchObject({ result: "error", reason: "timeout" });
  });

  it("gitBirth: birth time, else .git/description's time, never the inode change time", () => {
    const stat = (birth: number, desc: number | null) => (p: string) => {
      if (p.endsWith("description")) {
        if (desc === null) throw new Error("missing");
        return { birthtimeMs: 0, mtimeMs: desc, ctimeMs: 9 };
      }
      return { birthtimeMs: birth, mtimeMs: 7, ctimeMs: 9 };
    };
    expect(gitBirth("/r", stat(5, 6))).toBe(5);
    expect(gitBirth("/r", stat(0, 6))).toBe(6);
    expect(gitBirth("/r", stat(0, null))).toBeNull();
  });
});

describe("align verify", () => {
  it("runs the checks, prints one line each, and sends paths and line numbers only", async () => {
    await setup();
    server.capture.checks.items = CHECKS;
    const r = await run(["verify"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Verify {7}6 checks on commit [0-9a-f]{12} \(tracked files as committed/);
    expect(r.out).toContain("× AL-1     forbid_import      contradicted · lib/cart/lock.ts:1");
    expect(r.out).toContain("✓ AL-3     path_exists        holds");
    expect(r.out).toContain("5 decisions checked · 1 looks contradicted by the current code");
    expect(r.out).toContain("local conflicts: 2 opened · 0 resolved (advisory)");
    const bodies = server.capture.checks.results;
    expect(bodies).toHaveLength(1);
    expect(CheckResultsRequest.safeParse(bodies[0]).success).toBe(true);
    const raw = JSON.stringify(bodies);
    expect(raw).not.toContain(CONTENT);
    expect(raw).not.toContain("ioredis");
    expect(raw).not.toMatch(/secrets\/|lib\/private|untracked|big\.ts|link\.ts/);
    expect((bodies[0] as { sha: string }).sha).toBe(gitIn(sb.repo, "rev-parse", "HEAD"));
  });

  it("--json prints the results; the checks are read page by page and reported 200 at a time", async () => {
    await setup();
    server.capture.checks.items = Array.from({ length: 250 }, (_, i) => ({
      ...CHECKS[3],
      id: uuid(i + 1),
      entry_key: `AL-${i + 1}`,
    }));
    const r = await run(["verify", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { results: { result: string }[]; conflicts_opened: number };
    expect(out.results).toHaveLength(250);
    expect(out.results.every((x) => x.result === "pass")).toBe(true);
    expect(server.requests.filter((q) => q.path === "/checks")).toHaveLength(3);
    expect(server.capture.checks.results.map((b) => (b as { results: unknown[] }).results.length)).toEqual([200, 50]);
  });

  it("no checks; offline when reporting (exit 1); opted out (never read)", async () => {
    await setup();
    let r = await run(["verify"]);
    expect(r.out).toContain("No checks for this repository yet.");
    server.capture.checks.items = CHECKS.slice(0, 1);
    server.capture.checks.resultsDown = true;
    r = await run(["verify"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the server could not be told; run align verify again later.");
    server.capture.checks.resultsDown = false;
    setOptedIn(alignPaths(sb.alignHome), sb.repo, false);
    const before = server.requests.length;
    r = await run(["verify"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("This repository is not connected. Run align init.");
    expect(server.requests.length).toBe(before);
  });
});

describe("L15b-2: the reported commit, stateful line redaction, cat-file, resolved deny", () => {
  it("reported at the newest commit HEAD shares with a remote; unpushed commits never decide a posted result", async () => {
    await setup();
    server.capture.checks.items = [{ ...CHECKS[0], spec: { module: "left-pad", paths: ["**"] } }, { ...CHECKS[3] }];
    const base = headSha();
    put("lib/new.ts", 'import pad from "left-pad";\n');
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "local only");
    expect(await reportCommit(sb.repo, REMOTE)).toBe(base);
    const r = await run(["verify"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`on commit ${base.slice(0, 12)}`);
    expect(r.out).toContain("later commits are not on a remote yet");
    expect(r.out).toContain("with your uncommitted changes: contradicted");
    const body = server.capture.checks.results.at(-1) as { sha: string; results: { result: string }[] };
    expect(body.sha).toBe(base);
    // the unpushed commit's import never shows in what is reported (big.ts, over 1 MB, makes the first one skipped)
    expect(body.results.map((x) => x.result)).toEqual(["skipped", "pass"]);
    // a tracked upstream wins over other remote refs
    gitIn(sb.repo, "update-ref", "refs/remotes/fork/main", "HEAD");
    gitIn(sb.repo, "branch", "--set-upstream-to=origin/main");
    expect(await reportCommit(sb.repo, REMOTE)).toBe(base);
  });

  it("R1: a local branch as the upstream, or a personal fork's refs, never make a commit reported", async () => {
    sb = sandbox();
    fixtureRepo();
    const base = headSha();
    // a local `main` ahead of origin/main, and a feature branch whose upstream is that local branch
    put("lib/a.ts", "export const a = 1;\n");
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "local main");
    const localMain = headSha();
    gitIn(sb.repo, "switch", "-q", "-c", "feat");
    gitIn(sb.repo, "branch", "--set-upstream-to=main");
    expect(gitIn(sb.repo, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe("refs/heads/main");
    expect(await reportCommit(sb.repo, REMOTE)).toBe(base);
    // a personal fork with the newer commit pushed: not the repository's own remote
    gitIn(sb.repo, "remote", "add", "fork", "git@github.com:someone/checkout.git");
    gitIn(sb.repo, "update-ref", "refs/remotes/fork/main", localMain);
    gitIn(sb.repo, "branch", "--set-upstream-to=fork/main");
    expect(await reportCommit(sb.repo, REMOTE)).toBe(base);
    // the right remote under another name counts; with no remote of this repository, nothing is reported
    expect(await reportCommit(sb.repo, "github.com/acme/other")).toBeNull();
    gitIn(sb.repo, "update-ref", "refs/remotes/origin/main", localMain);
    gitIn(sb.repo, "branch", "--set-upstream-to=origin/main");
    expect(await reportCommit(sb.repo, REMOTE)).toBe(localMain);
  });

  it("R2: anchors and tags, `- ` items, flow and quoted blocks, continuations, CDATA, pair rules, Secret manifests", () => {
    const join = (l: string[]) => l.join("\n");
    const out = (l: string[]) => redactLines(join(l), TCTX);
    const hidden = (text: string, values: string[]) => {
      for (const v of values) expect(text, v).not.toContain(v);
    };
    hidden(out(["password: &pw !!str", "  anchor-val-1", "token: !vault |", "  tagged-val-2"]), [
      "anchor-val-1",
      "tagged-val-2",
    ]);
    hidden(out(["secrets:", "- item-val-3", "- item-val-4", "other: 1"]), ["item-val-3", "item-val-4"]);
    hidden(out(["api_key: [", "  flow-val-5,", "]"]), ["flow-val-5"]);
    hidden(out(['private_key = """', "quoted-val-6", '"""', "x = 1"]), ["quoted-val-6"]);
    hidden(out(["export DB_PASSWORD=start\\", "cont-val-7\\", "cont-val-8", "after = visible"]), [
      "cont-val-7",
      "cont-val-8",
    ]);
    hidden(out(["<password><![CDATA[", "cdata-val-9", "]]></password>"]), ["cdata-val-9"]);
    hidden(out(["<secret>inline-val-10</secret>"]), ["inline-val-10"]);
    hidden(out(["env:", "- name: DB_PASSWORD", "  value: k8s-val-11", "- name: LOG_LEVEL", "  value: debug"]), [
      "k8s-val-11",
    ]);
    expect(out(["- name: LOG_LEVEL", "  value: debug"])).toContain("debug");
    hidden(out(["<property>", "  <name>db.password</name>", "  <value>xml-val-12</value>", "</property>"]), [
      "xml-val-12",
    ]);
    hidden(
      out([
        "apiVersion: v1",
        "kind: Secret",
        "data:",
        "  user: dXNlci12YWwtMTM=",
        "stringData:",
        "  conf: plain-val-14",
        "type: Opaque",
      ]),
      ["dXNlci12YWwtMTM=", "plain-val-14"],
    );
    expect(out(["kind: ConfigMap", "data:", "  conf: config-kept"])).toContain("config-kept");
    expect(out(["kind: Secret", "data:", "  a: b", "type: Opaque"]).split("\n")[3]).toBe("type: Opaque");
    const after = out(["after = visible"]);
    expect(after).toBe("after = visible");
  });

  it("no commit shared with any remote: shown on the laptop, nothing reported", async () => {
    await setup();
    gitIn(sb.repo, "update-ref", "-d", "refs/remotes/origin/main");
    server.capture.checks.items = CHECKS.slice(3, 4);
    let r = await run(["verify"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("this branch shares no commit with a remote yet, so nothing is reported");
    expect(server.capture.checks.results).toHaveLength(0);
    r = await run(["verify", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ sha: null, reported: "none", reason: "no_shared_commit" });
  });

  it("a value on the lines after a secret-like key is redacted: YAML blocks, empty values, XML elements", () => {
    const yaml = [
      "db:",
      "  password:",
      "    hunter2-long-value",
      "  jwt_signing_key: |",
      "    line-one-abc",
      "    line-two-def",
      "  name: shop",
      "encryption_key: >-",
      "  folded-ghi",
      "description: |",
      "  ordinary text stays",
      "<Secret>",
      "  xml-value-jkl",
      "</Secret>",
      "<title>",
      "  kept",
      "</title>",
    ].join("\n");
    const out = redactLines(yaml, TCTX).split("\n");
    expect(out).toHaveLength(17);
    for (const v of ["hunter2-long-value", "line-one-abc", "line-two-def", "folded-ghi", "xml-value-jkl"])
      expect(out.join("\n")).not.toContain(v);
    expect(out[2]).toBe("    ‹secret›");
    expect(out[6]).toBe("  name: shop");
    expect(out[10]).toBe("  ordinary text stays");
    expect(out[13]).toBe("‹secret›</Secret>");
    expect(out[15]).toBe("  kept");
    expect(SECRET_KEY.test("jwt")).toBe(true);
    expect(SECRET_KEY.test("signing")).toBe(true);
    expect(SECRET_KEY.test("encryption_iv")).toBe(true);
  });

  it("a probe for a block value finds nothing (posted and shown)", async () => {
    sb = sandbox();
    put("config/app.yml", "token: |\n  probe-value-xyz\nother: 1\n");
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "c");
    for (const source of ["head", "worktree"] as const) {
      const [r] = await runLocalChecks(
        sb.repo,
        [
          {
            check_id: uuid(1),
            entry_key: "AL-1",
            kind: "forbid_pattern",
            spec: { pattern: "probe-val", paths: ["**"], description: "p" },
          },
        ],
        { paths: alignPaths(sb.alignHome), ctx: TCTX, source, commit: headSha() },
      );
      expect(r?.result).toBe("pass");
    }
  });

  it("cat-file: an answer that is not the blob asked for fails the reader for good", async () => {
    sb = sandbox();
    const tree = gitIn(sb.repo, "rev-parse", "HEAD^{tree}");
    const blob = gitIn(sb.repo, "rev-parse", "HEAD:README.md");
    const reader = new BlobReader(sb.repo, process.env);
    await expect(reader.read(tree)).rejects.toThrow();
    await expect(reader.read(blob)).rejects.toThrow();
    reader.close();
    const fresh = new BlobReader(sb.repo, process.env);
    await expect(fresh.read(blob)).resolves.toBe("synthetic\n");
    fresh.close();
  });

  it("the display run matches deny globs on where a file really is", async () => {
    sb = sandbox();
    put("config/app.ts", "export const a = 1;\n");
    gitIn(sb.repo, "add", "-A");
    gitIn(sb.repo, "commit", "-q", "-m", "c");
    put("secrets/app.ts", 'import Redis from "ioredis";\n');
    rmSync(join(sb.repo, "config"), { recursive: true });
    symlinkSync(join(sb.repo, "secrets"), join(sb.repo, "config"));
    const tracked = (await trackedPaths(sb.repo)) ?? [];
    expect(tracked).toContain("config/app.ts");
    const files = localFiles(sb.repo, tracked, denyGlobsFor(alignPaths(sb.alignHome), sb.repo));
    expect(files.map((f) => f.path)).not.toContain("config/app.ts");
  });
});

describe("align verify when reporting fails (N6)", () => {
  it("a server error: lines still printed, the not-reported line, exit 1, --json without conflict counts", async () => {
    await setup();
    server.capture.checks.items = CHECKS.slice(3, 4);
    server.capture.checks.fail = { status: 500, code: "internal", after: 0, times: 2 };
    let r = await run(["verify"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✓ AL-3");
    expect(r.err).toContain("the server could not be told");
    r = await run(["verify", "--json"]);
    const out = JSON.parse(r.out) as Record<string, unknown>;
    expect(out.reported).toBe("none");
    expect("conflicts_opened" in out).toBe(false);
  });

  it("a partial report says how much reached the server", async () => {
    await setup();
    server.capture.checks.items = Array.from({ length: 250 }, (_, i) => ({ ...CHECKS[3], id: uuid(i + 1) }));
    server.capture.checks.fail = { status: 503, code: "internal", after: 1, times: 1 };
    const r = await run(["verify"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Only 200 of 250 results reached the server");
  });

  it("a check that vanished meanwhile: fetched again and the rest reported", async () => {
    await setup();
    server.capture.checks.items = CHECKS.slice(3, 5);
    server.capture.checks.fail = { status: 404, code: "entry_not_found", after: 0, times: 1 };
    server.capture.onEvents = null;
    const original = server.capture.checks;
    // The second GET /checks lists only one of the two.
    let gets = 0;
    const items = original.items;
    Object.defineProperty(original, "items", {
      get: () => (++gets > 1 ? items.slice(0, 1) : items),
      configurable: true,
    });
    const r = await run(["verify"]);
    expect(r.code, r.err).toBe(0);
    const last = server.capture.checks.results.at(-1) as { results: unknown[] };
    expect(last.results).toHaveLength(1);
  });
});

describe("Cursor decoding with Unicode forms (#57 follow-up)", () => {
  it("a segment whose NFC form encodes to nothing is transparent even when stored decomposed", () => {
    sb = sandbox();
    const root = join(sb.dir, "work", "my-repo");
    mkdirSync(root, { recursive: true });
    const twin = join(sb.dir, "é", "work", "my-repo"); // "é" stored as NFD: raw encodes "e", NFC encodes ""
    mkdirSync(twin, { recursive: true });
    expect(decodeCursorProject(encodeCursorProject(root)).length).toBeGreaterThan(1);
  });
});
