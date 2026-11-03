/**
 * Backfill (docs/15 `align init` step 8 and `align backfill`; docs/10 §Backfill sources; docs/12 §Triggers): find this
 * repository's recent sessions in the chosen harnesses, show the counts, ask, upload them redacted with `capture:
 * 'backfill'` through the uploader, ask the server to compile them (`POST /backfill`) and follow its progress for up
 * to ten minutes (`GET /backfill/:id`).
 *
 * Everything capture guarantees holds here too: only a registered, opted-in repository (checked again before each
 * session is spooled, and by the uploader before each request) and only the harnesses chosen for it (D95 (h));
 * redaction, code-block replacement, path and deny rules on the laptop (build.ts); held events (`unsettled`) never
 * leave; the uploader's batching, `busy_kind` waits and conflicts. A "no" reads and writes nothing. Without a
 * terminal nothing but the result lines is printed (quiet by default).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BACKFILL_LIMITS,
  BackfillResponse,
  BackfillStatus,
  MAX_BACKFILL_DAYS,
  MAX_BACKFILL_SESSIONS,
  type RepoState,
} from "@align/core/api";
import { type ApiClient, ApiError } from "../api";
import { reportCommit, runLocalChecks, textContext } from "../checks/fs-local";
import { contradicted, postResults } from "../checks/report";
import type { HarnessName } from "../commands/harness";
import { agentHarness, askTty } from "../confirm/person";
import { type Ctx, UserError } from "../context";
import { copy } from "../copy";
import { defaultKeychain } from "../credentials";
import { codexDir } from "../harness/codex/install";
import { machineIdFor, type Repo, redactionContext, spool } from "../hook/events";
import { readState } from "../hook/state";
import { repoHash } from "../paths";
import { lookupRepo, type RepoEntry, readRegistry } from "../registry";
import { findSession, sessionFor } from "../sessions";
import { heartbeat, tryLock, unlock } from "../upload/lock";
import { sendSpool } from "../upload/send";
import { listSpool, readSpoolFile } from "../upload/spool";
import { buildSession } from "./build";
import { DAY_MS, type Found, scanHistory } from "./scan";
import { type BackfillFile, backfillKey, lockBackfill, readBackfill, writeBackfill } from "./state";

/** docs/15 step 8: progress is followed for up to ten minutes. */
export const POLL_BUDGET_MS = 10 * 60 * 1000;
export const POLL_EVERY_MS = 3000;
/** The spool is sent whenever this much is waiting, so a long backfill never nears the uploader's 50 MB cap. */
export const SEND_EVERY_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 15_000;

export type BackfillOptions = {
  days?: string;
  harness?: string;
  yes?: boolean;
  /** `init`: told how many proposals the backfill found, for its "Next" lines. */
  onSummary?: (s: { proposals: number }) => void;
};

/** The backfill lock is refreshed this often while a run holds it (consent, uploads, waits and polling). */
export const LOCK_REFRESH_MS = 60_000;

export type BackfillTarget = { root: string; entry: RepoEntry; api: ApiClient; state: RepoState };

type Counts = Record<HarnessName, number>;
const zero = (): Counts => ({ "claude-code": 0, cursor: 0, codex: 0 });

/** `--days`: a whole number from 1 to 90 (checked before anything else runs, also by `init`). */
export function parseDays(days?: string): number | null {
  if (days === undefined) return null;
  if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > MAX_BACKFILL_DAYS)
    throw new UserError(copy.backfill.badDays, 2);
  return Number(days);
}

/** The window and the session cap: `--days` within the plan's window; the organisation's cap, else the plan's. */
export function limitsFor(state: RepoState, days?: string): { days: number; sessions: number } {
  const plan = BACKFILL_LIMITS[state.plan as keyof typeof BACKFILL_LIMITS] ?? BACKFILL_LIMITS.free;
  const serverDays = state.limits.backfill_days;
  const planDays = Math.min(plan.days, typeof serverDays === "number" && serverDays > 0 ? serverDays : plan.days);
  const wanted = parseDays(days) ?? planDays;
  const serverCap = state.limits.backfill_sessions;
  const sessions = typeof serverCap === "number" && serverCap >= 0 ? serverCap : plan.sessions;
  return { days: Math.min(wanted, planDays), sessions: Math.min(sessions, MAX_BACKFILL_SESSIONS) };
}

