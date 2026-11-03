/**
 * Sends the spool (docs/15 §The uploader, docs/25 §Capture, D86): for each organisation, with the token its
 * credential record holds and only to the server that issued it (never `ALIGN_SERVER` or `ALIGN_HOME` from an
 * environment a repository can set; L11's review), in batches of at most 500 events and 1 MB gzip.
 *
 * Before anything leaves, and again before every request, each spool file's repository is checked against the
 * registry (read strictly): registered under the same repository id and opted in, or its events are dropped (counted). Events whose redaction did not settle
 * (`redaction.hits.unsettled`) are held back on the laptop and never sent (L10's follow-up).
 *
 * Per-event answers: accepted and duplicates are done; `rate_limited` stays in the spool; `session_conflict` points
 * the session index at the server's id (or a new one) and re-spools the event under it; every other code is final
 * and moves the event to `rejected/`. Whole-batch answers: 401 stops that organisation and records "login
 * required"; 429 waits (`Retry-After`) and follows `busy_kind` (D97: `in_flight` never splits, `too_slow` halves);
 * 413 halves (one event alone is rejected); 400 halves (one event alone is kept and the organisation stops);
 * network errors, time-outs and 5xx back off 1, 2, 4 … 60 s for up to 5 minutes, then the pass gives up (the spool
 * stays; the next hook starts another uploader).
 *
 * Crash safety (docs/15 §Guarantees 7): the server de-duplicates on `event_id`, and a spool file is rewritten (tmp +
 * rename) only after the server has answered and after any re-spooled or set-aside copy is on disk, so a crash at any
 * point re-sends at worst events the server already has, and loses none.
 */
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { EventsResponse } from "@align/core/api";
import { ApiClient, ApiError, type FetchLike, isOffline, normalizeServer } from "../api";
import { CredentialStore, type Keychain } from "../credentials";
import { CorruptFileError } from "../fsx";
import type { TraceEvent } from "../hook/events";
import { logCount } from "../hook/log";
import type { Paths } from "../paths";
import { type Registry, readRegistryStrict } from "../registry";
import { readSessionIndex } from "../sessions";
import { resolveConflict } from "./conflict";
import { readDeleted, repairDeleted } from "./deleted";
import {
  listSpool,
  quarantineUnreadable,
  readSpoolFile,
  rewriteSpoolFile,
  type SpoolEntry,
  type SpoolFile,
  setAside,
  writeSpoolFile,
} from "./spool";
import { clearLoginRequired, setLoginRequired, updateUploadState } from "./state";

export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_GZIP_BYTES = 1024 * 1024;
/** Raw JSON per batch before compression (the server inflates at most 8 MB). */
export const MAX_BATCH_RAW_BYTES = 6 * 1024 * 1024;
export const BACKOFF_BUDGET_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 60_000;
/** A re-spooled event that conflicts this many times is given up (rejected) instead of looping. */
export const MAX_CONFLICT_ATTEMPTS = 3;
const POST_TIMEOUT_MS = 30_000;

/** Named points where a test can simulate a crash (`fault` throws; the pass stops with the disk as it is). */
export type FaultStep = "loaded" | "before_send" | "after_send" | "after_aside" | "after_rewrite";

export type SendDeps = {
  paths: Paths;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch?: FetchLike;
  keychain: Keychain | null;
  fault?: (step: FaultStep) => void;
  onProgress?: (p: { sent: number; total: number }) => void;
  backoffBudgetMs?: number;
  /**
   * Refreshes the uploader lock's heartbeat; throws when the lock is no longer this process's (another uploader took
   * it over), which ends the pass. Called before every request, so a long pass never looks like a dead uploader.
   */
  beat?: () => void;
};

export type SendResult = {
  accepted: number;
  duplicates: number;
  rejected: number;
  held: number;
  dropped: number;
  /** Events left in the spool for a later pass (retryable answers, no token, offline). */
  kept: number;
  offline: boolean;
  /** The server kept asking us to wait (whole-batch 429) until the pass's waiting budget ran out. */
  busy: boolean;
  /** The session index or the registry is unreadable: nothing was uploaded (doctor names the file). */
  corruptIndex: boolean;
  /** The deleted-session list was unreadable: this pass stopped, and the list was set aside and rewritten (D278). */
  corruptDeleted: boolean;
  loginRequired: string[];
  /** ALIGN session ids with at least one event stored or already stored in this pass (notices are fetched for them). */
  sessions: Map<string, { orgId: string; server: string }>;
};

