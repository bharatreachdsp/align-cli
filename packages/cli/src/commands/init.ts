/**
 * `align init` (docs/15): preflight, self-install, sign in, resolve or claim the repository, consent and opt-in,
 * then the harnesses and git hooks (steps 6–7, L12, L13), then backfill (step 8, L15: `--no-backfill`, `--days`).
 * Re-running is safe.
 */
import { realpathSync } from "node:fs";
import { ClaimResponse, compareVersions, OptinResponse, RepoState, ResolveResponse } from "@align/core/api";
import { remoteProvider } from "@align/core/remote";
import { ApiError, normalizeServer } from "../api";
import { parseDays, runBackfill } from "../backfill/run";
import { updateConfig } from "../config";
import { agentHarness } from "../confirm/person";
import { type Ctx, UserError } from "../context";
import { copy } from "../copy";
import * as gitx from "../git";
import { ensureSignedIn } from "../login";
import { turnOn } from "../optin";
import { lookupRepo, readRegistry, removeRepo, updateRegistry, upsertRepo } from "../registry";
import { findGit, installShim, isBundlePath } from "../shim";
import { VERSION } from "../version";
import { chooseHarnesses, installHarnesses } from "./harness";

export const MIN_NODE = "22.14.0";

/** `init` is interactive: git gets 10 s here (hooks keep 300 ms). */
const T = gitx.INTERACTIVE_GIT_TIMEOUT_MS;

export type InitOptions = {
  yes?: boolean;
  server?: string;
  org?: string;
  remote?: string;
  backfill?: boolean;
  harness?: string;
  days?: string;
  acceptPilotTerms?: boolean;
};

export type Preflight = {
  root: string;
  remote_norm: string;
  root_commit: string;
  default_branch: string;
  branch: string | null;
};

export async function preflight(ctx: Ctx, remote?: string): Promise<Preflight> {
  if ((ctx.deps.platform ?? process.platform) === "win32") throw new UserError(copy.windows);
  const node = (ctx.deps.nodeVersion ?? process.versions.node).replace(/^v/, "");
  if (compareVersions(node, MIN_NODE) < 0) throw new UserError(copy.nodeTooOld(node, MIN_NODE));
  const top = await gitx.toplevel(ctx.cwd, T);
  if (!top) throw new UserError(copy.notGitRepo);
  const root = realpathSync(top);
  const choice = await gitx.chooseRemote(root, remote, T);
  if (choice.kind === "none") throw new UserError(copy.noRemote);
  if (choice.kind === "ambiguous") throw new UserError(copy.ambiguousRemote(choice.remotes));
  if (choice.kind === "unrecognised") throw new UserError(copy.unrecognisedRemote(choice.remote));
  const rootCommit = await gitx.rootCommit(root, T);
  if (!rootCommit) throw new UserError(copy.noCommits);
  return {
    root,
    remote_norm: choice.remote_norm,
    root_commit: rootCommit,
    default_branch: await gitx.defaultBranch(root, choice.remote, T),
    branch: await gitx.branch(root, T),
  };
}