/** The harnesses chosen for this repository at init (`harnesses` in the registry), narrowed by `--harness`. */
export function harnessesFor(entry: RepoEntry, flag?: string): HarnessName[] {
  const chosen = entry.harnesses.filter(
    (h): h is HarnessName => h === "claude-code" || h === "cursor" || h === "codex",
  );
  if (!flag) return chosen;
  const wanted = flag.split(",").map((h) => h.trim());
  return chosen.filter((h) => wanted.includes(h));
}

/** Still registered under the same id and opted in (hard rule 6), read fresh each time. */
const stillAllowed = (ctx: Ctx, t: BackfillTarget) => {
  const now = lookupRepo(readRegistry(ctx.paths), t.root);
  return now?.root === t.root && now.entry.repo_id === t.entry.repo_id && now.entry.opted_in;
};

type Pick = { found: Found; key: string; reuse: string | null; upload: boolean };

/**
 * What to do with each session found (D270). A session the index knows but backfill never recorded was captured
 * live at some point (its capture state may since have been pruned): live capture owns it, it is skipped. One handed
 * to the server, refused or empty, and unchanged since, is skipped. One spooled earlier and either already sent or
 * still waiting in the spool is handed over without reading it again; one whose spool was emptied without being sent
 * (an opt-out meanwhile) is read again. The rest are read and uploaded. The cap counts the most recent first.
 */
function choose(ctx: Ctx, found: Found[], file: BackfillFile, cap: number, waiting: Set<string>): Pick[] {
  const picks: Pick[] = [];
  for (const f of found) {
    if (picks.length >= cap) break;
    const known = findSession(ctx.paths, f.harness, f.harnessSessionId);
    const key = backfillKey(f.harness, f.harnessSessionId);
    const prev = file.sessions[key];
    if (known && (!prev || readState(ctx.paths, known))) continue;
    const unchanged = prev !== undefined && prev.size === f.size && prev.mtime === f.mtimeMs;
    if (unchanged && (prev.empty || prev.posted || prev.refused)) continue;
    const resend = unchanged && prev.spooled && (prev.sent === true || waiting.has(prev.id));
    picks.push({ found: f, key, reuse: known, upload: !resend });
  }
  return picks;
}

/** ALIGN session ids that still have events waiting in this repository's spool. */
function waitingSessions(ctx: Ctx, root: string): Set<string> {
  const out = new Set<string>();
  for (const e of listSpool(ctx.paths)) {
    const f = readSpoolFile(e.path);
    if (!f || f === "gone" || f.root !== root) continue;
    for (const ev of f.events) if (ev.session.id) out.add(ev.session.id);
  }
  return out;
}

/**
 * ALIGN session ids with an event the server refused with a final code (`spool/rejected/<repo>/`) or one held back on
 * the laptop because its redaction did not settle (`spool/held/<repo>/`): such a session is incomplete on the server.
 */
function refusedSessions(ctx: Ctx, root: string): Set<string> {
  const out = new Set<string>();
  for (const base of [ctx.paths.rejected, ctx.paths.held]) {
    const dir = join(base, repoHash(root));
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const v = JSON.parse(readFileSync(join(dir, n), "utf8")) as {
          items?: { event?: { session?: { id?: unknown } } }[];
        };
        for (const it of v.items ?? []) if (typeof it.event?.session?.id === "string") out.add(it.event.session.id);
      } catch {
        // unreadable: ignored
      }
    }
  }
  return out;
}

class LockLost extends Error {
  override readonly name = "LockLost";
}

/**
 * Consent (D403 (a), D405): never from an agent's shell; on a terminal the question (or `--yes`); without one, a `y`
 * typed on the controlling terminal (`/dev/tty`), which a pipe cannot supply. True only for a person's yes.
 */