type FileWork = { entry: SpoolEntry; file: SpoolFile; resolved: Set<number> };
type Item = { work: FileWork; index: number; event: TraceEvent; bytes: number };
type Group = { orgId: string; server: string; token: string; items: Item[] };

const emptyResult = (): SendResult => ({
  accepted: 0,
  duplicates: 0,
  rejected: 0,
  held: 0,
  dropped: 0,
  kept: 0,
  offline: false,
  busy: false,
  corruptIndex: false,
  corruptDeleted: false,
  loginRequired: [],
  sessions: new Map(),
});

/**
 * Events that must never leave the laptop: redaction did not settle (`hits.unsettled`, L10's follow-up), or the event
 * carries no redaction stamp at all (every writer redacts before spooling; one without a stamp was not redacted).
 */
const holdReason = (e: TraceEvent): string | null => {
  if (typeof e.redaction?.version !== "number") return "unredacted";
  return (e.redaction.hits?.unsettled ?? 0) > 0 ? "unsettled" : null;
};

/** Cursor and Codex hooks are user-level: their events count only where that harness was chosen (D95 (h)). */
const USER_LEVEL_HARNESSES = new Set(["cursor", "codex"]);

/** Hard rule 6: a spool file is sent only while its root is registered under the same id and opted in. */
const allowed = (registry: Registry, root: string, repoId: string) => {
  const reg = registry.repos[root];
  return reg !== undefined && reg.repo_id === repoId && reg.opted_in;
};

/** Reads the spool into groups per organisation; drops, holds and quarantines what must never be sent. */
function load(deps: SendDeps, r: SendResult): Group[] {
  const { paths } = deps;
  const registry = readRegistryStrict(paths);
  const store = new CredentialStore(paths, deps.keychain);
  const metas = new Map(store.list().map((m) => [m.org.id, m]));
  const groups = new Map<string, Group>();
  const noToken = new Set<string>();
  // Read once per pass here and again before every request (dropDisallowed): a session listed meanwhile stops there.
  const deleted = readDeleted(paths);
  for (const entry of listSpool(paths)) {
    const file = readSpoolFile(entry.path);
    if (file === "gone") continue;
    if (file === null) {
      quarantineUnreadable(paths, entry);
      logCount(paths.logs, "upload", "unreadable_file");
      continue;
    }
    const reg = registry.repos[file.root];
    // Hard rule 6: only a repository still registered, under the same id, and opted in, is ever uploaded.
    if (!reg || !allowed(registry, file.root, file.repo_id)) {
      rewriteSpoolFile(entry, file, []);
      r.dropped += file.events.length;
      logCount(
        paths.logs,
        "upload",
        reg?.opted_in === false ? "dropped_opted_out" : "dropped_unregistered",
        file.events.length,
      );
      continue;
    }
    // A session `align sessions rm` listed whose delete the server has not confirmed yet: the whole file waits, untouched
    // (nothing of it sent, held or dropped), until the delete is confirmed or refused (D278).
    const pending = file.events.filter((e) => e.session?.id && deleted.pending.has(e.session.id)).length;
    if (pending > 0) {
      r.kept += file.events.length;
      logCount(paths.logs, "upload", "kept_delete_pending", pending);
      continue;
    }
    const held: { event: TraceEvent; code: string }[] = [];
    const otherHarness: TraceEvent[] = [];
    const events: TraceEvent[] = [];
    let ofDeleted = 0;
    for (const e of file.events) {
      // A session the server confirmed deleted: never sent, never set aside, dropped from the spool (D278).
      if (e.session?.id && deleted.confirmed.has(e.session.id)) {
        ofDeleted++;
        continue;
      }
      const why = holdReason(e);
      const name = typeof e.harness.name === "string" ? e.harness.name : "";
      if (why) held.push({ event: e, code: why });
      else if (USER_LEVEL_HARNESSES.has(name) && !reg.harnesses.includes(name)) otherHarness.push(e);
      else events.push(e);
    }
    if (held.length > 0) {
      setAside(paths, "held", entry, file, held, deps.now());
      r.held += held.length;
      for (const code of new Set(held.map((h) => h.code)))
        logCount(paths.logs, "upload", `held_${code}`, held.filter((h) => h.code === code).length);
    }
    if (ofDeleted > 0) {
      r.dropped += ofDeleted;
      logCount(paths.logs, "upload", "dropped_session_deleted", ofDeleted);
    }
    if (otherHarness.length > 0) {
      r.dropped += otherHarness.length;
      logCount(paths.logs, "upload", "dropped_harness_not_chosen", otherHarness.length);
    }
    if (events.length !== file.events.length) rewriteSpoolFile(entry, file, events);
    if (events.length === 0) continue;
    const meta = metas.get(reg.org_id);
    const server = meta ? normalizeServer(meta.server) : null;
    const token = meta && server ? store.tokenFor(reg.org_id, meta.server) : null;
    if (!meta || !server || !token) {
      r.kept += events.length;
      noToken.add(reg.org_id);
      continue;
    }
    const key = `${reg.org_id} ${server}`;
    let g = groups.get(key);
    if (!g) {
      g = { orgId: reg.org_id, server, token, items: [] };
      groups.set(key, g);
    }
    const work: FileWork = { entry, file: { ...file, events }, resolved: new Set() };
    events.forEach((event, index) => {
      g.items.push({ work, index, event, bytes: Buffer.byteLength(JSON.stringify(event), "utf8") + 1 });
    });
  }
  if (noToken.size > 0) logCount(paths.logs, "upload", "no_token", noToken.size);
  r.loginRequired.push(...noToken);
  return [...groups.values()];
}

