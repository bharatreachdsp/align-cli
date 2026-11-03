/**
 * `align git-hook` (docs/15 §Git hooks): the trailer is added once and only for a recent session, and the commit
 * event drops session ids this laptop never recorded. Temporary HOME and repositories only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTrailers, postCommit, prepareCommitMsg } from "../src/git/run";
import { newState, updateState } from "../src/hook/state";
import { alignPaths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { sessionFor } from "../src/sessions";
import { gitIn, type Sandbox, sandbox } from "./helpers";

let sb: Sandbox;
afterEach(() => sb?.cleanup());

function register(root = sb.repo) {
  upsertRepo(alignPaths(sb.alignHome), root, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(root, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses: [],
    installed_at: new Date().toISOString(),
  });
}

function session(lastSeen: number, root = sb.repo): string {
  const paths = alignPaths(sb.alignHome);
  const id = sessionFor(paths, "claude-code", `hs-${lastSeen}`, lastSeen);
  updateState(paths, id, () => ({
    ...newState({
      id,
      harness: "claude-code",
      harness_session_id: `hs-${lastSeen}`,
      root,
      mode: "hooks",
      transcript_path: null,
      now: lastSeen,
    }),
  }));
  return id;
}

/** The commit event the sandbox's spool holds for HEAD (spool files written in the same millisecond sort randomly). */
function lastEvent() {
  const head = gitIn(sb.repo, "rev-parse", "HEAD");
  const spool = join(sb.alignHome, "spool");
  const dir = join(spool, readdirSync(spool).find((d) => /^[0-9a-f]{16}$/.test(d)) ?? "");
  const events = readdirSync(dir).flatMap(
    (f) => JSON.parse(readFileSync(join(dir, f), "utf8")).events as { kind: string; payload: { sha?: string } }[],
  );
  const found = events.filter((e) => e.kind === "commit" && e.payload.sha === head);
  expect(found).toHaveLength(1);
  // biome-ignore lint/suspicious/noExplicitAny: test-only access to the event's fields
  return found[0] as any;
}

