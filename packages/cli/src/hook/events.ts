/**
 * Builds trace events (docs/10 §Envelope, schema version 2), redacts them on the laptop with
 * `@align/core/redact` (`redactEvent`: allow-listed fields, secrets, code blocks, paths, deny globs) and writes
 * them to the spool, one file per invocation, atomically (docs/15 §Files). Nothing reaches the spool without
 * passing through `redactEvent`.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, relative } from "node:path";
import { uuidv7 } from "@align/core/ids";
import { machineId, parseDenyGlobs, type RedactionContext, redactEvent } from "@align/core/redact";
import { readConfig } from "../config";
import { writeFileAtomic, writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";
import type { RepoEntry } from "../registry";
import type { RepoFacts } from "./home";

export const SCHEMA_VERSION = 2;

export type Kind = "session.start" | "session.stop" | "session.end" | "transcript.chunk" | "commit";

export type Harness = { name: string; version?: string | null; session_id: string | null; hook_event: string | null };

export type Repo = { root: string; entry: RepoEntry; facts: RepoFacts };

export type TraceEvent = {
  schema_version: number;
  event_id: string;
  ts: string;
  kind: Kind;
  harness: Record<string, unknown>;
  session: { id: string | null };
  repo: { remote_norm: string; root_commit: string; branch: string | null; head: string | null };
  cwd_rel: string | null;
  machine_id: string | null;
  capture: "live" | "backfill";
  payload: Record<string, unknown>;
  redaction?: { version: number; hits?: Record<string, number> };
};

/** The per-installation salt (created on first use, 0600). */
export function salt(paths: Paths): string {
  try {
    const s = readFileSync(paths.salt, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  } catch {
    // first use
  }
  const s = randomBytes(32).toString("hex");
  writeFileAtomic(paths.salt, `${s}\n`);
  return s;
}

/**
 * A deny file (`.aligndeny` is committed to the repository, so it is untrusted) is used only as a regular file
 * (never through a symbolic link) of at most 64 KB, 500 globs and 8 KB of glob text. One that is not fails closed:
 * every path is denied (paths are only removed from events, never added), and doctor reports it.
 */
export const MAX_DENY_BYTES = 64 * 1024;
export const MAX_DENY_GLOBS = 500;
export const MAX_DENY_GLOB_BYTES = 8 * 1024;
export const DENY_ALL = "**";

export function readDenyFile(p: string): { globs: string[]; usable: boolean } {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return { globs: [], usable: true };
  }
  try {
    if (!st.isFile() || st.size > MAX_DENY_BYTES) return { globs: [DENY_ALL], usable: false };
    const globs = parseDenyGlobs(readFileSync(p, "utf8"));
    const bytes = globs.reduce((n, g) => n + g.length, 0);
    if (globs.length > MAX_DENY_GLOBS || bytes > MAX_DENY_GLOB_BYTES) return { globs: [DENY_ALL], usable: false };
    return { globs, usable: true };
  } catch {
    return { globs: [DENY_ALL], usable: false };
  }
}

/** What redaction needs for this repository: the organisation's email domains, deny globs, root, identity. */
export function redactionContext(paths: Paths, repo: Repo): RedactionContext {
  const domains = readConfig(paths).orgs[repo.entry.org_id]?.email_domains;
  const host = hostname();
  let user: string | null = null;
  try {
    user = userInfo().username;
  } catch {
    user = null;
  }
  return {
    orgDomains: domains && domains.length > 0 ? domains : null,
    // `.aligndeny` is committed to the repository, so it is untrusted input: read defensively (core matches its globs
    // in linear time and takes over-long or wildcard-heavy ones literally).
    denyGlobs: [...readDenyFile(join(repo.root, ".aligndeny")).globs, ...readDenyFile(paths.deny(repo.root)).globs],
    repoRoot: repo.root,
    salt: salt(paths),
    hostnames: [...new Set([host, host.split(".")[0] ?? ""].filter((h) => h.length >= 2))],
    usernames: user && user.length >= 2 ? [user] : [],
  };
}

/**
 * `cwd_rel` for a working directory: `""` at the root, null outside or unknown (redaction checks it again). The
 * directory is resolved first, so a symlinked spelling of the repository still counts as inside.
 */
export function cwdRel(root: string, cwd: string | null): string | null {
  if (!cwd) return null;
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // keep as given
  }
  const rel = relative(root, real);
  if (rel === "") return "";
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  return rel;
}

export function envelope(
  kind: Kind,
  payload: Record<string, unknown>,
  o: {
    harness: Harness;
    sessionId: string | null;
    repo: Repo;
    cwd: string | null;
    now: number;
    machineId: string | null;
  },
): TraceEvent {
  const harness: Record<string, unknown> = {
    name: o.harness.name,
    session_id: o.harness.session_id,
    hook_event: o.harness.hook_event,
  };
  if (o.harness.version) harness.version = o.harness.version;
  return {
    schema_version: SCHEMA_VERSION,
    event_id: uuidv7(o.now),
    ts: new Date(o.now).toISOString(),
    kind,
    harness,
    session: { id: o.sessionId },
    repo: {
      remote_norm: o.repo.entry.remote_norm,
      root_commit: o.repo.entry.root_commit,
      branch: o.repo.facts.branch,
      head: o.repo.facts.head,
    },
    cwd_rel: cwdRel(o.repo.root, o.cwd),
    machine_id: o.machineId,
    capture: "live",
    payload,
  };
}

export function machineIdFor(paths: Paths): Promise<string | null> {
  return machineId(hostname(), salt(paths)).catch(() => null);
}

/** Redacts each event; dropped events (an unknown kind, a commit with every file denied) are left out. */
export function redactAll(events: TraceEvent[], ctx: RedactionContext): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const e of events) {
    const r = redactEvent(e, ctx);
    if (r.event) out.push(r.event);
  }
  return out;
}

/**
 * Writes already-redacted events as one spool file (`<time>-<random>.json`, tmp + rename) and returns its path.
 * The file names the repository root and id, so the uploader (L14) can check the registry again before sending.
 */
export function spool(paths: Paths, repo: Repo, events: TraceEvent[], now: number): string | null {
  if (events.length === 0) return null;
  const name = `${String(now).padStart(14, "0")}-${randomBytes(6).toString("hex")}.json`;
  const file = join(paths.spoolFor(repo.root), name);
  writeJsonAtomic(file, { version: 1, root: repo.root, repo_id: repo.entry.repo_id, events });
  return file;
}
