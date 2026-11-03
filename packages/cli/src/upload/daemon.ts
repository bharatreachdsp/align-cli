/**
 * The uploader process (docs/15 §The uploader): `align upload --daemon` (detached, spawned by the hooks), `align
 * upload` (one pass) and `align flush` (foreground, with progress). One at a time behind `spool/upload.lock`.
 *
 * Each tick of the daemon: the heartbeat; sessions the Stop and SessionEnd hooks marked are read (transcript
 * deltas, hook/read.ts); the spool is sent (send.ts); notices are fetched for sessions that just uploaded. After a
 * SessionEnd the session is read once more 3 s later (transcripts are written asynchronously). It exits after 10 s
 * with nothing to do, when the network has been gone for 5 minutes (the next hook starts another), or when its lock
 * was taken over. Caps and old session files are tidied at start and every minute.
 */
import { readdirSync, rmSync } from "node:fs";
import type { FetchLike } from "../api";
import { copy } from "../copy";
import { defaultKeychain, type Keychain } from "../credentials";
import { pruneStaleRecord } from "../harness/claude-code/install";
import { logCount } from "../hook/log";
import { readSession } from "../hook/read";
import { applyMarks, listStates, updateState } from "../hook/state";
import type { Paths } from "../paths";
import { readRegistry } from "../registry";
import { heartbeat, sweepLockLeftovers, tryLock, unlock } from "./lock";
import { fetchNotices } from "./notices";
import { type FaultStep, type SendResult, sendSpool } from "./send";
import { enforceCaps, listSpool } from "./spool";

export const END_GRACE_MS = 3000;
export const STOP_GRACE_MS = 1500;
export const IDLE_EXIT_MS = 10_000;
export const HOUSEKEEPING_EVERY_MS = 60_000;
/** Session state files untouched this long, and not pending, are removed. */
export const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TICK_MS = 1000;
/** `align flush` waits this long for a running uploader to finish before leaving the spool to it. */
const FLUSH_LOCK_WAIT_MS = 15_000;

function applyAllMarks(paths: Paths): void {
  let names: string[] = [];
  try {
    names = readdirSync(paths.sessions);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^([0-9a-f-]{36})\.marks$/.exec(n);
    if (!m?.[1]) continue;
    try {
      applyMarks(paths, m[1]);
    } catch {
      // busy: next pass
    }
  }
}

/** The caps (spool 50 MB, rejected and held 5 MB), stale kept settings copies, and old session state files. */
export function housekeeping(paths: Paths, now: number): void {
  enforceCaps(paths);
  sweepLockLeftovers(paths);
  // A kept copy of a settings file that has changed since ALIGN wrote it would restore stale bytes: dropped.
  for (const root of Object.keys(readRegistry(paths).repos)) {
    try {
      pruneStaleRecord(paths, root);
    } catch {
      // unreadable: left for doctor
    }
  }
  for (const st of listStates(paths)) {
    if (st.pending || now - st.last_seen < STATE_RETENTION_MS) continue;
    rmSync(paths.sessionState(st.id), { force: true });
    rmSync(paths.sessionMarks(st.id), { recursive: true, force: true });
    rmSync(paths.sessionNotice(st.id), { force: true });
  }
}

/**
 * One pass over every pending session. `wait` false (the foreground commands) reads ended sessions at once; true
 * (the daemon) leaves a session that ended less than 3 s ago (or stopped less than 1.5 s ago) pending for the next.
 */
export async function processPending(
  paths: Paths,
  now: number,
  wait: boolean,
  beat: () => void = () => {},
): Promise<{ pending: number; lines: number }> {
  let pending = 0;
  let lines = 0;
  applyAllMarks(paths);
  for (const s of listStates(paths)) {
    if (!s.pending) continue;
    // Per session: a long read pass keeps the lock's heartbeat fresh, and stops if the lock was taken over.
    beat();
    pending++;
    try {
      lines += await readSession(paths, s.id, now);
    } catch (e) {
      logCount(paths.logs, "reader", `error_${String((e as { name?: string })?.name ?? "Error").toLowerCase()}`);
    }
    const ended = s.ended_at;
    const settled = !wait || (ended !== null ? now - ended >= END_GRACE_MS : now - s.last_seen >= STOP_GRACE_MS);
    if (settled) {
      try {
        updateState(
          paths,
          s.id,
          () => s,
          (cur) => ({ ...cur, pending: cur.ended_at !== ended || cur.last_seen > now ? cur.pending : false }),
        );
      } catch {
        // busy: next pass
      }
    }
  }
  return { pending, lines };
}

export type UploadOptions = {
  daemon: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tests: the server's fetch, the Keychain stand-in, and simulated crashes. */
  fetch?: FetchLike;
  keychain?: Keychain | null;
  fault?: (step: FaultStep) => void;
  backoffBudgetMs?: number;
};

class LockLost extends Error {
  override readonly name = "LockLost";
}

/**
 * The lock-keeping pieces every holder of the uploader lock uses (daemon, one-shot upload, flush): `beat` refreshes
 * the heartbeat and throws `LockLost` when the lock is no longer this process's; `sleep` waits in pieces of at most
 * 10 s with a beat after each, so a long back-off or a long pass never looks like a dead uploader (docs/15).
 */