describe("git-hook prepare-commit-msg and post-commit", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");

  it("adds the trailer for the newest recent session once, never for merges or stale sessions", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    session(now - 3 * 60 * 60 * 1000); // too old
    const recent = session(now - 60 * 1000);
    session(now - 10 * 60 * 1000);
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "Use Redis for the cart lock\n\n# Please enter the commit message\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now });
    const once = readFileSync(msg, "utf8");
    expect(once).toContain(`Align-Session: ${recent}`);
    await prepareCommitMsg([msg, "message"], { paths, cwd: sb.repo, now: () => now });
    expect(readFileSync(msg, "utf8")).toBe(once);
    writeFileSync(msg, "Merge branch x\n");
    await prepareCommitMsg([msg, "merge"], { paths, cwd: sb.repo, now: () => now });
    expect(readFileSync(msg, "utf8")).toBe("Merge branch x\n");
    writeFileSync(msg, "later\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now + 5 * 60 * 60 * 1000 });
    expect(readFileSync(msg, "utf8")).toBe("later\n");
  });

  it("does nothing in a repository that is not registered", async () => {
    sb = sandbox();
    session(now);
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "x\n");
    await prepareCommitMsg([msg], { paths: alignPaths(sb.alignHome), cwd: sb.repo, now: () => now });
    expect(readFileSync(msg, "utf8")).toBe("x\n");
    await postCommit({ paths: alignPaths(sb.alignHome), cwd: sb.repo, now: () => now });
    expect(existsSync(join(sb.alignHome, "spool"))).toBe(false);
  });

  it("post-commit spools the commit with its files and trailers; unknown session ids are dropped", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    const known = session(now);
    writeFileSync(join(sb.repo, "lock.ts"), "export {}\n");
    writeFileSync(join(sb.repo, ".env.local"), "X=1\n");
    gitIn(sb.repo, "add", ".");
    const unknown = "0192f6a7-0000-7000-8000-000000000000";
    // what git does: prepare-commit-msg adds this CLI's trailer, the person adds more, then the commit and post-commit
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "Use Redis for the cart lock\n\nDecides: AL-12\n");
    await prepareCommitMsg([msg, "message"], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(readFileSync(msg, "utf8")).toContain(`Align-Session: ${known}`);
    writeFileSync(msg, `${readFileSync(msg, "utf8")}Align-Session: ${unknown}\n`);
    gitIn(sb.repo, "commit", "-q", "-F", msg);
    await postCommit({ paths, cwd: sb.repo, now: () => now });
    expect(existsSync(paths.trailerPending(sb.repo))).toBe(false);
    const dir = join(
      sb.alignHome,
      "spool",
      readdirSync(join(sb.alignHome, "spool")).find((d) => /^[0-9a-f]{16}$/.test(d)) ?? "",
    );
    const [file] = readdirSync(dir);
    const [event] = JSON.parse(readFileSync(join(dir, file as string), "utf8")).events;
    expect(event).toMatchObject({
      kind: "commit",
      harness: { name: "git", hook_event: null },
      session: { id: known },
      payload: {
        sha: gitIn(sb.repo, "rev-parse", "HEAD"),
        files: ["lock.ts"],
        trailers: { Decides: ["AL-12"], "Align-Session": [known] },
      },
    });
    expect(event.payload.message).toContain("Use Redis for the cart lock");
  });

  it("leaves out a file name over 1,024 characters before redaction, and counts it (round 5)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    const deep = join(...Array.from({ length: 5 }, (_, i) => `${String(i)}${"d".repeat(249)}`), "f.ts");
    expect(deep.length).toBeGreaterThan(1024);
    mkdirSync(join(sb.repo, dirname(deep)), { recursive: true });
    writeFileSync(join(sb.repo, deep), "x\n");
    writeFileSync(join(sb.repo, "short.ts"), "x\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-m", "long names");
    await postCommit({ paths, cwd: sb.repo, now: () => now, env: {} });
    const dir = join(
      sb.alignHome,
      "spool",
      readdirSync(join(sb.alignHome, "spool")).find((d) => /^[0-9a-f]{16}$/.test(d)) ?? "",
    );
    const [file] = readdirSync(dir);
    const [event] = JSON.parse(readFileSync(join(dir, file as string), "utf8")).events;
    expect(event.payload.files).toEqual(["short.ts"]);
    expect(readFileSync(join(sb.alignHome, "logs", "align.log"), "utf8")).toMatch(/git path_too_long/);
  });

  it("keeps a session trailer only when this CLI added it for this commit (D472, #94 security review)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    // The person's own session: a teammate copied its id (from one of their pushed commits) into a message.
    const mine = session(now);
    const copied = `Fix the cart\n\nAlign-Session: ${mine}\n`;
    const msg = join(sb.dir, "MSG");
    let n = 0;
    const commit = async (source: string[] | null, at = now) => {
      writeFileSync(join(sb.repo, `f${++n}.ts`), "export {}\n");
      gitIn(sb.repo, "add", ".");
      if (source) await prepareCommitMsg([msg, ...source], { paths, cwd: sb.repo, now: () => at, env: {} });
      gitIn(sb.repo, "commit", "-q", "-F", msg);
      await postCommit({ paths, cwd: sb.repo, now: () => at, env: {} });
      return lastEvent();
    };

    // a squash, an amend / -c / -C (message reuse) and a message given with -m or -F that already names the session
    for (const source of [["squash"], ["commit", "HEAD"], ["message"], ["template"]]) {
      writeFileSync(msg, copied);
      const event = await commit(source);
      expect(event.session.id, source[0]).toBeNull();
      expect(event.payload.trailers["Align-Session"], source[0]).toBeUndefined();
    }
    // no prepare-commit-msg at all (hooks skipped, the commit made by another tool)
    writeFileSync(msg, copied);
    expect((await commit(null)).session.id).toBeNull();

    // an aborted commit's record never vouches for the next commit, which reuses the id
    writeFileSync(msg, "aborted\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(existsSync(paths.trailerPending(sb.repo))).toBe(true);
    writeFileSync(msg, copied);
    expect((await commit(["message"])).session.id).toBeNull();

    // a record made at another HEAD (a commit came in between without the hook) or too long ago
    writeFileSync(msg, "first\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    writeFileSync(join(sb.repo, "between.ts"), "x\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-m", "between");
    writeFileSync(msg, copied);
    expect((await commit(null)).session.id).toBeNull();
    writeFileSync(msg, "late\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(readFileSync(msg, "utf8")).toContain(`Align-Session: ${mine}`);
    writeFileSync(join(sb.repo, "late.ts"), "x\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-F", msg);
    await postCommit({ paths, cwd: sb.repo, now: () => now + 3 * 60 * 60 * 1000, env: {} });
    expect(lastEvent().session.id).toBeNull();

    // the trailer this CLI added for this commit is kept, once; the record is consumed
    writeFileSync(msg, "Fix the cart for real\n");
    const own = await commit([]);
    expect(own.session.id).toBe(mine);
    expect(own.payload.trailers["Align-Session"]).toEqual([mine]);
    expect(existsSync(paths.trailerPending(sb.repo))).toBe(false);
    // amending it keeps its message, trailer included, but the amended commit is not linked again
    writeFileSync(join(sb.repo, "amend.ts"), "x\n");
    gitIn(sb.repo, "add", ".");
    const amended = join(sb.dir, "AMEND");
    writeFileSync(amended, gitIn(sb.repo, "log", "-1", "--format=%B"));
    await prepareCommitMsg([amended, "commit", "HEAD"], { paths, cwd: sb.repo, now: () => now, env: {} });
    gitIn(sb.repo, "commit", "-q", "--amend", "-F", amended);
    await postCommit({ paths, cwd: sb.repo, now: () => now, env: {} });
    const again = lastEvent();
    expect(again.payload.message).toContain(`Align-Session: ${mine}`);
    expect(again.session.id).toBeNull();
    expect(again.payload.trailers["Align-Session"]).toBeUndefined();
  });

  it("prepare-commit-msg clears a copy an earlier post-commit took but could not delete (D472)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    const id = session(now);
    mkdirSync(dirname(paths.trailerPending(sb.repo)), { recursive: true });
    const left = `${paths.trailerPending(sb.repo)}.taken-0123456789ab`;
    writeFileSync(left, JSON.stringify({ id, head: null, at: now }));
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "x\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(existsSync(left)).toBe(false);
    expect(readFileSync(msg, "utf8")).toContain(`Align-Session: ${id}`);
  });

  it("a record that cannot be cleared means no trailer (D472)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    session(now);
    // a directory where the record goes: rmSync without recursive cannot remove it
    mkdirSync(join(paths.trailerPending(sb.repo), "x"), { recursive: true });
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "x\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(readFileSync(msg, "utf8")).toBe("x\n");
    expect(readFileSync(join(sb.alignHome, "logs", "align.log"), "utf8")).toMatch(/git trailer_record_stuck/);
  });

  it("drops a session trailer naming this laptop's session from another repository", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    const elsewhere = session(now, join(sb.dir, "work", "elsewhere"));
    writeFileSync(join(sb.repo, "a.ts"), "export {}\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "commit", "-q", "-m", `copied\n\nAlign-Session: ${elsewhere}`);
    await postCommit({ paths, cwd: sb.repo, now: () => now });
    const dir = join(
      sb.alignHome,
      "spool",
      readdirSync(join(sb.alignHome, "spool")).find((d) => /^[0-9a-f]{16}$/.test(d)) ?? "",
    );
    const [file] = readdirSync(dir);
    const [event] = JSON.parse(readFileSync(join(dir, file as string), "utf8")).events;
    expect(event.session.id).toBeNull();
    expect(event.payload.trailers["Align-Session"]).toBeUndefined();
  });

  it("adds no trailer for amend/-c/-C, or during a cherry-pick, revert or rebase", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    session(now);
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "x\n");
    await prepareCommitMsg([msg, "commit", "HEAD"], { paths, cwd: sb.repo, now: () => now });
    expect(readFileSync(msg, "utf8")).toBe("x\n");
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: { GIT_REFLOG_ACTION: "rebase (pick)" } });
    expect(readFileSync(msg, "utf8")).toBe("x\n");
    for (const f of ["CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      writeFileSync(join(sb.repo, ".git", f), "0".repeat(40));
      await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
      expect(readFileSync(msg, "utf8")).toBe("x\n");
      rmSync(join(sb.repo, ".git", f));
    }
    mkdirSync(join(sb.repo, ".git", "rebase-merge"));
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(readFileSync(msg, "utf8")).toBe("x\n");
    rmSync(join(sb.repo, ".git", "rebase-merge"), { recursive: true });
    await prepareCommitMsg([msg], { paths, cwd: sb.repo, now: () => now, env: {} });
    expect(readFileSync(msg, "utf8")).toContain("Align-Session:");
  });

  it("adds no trailer when rewording a teammate's commit or writing a revert", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    session(now);
    gitIn(sb.repo, "config", "user.email", "me@acme.example");
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "reworded\n");
    await prepareCommitMsg([msg, "message"], {
      paths,
      cwd: sb.repo,
      now: () => now,
      env: { GIT_AUTHOR_EMAIL: "other@globex.example" },
    });
    expect(readFileSync(msg, "utf8")).toBe("reworded\n");
    writeFileSync(msg, 'Revert "x"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.\n');
    await prepareCommitMsg([msg, "message"], {
      paths,
      cwd: sb.repo,
      now: () => now,
      env: { GIT_AUTHOR_EMAIL: "me@acme.example" },
    });
    expect(readFileSync(msg, "utf8")).not.toContain("Align-Session");
    writeFileSync(msg, "mine\n");
    await prepareCommitMsg([msg, "message"], {
      paths,
      cwd: sb.repo,
      now: () => now,
      env: { GIT_AUTHOR_EMAIL: "me@acme.example" },
    });
    expect(readFileSync(msg, "utf8")).toContain("Align-Session");
  });

  it("takes the committer from GIT_COMMITTER_EMAIL when git exports it (round 4, finding 9)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    session(now);
    gitIn(sb.repo, "config", "user.email", "me@acme.example");
    const msg = join(sb.dir, "MSG");
    const run = async (env: Record<string, string>) => {
      writeFileSync(msg, "change\n");
      await prepareCommitMsg([msg, "message"], { paths, cwd: sb.repo, now: () => now, env });
      return readFileSync(msg, "utf8").includes("Align-Session");
    };
    // The environment names both: the configured identity is not the committer.
    expect(await run({ GIT_AUTHOR_EMAIL: "ci@acme.example", GIT_COMMITTER_EMAIL: "ci@acme.example" })).toBe(true);
    expect(await run({ GIT_AUTHOR_EMAIL: "me@acme.example", GIT_COMMITTER_EMAIL: "bot@globex.example" })).toBe(false);
    expect(await run({ GIT_AUTHOR_EMAIL: "me@acme.example" })).toBe(true);
  });

  it("skips the trailer step when ALIGN's part is already late (round 4, finding 7)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    session(now);
    const msg = join(sb.dir, "MSG");
    writeFileSync(msg, "change\n");
    await prepareCommitMsg([msg, "message"], { paths, cwd: sb.repo, now: () => now, env: {}, elapsed: () => 1300 });
    expect(readFileSync(msg, "utf8")).toBe("change\n");
    await prepareCommitMsg([msg, "message"], { paths, cwd: sb.repo, now: () => now, env: {}, elapsed: () => 100 });
    expect(readFileSync(msg, "utf8")).toContain("Align-Session");
  });

  it("spools no commit event for someone else's commit applied here", async () => {
    sb = sandbox();
    register();
    writeFileSync(join(sb.repo, "a.ts"), "export {}\n");
    gitIn(sb.repo, "add", ".");
    gitIn(sb.repo, "-c", "user.name=x", "commit", "-q", "--author", "Other <other@globex.example>", "-m", "theirs");
    await postCommit({ paths: alignPaths(sb.alignHome), cwd: sb.repo, now: () => now, env: {} });
    expect(existsSync(join(sb.alignHome, "spool"))).toBe(false);
  });

  it("a hostile .aligndeny cannot slow the commit hook (62 KB, 500 globs, 200-character paths)", async () => {
    sb = sandbox();
    register();
    const paths = alignPaths(sb.alignHome);
    const glob = (i: number) => `${"**/a*".repeat(4)}${"x".repeat(100)}${i}`;
    const long = `${"a/".repeat(95)}file.ts`;
    mkdirSync(join(sb.repo, dirname(long)), { recursive: true });
    writeFileSync(join(sb.repo, long), "x\n");
    for (const [name, globs] of [
      ["over the caps (fails closed: every path denied)", Array.from({ length: 500 }, (_, i) => glob(i))],
      ["under the caps (the matching budget fails closed)", Array.from({ length: 60 }, (_, i) => glob(i)).slice(0, 60)],
    ] as const) {
      writeFileSync(join(sb.repo, ".aligndeny"), `${globs.join("\n")}\n`);
      gitIn(sb.repo, "add", ".");
      gitIn(sb.repo, "commit", "-q", "--allow-empty", "-m", name);
      const t0 = performance.now();
      await postCommit({ paths, cwd: sb.repo, now: () => now, env: {} });
      expect(performance.now() - t0, name).toBeLessThan(2000);
    }
  });

  it("a Windows path git parsed as a trailer (`C: \\Users\\…`) is not a trailer (lane S)", () => {
    expect(parseTrailers(`Refs: Q-3\nC: \\Users\\riya\\x\nd: ${["", "Users", "riya"].join("/")}/y\n`)).toEqual({
      Refs: ["Q-3"],
    });
  });

  it("parses trailers into lists under their canonical keys", () => {
    expect(parseTrailers("decides: AL-1\nDecides: AL-2\nRefs: Q-3\n")).toEqual({
      Decides: ["AL-1", "AL-2"],
      Refs: ["Q-3"],
    });
  });
});