type Verdict =
  | { kind: "done" }
  | { kind: "keep" }
  | { kind: "reject"; code: string }
  | { kind: "conflict"; id?: string };

/**
 * Writes the outcome of one batch to disk: set-aside and re-spooled copies first, then each touched spool file
 * rewritten with what is still to send (or deleted).
 */
function apply(deps: SendDeps, batch: Item[], verdicts: Verdict[], r: SendResult, minted: Map<string, string>): void {
  const { paths } = deps;
  const now = deps.now();
  const rejects = new Map<FileWork, { event: unknown; code: string }[]>();
  const respool = new Map<FileWork, TraceEvent[]>();
  batch.forEach((item, i) => {
    const v = verdicts[i] ?? { kind: "keep" };
    if (v.kind === "keep") return;
    item.work.resolved.add(item.index);
    if (v.kind === "done") return;
    if (v.kind === "conflict") {
      const harness = typeof item.event.harness.name === "string" ? item.event.harness.name : null;
      const hsid = typeof item.event.harness.session_id === "string" ? item.event.harness.session_id : null;
      const oldId = item.event.session.id;
      if (harness && hsid && oldId && item.work.file.attempts < MAX_CONFLICT_ATTEMPTS) {
        const newId = resolveConflict(
          paths,
          { harness, harnessSessionId: hsid, oldId, serverId: v.id ?? null, now },
          minted,
        );
        const list = respool.get(item.work) ?? [];
        list.push({ ...item.event, session: { id: newId } });
        respool.set(item.work, list);
        logCount(paths.logs, "upload", "session_conflict");
        return;
      }
    }
    const code = v.kind === "reject" ? v.code : "session_conflict";
    const list = rejects.get(item.work) ?? [];
    list.push({ event: item.event, code });
    rejects.set(item.work, list);
    r.rejected++;
    logCount(paths.logs, "upload", `rejected_${code}`);
  });
  const deleted = rejects.size > 0 ? readDeleted(paths).all : new Set<string>();
  for (const [work, items] of rejects)
    setAside(
      paths,
      "rejected",
      work.entry,
      work.file,
      items.filter((x) => !deleted.has((x.event as TraceEvent).session?.id ?? "")),
      now,
    );
  // A re-spool is a new file: only while the repository is still allowed (an `align off` meanwhile drops it).
  const registry = respool.size > 0 ? readRegistryStrict(paths) : null;
  for (const [work, events] of respool) {
    if (registry && !allowed(registry, work.file.root, work.file.repo_id)) {
      r.dropped += events.length;
      logCount(paths.logs, "upload", "dropped_no_longer_allowed", events.length);
      continue;
    }
    writeSpoolFile(
      paths,
      work.entry.repoDir,
      { root: work.file.root, repo_id: work.file.repo_id, events, attempts: work.file.attempts + 1 },
      now,
    );
  }
  deps.fault?.("after_aside");
  // `resolved` accumulates over the pass and `file.events` stays as loaded, so each rewrite is the loaded events
  // minus everything answered so far.
  for (const work of new Set(batch.map((i) => i.work)))
    rewriteSpoolFile(
      work.entry,
      work.file,
      work.file.events.filter((_, idx) => !work.resolved.has(idx)),
    );
  deps.fault?.("after_rewrite");
}

/**
 * Items whose repository is no longer registered under that id and opted in, or whose session the person deleted
 * since the pass began: dropped from the spool, unsent.
 */