function guarded(paths: Paths, now: () => number, realSleep: (ms: number) => Promise<void>) {
  const beat = () => {
    if (!heartbeat(paths, now())) throw new LockLost("lock taken over");
  };
  const sleep = async (ms: number) => {
    for (let left = ms; left > 0; left -= 10_000) {
      await realSleep(Math.min(left, 10_000));
      beat();
    }
  };
  return { beat, sleep };
}

function sendDeps(paths: Paths, o: UploadOptions, now: () => number, g: ReturnType<typeof guarded>) {
  return {
    paths,
    now,
    sleep: g.sleep,
    beat: g.beat,
    fetch: o.fetch,
    // The credential record says where each token lives; the environment never decides (it is a repository's to set).
    keychain: o.keychain === undefined ? defaultKeychain({}) : o.keychain,
    fault: o.fault,
    backoffBudgetMs: o.backoffBudgetMs,
  };
}

/** `align upload [--daemon]`. Returns the exit code (always 0); only a test's simulated crash propagates. */
export async function upload(paths: Paths, o: UploadOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const realSleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!tryLock(paths, now())) return 0;
  const g = guarded(paths, now, realSleep);
  const deps = sendDeps(paths, o, now, g);
  const lastFetch = new Map<string, number>();
  try {
    if (!o.daemon) {
      enforceCaps(paths);
      await processPending(paths, now(), false, g.beat);
      const r = await sendSpool(deps);
      await fetchNotices(deps, r.sessions, lastFetch);
      return 0;
    }
    logCount(paths.logs, "upload", "daemon_start");
    housekeeping(paths, now());
    let lastHousekeeping = now();
    // Idle time is counted in ticks, so a test's instant sleep ends the loop as quickly as a real one does.
    let idleTicks = 0;
    let stuckAt: string | null = null;
    for (;;) {
      g.beat();
      const read = await processPending(paths, now(), true, g.beat);
      let r: SendResult | null = null;
      // The spool is read and sent again only when it changed since a pass that could send nothing (no token, only
      // retryable answers): an uploader that cannot send never spends a hook's CPU re-reading the same files.
      const files = listSpool(paths);
      const signature = `${files.length} ${files.at(-1)?.name ?? ""}`;
      if (files.length > 0 && signature !== stuckAt) {
        r = await sendSpool(deps);
        await fetchNotices(deps, r.sessions, lastFetch);
        if (r.offline || r.corruptIndex) break;
        stuckAt = r.accepted + r.duplicates + r.rejected + r.held + r.dropped > 0 ? null : signature;
      }
      const progressed = read.pending > 0 || (r !== null && r.accepted + r.duplicates + r.rejected > 0);
      idleTicks = progressed ? 0 : idleTicks + 1;
      if (idleTicks * TICK_MS >= IDLE_EXIT_MS) break;
      if (now() - lastHousekeeping >= HOUSEKEEPING_EVERY_MS) {
        housekeeping(paths, now());
        lastHousekeeping = now();
      }
      await g.sleep(TICK_MS);
    }
  } catch (e) {
    if (!(e instanceof LockLost)) throw e;
  } finally {
    unlock(paths);
  }
  return 0;
}

/**
 * `align flush`: reads pending transcripts and sends the whole spool now, printing progress. Exit 0 when nothing
 * is left to send, 1 when something waits (offline, sign-in needed, retry later).
 */
export async function flush(paths: Paths, o: UploadOptions & { out: (line: string) => void }): Promise<number> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let locked = tryLock(paths, now());
  for (let waited = 0; !locked && waited < FLUSH_LOCK_WAIT_MS; waited += TICK_MS) {
    await sleep(TICK_MS);
    locked = tryLock(paths, now());
  }
  if (!locked) {
    o.out(`${copy.flush.busy}\n`);
    return 0;
  }
  const g = guarded(paths, now, sleep);
  try {
    enforceCaps(paths);
    await processPending(paths, now(), false, g.beat);
    if (listSpool(paths).length === 0) {
      o.out(`${copy.flush.nothing}\n`);
      return 0;
    }
    const deps = {
      ...sendDeps(paths, o, now, g),
      onProgress: (p: { sent: number; total: number }) => o.out(`${copy.flush.progress(p.sent, p.total)}\n`),
    };
    const r = await sendSpool(deps);
    await fetchNotices(deps, r.sessions, new Map());
    o.out(`${copy.flush.done(r.accepted + r.duplicates, r.rejected, r.held)}\n`);
    if (r.corruptDeleted) o.out(`${copy.flush.corruptDeleted}\n`);
    else if (r.corruptIndex) o.out(`${copy.flush.corruptIndex}\n`);
    else if (r.loginRequired.length > 0) o.out(`${copy.loginRequired}\n`);
    else if (r.offline) o.out(`${copy.flush.offline(r.kept)}\n`);
    else if (r.busy) o.out(`${copy.flush.waiting(r.kept)}\n`);
    else if (r.kept > 0) o.out(`${copy.flush.waiting(r.kept)}\n`);
    return r.kept > 0 || r.offline || r.busy || r.corruptIndex || r.loginRequired.length > 0 ? 1 : 0;
  } catch (e) {
    if (!(e instanceof LockLost)) throw e;
    o.out(`${copy.flush.busy}\n`);
    return 1;
  } finally {
    unlock(paths);
  }
}
