/**
 * Self-install (docs/15 `init` step 2): copy the running bundle to `~/.align/lib/align-<version>.mjs`, point
 * `~/.align/lib/align.mjs` at it (a relative symlink swapped atomically), and write the shim
 * `~/.align/bin/align` (0755) that runs it with the absolute `node` recorded now, falling back to `node`
 * on PATH. Hook commands only ever name the shim, so updates never change them.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { ensureDir, writeFileAtomic } from "./fsx";
import type { Paths } from "./paths";
import { UPLOADER_ENV } from "./upload/lock";

/** The entry points the shim starts with a cleared environment (internal.ts dispatches the same names). */
export const INTERNAL_ENTRY_POINTS = ["hook", "git-hook", "upload", "flush", "pack", "mcp"] as const;

/**
 * What they keep: the uploader's allow-list (upload/lock.ts), the git and compile cache the shim set, and the few
 * variables the hooks read (Cursor's guard and project directory, Codex's home, git's author and reflog action).
 * Never `HOME` or `XDG_CONFIG_HOME`: git would read its configuration (and the commands it names) from there; the
 * bundle takes the home from the password database instead (L16 review round 4, D276).
 */
export const SHIM_ENV_ALLOW = [
  ...UPLOADER_ENV,
  "ALIGN_GIT",
  "NODE_COMPILE_CACHE",
  "CURSOR_VERSION",
  "CURSOR_PROJECT_DIR",
  "CODEX_HOME",
  "GIT_AUTHOR_EMAIL",
  "GIT_REFLOG_ACTION",
] as const;

/** POSIX single-quoting: safe for any path, including spaces, quotes and `$`. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function shimScript(nodePath: string, bundle: string, compileCache?: string, gitPath?: string): string {
  return [
    "#!/bin/sh",
    `# ${CLI_BIN} shim: written by \`${CLI_BIN} init\`; hooks call this file, so its path never changes.`,
    `NODE=${shQuote(nodePath)}`,
    `[ -x "$NODE" ] || NODE=node`,
    // Options a repository's harness configuration could set for its hooks never reach node.
    "unset NODE_OPTIONS NODE_PATH",
    // The git found at init, so the hooks do not depend on the PATH a harness gives them.
    ...(gitPath ? [`ALIGN_GIT=${shQuote(gitPath)}`, "export ALIGN_GIT"] : ["unset ALIGN_GIT"]),
    // Node's on-disk compile cache (user-only, inside ~/.align) keeps hook start-up short (docs/15 §Guarantees 2).
    // Never one the harness's environment names: the cache holds code node runs.
    ...(compileCache
      ? [`NODE_COMPILE_CACHE=${shQuote(compileCache)}`, "export NODE_COMPILE_CACHE"]
      : ["unset NODE_COMPILE_CACHE"]),
    // The internal entry points hold tokens and run in a harness's environment, which a repository can set (for
    // Claude Code, `.claude/settings.json` `env`): proxies (NODE_USE_ENV_PROXY, HTTPS_PROXY, …), extra CAs, TLS
    // opt-outs. They start from an empty environment with only this allow-list (L16 review round 3).
    'case "${1-}" in',
    `  ${INTERNAL_ENTRY_POINTS.join("|")})`,
    `    exec /usr/bin/env -i ${SHIM_ENV_ALLOW.map((k) => `\${${k}+"${k}=$${k}"}`).join(" ")} "$NODE" ${shQuote(bundle)} "$@" ;;`,
    "esac",
    `exec "$NODE" ${shQuote(bundle)} "$@"`,
    "",
  ].join("\n");
}

/** True for a file that looks like our bundle (`align.mjs` or `align-<version>.mjs`). */
export function isBundlePath(path: string | null): path is string {
  if (!path) return false;
  const name = basename(path);
  return (
    (name === `${CLI_BIN}.mjs` || /^[a-z]+-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.mjs$/.test(name)) && existsSync(path)
  );
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export type InstallResult = { shim: string; bundle: string; copied: boolean };

export function installShim(
  paths: Paths,
  opts: { bundleSource: string; nodePath: string; version: string; gitPath?: string },
): InstallResult {
  ensureDir(paths.home);
  ensureDir(paths.bin);
  ensureDir(paths.lib);
  const target = paths.bundle(opts.version);
  const source = realpathSync(opts.bundleSource);
  let copied = false;
  if (!existsSync(target) || (realpathSync(target) !== source && sha256File(target) !== sha256File(source))) {
    const tmp = `${target}.${process.pid}.tmp`;
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o644);
    renameSync(tmp, target);
    copied = true;
  }
  const linkTarget = basename(target);
  let current: string | null = null;
  try {
    current = readlinkSync(paths.current);
  } catch {
    current = null;
  }
  if (current !== linkTarget) {
    const tmpLink = `${paths.current}.${process.pid}.tmp`;
    rmSync(tmpLink, { force: true });
    symlinkSync(linkTarget, tmpLink);
    renameSync(tmpLink, paths.current);
  }
  ensureDir(paths.compileCache);
  writeFileAtomic(paths.shim, shimScript(opts.nodePath, paths.current, paths.compileCache, opts.gitPath), 0o755);
  return { shim: paths.shim, bundle: target, copied };
}

/** Which installed bundle `align.mjs` points at, or null. */
export function installedBundle(paths: Paths): string | null {
  try {
    return realpathSync(paths.current);
  } catch {
    return null;
  }
}

/** The absolute path of the first executable `git` on `PATH`, or undefined. */
export function findGit(pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir.startsWith("/")) continue;
    const p = `${dir.replace(/\/+$/, "")}/git`;
    try {
      accessSync(p, constants.X_OK);
      // The path as found, not resolved: a package manager's upgrade moves the real file, not the link.
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
}