async function consent(ctx: Ctx, o: BackfillOptions, days: number): Promise<boolean> {
  const stdinTty = ctx.io.isTTY === true;
  if (stdinTty && o.yes) return true;
  if (stdinTty) {
    const a = ((await ctx.ask(copy.backfill.question(days))) ?? "").trim().toLowerCase();
    if (a === "" || a === "y" || a === "yes") return true;
    ctx.line(copy.backfill.declined);
    return false;
  }
  const a = await (ctx.deps.ttyAsk ?? askTty)(copy.backfill.question(days));
  if (a === null) {
    ctx.line(copy.backfill.needsTerminal);
    return false;
  }
  if (["y", "yes"].includes(a.trim().toLowerCase())) return true;
  ctx.line(copy.backfill.declined);
  return false;
}

export async function runBackfill(ctx: Ctx, t: BackfillTarget, o: BackfillOptions): Promise<number> {
  const agent = agentHarness(ctx.env);
  if (agent) throw new UserError(copy.backfill.agent(agent));
  const tty = ctx.io.isTTY === true;
  const { days, sessions: cap } = limitsFor(t.state, o.days);
  const harnesses = harnessesFor(t.entry, o.harness);
  if (!t.entry.opted_in || !stillAllowed(ctx, t)) throw new UserError(copy.notRegistered);
  const lock = lockBackfill(ctx.paths, t.root, Date.now());
  if (!lock) {
    ctx.line(copy.backfill.busy);
    return 0;
  }
  const refresh = setInterval(() => lock.touch(), LOCK_REFRESH_MS);
  refresh.unref?.();
  try {
    return await locked(ctx, t, o, { tty, days, cap, harnesses, touch: lock.touch });
  } finally {
    clearInterval(refresh);
    lock.release();
  }
}

