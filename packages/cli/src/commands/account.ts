/**
 * `align login [--org]`, `align logout [--all]`, `align on`, `align off`, `align uninstall [--purge]`
 * (docs/15). `off` stops capture on this laptop before it tells the server, so it takes effect at once.
 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { LogoutResponse, OptinResponse, RepoState } from "@align/core/api";
import { HOME_DIR_NAME } from "@align/core/brand";
import { ApiError } from "../api";
import { type Ctx, repoHere, UserError } from "../context";
import { copy } from "../copy";
import { INTERACTIVE_GIT_TIMEOUT_MS, toplevel } from "../git";
import { deviceLogin, ensureSignedIn } from "../login";
import { turnOn } from "../optin";
import { forgetPacks } from "../pack/serve";
import { readRegistry, removeRepo, setOptedIn } from "../registry";
import { hasInstalled, removeUserHooks, uninstallHarnesses } from "./harness";

const realOrSelf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export async function login(ctx: Ctx, opts: { org?: string }): Promise<number> {
  const meta = opts.org ? await ensureSignedIn(ctx, { org: opts.org }) : await deviceLogin(ctx);
  ctx.line(copy.loggedIn(meta.org.name));
  return 0;
}

async function revoke(ctx: Ctx, orgId: string): Promise<boolean> {
  const api = ctx.clientFor(orgId);
  if (!api) return true;
  try {
    await api.request("POST", "/auth/logout", LogoutResponse, undefined, { timeoutMs: 5000 });
    return true;
  } catch (e) {
    // an already revoked or expired token is signed out as far as the server is concerned
    return e instanceof ApiError && (e.status === 401 || e.code === "unauthorized" || e.code === "token_expired");
  }
}

export async function logout(ctx: Ctx, opts: { all?: boolean }): Promise<number> {
  const server = ctx.server();
  const metas = ctx.credentials.list();
  let targets = metas;
  if (!opts.all) {
    const found = await repoHere(ctx);
    const here = metas.filter((m) => m.server === server);
    targets = found ? here.filter((m) => m.org.id === found.entry.org_id) : here.length === 1 ? here : [];
    if (!found && here.length > 1) throw new UserError(copy.chooseOrg(here.map((m) => m.org.slug).sort()));
  }
  if (targets.length === 0) {
    ctx.line(copy.notLoggedIn);
    return 0;
  }
  for (const m of targets) {
    const revoked = m.server === server ? await revoke(ctx, m.org.id) : false;
    ctx.credentials.remove(m.org.id);
    // Signed out: the organisation's packs are no longer this person's to show (D402).
    for (const [root, e] of Object.entries(readRegistry(ctx.paths).repos))
      if (e.org_id === m.org.id) forgetPacks(ctx.paths, root);
    ctx.line(revoked ? copy.loggedOut(m.org.name) : copy.loggedOutLocalOnly(m.org.name));
  }
  return 0;
}

async function hereOrFail(ctx: Ctx) {
  const found = await repoHere(ctx);
  if (!found) throw new UserError(copy.notRegistered);
  return found;
}

export async function setCapture(ctx: Ctx, on: boolean): Promise<number> {
  const { root, entry } = await hereOrFail(ctx);
  if (!on) {
    // Stop capture first, then drop what was captured but not sent yet (D241), then tell the server.
    setOptedIn(ctx.paths, root, false);
    rmSync(ctx.paths.spoolFor(root), { recursive: true, force: true });
  }
  const api = ctx.clientFor(entry.org_id);
  if (!api) {
    if (!on) {
      ctx.line(copy.offDone(entry.remote_norm));
      ctx.line(copy.offServerPending);
      return 0;
    }
    throw new UserError(copy.loginRequired);
  }
  if (on) {
    // D517: on is the console unless the server already holds a live opt-in (then this laptop just resumes); nothing
    // is asked on the terminal. Off never asks.
    const repoPath = `/repos/${encodeURIComponent(entry.repo_id)}`;
    const { data: state } = await api.request("GET", `${repoPath}/state`, RepoState);
    const outcome = await turnOn(ctx, api, repoPath, entry.remote_norm, state);
    if (outcome === "failed") return 1;
    if (outcome === "declined") {
      ctx.line(copy.notOptedIn);
      return 0;
    }
    setOptedIn(ctx.paths, root, true);
    ctx.line(copy.onDone(entry.remote_norm));
    return 0;
  }
  try {
    await api.request("PUT", `/repos/${encodeURIComponent(entry.repo_id)}/optin`, OptinResponse, { opted_in: false });
  } catch {
    // Capture already stopped on this laptop; the server is told on the next `off`.
    ctx.line(copy.offDone(entry.remote_norm));
    ctx.line(copy.offServerPending);
    return 0;
  }
  ctx.line(copy.offDone(entry.remote_norm));
  return 0;
}

/** What `--purge` may delete inside `~/.align`, by name; anything else there is left alone. */
const OWN_ENTRIES =
  /^(?:bin|lib|repos|sessions|spool|cache|logs|hooks|harness|salt|(?:credentials|config|repos|upload)\.json(?:\.lock|\.corrupt-\d+|\.\d+\.[0-9a-f]+\.tmp)?)$/;

/** Only a directory named `.align` (or `ALIGN_HOME`'s own, if named so), never `$HOME` or `/`. */
function isOwnHome(home: string): boolean {
  if (basename(home) !== HOME_DIR_NAME) return false;
  try {
    return lstatSync(home).isDirectory();
  } catch {
    return false;
  }
}

/** Deletes ALIGN's own entries by name, then the directory itself if nothing else is in it. */
function purgeHome(home: string): void {
  for (const name of readdirSync(home)) {
    if (OWN_ENTRIES.test(name)) rmSync(join(home, name), { recursive: true, force: true });
  }
  try {
    rmdirSync(home);
  } catch {
    // something that is not ours is still there: keep it
  }
}

/**
 * Removes what was installed for this repository (Claude Code hook entries, git hook wrappers with the originals
 * restored, exclude lines; L13 adds Cursor and Codex) and its registry entry (capture stops); with `--purge`, signs
 * out everywhere and deletes `~/.align`.
 */
export async function uninstall(ctx: Ctx, opts: { purge?: boolean; yes?: boolean }): Promise<number> {
  const found = await repoHere(ctx);
  if (opts.purge && !opts.yes) throw new UserError(copy.purgeNeedsYes);
  if (found) {
    // Capture stops first, whatever happens to the files after.
    removeRepo(ctx.paths, found.root);
    rmSync(ctx.paths.spoolFor(found.root), { recursive: true, force: true });
    uninstallHarnesses(ctx, found.root);
    ctx.line(copy.uninstalled(found.entry.remote_norm));
  } else {
    // An earlier uninstall that could not remove everything: no registry entry any more, but leftovers recorded.
    const top = await toplevel(ctx.cwd, INTERACTIVE_GIT_TIMEOUT_MS);
    const root = top ? realOrSelf(top) : null;
    if (root && hasInstalled(ctx, root)) {
      if (uninstallHarnesses(ctx, root)) ctx.line(copy.uninstallLeftovers);
    } else if (!opts.purge) ctx.line(copy.uninstallNothing);
  }
  if (opts.purge) {
    if (!isOwnHome(ctx.paths.home)) throw new UserError(copy.purgeRefused(ctx.paths.home));
    await logout(ctx, { all: true });
    removeUserHooks(ctx);
    purgeHome(ctx.paths.home);
    ctx.line(copy.purged(ctx.paths.home));
  }
  return 0;
}
