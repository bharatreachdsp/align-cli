/**
 * Installs and removes the `prepare-commit-msg` and `post-commit` wrappers (docs/15 §Git hooks).
 *
 * An existing hook is renamed `<name>.pre-align`; the wrapper runs ALIGN's part (output discarded, exit code
 * ignored) and then execs the original with the same arguments, so the original's exit code is the hook's.
 * A wrapper is recognised by its marker line and rewritten in place on a re-run (idempotent). When
 * `core.hooksPath` is set (Husky, lefthook), nothing is touched and the caller prints the line to add.
 * `uninstall` removes only ALIGN's wrappers and puts the originals back.
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CLI_BIN, ORIGINAL_HOOK_SUFFIX } from "@align/core/brand";
import { writeUserFileAtomic } from "../fsx";
import { git, INTERACTIVE_GIT_TIMEOUT_MS } from "../git";
import { shQuote } from "../shim";

export const GIT_HOOKS = ["prepare-commit-msg", "post-commit"] as const;
export type GitHookName = (typeof GIT_HOOKS)[number];
export const WRAPPER_MARKER = `# ${CLI_BIN}-git-hook-wrapper v1`;
export const ORIGINAL_SUFFIX = ORIGINAL_HOOK_SUFFIX;

/** The line a hook manager needs to call ALIGN's part itself. */
export const hookManagerLine = (shim: string, name: GitHookName) =>
  `${shQuote(shim)} git-hook ${name} "$@" >/dev/null 2>&1 || true`;

/** Seconds ALIGN's part of a git hook may take before the wrapper kills it. */
export const GIT_HOOK_LIMIT_S = 2;

export function wrapperScript(shim: string, name: GitHookName): string {
  return [
    "#!/bin/sh",
    WRAPPER_MARKER,
    `# Written by \`${CLI_BIN} init\`; \`${CLI_BIN} uninstall\` removes it and restores ${name}${ORIGINAL_SUFFIX} if present.`,
    // ALIGN's part runs as a child that is killed after 2 s whatever it is doing (docs/15 §Git hooks, D94); its
    // output and exit code are ignored. ALIGN stops its own git steps by 1.5 s (git/run.ts), so no git child of it
    // is still writing when the original hook runs.
    `${shQuote(shim)} git-hook ${name} "$@" </dev/null >/dev/null 2>&1 &`,
    "align_pid=$!",
    // The watcher polls in steps of 0.1 s and leaves as soon as ALIGN's part has exited, so it never needs a long
    // `sleep` that could outlive it; stopping it early can orphan at most one 0.1 s sleep (L12 review round 5).
    // A `sleep` that takes whole seconds only (POSIX allows no fraction) fails at once on `0.1`: the watcher then steps in
    // seconds, so ALIGN's part still gets its 2 s rather than being killed at once (#43 chain re-review).
    `( n=${GIT_HOOK_LIMIT_S * 10}; s=0.1; sleep 0.1 2>/dev/null || { n=${GIT_HOOK_LIMIT_S}; s=1; sleep 1; }; i=1; while kill -0 "$align_pid" 2>/dev/null; do [ "$i" -ge "$n" ] && { kill -9 "$align_pid"; exit 0; }; sleep "$s"; i=$((i+1)); done ) </dev/null >/dev/null 2>&1 &`,
    "align_watch=$!",
    'wait "$align_pid" 2>/dev/null',
    'kill "$align_watch" 2>/dev/null',
    // `$0` is the hook's path as git ran it; a bare name (no slash) means the current directory.
    'case "$0" in */*) d="${0%/*}" ;; *) d=. ;; esac',
    `original="$d/${name}${ORIGINAL_SUFFIX}"`,
    `if [ -x "$original" ]; then exec "$original" "$@"; fi`,
    "exit 0",
    "",
  ].join("\n");
}

const isWrapper = (path: string) => {
  try {
    return readFileSync(path, "utf8").includes(WRAPPER_MARKER);
  } catch {
    return false;
  }
};

export type GitHooksPlan = { kind: "hooks_dir"; dir: string } | { kind: "hooks_path"; path: string } | { kind: "none" };

/** Where the hooks go: `core.hooksPath` set → leave it to the hook manager; else the repository's hooks dir. */
export async function gitHooksPlan(root: string): Promise<GitHooksPlan> {
  const hooksPath = await git(["config", "--get", "core.hooksPath"], root, INTERACTIVE_GIT_TIMEOUT_MS);
  if (hooksPath) return { kind: "hooks_path", path: hooksPath };
  const dir = await git(["rev-parse", "--git-path", "hooks"], root, INTERACTIVE_GIT_TIMEOUT_MS);
  if (!dir) return { kind: "none" };
  return { kind: "hooks_dir", dir: isAbsolute(dir) ? dir : join(root, dir) };
}

export type HookInstall = { name: GitHookName; preserved: boolean; skipped?: "original_exists" };

export function installGitHooks(dir: string, shim: string): HookInstall[] {
  const out: HookInstall[] = [];
  for (const name of GIT_HOOKS) {
    const path = join(dir, name);
    const original = `${path}${ORIGINAL_SUFFIX}`;
    let preserved = existsSync(original);
    if (existsSync(path) && !isWrapper(path)) {
      // Someone else's hook. Never overwrite an earlier saved original.
      if (existsSync(original)) {
        out.push({ name, preserved: true, skipped: "original_exists" });
        continue;
      }
      renameSync(path, original);
      preserved = true;
    }
    writeUserFileAtomic(path, wrapperScript(shim, name), 0o755);
    out.push({ name, preserved });
  }
  return out;
}

export function uninstallGitHooks(dir: string): GitHookName[] {
  const removed: GitHookName[] = [];
  for (const name of GIT_HOOKS) {
    const path = join(dir, name);
    if (!isWrapper(path)) continue;
    rmSync(path, { force: true });
    const original = `${path}${ORIGINAL_SUFFIX}`;
    if (existsSync(original)) renameSync(original, path);
    removed.push(name);
  }
  return removed;
}

/** For doctor: both wrappers present and naming this shim. */
export function gitHooksInstalled(dir: string, shim: string): boolean {
  return GIT_HOOKS.every((name) => {
    try {
      const body = readFileSync(join(dir, name), "utf8");
      return body.includes(WRAPPER_MARKER) && body.includes(shQuote(shim));
    } catch {
      return false;
    }
  });
}