function dropDisallowed(deps: SendDeps, queue: Item[], r: SendResult): Item[] {
  const registry = readRegistryStrict(deps.paths);
  const deleted = readDeleted(deps.paths);
  const sid = (i: Item) => i.event.session?.id ?? "";
  const gone = queue.filter(
    (i) => !allowed(registry, i.work.file.root, i.work.file.repo_id) || deleted.confirmed.has(sid(i)),
  );
  // Listed since the pass began and not yet confirmed: not sent, left in the spool (the delete may still be refused).
  const waiting = queue.filter((i) => deleted.pending.has(sid(i)));
  if (gone.length === 0 && waiting.length === 0) return queue;
  for (const i of gone) i.work.resolved.add(i.index);
  for (const work of new Set(gone.map((i) => i.work)))
    rewriteSpoolFile(
      work.entry,
      work.file,
      work.file.events.filter((_, idx) => !work.resolved.has(idx)),
    );
  if (gone.length > 0) {
    r.dropped += gone.length;
    logCount(deps.paths.logs, "upload", "dropped_no_longer_allowed", gone.length);
  }
  r.kept += waiting.length;
  const out = new Set([...gone, ...waiting]);
  return queue.filter((i) => !out.has(i));
}

/** Sends one organisation's items. */
async function sendGroup(deps: SendDeps, g: Group, r: SendResult, total: { sent: number; total: number }) {
  const { paths } = deps;
  const client = new ApiClient({ server: g.server, token: g.token, fetch: deps.fetch });
  const budget = deps.backoffBudgetMs ?? BACKOFF_BUDGET_MS;
  const minted = new Map<string, string>();
  let queue = g.items;
  let limit = MAX_BATCH_EVENTS;
  // After the server said a batch took too long, the batch size grows back only after this many good batches.
  let holdGrowth = 0;
  let failures = 0;
  let waited = 0;
  const wait = async (ms: number): Promise<boolean> => {
    if (waited + ms > budget) return false;
    waited += ms;
    await deps.sleep(ms);
    return true;
  };
  const halve = (n: number) => {
    limit = Math.max(1, Math.floor(n / 2));
    holdGrowth = 2;
  };
  while (queue.length > 0) {
    // Before every request: the lock is still ours, and the repositories are still registered and opted in (an
    // `align off` during a long back-off stops what is not sent yet).
    deps.beat?.();
    queue = dropDisallowed(deps, queue, r);
    if (queue.length === 0) break;
    const batch: Item[] = [];
    let raw = 0;
    for (const item of queue) {
      if (batch.length >= limit || (batch.length > 0 && raw + item.bytes > MAX_BATCH_RAW_BYTES)) break;
      batch.push(item);
      raw += item.bytes;
    }
    const body = { batch_id: randomUUID(), events: batch.map((i) => i.event) };
    const gz = gzipSync(JSON.stringify(body));
    if (gz.byteLength > MAX_BATCH_GZIP_BYTES && batch.length > 1) {
      halve(batch.length);
      continue;
    }
    deps.fault?.("before_send");
    let verdicts: Verdict[];
    try {
      const { data } = await client.request("POST", "/events", EventsResponse, undefined, {
        gzipped: gz,
        timeoutMs: POST_TIMEOUT_MS,
      });
      const byIndex = new Map(data.rejected.map((x) => [x.index, x]));
      verdicts = batch.map((_, i) => {
        const x = byIndex.get(i);
        if (!x) return { kind: "done" };
        if (x.code === "rate_limited") return { kind: "keep" };
        if (x.code === "session_conflict")
          return x.session_id ? { kind: "conflict", id: x.session_id } : { kind: "conflict" };
        return { kind: "reject", code: x.code };
      });
      r.accepted += data.accepted;
      r.duplicates += data.duplicates;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        // 401: the token expired or was revoked; 403: this token may not upload. Either way, stop this organisation.
        if (e.status === 401) {
          setLoginRequired(paths, g.orgId, deps.now());
          r.loginRequired.push(g.orgId);
        }
        logCount(paths.logs, "upload", e.status === 401 ? "login_required" : "forbidden");
        r.kept += queue.length;
        return;
      }
      if (e instanceof ApiError && e.status === 429) {
        // D97: `in_flight` (another batch of this person is being stored: wait, never split), `too_slow` (the batch
        // took too long to check: halve it), `conflict` (a deadlock with another writer: retry); none: a window.
        const kind = e.details.busy_kind;
        if (kind === "too_slow" && batch.length > 1) halve(batch.length);
        logCount(
          paths.logs,
          "upload",
          `busy_${typeof kind === "string" && /^[a-z_]{1,20}$/.test(kind) ? kind : "window"}`,
        );
        if (await wait(Math.min(e.retryAfterMs ?? 2000, MAX_BACKOFF_MS))) continue;
        r.busy = true;
        r.kept += queue.length;
        return;
      }
      if (e instanceof ApiError && e.status === 413 && batch.length > 1) {
        halve(batch.length);
        continue;
      }
      if (e instanceof ApiError && e.status === 413) {
        verdicts = [{ kind: "reject", code: "payload_too_large" }];
      } else if (e instanceof ApiError && e.status === 400 && batch.length > 1) {
        halve(batch.length);
        continue;
      } else if (e instanceof ApiError && e.status < 500) {
        // A whole-batch refusal of a single event (400: an envelope the server cannot read), a wrong server, a route
        // that moved: nothing is quarantined on such an answer; this organisation stops for the pass.
        logCount(paths.logs, "upload", `refused_${e.status}`);
        r.kept += queue.length;
        return;
      } else {
        // Network, time-out, 5xx, or an answer we could not read: back off and try again.
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures);
        failures++;
        logCount(paths.logs, "upload", isOffline(e) ? "offline" : "server_error");
        if (await wait(delay)) continue;
        r.offline = true;
        r.kept += queue.length;
        return;
      }
    }
    // The answer came back: if another uploader took the lock meanwhile, this one stops here and leaves the batch in
    // the spool (the server de-duplicates the replay), so two uploaders never rewrite the same files.
    deps.beat?.();
    deps.fault?.("after_send");
    apply(deps, batch, verdicts, r, minted);
    failures = 0;
    if (holdGrowth > 0) holdGrowth--;
    else limit = Math.min(MAX_BATCH_EVENTS, limit * 2);
    const sent = new Set(batch);
    queue = queue.filter((i) => !sent.has(i));
    let stored = 0;
    batch.forEach((item, i) => {
      const v = verdicts[i];
      if (v?.kind === "keep") r.kept++;
      if (v?.kind === "done") {
        stored++;
        const sid = item.event.session.id;
        if (sid) r.sessions.set(sid, { orgId: g.orgId, server: g.server });
      }
    });
    if (stored > 0) {
      const at = deps.now();
      updateUploadState(paths, (s) => {
        s.last_upload = at;
      });
      clearLoginRequired(paths, g.orgId);
    }
    total.sent += batch.length;
    deps.onProgress?.({ ...total });
  }
}

