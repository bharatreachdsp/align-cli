/**
 * `align git-hook prepare-commit-msg FILE [SOURCE] [SHA]` and `align git-hook post-commit` (docs/15 §Git hooks).
 * Both run only in a registered, opted-in repository (exact toplevel, D81), never print, never fail the commit
 * (the wrapper ignores this exit code), and keep to git calls with the 300 ms timeout.
 *
 * prepare-commit-msg appends the session trailer (`TRAILERS.session: <id>`) for the session in this repository with
 * the newest hook activity in the last 2 hours (D88), unless a session trailer is already there; merge, squash and
 * reused messages (amend, `-c`, `-C`) are left alone. When it adds one it records it locally (`trailerPending`: the
 * id, HEAD at that moment, the time), and every run first clears that record. post-commit spools a `commit` event
 * (sha, message ≤ 4,000 characters, files, parsed trailers) and consumes the record: a session trailer stays in the
 * event only when it is the one this CLI added for this very commit (same id, the commit's first parent is the HEAD
 * recorded, within the window, a session of this repository this laptop recorded). Any other session trailer, typed
 * by hand, copied from another commit or carried in by a squash, an amend or `-C` (someone can put a teammate's
 * session id in a message the teammate then squashes or amends), is dropped, so a commit is linked only to the
 * session it came from (D472, #94 security review).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TRAILERS, trailerKind } from "@align/core/brand";
import { MAX_PATH_CHARS } from "@align/core/redact";
import { CorruptFileError, readJson, writeJsonAtomic } from "../fsx";
import { GIT_TIMEOUT_MS } from "../git";
import { envelope, machineIdFor, type Repo, redactAll, redactionContext, spool } from "../hook/events";
import { hookGit, repoFacts } from "../hook/home";
import { logCount } from "../hook/log";
import { listStates, readState } from "../hook/state";
import type { Paths } from "../paths";
import { lookupRepo, readRegistry } from "../registry";
import { readSessionIndex } from "../sessions";

export const TRAILER_WINDOW_MS = 2 * 60 * 60 * 1000;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_FILES = 1000;
const MAX_TRAILER_VALUE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GitHookDeps = {
  paths: Paths;
  cwd: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds since ALIGN's part started (the process's uptime in the bundle; since the call by default). */
  elapsed?: () => number;
};

/**
 * The wrapper kills ALIGN's part after 2 s, but only the node process: a git child still writing `COMMIT_EDITMSG`
 * could race the user's own hook. So ALIGN starts its last write (`interpret-trailers`) only before 1.2 s and gives it
 * what is left of 1.5 s, and is done well before the kill (L12 review round 4).
 */
export const TRAILER_START_BY_MS = 1200;
export const GIT_PART_DONE_BY_MS = 1500;

/**
 * A commit that replays or rewrites someone's work is not a new commit from this laptop's session: no trailer and no
 * commit event during a cherry-pick, revert or rebase (their state files in the git directory, or git's
 * `GIT_REFLOG_ACTION`), L12 security review.
 */
/** A revert's message (a clean `git revert` leaves no REVERT_HEAD behind). */
const REVERT = /^This reverts commit [0-9a-f]{7,64}/m;

const emailOf = (ident: string | null | undefined) =>
  /<([^>]*)>/
    .exec(ident ?? "")?.[1]
    ?.trim()
    .toLowerCase() ?? null;

/**
 * Whether the commit being written is authored by the person committing it. Git exports the author of the commit
 * being written to the hook (`GIT_AUTHOR_EMAIL`, also for `--amend` of someone else's commit); the committer is
 * `GIT_COMMITTER_EMAIL` when exported, else the configured identity. Only a known, different author skips (an identity
 * git cannot tell is not a reason).
 */
async function ownCommit(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const author = env.GIT_AUTHOR_EMAIL?.trim().toLowerCase() || emailOf(await hookGit(["var", "GIT_AUTHOR_IDENT"], cwd));
  // Hook-path git runs without GIT_* variables, so `git var` sees only the configured identity: an exported
  // GIT_COMMITTER_EMAIL is the committer git itself uses.
  const committer =
    env.GIT_COMMITTER_EMAIL?.trim().toLowerCase() || emailOf(await hookGit(["var", "GIT_COMMITTER_IDENT"], cwd));
  return author === null || committer === null || author === committer;
}

