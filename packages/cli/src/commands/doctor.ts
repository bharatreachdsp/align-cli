/**
 * `align doctor [--json]` (docs/15 §align doctor checks): the first checks — Node, shim and bundle, token,
 * server reachability and clock skew, repository registration. Harness, git-hook, transcript, spool and
 * upload checks join as L12–L15 add those pieces. Each failure prints one fix line; exit 1 if any fail.
 */
import { existsSync, realpathSync } from "node:fs";
import { ClientResponse, compareVersions, MeResponse } from "@align/core/api";
import { ApiError } from "../api";
import { type Ctx, repoHere } from "../context";
import { copy } from "../copy";
import { CorruptFileError, fileMode, PRIVATE_MODE, readJsonFile } from "../fsx";
import { installedBundle, isBundlePath, sha256File } from "../shim";
import { readDeleted } from "../upload/deleted";
import { hardLinksWork } from "../upload/lock";
import { countAside, spoolStats } from "../upload/spool";
import { readUploadState } from "../upload/state";
import { VERSION } from "../version";
import { harnessChecks, removePluginDuplicates } from "./harness";
import { MIN_NODE } from "./init";

export type Check = { id: string; ok: boolean; label: string; fix?: string };

const MAX_SKEW_MS = 2 * 60 * 1000;
/** A spool file older than this means uploads are not draining. */
const SPOOL_STALE_MS = 24 * 60 * 60 * 1000;