/**
 * The deleted-session list does not parse: this pass sends nothing more (it must never read as "nothing deleted"), and
 * the list is moved aside and rewritten with the ids it still holds, so the next pass goes on (D278).
 */
function deletedListUnreadable(deps: SendDeps, r: SendResult): SendResult {
  logCount(deps.paths.logs, "upload", "corrupt_deleted_list");
  try {
    repairDeleted(deps.paths, deps.now());
  } catch {
    // busy lock or unwritable: tried again on the next pass
  }
  r.corruptIndex = true;
  r.corruptDeleted = true;
  return r;
}

/** One pass over the whole spool. Never throws for a server's answer; a test's simulated crash propagates. */
export async function sendSpool(deps: SendDeps): Promise<SendResult> {
  const r = emptyResult();
  try {
    readSessionIndex(deps.paths);
  } catch (e) {
    if (e instanceof CorruptFileError) {
      // A corrupt index would make conflicts mint ids twice: nothing is uploaded until it is fixed (doctor names it).
      logCount(deps.paths.logs, "upload", "corrupt_index");
      r.corruptIndex = true;
      return r;
    }
    throw e;
  }
  let groups: Group[];
  try {
    groups = load(deps, r);
  } catch (e) {
    if (!(e instanceof CorruptFileError)) throw e;
    if (e.path === deps.paths.deletedSessions) return deletedListUnreadable(deps, r);
    // A corrupt registry must never read as "nothing registered" (which would delete the spool): stop the pass.
    logCount(deps.paths.logs, "upload", "corrupt_registry");
    r.corruptIndex = true;
    return r;
  }
  deps.fault?.("loaded");
  const total = { sent: 0, total: groups.reduce((n, g) => n + g.items.length, 0) };
  for (const g of groups) {
    try {
      await sendGroup(deps, g, r, total);
    } catch (e) {
      if (e instanceof CorruptFileError && e.path === deps.paths.deletedSessions) return deletedListUnreadable(deps, r);
      if (e instanceof CorruptFileError) {
        logCount(deps.paths.logs, "upload", "corrupt_index");
        r.corruptIndex = true;
        return r;
      }
      throw e;
    }
  }
  return r;
}