async function locked(
  ctx: Ctx,
  t: BackfillTarget,
  o: BackfillOptions,
  c: { tty: boolean; days: number; cap: number; harnesses: HarnessName[]; touch: () => void },
): Promise<number> {
  const { tty, days, cap, harnesses } = c;
  const home = ctx.env.HOME || homedir();
  const found = scanHistory({
    root: t.root,
    home,
    codexHome: codexDir(ctx.env, home),
    harnesses,
    since: ctx.now() - days * DAY_MS,
  });
  let file = readBackfill(ctx.paths, t.root);
  const picks = choose(ctx, found, file, cap, waitingSessions(ctx, t.root));
  if (picks.length === 0) {
    ctx.line(copy.backfill.nothing(days));
    return 0;
  }
  const counts = zero();
  for (const p of picks) counts[p.found.harness]++;
  ctx.line(copy.backfill.found(copy.backfill.counts(counts, harnesses), days));

  // Consent: a "no" (or no way to ask a person) mints, spools and sends nothing.
  if (!(await consent(ctx, o, days))) return 0;

  const repo: Repo = { root: t.root, entry: t.entry, facts: { toplevel: t.root, head: null, branch: null } };
  const rctx = redactionContext(ctx.paths, repo);
  const machineId = await machineIdFor(ctx.paths);
  const keychain = ctx.deps.keychain === undefined ? defaultKeychain(ctx.env, ctx.deps.platform) : ctx.deps.keychain;
  const uploaded = zero();
  const sizes = new Map<string, number>();
  const sent = new Set<string>();
  let pending = 0;
  let left = 0;
  let done = 0;
  let stopped = false;
  const save = () => {
    writeBackfill(ctx.paths, t.root, file);
    c.touch();
  };
  const progress = (n: number) => {
    if (tty) ctx.io.out(`\r${copy.backfill.uploading(copy.bar(n, picks.length), n, picks.length)}`);
  };

  /** Sends what waits in the spool, holding the uploader lock (another uploader holding it sends it instead). */
  const send = async (): Promise<boolean> => {
    let locked = tryLock(ctx.paths, ctx.now());
    for (let waited = 0; !locked && waited < LOCK_WAIT_MS; waited += 1000) {
      await ctx.sleep(1000);
      locked = tryLock(ctx.paths, ctx.now());
    }
    if (!locked) return false;
    try {
      const beat = () => {
        if (!heartbeat(ctx.paths, ctx.now())) throw new LockLost("lock taken over");
      };
      const r = await sendSpool({
        paths: ctx.paths,
        now: ctx.now,
        sleep: async (ms) => {
          for (let rest = ms; rest > 0; rest -= 10_000) {
            await ctx.sleep(Math.min(rest, 10_000));
            beat();
          }
        },
        beat,
        fetch: ctx.deps.fetch,
        keychain,
      });
      for (const id of r.sessions.keys()) sent.add(id);
      return !(r.offline || r.corruptIndex || r.loginRequired.length > 0);
    } catch (e) {
      if (e instanceof LockLost) return false;
      throw e;
    } finally {
      unlock(ctx.paths);
    }
  };

  progress(0);
  for (const [i, p] of picks.entries()) {
    if (!stillAllowed(ctx, t)) {
      stopped = true;
      break;
    }
    const f = p.found;
    if (p.upload) {
      const id = p.reuse ?? sessionFor(ctx.paths, f.harness, f.harnessSessionId, f.startedAt);
      const entry = { id, harness: f.harness, size: f.size, mtime: f.mtimeMs, posted: false };
      // Recorded before anything is read, so a crash never leaves an id that looks captured live (choose()).
      file.sessions[p.key] = { ...entry, empty: false, spooled: false };
      save();
      const built = buildSession(f, { id, repo, rctx, machineId, now: ctx.now() });
      if (!built) {
        file.sessions[p.key] = { ...entry, empty: true, spooled: false };
      } else {
        spool(ctx.paths, repo, built.events, ctx.now());
        const b = built.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), "utf8"), 0);
        sizes.set(p.key, b);
        pending += b;
        file.sessions[p.key] = { ...entry, empty: false, spooled: true };
      }
      save();
    }
    done = i + 1;
    if (pending >= SEND_EVERY_BYTES) {
      pending = 0;
      if (!(await send())) {
        stopped = true;
        break;
      }
    }
    progress(done);
  }
  if (!stopped && !(await send())) stopped = true;
  if (tty) ctx.io.out("\n");

  // Hand over the sessions the uploader reported sent, with nothing left in the spool and nothing refused or held
  // (the index names their current id: a `session_conflict` may have moved one).
  const waiting = waitingSessions(ctx, t.root);
  const refused = refusedSessions(ctx, t.root);
  let refusedCount = 0;
  let bytes = 0;
  const ready: string[] = [];
  file = readBackfill(ctx.paths, t.root);
  for (const p of picks) {
    const e = file.sessions[p.key];
    if (!e || e.empty || !e.spooled) continue;
    const id = findSession(ctx.paths, p.found.harness, p.found.harnessSessionId) ?? e.id;
    if (waiting.has(id) || waiting.has(e.id)) {
      left++;
      continue;
    }
    if (refused.has(id) || refused.has(e.id)) {
      file.sessions[p.key] = { ...e, refused: true };
      refusedCount++;
      continue;
    }
    if (!(e.sent || sent.has(id) || sent.has(e.id))) {
      // Its spool was emptied without the server storing it (an opt-out meanwhile): read again next time.
      file.sessions[p.key] = { ...e, spooled: false };
      left++;
      continue;
    }
    file.sessions[p.key] = { ...e, id, sent: true };
    uploaded[p.found.harness]++;
    bytes += sizes.get(p.key) ?? 0;
    ready.push(id);
  }
  save();
  ctx.line(copy.backfill.uploaded(copy.backfill.counts(uploaded, harnesses), copy.size(bytes)));
  if (refusedCount > 0) ctx.line(copy.backfill.refused(refusedCount));
  const notDone = left + (picks.length - done);
  if (notDone > 0) ctx.line(copy.backfill.waiting(notDone));
  if (ready.length === 0) return notDone > 0 ? 1 : 0;
  // Opted out (or unregistered) meanwhile: the server is not asked to compile anything (hard rule 6).
  if (!stillAllowed(ctx, t)) return 0;

  let backfillId: string;
  try {
    const { data } = await t.api.request("POST", "/backfill", BackfillResponse, {
      repo_id: t.entry.repo_id,
      session_ids: ready.slice(0, MAX_BACKFILL_SESSIONS),
      window_days: days,
    });
    backfillId = data.backfill_id;
  } catch (e) {
    // Before L23b the route does not exist: the sessions stay un-posted and the next run hands them over.
    if (e instanceof ApiError && e.status === 404 && (e.code === "invalid_response" || e.code === "not_found")) {
      ctx.line(copy.backfill.notReady);
      return 0;
    }
    throw e;
  }
  for (const p of picks) {
    const e = file.sessions[p.key];
    if (e && ready.includes(e.id)) e.posted = true;
  }
  file.last = { backfill_id: backfillId, at: ctx.now() };
  save();
  return follow(ctx, t, backfillId, tty, o);
}

