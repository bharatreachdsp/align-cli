import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitIn, type Sandbox, sandbox } from "../test/helpers";
import * as g from "./git";

let sb: Sandbox;
afterEach(() => sb?.cleanup());

describe("git helpers", () => {
  it("reads toplevel, branch, head, root commit and the default branch", async () => {
    sb = sandbox("https://github.com/Acme/Checkout.git");
    expect(await g.toplevel(sb.repo)).toBe(sb.repo);
    expect(await g.branch(sb.repo)).toBe("main");
    expect(await g.head(sb.repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.rootCommit(sb.repo)).toBe(await g.head(sb.repo));
    expect(await g.defaultBranch(sb.repo)).toBe("main");
    expect(await g.chooseRemote(sb.repo)).toEqual({
      kind: "ok",
      remote: "origin",
      remote_norm: "github.com/acme/checkout",
    });
  });

  it("follows refs/remotes/origin/HEAD and picks the lexicographically first root", async () => {
    sb = sandbox();
    const first = await g.rootCommit(sb.repo);
    gitIn(sb.repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    gitIn(sb.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await g.defaultBranch(sb.repo)).toBe("trunk");
    gitIn(sb.repo, "checkout", "-q", "--orphan", "other");
    gitIn(sb.repo, "commit", "-q", "--allow-empty", "-m", "second root");
    const second = gitIn(sb.repo, "rev-parse", "HEAD");
    gitIn(sb.repo, "checkout", "-q", "main");
    gitIn(sb.repo, "merge", "-q", "--allow-unrelated-histories", "-m", "join", "other");
    expect(await g.rootCommit(sb.repo)).toBe([first, second].sort()[0]);
  });

  it("handles missing, single and ambiguous remotes", async () => {
    sb = sandbox(null);
    expect(await g.chooseRemote(sb.repo)).toEqual({ kind: "none" });
    gitIn(sb.repo, "remote", "add", "upstream", "git@github.com:acme/checkout.git");
    expect((await g.chooseRemote(sb.repo)).kind).toBe("ok");
    gitIn(sb.repo, "remote", "add", "fork", "/srv/local/path");
    expect((await g.chooseRemote(sb.repo)).kind).toBe("ambiguous");
    expect(await g.chooseRemote(sb.repo, "fork")).toEqual({ kind: "unrecognised", remote: "fork" });
    // a remote name is never read as an option
    expect(await g.chooseRemote(sb.repo, "--help")).toEqual({ kind: "ambiguous", remotes: ["fork", "upstream"] });
  });

  it("returns null outside a repository and when git exceeds the timeout", async () => {
    sb = sandbox();
    expect(await g.toplevel(sb.home)).toBeNull();
    expect(g.GIT_TIMEOUT_MS).toBe(300);
    const bin = join(sb.dir, "slow-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 2\necho late\n");
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const started = Date.now();
      expect(await g.git(["rev-parse", "HEAD"], sb.repo)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      process.env.PATH = path;
    }
  });
});
