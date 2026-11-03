/**
 * Where the internal entry points (`hook`, `git-hook`, `upload`) find `~/.align`, and how they run git.
 *
 * A repository's harness configuration can set environment variables for the hooks it runs (Claude Code's
 * `env` setting, for one), so these entry points never read `ALIGN_HOME`, `HOME` or `ALIGN_SERVER`: the home is
 * the directory the running bundle was installed into (`<home>/lib/align-<version>.mjs`, next to
 * `<home>/bin/align`), else the account's home from the password database. A repository therefore cannot point
 * capture at a registry, spool or credential file of its choosing (L11 review, lead's note in L12). Git runs with
 * every `GIT_*` variable removed, so `GIT_DIR` or `GIT_WORK_TREE` cannot make one repository look like another, and
 * with `HOME` taken from the password database and `XDG_CONFIG_HOME` removed, so a repository cannot hand git a
 * configuration of its own (an `fsmonitor` or hooks path is a command git runs; L16 review round 4, D276). Its
 * read-only calls also switch off the commands a repository's own `.git/config` could name (`HOOK_GIT_CONFIG`).
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CLI_BIN, HOME_DIR_NAME } from "@align/core/brand";
import { GIT_TIMEOUT_MS } from "../git";

/** The installation home a bundle at `bundlePath` belongs to, or null when it is not an installed bundle. */
export function homeOfBundle(bundlePath: string | null | undefined): string | null {
  if (!bundlePath) return null;
  let real: string;
  try {
    real = realpathSync(bundlePath);
  } catch {
    return null;
  }
  const lib = dirname(real);
  if (basename(lib) !== "lib") return null;
  const home = dirname(lib);
  return existsSync(join(home, "bin", CLI_BIN)) ? home : null;
}

/**
 * The home for internal entry points. `override` exists for in-process tests only (the source is not an
 * installed bundle); it is a function argument, never an environment variable.
 */
export function internalHome(bundlePath: string | null | undefined, override?: string): string {
  if (override) return override;
  return homeOfBundle(bundlePath) ?? join(userInfo().homedir, HOME_DIR_NAME);
}

/**
 * The account's home from the password database, never from `HOME` (which a harness's `env` setting can change), or
 * undefined when there is no entry (a container with an arbitrary uid): then git and the uploader get no home at all.
 */
export function accountHome(): string | undefined {
  try {
    const h = userInfo().homedir;
    return h && isAbsolute(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

/** Variables that tell git (or a program it starts) where to find configuration: never taken from the caller. */
const CONFIG_LOCATION = new Set(["HOME", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS"]);

/**
 * The environment git gets on hook paths: no `GIT_*` from the caller, the account's real home (so `~/.gitconfig` is
 * the person's own), no XDG configuration directory, no prompts, the C locale. The system file (`/etc/gitconfig`) is
 * root's and stays (D276).
 */
export function gitEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string | null = accountHome() ?? null,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_") && !CONFIG_LOCATION.has(k)) out[k] = v;
  return { ...out, ...(home ? { HOME: home } : {}), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/**
 * Prepended to every hook-path git call: the commands a configuration file can make a read-only call run are off,
 * whichever file names them, the repository's own `.git/config` included (a crafted repository opened from an
 * archive carries one). `-c` reaches the git processes a call starts for submodules as well (D276).
 */
export const HOOK_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "log.showSignature=false",
] as const;

/**
 * The git the shim recorded at init (`ALIGN_GIT`, set by the shim itself, absolute and present), else the system's
 * `/usr/bin/git`, else none: the hook paths then skip git. Never a `git` found on PATH, which a harness's `env` (a
 * repository's `.claude/settings.json`) can point at a directory it ships (L16 final round, D276).
 */
export function gitBinary(
  env: NodeJS.ProcessEnv = process.env,
  fallbacks: readonly string[] = ["/usr/bin/git"],
): string | null {
  const g = env.ALIGN_GIT;
  if (g && isAbsolute(g) && existsSync(g)) return g;
  return fallbacks.find((f) => isAbsolute(f) && existsSync(f)) ?? null;
}

/** Runs git on a hook path (300 ms, sanitised environment); `input` goes to its stdin. Null on any failure. */
export function hookGit(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  input?: string,
): Promise<string | null> {
  const git = gitBinary();
  if (!git) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(
      git,
      [...HOOK_GIT_CONFIG, ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: gitEnv() },
      (err, stdout) => resolve(err ? null : stdout.toString()),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

export type RepoFacts = { toplevel: string; head: string | null; branch: string | null };

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The repository root (symlinks resolved), HEAD and branch in one `git rev-parse` (300 ms). A repository with
 * no commits yet answers with the root alone.
 */
export async function repoFacts(cwd: string): Promise<RepoFacts | null> {
  if (!cwd || !existsSync(cwd)) return null;
  const out = await hookGit(["rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"], cwd);
  let top: string | null = null;
  let head: string | null = null;
  let branch: string | null = null;
  if (out !== null) {
    const [t, h, b] = out.split("\n");
    top = t?.trim() || null;
    head = h && SHA.test(h.trim()) ? h.trim() : null;
    branch = b && b.trim() !== "HEAD" ? b.trim() : null;
  } else {
    top = (await hookGit(["rev-parse", "--show-toplevel"], cwd))?.trim() || null;
  }
  if (!top) return null;
  try {
    return { toplevel: realpathSync(top), head, branch };
  } catch {
    return null;
  }
}
