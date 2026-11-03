/**
 * `align sessions [list | show ID | rm ID]` (docs/15 §Commands, docs/25 §Capture): what was kept from the person's own
 * sessions in this repository, and deleting one. `rm` needs a `y` typed on the person's terminal (`/dev/tty`; there is
 * no `--yes`, D278), lists the session as deleted on this laptop (upload/deleted.ts: the uploader never sends or sets
 * aside its events from then on), deletes on the server (`DELETE /sessions/:id`: the session's lines, and everything
 * derived only from it), then purges this laptop: the session's events still in the spool (and in `rejected/` and
 * `held/`), its notice file and its marks. When the server refused, nothing is purged and the session is unlisted.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DeleteSessionResponse, SessionDetail, SessionsPage } from "@align/core/api";
import type { z } from "zod";
import { ApiError } from "../api";
import { flat } from "../confirm/card";
import { askTty } from "../confirm/person";
import type { Ctx } from "../context";
import { repoHere, UserError } from "../context";
import { copy } from "../copy";
import { writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";
import { confirmDeleted, markDeleted, unmarkDeleted } from "../upload/deleted";
import { tryLock, unlock } from "../upload/lock";
import { listSpool, readSpoolFile, rewriteSpoolFile } from "../upload/spool";
import { requirePerson, typedYes } from "./confirm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

async function here(ctx: Ctx) {
  const found = await repoHere(ctx);
  if (!found) throw new UserError(copy.notRegistered);
  const api = ctx.clientFor(found.entry.org_id);
  if (!api) throw new UserError(copy.loginRequired);
  return { api, repoId: found.entry.repo_id };
}

function sessionId(id: string | undefined): string {
  const v = (id ?? "").trim().toLowerCase();
  if (!UUID.test(v)) throw new UserError(copy.sessions.badId, 2);
  return v;
}

export async function sessions(
  ctx: Ctx,
  action: string | undefined,
  id: string | undefined,
  _o: Record<string, never>,
  ttyAsk: (q: string) => Promise<string | null> = askTty,
) {
  const { api, repoId } = await here(ctx);
  if (!action || action === "list") {
    const items: z.infer<typeof SessionsPage>["items"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const q: string = `repo_id=${encodeURIComponent(repoId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: { data: z.infer<typeof SessionsPage> } = await api.request("GET", `/sessions?${q}`, SessionsPage);
      const data = res.data;
      items.push(...data.items);
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    if (items.length === 0) {
      ctx.line(copy.sessions.none);
      return 0;
    }
    for (const s of items)
      ctx.line(
        copy.sessions.line(flat(s.id), flat(s.harness), s.source, when(s.started_at), s.lines, s.proposed, s.cited),
      );
    return 0;
  }
  if (action === "show") {
    const sid = sessionId(id);
    const { data } = await api.request("GET", `/sessions/${sid}`, SessionDetail);
    ctx.line(
      copy.sessions.line(
        data.id,
        flat(data.harness),
        data.source,
        when(data.started_at),
        data.lines,
        data.proposed,
        data.cited,
      ),
    );
    ctx.line(
      copy.sessions.detail(data.branch ? flat(data.branch) : null, flat(data.compile_state), when(data.ended_at)),
    );
    for (const e of data.entries)
      ctx.line(`  ${flat(e.key).padEnd(8)} ${flat(e.status).padEnd(10)} “${flat(e.statement)}”`);
    return 0;
  }
  if (action === "rm") {
    const sid = sessionId(id);
    // Deleting is the person's act (D404): never from an agent's shell, and always a y typed on their own terminal.
    requirePerson(ctx.env);
    try {
      await typedYes(ttyAsk, copy.sessions.ask(sid));
    } catch (e) {
      if (!(e instanceof UserError && e.message === copy.confirm.cancelled)) throw e;
      ctx.line(copy.sessions.kept);
      return 0;
    }
    // Listed first, so an upload already running stops sending the session before the server deletes it (D278).
    markDeleted(ctx.paths, sid, ctx.now());
    let result = { withdrawn: 0, scrubbed: 0, kept_confirmed: 0 };
    try {
      const { data } = await api.request("DELETE", `/sessions/${sid}`, DeleteSessionResponse, undefined, {
        idempotencyKey: `cli-rm-${sid}`,
      });
      result = data;
    } catch (e) {
      // Already gone on the server (or never uploaded): what is left on this laptop goes all the same.
      if (!(e instanceof ApiError && e.code === "entry_not_found")) {
        unmarkDeleted(ctx.paths, sid, ctx.now());
        throw e;
      }
    }
    const purged = await purgeLocal(ctx.paths, sid, ctx.now, ctx.sleep);
    ctx.line(copy.sessions.deleted(result.withdrawn, result.scrubbed, result.kept_confirmed, purged));
    return 0;
  }
  throw new UserError(copy.sessions.usage, 2);
}

/**
 * Removes the session's events from the spool, `rejected/` and `held/`, and its notice file and marks. Takes the
 * uploader's lock when it can (so a running upload does not write the events back); without it the spool is left to
 * the uploader, which drops the listed session's events itself.
 */
export async function purgeLocal(
  paths: Paths,
  sid: string,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  // Called only once the server deleted the session (or no longer has it): from now on its events may go, here or in
  // the uploader; until this, a listed session's events were only held back (D278).
  confirmDeleted(paths, sid, now());
  // A running upload holds the lock and rewrites the spool files it loaded: wait for it a little; if it is still
  // busy, the spool files are left to it (other sessions' events in them must not be lost): it drops the confirmed
  // session's events itself, before every request and before setting anything aside (upload/deleted.ts, D278).
  let locked = tryLock(paths, now());
  for (let i = 0; i < 10 && !locked; i++) {
    await sleep(500);
    locked = tryLock(paths, now());
  }
  let purged = 0;
  try {
    for (const entry of listSpool(paths)) {
      const file = readSpoolFile(entry.path);
      if (file === null || file === "gone") continue;
      const remaining = file.events.filter((e) => e.session?.id !== sid);
      if (remaining.length === file.events.length) continue;
      if (!locked) continue;
      purged += file.events.length - remaining.length;
      rewriteSpoolFile(entry, file, remaining);
    }
    for (const side of [paths.rejected, paths.held]) {
      let dirs: string[] = [];
      try {
        dirs = readdirSync(side);
      } catch {
        continue;
      }
      for (const d of dirs) {
        let names: string[] = [];
        try {
          names = readdirSync(join(side, d));
        } catch {
          continue;
        }
        for (const n of names) {
          if (!n.endsWith(".json")) continue;
          const p = join(side, d, n);
          try {
            const v = JSON.parse(readFileSync(p, "utf8")) as { items?: { event?: { session?: { id?: string } } }[] };
            if (!Array.isArray(v.items)) continue;
            const keep = v.items.filter((i) => i?.event?.session?.id !== sid);
            if (keep.length === v.items.length) continue;
            purged += v.items.length - keep.length;
            if (keep.length === 0) rmSync(p, { force: true });
            else writeJsonAtomic(p, { ...v, items: keep });
          } catch {
            // unreadable: left for doctor
          }
        }
      }
    }
    rmSync(paths.sessionNotice(sid), { force: true });
    rmSync(paths.sessionMarks(sid), { recursive: true, force: true });
  } finally {
    if (locked) unlock(paths);
  }
  return purged;
}
