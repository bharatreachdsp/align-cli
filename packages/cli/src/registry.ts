/**
 * `~/.align/repos.json`: root path → repository (docs/15 §Files). Every write holds the file lock. A lookup is
 * an exact match on the repository's own root (`git rev-parse --show-toplevel`, symlinks resolved): a nested
 * clone or submodule is a different repository and never inherits its parent's opt-in (AGENTS.md rule 6, D81).
 * A corrupt registry reads as empty (nothing is captured) and is never overwritten.
 */
import { realpathSync, rmSync } from "node:fs";
import { isRecord, isString, isStringArray, recordOf, versionOk } from "./check";
import { readJsonFile, withLock, writeJsonAtomic } from "./fsx";
import type { Paths } from "./paths";

export type RepoEntry = {
  repo_id: string;
  org_id: string;
  remote_norm: string;
  root_commit: string;
  default_branch: string;
  opted_in: boolean;
  harnesses: string[];
  installed_at: string;
};
export type Registry = { version: 1; repos: Record<string, RepoEntry> };

const emptyRegistry = (): Registry => ({ version: 1, repos: {} });

function parseEntry(v: unknown): RepoEntry | null {
  if (!isRecord(v)) return null;
  const { repo_id, org_id, remote_norm, root_commit, default_branch, opted_in, harnesses, installed_at } = v;
  if (![repo_id, org_id, remote_norm, root_commit, default_branch, installed_at].every(isString)) return null;
  if (typeof opted_in !== "boolean" || (harnesses !== undefined && !isStringArray(harnesses))) return null;
  return {
    repo_id: repo_id as string,
    org_id: org_id as string,
    remote_norm: remote_norm as string,
    root_commit: root_commit as string,
    default_branch: default_branch as string,
    opted_in,
    harnesses: harnesses ?? [],
    installed_at: installed_at as string,
  };
}

const parseRegistry = (v: unknown): Registry | null => {
  if (!isRecord(v) || !versionOk(v)) return null;
  const repos = recordOf(v.repos, parseEntry);
  return repos ? { version: 1, repos } : null;
};

/** The registry; a corrupt file reads as empty, so capture stops rather than guesses. */
export function readRegistry(paths: Paths): Registry {
  try {
    return readJsonFile(paths.repos, parseRegistry, emptyRegistry);
  } catch {
    return emptyRegistry();
  }
}

/**
 * The registry for the uploader: a corrupt file throws `CorruptFileError` (the pass stops), so a broken registry is
 * never taken as "nothing registered" and the spool is never deleted because of it.
 */
export function readRegistryStrict(paths: Paths): Registry {
  return readJsonFile(paths.repos, parseRegistry, emptyRegistry);
}

/** Read-modify-write under the lock. A corrupt file throws `CorruptFileError`: it is never overwritten. */
export function updateRegistry(paths: Paths, change: (r: Registry) => void): Registry {
  return withLock(paths.reposLock, () => {
    const r = readJsonFile(paths.repos, parseRegistry, emptyRegistry);
    change(r);
    writeJsonAtomic(paths.repos, r);
    return r;
  });
}

/**
 * Whenever a repository becomes opted in, whatever its spool holds is deleted first (under the registry lock, before
 * the opt-in is written): events captured before an `align off` — including any an in-flight upload wrote back after
 * it — are never sent by a later `align on` or `init` (D241).
 */
function clearSpoolOnOptIn(paths: Paths, root: string, before: RepoEntry | undefined, optedIn: boolean): void {
  if (optedIn && !before?.opted_in) rmSync(paths.spoolFor(root), { recursive: true, force: true });
}

export function upsertRepo(paths: Paths, root: string, entry: RepoEntry): void {
  updateRegistry(paths, (r) => {
    clearSpoolOnOptIn(paths, root, r.repos[root], entry.opted_in);
    r.repos[root] = entry;
  });
}

export function setOptedIn(paths: Paths, root: string, optedIn: boolean): boolean {
  let found = false;
  updateRegistry(paths, (r) => {
    const e = r.repos[root];
    if (e) {
      clearSpoolOnOptIn(paths, root, e, optedIn);
      e.opted_in = optedIn;
      found = true;
    }
  });
  return found;
}

export function removeRepo(paths: Paths, root: string): boolean {
  let found = false;
  updateRegistry(paths, (r) => {
    found = root in r.repos;
    delete r.repos[root];
  });
  return found;
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The entry registered for exactly this repository root (pass `git rev-parse --show-toplevel`; symlinks are
 * resolved), or null. Never a parent's entry: `/src/mono/vendor/lib` (its own clone) is not `/src/mono`.
 */
export function lookupRepo(registry: Registry, toplevel: string): { root: string; entry: RepoEntry } | null {
  const root = canonical(toplevel);
  const entry = registry.repos[root];
  return entry ? { root, entry } : null;
}
