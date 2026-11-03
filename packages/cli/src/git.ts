/**
 * Git facts for a working tree (docs/15 `init` step 1). Each call runs `git` with a 300 ms timeout, no
 * prompts and the C locale, and returns null on any failure: callers decide what a missing fact means.
 */
import { execFile } from "node:child_process";
import { normalizeRemote } from "@align/core/remote";

export const GIT_TIMEOUT_MS = 300;

export function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (err, stdout) => resolve(err ? null : stdout.toString().trim()),
    );
  });
}

/** Timeouts: 300 ms on hook paths (they must never slow a harness); `init` and other commands use 10 s. */
export const INTERACTIVE_GIT_TIMEOUT_MS = 10_000;

export const toplevel = (cwd: string, timeoutMs = GIT_TIMEOUT_MS) =>
  git(["rev-parse", "--show-toplevel"], cwd, timeoutMs);

export const head = (cwd: string, timeoutMs = GIT_TIMEOUT_MS) =>
  git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd, timeoutMs);

/** The current branch name, or null on a detached head. */
export async function branch(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  const b = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, timeoutMs);
  return b || null;
}

/** The lexicographically first root commit (`git rev-list --max-parents=0 HEAD`). */
export async function rootCommit(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  const out = await git(["rev-list", "--max-parents=0", "HEAD"], cwd, timeoutMs);
  if (!out) return null;
  return (
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()[0] ?? null
  );
}

/** `refs/remotes/<remote>/HEAD`, else `main`, else `master` (when such a branch exists), else `main`. */
export async function defaultBranch(cwd: string, remote = "origin", timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const ref = await git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], cwd, timeoutMs);
  const prefix = `refs/remotes/${remote}/`;
  if (ref?.startsWith(prefix)) return ref.slice(prefix.length);
  for (const name of ["main", "master"]) {
    const local = await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd, timeoutMs);
    const tracked = await git(["show-ref", "--verify", "--quiet", `${prefix}${name}`], cwd, timeoutMs);
    if (local !== null || tracked !== null) return name;
  }
  return "main";
}

export type RemoteChoice =
  | { kind: "ok"; remote: string; remote_norm: string }
  | { kind: "none" }
  | { kind: "ambiguous"; remotes: string[] }
  | { kind: "unrecognised"; remote: string };

/** `origin` when it exists; otherwise the only remote; otherwise ambiguous (the caller asks). */
export async function chooseRemote(cwd: string, preferred?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<RemoteChoice> {
  const list = await git(["remote"], cwd, timeoutMs);
  const remotes = (list ?? "")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  const name = preferred ?? (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined);
  if (remotes.length === 0) return { kind: "none" };
  if (!name || !remotes.includes(name)) return { kind: "ambiguous", remotes };
  // `--` so a remote name can never be read as an option.
  const url = await git(["remote", "get-url", "--", name], cwd, timeoutMs);
  const norm = url ? normalizeRemote(url) : null;
  return norm ? { kind: "ok", remote: name, remote_norm: norm } : { kind: "unrecognised", remote: name };
}