export async function replaying(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (/^(?:rebase|cherry-pick|revert)/.test(env.GIT_REFLOG_ACTION ?? "")) return true;
  const dir = (await hookGit(["rev-parse", "--absolute-git-dir"], cwd))?.trim();
  if (!dir) return true;
  return ["CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((f) => existsSync(join(dir, f)));
}

async function optedInRepo(paths: Paths, cwd: string): Promise<Repo | null> {
  const facts = await repoFacts(cwd);
  if (!facts) return null;
  const found = lookupRepo(readRegistry(paths), facts.toplevel);
  return found?.entry.opted_in ? { root: found.root, entry: found.entry, facts } : null;
}

/** The newest session in this repository seen within the window, or null. */
export function recentSession(paths: Paths, root: string, now: number): string | null {
  let best: { id: string; at: number } | null = null;
  for (const s of listStates(paths)) {
    if (s.root !== root || now - s.last_seen > TRAILER_WINDOW_MS) continue;
    if (!best || s.last_seen > best.at) best = { id: s.id, at: s.last_seen };
  }
  return best?.id ?? null;
}

/** What prepare-commit-msg records when it adds the session trailer (D472). */
type PendingTrailer = { id: string; head: string | null; at: number };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function parsePending(v: unknown): PendingTrailer | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !UUID.test(o.id)) return null;
  if (o.head !== null && (typeof o.head !== "string" || !SHA.test(o.head))) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  return { id: o.id.toLowerCase(), head: o.head, at: o.at };
}

/**
 * Removes the record and any copy a post-commit took but could not delete (`trailer.json.taken-*`, never read again);
 * false when the record itself could not be removed (the caller then adds no trailer).
 */
