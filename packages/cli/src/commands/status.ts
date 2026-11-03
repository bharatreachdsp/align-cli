/**
 * `align status [--json]` (docs/15): what is captured here and where it goes. Works offline: the server
 * line says it is unreachable and the command still exits 0.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ClientResponse } from "@align/core/api";
import { isOffline } from "../api";
import { type Ctx, repoHere } from "../context";
import { copy } from "../copy";
import { repoHash } from "../paths";
import { checkForUpdate } from "../update";
import { countAside } from "../upload/spool";
import { readUploadState } from "../upload/state";
import { VERSION } from "../version";

export type StatusReport = {
  version: string;
  latest: string | null;
  server: { url: string; reachable: boolean };
  repository: { root: string; remote_norm: string; opted_in: boolean; harnesses: string[] } | null;
  organisation: { slug: string; name: string; signed_in: boolean; login_required: boolean } | null;
  spool: { files: number; bytes: number; refused: number; held: number };
  last_upload: string | null;
};

function spoolSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      files++;
      bytes += statSync(join(dir, name)).size;
    }
  } catch {
    // no spool yet
  }
  return { files, bytes };
}

export async function collectStatus(ctx: Ctx): Promise<StatusReport> {
  const server = ctx.server();
  const found = await repoHere(ctx);
  const orgId = found?.entry.org_id ?? null;
  const meta = orgId ? ctx.credentials.list().find((m) => m.org.id === orgId) : undefined;
  let reachable = true;
  try {
    await ctx.client().request("GET", "/client", ClientResponse, undefined, { timeoutMs: 3000, auth: false });
  } catch (e) {
    reachable = !isOffline(e);
  }
  const update = reachable ? await checkForUpdate(ctx) : null;
  const upload = readUploadState(ctx.paths);
  return {
    version: VERSION,
    latest: update?.available ? update.latest : null,
    server: { url: server, reachable },
    repository: found
      ? {
          root: found.root,
          remote_norm: found.entry.remote_norm,
          opted_in: found.entry.opted_in,
          harnesses: found.entry.harnesses,
        }
      : null,
    organisation: meta
      ? {
          slug: meta.org.slug,
          name: meta.org.name,
          signed_in: !!ctx.credentials.tokenFor(meta.org.id, server),
          login_required: meta.org.id in upload.login_required,
        }
      : null,
    spool: found
      ? {
          ...spoolSize(join(ctx.paths.spool, repoHash(found.root))),
          refused: countAside(join(ctx.paths.rejected, repoHash(found.root))),
          held: countAside(join(ctx.paths.held, repoHash(found.root))),
        }
      : { files: 0, bytes: 0, refused: 0, held: 0 },
    last_upload: upload.last_upload === null ? null : new Date(upload.last_upload).toISOString(),
  };
}

export async function status(ctx: Ctx, opts: { json?: boolean }): Promise<number> {
  const r = await collectStatus(ctx);
  if (opts.json) {
    ctx.line(JSON.stringify(r, null, 2));
    return 0;
  }
  const s = copy.status;
  ctx.line(s.repository(r.repository?.remote_norm ?? s.notConnected));
  ctx.line(
    s.organisation(
      r.organisation
        ? `${r.organisation.name}${
            !r.organisation.signed_in
              ? ` (${s.signedOut})`
              : r.organisation.login_required
                ? ` (${s.loginRequired})`
                : ""
          }`
        : s.signedOut,
    ),
  );
  ctx.line(s.optIn(r.repository ? r.repository.opted_in : null));
  ctx.line(s.harnesses(r.repository?.harnesses ?? []));
  ctx.line(s.lastUpload(r.last_upload ? copy.ago(Math.max(0, ctx.now() - Date.parse(r.last_upload))) : null));
  ctx.line(s.spool(r.spool.files, r.spool.bytes, r.spool.refused, r.spool.held));
  ctx.line(r.server.reachable ? s.serverOk(r.server.url) : s.serverOffline(r.server.url));
  ctx.line(s.version(r.version, r.latest));
  return 0;
}
