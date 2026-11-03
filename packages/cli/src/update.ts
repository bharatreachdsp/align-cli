/**
 * The daily update check (docs/15 §Updates): `GET /client` at most once per 24 hours, cached in
 * `~/.align/config.json`; the update line shows at most once per UTC day (docs/19 budgets). Never throws:
 * an offline laptop just keeps the last known answer.
 */
import { ClientResponse, compareVersions } from "@align/core/api";
import { readConfig, updateConfig } from "./config";
import type { Ctx } from "./context";
import { copy } from "./copy";
import { VERSION } from "./version";

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export type UpdateInfo = { latest: string; min_supported: string; available: boolean; required: boolean };

const info = (latest: string, min: string): UpdateInfo => ({
  latest,
  min_supported: min,
  available: compareVersions(latest, VERSION) > 0,
  required: compareVersions(VERSION, min) < 0,
});

export async function checkForUpdate(
  ctx: Ctx,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<UpdateInfo | null> {
  const cached = readConfig(ctx.paths).update;
  if (cached && !opts.force && ctx.now() - cached.checked_at < CHECK_EVERY_MS) {
    return info(cached.latest, cached.min_supported);
  }
  try {
    const { data } = await ctx.client().request("GET", "/client", ClientResponse, undefined, {
      timeoutMs: opts.timeoutMs ?? 2000,
      auth: false,
    });
    updateConfig(ctx.paths, (c) => {
      c.update = { ...c.update, checked_at: ctx.now(), latest: data.latest, min_supported: data.min_supported };
    });
    return info(data.latest, data.min_supported);
  } catch {
    return cached ? info(cached.latest, cached.min_supported) : null;
  }
}

/** The update line when one is due today (used by the session-start hook in L12), else null. */
export async function updateNotice(ctx: Ctx): Promise<string | null> {
  const u = await checkForUpdate(ctx);
  if (!u?.available) return null;
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  if (readConfig(ctx.paths).update?.notice_shown_on === today) return null;
  updateConfig(ctx.paths, (c) => {
    if (c.update) c.update.notice_shown_on = today;
  });
  return copy.updateAvailable(u.latest, VERSION);
}
