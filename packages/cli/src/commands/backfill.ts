/**
 * `align backfill [--days N] [--harness …] [--yes]` (docs/15 §Commands): re-run backfill for the repository the person
 * is in (registered and opted in), with the same scan, consent, upload and progress as `align init` step 8.
 */
import { RepoState } from "@align/core/api";
import { runBackfill } from "../backfill/run";
import { type Ctx, repoHere, UserError } from "../context";
import { copy } from "../copy";

export type BackfillCommandOptions = { days?: string; harness?: string; yes?: boolean };

export async function backfill(ctx: Ctx, o: BackfillCommandOptions): Promise<number> {
  const found = await repoHere(ctx);
  if (!found?.entry.opted_in) throw new UserError(copy.notRegistered);
  const api = ctx.clientFor(found.entry.org_id);
  if (!api) throw new UserError(copy.loginRequired);
  const { data: state } = await api.request(
    "GET",
    `/repos/${encodeURIComponent(found.entry.repo_id)}/state`,
    RepoState,
  );
  if (!state.opted_in) throw new UserError(copy.notRegistered);
  return runBackfill(ctx, { root: found.root, entry: found.entry, api, state }, o);
}