/**
 * Polls the backfill for up to ten minutes; a progress bar on a terminal, then the checks compile proposed are run on
 * the working tree (L15b: tracked files, paths and line numbers only sent), and the result line, with "contradicted"
 * counted from the local failures when there were checks to run. The sessions are already handed over, so a failed
 * poll is not a failure: the background line is shown and the run ends normally; a failed local run keeps the
 * server's count.
 */
async function follow(ctx: Ctx, t: BackfillTarget, id: string, tty: boolean, o: BackfillOptions): Promise<number> {
  const started = ctx.now();
  let last: BackfillStatus | null = null;
  try {
    for (;;) {
      const { data } = await t.api.request("GET", `/backfill/${encodeURIComponent(id)}`, BackfillStatus);
      last = data;
      if (tty)
        ctx.io.out(
          `\r${copy.backfill.compiling(copy.bar(data.sessions_compiled, data.sessions_total), data.sessions_compiled, data.sessions_total)}`,
        );
      if (data.status !== "running" || ctx.now() - started >= POLL_BUDGET_MS) break;
      await ctx.sleep(POLL_EVERY_MS);
    }
  } catch {
    if (tty) ctx.io.out("\n");
    ctx.line(copy.backfill.background);
    return 0;
  }
  if (tty) ctx.io.out("\n");
  let contradictedNow = last.contradicted;
  if (last.checks_to_run.length > 0) {
    const local = await localChecks(ctx, t, last.checks_to_run);
    if (local !== null) contradictedNow = local;
  }
  ctx.line(copy.backfill.summary(last.proposals, contradictedNow, last.questions));
  o.onSummary?.({ proposals: last.proposals });
  if (last.status === "paused") ctx.line(copy.backfill.paused);
  else if (last.status === "running") ctx.line(copy.backfill.background);
  return 0;
}

/** The local checks after a backfill run within this much in all (each check also within its own 10 s). */
export const LOCAL_CHECKS_BUDGET_MS = 60_000;

/**
 * Runs the backfill's proposed checks (the person's own proposals) on HEAD's blobs and reports them (D423); the
 * decisions contradicted, or null when the run failed (every result an error), the repository is no longer opted in,
 * or reporting failed: the caller then keeps the server's count.
 */
async function localChecks(
  ctx: Ctx,
  t: BackfillTarget,
  checks: BackfillStatus["checks_to_run"],
): Promise<number | null> {
  try {
    // Reported under the newest commit HEAD shares with a remote; none → nothing is reported (D409).
    const sha = await reportCommit(t.root, t.entry.remote_norm, ctx.env);
    if (!sha) return null;
    const repo: Repo = { root: t.root, entry: t.entry, facts: { toplevel: t.root, head: sha, branch: null } };
    const results = await runLocalChecks(
      t.root,
      checks.map((c) => ({ check_id: c.check_id, entry_key: c.entry_key, kind: c.kind, spec: c.spec })),
      {
        paths: ctx.paths,
        ctx: textContext(redactionContext(ctx.paths, repo)),
        env: ctx.env,
        now: ctx.now,
        source: "head",
        commit: sha,
        deadline: Date.now() + LOCAL_CHECKS_BUDGET_MS,
      },
    );
    if (results.length === 0 || results.every((r) => r.result === "error")) return null;
    if (!stillAllowed(ctx, t)) return null;
    await postResults(t.api, t.entry.repo_id, sha, results);
    return contradicted(results);
  } catch {
    return null;
  }
}