export async function init(ctx: Ctx, opts: InitOptions): Promise<number> {
  const started = ctx.now();
  if (opts.server) {
    const s = normalizeServer(opts.server);
    if (!s) throw new UserError(copy.badServer);
    ctx.setServerOverride(s);
  }
  if (opts.backfill !== false) parseDays(opts.days);
  ctx.line(copy.initHeader(VERSION));

  // 1. Preflight
  const pre = await preflight(ctx, opts.remote);
  ctx.line(copy.repository(pre.remote_norm, pre.branch));

  // 2. Self-install (skipped when running from source, e.g. unit tests)
  const bundle = ctx.deps.bundlePath ?? null;
  if (isBundlePath(bundle)) {
    installShim(ctx.paths, {
      bundleSource: bundle,
      nodePath: ctx.deps.nodePath ?? process.execPath,
      version: VERSION,
      gitPath: findGit(ctx.env.PATH),
    });
  }
  if (opts.server) {
    const server = ctx.server();
    updateConfig(ctx.paths, (c) => {
      c.server = server;
    });
  }

  // 3. Sign in
  const me = await ensureSignedIn(ctx, { org: opts.org });
  const api = ctx.clientFor(me.org.id);
  if (!api) throw new UserError(copy.loginRequired);

  // 4. Repository: resolve, claim when unclaimed
  const identity = {
    remote_norm: pre.remote_norm,
    root_commit: pre.root_commit,
    default_branch: pre.default_branch,
    provider: remoteProvider(pre.remote_norm),
  };
  const { data: resolved } = await api.request("POST", "/repos/resolve", ResolveResponse, identity);
  let repo: { id: string };
  let first = false;
  let serverOptedIn = false;
  if (resolved.status === "other_org") {
    // An earlier opt-in on this laptop (the repository moved to another organisation since) stops here.
    if (lookupRepo(readRegistry(ctx.paths), pre.root)) {
      removeRepo(ctx.paths, pre.root);
      ctx.line(copy.captureStoppedHere(pre.remote_norm));
    }
    ctx.line(copy.otherOrg(pre.remote_norm, resolved.org_name));
    ctx.line(
      resolved.auto_join_url
        ? copy.otherOrgJoin(resolved.auto_join_url)
        : copy.otherOrgAsk(resolved.request_access_url ?? null),
    );
    return 1;
  }
  if (resolved.status === "unclaimed") {
    const { data } = await api.request("POST", "/repos/claim", ClaimResponse, identity);
    repo = data.repo;
    first = true;
  } else {
    repo = resolved.repo;
    serverOptedIn = resolved.opted_in;
    if (resolved.access === null) {
      // Connected, no access (a member without a repo_access row): claim proves the clone with the root commit;
      // owners and admins already get `owner`/`admin` from their role and never claim here (L20, PR #30).
      try {
        await api.request("POST", "/repos/claim", ClaimResponse, identity);
      } catch (e) {
        if (e instanceof ApiError && e.code === "forbidden") {
          ctx.line(copy.noAccessYet(pre.remote_norm, me.org.name));
          return 1;
        }
        throw e;
      }
    }
  }
  ctx.line(copy.organisation(me.org.name, first));

  // 5. Consent and opt-in
  const repoPath = `/repos/${encodeURIComponent(repo.id)}`;
  const { data: state } = await api.request("GET", `${repoPath}/state`, RepoState);
  const known = lookupRepo(readRegistry(ctx.paths), pre.root);
  const alreadyIn = serverOptedIn && state.opted_in && known?.root === pre.root && known.entry.opted_in;
  let optIn = alreadyIn;
  if (!alreadyIn) {
    // D517: a first opt-in is confirmed in the console; `--yes` and `--accept-pilot-terms` no longer opt in.
    const outcome = await turnOn(ctx, api, repoPath, pre.remote_norm, state);
    if (outcome === "failed") return 1;
    optIn = outcome === "in";
    if (!optIn && (serverOptedIn || state.opted_in)) {
      // "No" while the server still has this person opted in (an earlier run, another laptop): tell it.
      await api.request("PUT", `${repoPath}/optin`, OptinResponse, { opted_in: false });
    }
  }
  updateConfig(ctx.paths, (c) => {
    c.orgs[me.org.id] = {
      slug: me.org.slug,
      name: me.org.name,
      email_domains: state.email_domains,
      updated_at: ctx.now(),
    };
  });
  upsertRepo(ctx.paths, pre.root, {
    repo_id: repo.id,
    org_id: me.org.id,
    remote_norm: pre.remote_norm,
    root_commit: pre.root_commit,
    default_branch: pre.default_branch,
    opted_in: optIn,
    harnesses: known?.root === pre.root ? known.entry.harnesses : [],
    installed_at: known?.root === pre.root ? known.entry.installed_at : new Date(ctx.now()).toISOString(),
  });
  if (!optIn) {
    ctx.line(copy.notOptedIn);
    return 0;
  }
  ctx.line(copy.optedIn(pre.remote_norm));

  // 6–7. Harnesses: detect, ask, install hooks, git hooks and the local exclude lines.
  const chosen = await chooseHarnesses(ctx, { harness: opts.harness, yes: opts.yes });
  const harnesses = await installHarnesses(
    ctx,
    pre.root,
    chosen,
    known?.root === pre.root ? known.entry.harnesses : [],
  );
  updateRegistry(ctx.paths, (r) => {
    const e = r.repos[pre.root];
    if (e) e.harnesses = harnesses;
  });

  // 8. Backfill (unless --no-backfill): the chosen harnesses' recent sessions, with consent (L15).
  let code = 0;
  let proposals = false;
  if (opts.backfill !== false) {
    const entry = lookupRepo(readRegistry(ctx.paths), pre.root);
    const agent = agentHarness(ctx.env);
    if (agent) {
      // Only a person agrees to upload past sessions (D405): init itself carries on, the backfill step does not run.
      ctx.line();
      ctx.line(copy.backfill.agent(agent));
    } else if (entry?.root === pre.root) {
      ctx.line();
      code = await runBackfill(
        ctx,
        { root: pre.root, entry: entry.entry, api, state },
        { ...opts, onSummary: (s) => (proposals = s.proposals > 0) },
      );
    }
  }

  ctx.line(
    copy.initDone(Math.max(1, Math.round((ctx.now() - started) / 1000)), {
      proposals,
      console: copy.consoleUrl(ctx.server()),
    }),
  );
  return code;
}
