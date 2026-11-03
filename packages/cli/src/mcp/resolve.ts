/**
 * Which repository, organisation and server an MCP tool call is about (docs/14 §Agent tools): the server process's
 * working directory, else `--cwd`, else the tool's `repo_path` argument. Each is tried as the root of a repository
 * `align init` registered, an exact match (`lookupRepo`, D81). The first one found gives the request's
 * `{remote_norm, root_commit}`, the branch, and the organisation, whose credential record names the server and the
 * token. Nothing comes from the environment: `align mcp` is an internal entry point (D402 (g), D416).
 *
 * When no directory resolves, the model's `repo` (`owner/name` or a `remote_norm`) is matched against the registry
 * first. If that fails and exactly one organisation is signed in, it goes to that organisation's server, which
 * resolves the name among the repositories the person can read. Otherwise the call asks for `repo_path`.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { normalizeRemote } from "@align/core/remote";
import { CredentialStore, defaultKeychain, type Keychain } from "../credentials";
import { type RepoFacts, repoFacts } from "../hook/home";
import type { Paths } from "../paths";
import { lookupRepo, type RepoEntry, readRegistry } from "../registry";

export type Target = {
  orgId: string;
  server: string;
  token: string;
  /** Set when a registered repository was found on this laptop. */
  local: { root: string; entry: RepoEntry; facts: RepoFacts } | null;
  /** Set when the model's `repo` named exactly one opted-in registry entry: the request carries its identity. */
  named?: RepoEntry;
};

/** `opted_out`: the repository is registered here but the person turned capture off (`align off`, hard rule 6). */
export type ResolveFailure = "no_repo" | "signed_out" | "unknown_repo" | "opted_out";

export type ResolveInput = {
  paths: Paths;
  keychain?: Keychain | null;
  /** The server process's own working directory, then `--cwd`, then (reads only) the tool's `repo_path`. */
  dirs: (string | undefined)[];
  /** The model's `repo` (reads only; the writes go only to the repository the agent runs in, D420). */
  argRepo?: string;
};

const SHA = /^[0-9a-f]{40,64}$/;

async function registered(paths: Paths, dir: string | undefined) {
  if (!dir || !isAbsolute(dir) || !existsSync(dir)) return null;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return null;
  }
  const facts = await repoFacts(real);
  if (!facts) return null;
  const found = lookupRepo(readRegistry(paths), facts.toplevel);
  return found ? { ...found, facts } : null;
}

export async function resolveTarget(input: ResolveInput): Promise<Target | ResolveFailure> {
  const store = new CredentialStore(input.paths, input.keychain === undefined ? defaultKeychain({}) : input.keychain);
  const withOrg = (orgId: string, local: Target["local"], named?: RepoEntry): Target | ResolveFailure => {
    const meta = store.list().find((m) => m.org.id === orgId);
    const token = meta ? store.tokenFor(orgId, meta.server) : null;
    return meta && token ? { orgId, server: meta.server, token, local, ...(named ? { named } : {}) } : "signed_out";
  };
  for (const dir of input.dirs) {
    const found = await registered(input.paths, dir);
    // A repository the person opted out of here answers nothing and sends nothing, whatever the server would say.
    if (found) return found.entry.opted_in ? withOrg(found.entry.org_id, found) : "opted_out";
  }
  if (!input.argRepo) return "no_repo";
  const want = normaliseRepoName(input.argRepo);
  const named = Object.values(readRegistry(input.paths).repos).filter(
    (e) => e.remote_norm === want || e.remote_norm.endsWith(`/${want}`),
  );
  if (named.length > 0) {
    // Several clones of one repository are one match; anything else is ambiguous, and so is a mix with an opted-out one.
    const distinct = new Set(named.map((e) => `${e.org_id} ${e.remote_norm}`));
    if (distinct.size > 1) return "unknown_repo";
    if (named.every((e) => e.opted_in)) return withOrg((named[0] as RepoEntry).org_id, null, named[0]);
    return named.length === 1 ? "opted_out" : "unknown_repo";
  }
  const signedIn = store.list();
  if (signedIn.length === 1 && signedIn[0]) return withOrg(signedIn[0].org.id, null);
  return signedIn.length === 0 ? "signed_out" : "unknown_repo";
}

/**
 * The model's `repo` as a registry key: a URL or scp form through `normalizeRemote`, a `host/owner/name` as a URL
 * would normalise, else `owner/name` lower-cased.
 */
export function normaliseRepoName(raw: string): string {
  const t = raw.trim();
  const direct = normalizeRemote(t);
  if (direct) return direct;
  if (/^[^/]+\.[^/]+\//.test(t)) return normalizeRemote(`https://${t}`) ?? t.toLowerCase();
  return t.toLowerCase().replace(/\.git$/, "");
}

/** `{remote_norm, root_commit}` for the request, from the registry entry. */
export function requestRepo(entry: RepoEntry): { remote_norm: string; root_commit?: string } {
  return { remote_norm: entry.remote_norm, ...(SHA.test(entry.root_commit) ? { root_commit: entry.root_commit } : {}) };
}