const realOrSelf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export async function runChecks(ctx: Ctx): Promise<Check[]> {
  const d = copy.doctor;
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, label: string, fix: string) =>
    checks.push({ id, ok, label, ...(ok ? {} : { fix }) });

  const node = (ctx.deps.nodeVersion ?? process.versions.node).replace(/^v/, "");
  add("node", compareVersions(node, MIN_NODE) >= 0, d.node(node), d.nodeFix(MIN_NODE));

  const installed = installedBundle(ctx.paths);
  add("shim", existsSync(ctx.paths.shim) && installed !== null, d.shim, d.shimFix);
  const expected = realOrSelf(ctx.paths.bundle(VERSION));
  const running = ctx.deps.bundlePath ?? null;
  const bundleOk = installed === expected && (!isBundlePath(running) || sha256File(running) === sha256File(expected));
  add("bundle", bundleOk, d.bundle(VERSION), d.bundleFix);

  const server = ctx.server();
  const found = await repoHere(ctx);
  const metas = ctx.credentials.list().filter((m) => m.server === server);
  const meta =
    (found && metas.find((m) => m.org.id === found.entry.org_id)) ?? (metas.length === 1 ? metas[0] : undefined);
  let reachable = false;
  let tokenOk = false;
  let skewOk = false;
  const api = meta ? ctx.clientFor(meta.org.id) : null;
  if (api) {
    try {
      const before = ctx.now();
      const { date } = await api.request("GET", "/me", MeResponse, undefined, { timeoutMs: 5000 });
      reachable = true;
      tokenOk = true;
      skewOk = date !== null && Math.abs(date.getTime() - (before + ctx.now()) / 2) < MAX_SKEW_MS;
    } catch (e) {
      reachable = e instanceof ApiError;
    }
  } else {
    try {
      const { date } = await ctx.client().request("GET", "/client", ClientResponse, undefined, {
        timeoutMs: 5000,
        auth: false,
      });
      reachable = true;
      skewOk = date !== null && Math.abs(date.getTime() - ctx.now()) < MAX_SKEW_MS;
    } catch (e) {
      reachable = e instanceof ApiError;
    }
  }
  add("token", tokenOk, meta ? d.token(meta.org.name) : d.tokenNone, d.tokenFix);
  add("server", reachable, d.server(server), d.serverFix);
  add("clock", reachable && skewOk, d.clock, d.clockFix);
  add("repo", !!found?.entry.opted_in, d.repo, d.repoFix);
  if (found?.entry.opted_in) {
    for (const c of await harnessChecks(ctx, found.root, found.entry.harnesses)) add(c.id, c.ok, c.label, c.fix);
  }
  for (const store of ctx.credentials.stores()) {
    if (store === "keychain") add("store", true, d.storeKeychain, "");
    else add("store", fileMode(ctx.paths.credentials) === PRIVATE_MODE, d.storeFile, d.storeFileFix);
  }
  // A corrupt registry or session index stops capture (it is never overwritten); say which file.
  const corrupt = [ctx.paths.repos, ctx.paths.sessionsIndex].find((f) => {
    try {
      readJsonFile(
        f,
        (v) => v,
        () => null,
      );
      return false;
    } catch (e) {
      return e instanceof CorruptFileError;
    }
  });
  add("files", corrupt === undefined, d.files, d.filesFix(corrupt ?? ""));
  // A corrupt deleted-session list stops uploads until the uploader sets it aside (D278).
  let deletedOk = true;
  try {
    readDeleted(ctx.paths);
  } catch (e) {
    if (!(e instanceof CorruptFileError)) throw e;
    deletedOk = false;
  }
  add("deleted", deletedOk, d.deletedList, d.deletedListFix);
  // The uploader lock is created by hard link; without them it falls back to a weaker create (D1242). Shown only then.
  if (existsSync(ctx.paths.spool) && !hardLinksWork(ctx.paths.spool)) add("links", false, d.links, d.linksFix);

  // The uploader (L14): spool size and age, last upload, refused and held events, a refused token.
  const upload = readUploadState(ctx.paths);
  const spool = spoolStats(ctx.paths.spool);
  const age = (t: number | null) => (t === null ? null : copy.ago(Math.max(0, ctx.now() - t)));
  add(
    "spool",
    spool.oldest === null || ctx.now() - spool.oldest < SPOOL_STALE_MS,
    d.spool(spool.files, spool.bytes, age(spool.oldest)),
    d.spoolFix,
  );
  add("last_upload", true, d.lastUpload(age(upload.last_upload)), "");
  const refusedOrgs = Object.keys(upload.login_required);
  add("upload_sign_in", refusedOrgs.length === 0, d.uploadSignIn, d.uploadSignInFix);
  const rejected = countAside(ctx.paths.rejected);
  if (rejected > 0) add("rejected", true, d.rejected(rejected), "");
  const held = countAside(ctx.paths.held);
  if (held > 0) add("held", true, d.held(held), "");
  return checks;
}

export async function doctor(ctx: Ctx, opts: { json?: boolean }): Promise<number> {
  let checks = await runChecks(ctx);
  // Hooks left in the settings file from before the ALIGN plugin: offered for removal on a terminal (L41).
  if (!opts.json && ctx.io.isTTY && checks.some((c) => c.id === "claude_code_duplicate" && !c.ok)) {
    const found = await repoHere(ctx);
    const answer = ((await ctx.ask(copy.doctor.claudeDuplicateAsk)) ?? "").trim().toLowerCase();
    if (found && (answer === "" || answer === "y" || answer === "yes")) {
      const r = removePluginDuplicates(ctx, found.root);
      ctx.line(r.left ? copy.doctor.claudeDuplicateLeft : copy.doctor.claudeDuplicateRemoved(r.backup));
      checks = await runChecks(ctx);
    }
  }
  const failed = checks.filter((c) => !c.ok).length;
  if (opts.json) {
    ctx.line(JSON.stringify({ ok: failed === 0, checks }, null, 2));
  } else {
    for (const c of checks) ctx.line(c.ok ? copy.doctor.ok(c.label) : copy.doctor.fail(c.label, c.fix ?? ""));
    ctx.line(failed ? copy.doctor.summaryFail(failed) : copy.doctor.summaryOk);
  }
  return failed ? 1 : 0;
}
