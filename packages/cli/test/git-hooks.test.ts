/**
 * Git hook wrappers (docs/15 §Git hooks): they preserve existing hooks and their exit codes, `core.hooksPath` is
 * left alone, and the exclude lines are added once and removed exactly. Temporary repositories only.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addExcludes, removeExcludes, restoreExcludes } from "../src/git/exclude";
import { gitHooksPlan, installGitHooks, ORIGINAL_SUFFIX, uninstallGitHooks, wrapperScript } from "../src/git/install";
import { gitIn, type Sandbox, sandbox } from "./helpers";

let sb: Sandbox;
afterEach(() => sb?.cleanup());

const hooksDir = () => join(sb.repo, ".git", "hooks");
/**
 * After the runs, what of this process group is still sleeping: polled for up to 1.5 s, because a busy machine may take
 * a moment; the watcher's own sleeps last 0.1 s, so any sleep still there at 1.5 s was left behind.
 */
const settle = `n=0; while [ $n -lt 15 ]; do left=$(ps -eo pgid=,ppid=,args= | awk -v g=$$ '$1 == g && $3 == "sleep" { print }'); [ -z "$left" ] && break; sleep 0.1; n=$((n+1)); done; printf '%s' "$left"`;

describe("git hook wrappers", () => {
  it("keep the original hook, run it with the same arguments and return its exit code", () => {
    sb = sandbox();
    const original = join(hooksDir(), "prepare-commit-msg");
    writeFileSync(original, `#!/bin/sh\necho "$@" > "${sb.dir}/args"\nexit 3\n`);
    chmodSync(original, 0o755);
    const calls = join(sb.dir, "calls");
    const shim = join(sb.dir, "fake-shim");
    writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${calls}"\nexit 9\n`);
    chmodSync(shim, 0o755);
    installGitHooks(hooksDir(), shim);
    expect(existsSync(`${original}${ORIGINAL_SUFFIX}`)).toBe(true);
    const r = spawnSync(original, ["MSGFILE", "message"], { encoding: "utf8" });
    expect(r.status).toBe(3);
    expect(r.stdout + r.stderr).toBe("");
    expect(readFileSync(join(sb.dir, "args"), "utf8").trim()).toBe("MSGFILE message");
    expect(readFileSync(calls, "utf8").trim()).toBe("git-hook prepare-commit-msg MSGFILE message");
    // Without an original the wrapper succeeds even when ALIGN's part fails.
    const post = spawnSync(join(hooksDir(), "post-commit"), [], { encoding: "utf8" });
    expect(post.status).toBe(0);
  });

  it("kills ALIGN's part after 2 s and still runs the original hook with its exit code", () => {
    sb = sandbox();
    const original = join(hooksDir(), "post-commit");
    writeFileSync(original, "#!/bin/sh\nexit 4\n");
    chmodSync(original, 0o755);
    const shim = join(sb.dir, "slow-shim");
    writeFileSync(shim, "#!/bin/sh\nsleep 30\n");
    chmodSync(shim, 0o755);
    installGitHooks(hooksDir(), shim);
    const t0 = performance.now();
    const r = spawnSync(original, [], { encoding: "utf8" });
    const ms = performance.now() - t0;
    expect(r.status).toBe(4);
    expect(ms).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(4000);
  });

  it("leaves no watcher sleep behind when ALIGN's part finishes early (round 4, finding 7)", async () => {
    sb = sandbox();
    const shim = join(sb.dir, "fast-shim");
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
    installGitHooks(hooksDir(), shim);
    // The wrapper runs in its own process group; afterwards nothing of that group may be left running.
    const script = `"$1"; ${settle}`;
    const child = spawn("sh", ["-c", script, "sh", join(hooksDir(), "post-commit")], { detached: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
    expect(readFileSync(join(hooksDir(), "post-commit"), "utf8")).toContain('d="${0%/*}"');
  });

  it("runs the original when git calls the hook by a bare name (round 5)", () => {
    sb = sandbox();
    const original = join(hooksDir(), "post-commit");
    writeFileSync(original, "#!/bin/sh\nexit 5\n");
    chmodSync(original, 0o755);
    const shim = join(sb.dir, "fast-shim");
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
    installGitHooks(hooksDir(), shim);
    const r = spawnSync("sh", ["post-commit"], { cwd: hooksDir(), encoding: "utf8" });
    expect(r.status).toBe(5);
  });

  it("the watcher never leaves its sleep behind over 150 back-to-back runs (round 5, TERM race)", async () => {
    sb = sandbox();
    const shim = join(sb.dir, "fast-shim");
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
    installGitHooks(hooksDir(), shim);
    // 150 runs in one process group, each stopping the watcher as early as it can; then nothing may be left.
    const script = `i=0; while [ $i -lt 150 ]; do "$1"; i=$((i+1)); done; ${settle}`;
    const child = spawn("sh", ["-c", script, "sh", join(hooksDir(), "post-commit")], { detached: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  }, 60_000);

  it("with a sleep that takes whole seconds only, ALIGN's part still gets its 2 s (#43 chain re-review)", () => {
    sb = sandbox();
    const original = join(hooksDir(), "post-commit");
    writeFileSync(original, "#!/bin/sh\nexit 4\n");
    chmodSync(original, 0o755);
    const real = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    const bin = join(sb.dir, "bin");
    mkdirSync(bin);
    // A POSIX-only sleep: a fractional argument is an error.
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\ncase "$1" in *.*) exit 1 ;; esac\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "sleep"), 0o755);
    const shim = join(sb.dir, "slow-shim");
    writeFileSync(shim, "#!/bin/sh\nsleep 30\n");
    chmodSync(shim, 0o755);
    installGitHooks(hooksDir(), shim);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const t0 = performance.now();
    const r = spawnSync(original, [], { encoding: "utf8", env });
    const ms = performance.now() - t0;
    expect(r.status).toBe(4);
    expect(ms).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(4500);
    // A fast part still returns at once, and the watcher leaves within its one-second step.
    const fast = join(sb.dir, "fast-shim");
    writeFileSync(fast, "#!/bin/sh\nexit 0\n");
    chmodSync(fast, 0o755);
    installGitHooks(hooksDir(), fast);
    const t1 = performance.now();
    expect(spawnSync(original, [], { encoding: "utf8", env }).status).toBe(4);
    expect(performance.now() - t1).toBeLessThan(1500);
  });

  it("install is idempotent and uninstall restores the originals byte for byte", () => {
    sb = sandbox();
    const original = join(hooksDir(), "post-commit");
    const body = "#!/bin/sh\nexit 0\n";
    writeFileSync(original, body);
    chmodSync(original, 0o755);
    const before = readdirSync(hooksDir()).sort();
    installGitHooks(hooksDir(), "/x/.align/bin/align");
    installGitHooks(hooksDir(), "/x/.align/bin/align");
    expect(readFileSync(original, "utf8")).toBe(wrapperScript("/x/.align/bin/align", "post-commit"));
    expect(readFileSync(`${original}${ORIGINAL_SUFFIX}`, "utf8")).toBe(body);
    expect(uninstallGitHooks(hooksDir()).sort()).toEqual(["post-commit", "prepare-commit-msg"]);
    expect(readFileSync(original, "utf8")).toBe(body);
    expect(readdirSync(hooksDir()).sort()).toEqual(before);
  });

  it("leaves core.hooksPath alone", async () => {
    sb = sandbox();
    gitIn(sb.repo, "config", "core.hooksPath", ".husky");
    expect(await gitHooksPlan(sb.repo)).toEqual({ kind: "hooks_path", path: ".husky" });
  });
});

describe(".git/info/exclude", () => {
  it("adds missing lines once and gives back the exact bytes, also without a final newline or a file", () => {
    sb = sandbox();
    const file = join(sb.repo, ".git", "info", "exclude");
    for (const before of [readFileSync(file, "utf8"), "*.log", null]) {
      if (before === null) rmSync(file, { force: true });
      else writeFileSync(file, before);
      const change = addExcludes(file, ["/.claude/settings.local.json"]);
      expect(change?.added).toEqual(["/.claude/settings.local.json"]);
      expect(addExcludes(file, ["/.claude/settings.local.json"])).toBeNull();
      expect(readFileSync(file, "utf8").match(/settings\.local\.json/g)).toHaveLength(1);
      if (change) restoreExcludes(file, change);
      if (before === null) expect(existsSync(file)).toBe(false);
      else expect(readFileSync(file, "utf8")).toBe(before);
    }
  });

  it("removes only its own lines from a file edited since", () => {
    sb = sandbox();
    const file = join(sb.repo, ".git", "info", "exclude");
    writeFileSync(file, "a\n");
    const change = addExcludes(file, ["/x"]);
    writeFileSync(file, `${readFileSync(file, "utf8")}mine\n`);
    if (change) restoreExcludes(file, change);
    expect(readFileSync(file, "utf8")).toBe("a\nmine\n");
    expect(removeExcludes(file, ["/absent"])).toEqual([]);
  });
});
