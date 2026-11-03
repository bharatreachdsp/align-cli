/**
 * `align verify [--json]` (docs/15 §Commands, docs/13 §Default-branch verification; D406, D423): fetch the checks that
 * may run here (active ones, and the person's own private proposals' ones), run them on the commit checked out (HEAD's
 * blobs: what is reported, `POST /check-results` with paths, line numbers and rule names only) and, for this laptop
 * only, on the working tree with its uncommitted changes. Registered and opted-in repositories only (hard rule 6).
 * Exit 0 whatever the results (they are advisory); 1 when the checks could not be fetched or reported in full.
 */
import { ApiError, isOffline } from "../api";
import { type LocalResult, reportCommit, runLocalChecks, textContext } from "../checks/fs-local";
import { contradicted, fetchChecks, postResults, ReportError, type Reported } from "../checks/report";
import { type Ctx, repoHere, UserError } from "../context";
import { copy } from "../copy";
import * as gitx from "../git";
import { redactionContext } from "../hook/events";

export type VerifyOptions = { json?: boolean };

/** One line per result, for a person (paths are shown on this laptop only). */
export function resultLine(r: LocalResult, worktree?: LocalResult): string {
  const key = r.entry_key.replace(/[^A-Za-z0-9-]/g, "").slice(0, 16);
  const kind = r.kind.replace(/[^a-z_]/g, "").slice(0, 24);
  let line: string;
  if (r.result === "pass") line = copy.verify.pass(key, kind);
  else if (r.result === "skipped") line = copy.verify.skipped(key, kind);
  else if (r.result === "error") line = copy.verify.error(key, kind, (r.reason ?? "error").replace(/[^a-z_]/g, ""));
  else {
    const [first] = r.matches;
    const where = first ? `${first.path}${first.line > 0 ? `:${first.line}` : ""}` : "";
    line = copy.verify.fail(key, kind, where, Math.max(0, r.matches.length - 1));
  }
  if (worktree && worktree.result !== r.result)
    line += copy.verify.worktree(copy.verify.worktreeWord[worktree.result] ?? worktree.result);
  return line;
}

export async function verify(ctx: Ctx, o: VerifyOptions): Promise<number> {
  const found = await repoHere(ctx);
  if (!found?.entry.opted_in) throw new UserError(copy.notRegistered);
  const api = ctx.clientFor(found.entry.org_id);
  if (!api) throw new UserError(copy.loginRequired);
  const head = await gitx.head(found.root, gitx.INTERACTIVE_GIT_TIMEOUT_MS);
  if (!head || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new UserError(copy.verify.noCommit);
  // Results are reported under the newest commit HEAD shares with a remote (D409); none → nothing is reported.
  const base = await reportCommit(found.root, found.entry.remote_norm, ctx.env);
  let checks = await fetchChecks(api, found.entry.repo_id);
  if (checks.length === 0) {
    if (o.json)
      ctx.io.out(
        `${JSON.stringify(
          base
            ? { sha: base, results: [], conflicts_opened: 0, conflicts_resolved: 0, reported: "all" }
            : { sha: null, results: [], reported: "none", reason: "no_shared_commit" },
        )}\n`,
      );
    else ctx.line(copy.verify.none);
    return 0;
  }
  const tctx = textContext(
    redactionContext(ctx.paths, {
      root: found.root,
      entry: found.entry,
      facts: { toplevel: found.root, head, branch: null },
    }),
  );
  const run = { paths: ctx.paths, ctx: tctx, env: ctx.env, now: ctx.now };
  const worktree = await runLocalChecks(found.root, checks, { ...run, source: "worktree" });
  let results = base ? await runLocalChecks(found.root, checks, { ...run, source: "head", commit: base }) : [];

  let reported: Reported | null = null;
  let partial: { sent: number; total: number } | null = null;
  for (let attempt = 0; base && attempt < 2 && !reported; attempt++) {
    try {
      reported = await postResults(api, found.entry.repo_id, base, results);
    } catch (e) {
      const cause = e instanceof ReportError ? e.cause : e;
      // A check that vanished since it was fetched (disabled, entry gone): fetch again and report the rest, once.
      if (
        attempt === 0 &&
        cause instanceof ApiError &&
        cause.code === "entry_not_found" &&
        e instanceof ReportError &&
        e.sent === 0
      ) {
        checks = await fetchChecks(api, found.entry.repo_id);
        const still = new Set(checks.map((c) => c.check_id));
        results = results.filter((r) => still.has(r.check_id));
        // Every check vanished: nothing is left to report, which is not a failure.
        if (results.length === 0) reported = { conflicts_opened: 0, conflicts_resolved: 0 };
        continue;
      }
      if (!(cause instanceof ApiError) && !isOffline(cause)) throw cause;
      if (e instanceof ReportError && e.sent > 0) partial = { sent: e.sent, total: e.total };
      break;
    }
  }

  const byId = new Map(worktree.map((w) => [w.check_id, w]));
  const shown = base ? results : worktree;
  if (o.json) {
    ctx.io.out(
      `${JSON.stringify({
        sha: base,
        results: shown.map((r) => ({
          check_id: r.check_id,
          entry_key: r.entry_key,
          kind: r.kind,
          result: base ? r.result : null,
          matches: base ? r.matches : [],
          duration_ms: r.duration_ms,
          ...(r.reason && base ? { reason: r.reason } : {}),
          worktree: { result: byId.get(r.check_id)?.result ?? "error" },
        })),
        ...(reported ? reported : {}),
        reported: reported ? "all" : partial ? "partial" : "none",
        ...(base ? {} : { reason: "no_shared_commit" }),
      })}\n`,
    );
  } else if (!base) {
    ctx.line(copy.verify.noShared(worktree.length));
    for (const w of worktree) ctx.line(resultLine(w));
  } else {
    ctx.line(copy.verify.header(results.length, base));
    if (base !== head) ctx.line(copy.verify.unpushed(base));
    for (const r of results) ctx.line(resultLine(r, byId.get(r.check_id)));
    ctx.line(copy.verify.summary(new Set(results.map((r) => r.entry_key)).size, contradicted(results)));
    if (reported) ctx.line(copy.verify.conflicts(reported.conflicts_opened, reported.conflicts_resolved));
  }
  if (!base) return 0;
  if (!reported) {
    ctx.fail(partial ? copy.verify.partial(partial.sent, partial.total) : copy.verify.unreachable);
    return 1;
  }
  return 0;
}