function clearPending(paths: Paths, root: string): boolean {
  const file = paths.trailerPending(root);
  const prefix = `${basename(file)}.taken-`;
  try {
    for (const name of readdirSync(dirname(file))) {
      if (name.startsWith(prefix)) rmSync(join(dirname(file), name), { force: true });
    }
  } catch {
    // no directory yet, or a leftover copy that will not go: harmless, nothing reads it
  }
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Takes the record (renamed first, so two post-commits never both use it), or null. */
function takePending(paths: Paths, root: string): PendingTrailer | null {
  const file = paths.trailerPending(root);
  const taken = `${file}.taken-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(file, taken);
  } catch {
    return null;
  }
  const v = parsePending(readJson(taken));
  try {
    rmSync(taken, { force: true });
  } catch {
    // left for the next prepare-commit-msg to clear; never read again, and the commit's event still goes out
  }
  return v;
}

const hasSessionTrailer = (message: string) =>
  message.split("\n").some((l) => {
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*:/.exec(l);
    return m?.[1] !== undefined && trailerKind(m[1]) === "session";
  });

export async function prepareCommitMsg(args: readonly string[], deps: GitHookDeps): Promise<void> {
  const t0 = performance.now();
  const elapsed = deps.elapsed ?? (() => performance.now() - t0);
  const [file, source] = args;
  if (!file) return;
  const repo = await optedInRepo(deps.paths, deps.cwd);
  if (!repo) return;
  // Whatever this commit is, an earlier record (from a commit that was then aborted) never vouches for it (D472).
  if (!clearPending(deps.paths, repo.root)) {
    logCount(deps.paths.logs, "git", "trailer_record_stuck");
    return;
  }
  // merge, squash, and `commit` (amend, -c, -C: the message of an existing commit) are left alone.
  if (source === "merge" || source === "squash" || source === "commit") return;
  if (await replaying(deps.cwd, deps.env)) return;
  const id = recentSession(deps.paths, repo.root, (deps.now ?? Date.now)());
  if (!id) return;
  let message: string;
  try {
    message = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (hasSessionTrailer(message) || REVERT.test(message)) return;
  // Someone else's commit being reworded (`--amend -m` on a teammate's commit): git exports its author to the hook.
  if (!(await ownCommit(deps.cwd, deps.env ?? process.env))) return;
  // Too late to write safely before the wrapper's kill: no trailer this time (counted).
  const late = elapsed();
  if (late >= TRAILER_START_BY_MS) {
    logCount(deps.paths.logs, "git", "trailer_late");
    return;
  }
  // Recorded before the trailer is written: a record without its trailer vouches for nothing.
  try {
    const record: PendingTrailer = { id: id.toLowerCase(), head: repo.facts.head, at: (deps.now ?? Date.now)() };
    writeJsonAtomic(deps.paths.trailerPending(repo.root), record);
  } catch {
    logCount(deps.paths.logs, "git", "trailer_record_failed");
    return;
  }
  // git puts the trailer in the right place (after the body, before comment lines).
  const r = await hookGit(
    ["interpret-trailers", "--in-place", "--if-exists", "doNothing", "--trailer", `${TRAILERS.session}: ${id}`, file],
    deps.cwd,
    Math.min(GIT_TIMEOUT_MS, GIT_PART_DONE_BY_MS - late),
  );
  if (r === null) logCount(deps.paths.logs, "git", "trailer_failed");
}

/** `Key: value` trailers from `git interpret-trailers --parse` output, values capped. */
export function parseTrailers(out: string): Record<string, string[]> {
  const trailers: Record<string, string[]> = {};
  for (const line of out.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9-]{0,63}):\s?(.*)$/.exec(line);
    if (!m?.[1]) continue;
    // A drive letter is not a trailer key: git splits `C:\Users\<name>\…` at its colon (`C: \Users\…`), which would
    // send the path without the drive that the home rule needs (lane S).
    if (m[1].length === 1 && /^[\\/]/.test((m[2] ?? "").trim())) continue;
    const value = (m[2] ?? "").trim().slice(0, MAX_TRAILER_VALUE);
    const key = trailerKind(m[1]) ? TRAILERS[trailerKind(m[1]) as keyof typeof TRAILERS] : m[1];
    if (!trailers[key]) trailers[key] = [];
    trailers[key].push(value);
  }
  return trailers;
}

export async function postCommit(deps: GitHookDeps): Promise<void> {
  const repo = await optedInRepo(deps.paths, deps.cwd);
  if (!repo?.facts.head) return;
  const sha = repo.facts.head;
  // Consumed by every post-commit, whatever happens next: a record is good for one commit only.
  const pending = takePending(deps.paths, repo.root);
  if (await replaying(deps.cwd, deps.env)) return;
  const [meta, files] = await Promise.all([
    hookGit(["log", "-1", "--format=%ae%x00%ce%x00%P%x00%B", sha], deps.cwd),
    hookGit(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha], deps.cwd),
  ]);
  if (meta === null) return;
  const [authorEmail, committerEmail, parentList, ...rest] = meta.split("\0");
  // Someone else's commit applied here (am, a patch, a replay) is theirs, not this session's.
  if ((authorEmail ?? "").toLowerCase() !== (committerEmail ?? "").toLowerCase()) return;
  const message = rest.join("\0");
  if (REVERT.test(message)) return;
  // The commit message's trailers, through git's own parser (the message on stdin).
  const trailers = parseTrailers(
    (await hookGit(["interpret-trailers", "--parse"], deps.cwd, undefined, message)) ?? "",
  );

  const now = (deps.now ?? Date.now)();
  // The one session trailer this CLI added for this commit: its parent is HEAD as it was then, within the window
  // (D472). Without such a record every session trailer is dropped.
  const firstParent = (parentList ?? "").trim().split(" ")[0] || null;
  const age = pending ? now - pending.at : -1;
  const vouched = pending && firstParent === pending.head && age >= 0 && age <= TRAILER_WINDOW_MS ? pending.id : null;

  // Only sessions this laptop recorded may link a commit to a session.
  let knownIds = new Set<string>();
  try {
    knownIds = new Set(Object.values(readSessionIndex(deps.paths).sessions).map((s) => s.id));
  } catch (e) {
    if (!(e instanceof CorruptFileError)) throw e;
  }
  // …and only sessions of this repository (a trailer copied from another repository's commit is dropped).
  const sessions = (trailers[TRAILERS.session] ?? [])
    .map((v) => v.toLowerCase())
    .filter((v) => v === vouched && UUID.test(v) && knownIds.has(v) && readState(deps.paths, v)?.root === repo.root)
    .slice(0, 1);
  if (sessions.length > 0) trailers[TRAILERS.session] = sessions;
  else delete trailers[TRAILERS.session];

  const names = (files ?? "").split("\0").filter(Boolean).slice(0, MAX_FILES);
  // A file name over 1,024 characters is left out before redaction runs on it (counted; redaction drops them too).
  const fileList = names.filter((f) => f.length <= MAX_PATH_CHARS);
  if (fileList.length < names.length) logCount(deps.paths.logs, "git", "path_too_long", names.length - fileList.length);
  const event = envelope(
    "commit",
    { sha, message: message.trim().slice(0, MAX_MESSAGE_CHARS), files: fileList, trailers },
    {
      harness: { name: "git", session_id: null, hook_event: null },
      sessionId: sessions[0] ?? null,
      repo,
      cwd: null,
      now,
      machineId: await machineIdFor(deps.paths),
    },
  );
  spool(deps.paths, repo, redactAll([event], redactionContext(deps.paths, repo)), now);
}
