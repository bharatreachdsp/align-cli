/**
 * Backfill (docs/25 §Backfill and local checks; the routes arrive with L23b, the CLI side is L15). The CLI uploads a
 * repository's recent sessions with `capture: 'backfill'` first, then asks the server to compile them, most recent
 * first (docs/12 §Triggers), and polls the backfill until it is done or ten minutes have passed.
 */
import { z } from "zod";
import { Id } from "./common";
import { CheckKind } from "./ledger";

/** Plan windows and session caps (docs/12 §Budgets): free 30 days and 60 sessions, beta and team 90 and 300. */
export const BACKFILL_LIMITS = {
  free: { days: 30, sessions: 60 },
  beta: { days: 90, sessions: 300 },
  team: { days: 90, sessions: 300 },
  business: { days: 90, sessions: 300 },
} as const;
/** The server refuses events older than 90 days (ingest's retention floor), so no window is longer. */
export const MAX_BACKFILL_DAYS = 90;
export const MAX_BACKFILL_SESSIONS = 300;

export const BackfillRequest = z
  .object({
    repo_id: Id,
    /** Sessions already uploaded with `capture: 'backfill'`, most recent first. */
    session_ids: z.array(z.uuid()).min(1).max(MAX_BACKFILL_SESSIONS),
    window_days: z.number().int().min(1).max(MAX_BACKFILL_DAYS),
  })
  .strict();
export type BackfillRequest = z.infer<typeof BackfillRequest>;

export const BackfillResponse = z.object({ backfill_id: Id });
export type BackfillResponse = z.infer<typeof BackfillResponse>;

/** The checks compile proposed for backfilled decisions, run on the working tree by `align init` (L15b). */
export const BackfillCheck = z.object({
  check_id: Id,
  entry_key: z.string().min(1).max(200),
  kind: CheckKind,
  spec: z.record(z.string(), z.unknown()),
});

export const BackfillStatus = z.object({
  status: z.enum(["running", "done", "paused"]),
  sessions_total: z.number().int().min(0),
  sessions_compiled: z.number().int().min(0),
  proposals: z.number().int().min(0),
  contradicted: z.number().int().min(0),
  /** Not in docs/25's first draft; the init summary line counts them (docs/19). Absent → not shown. */
  questions: z.number().int().min(0).optional(),
  checks_to_run: z.array(BackfillCheck).max(1000),
});
export type BackfillStatus = z.infer<typeof BackfillStatus>;

export function mockBackfillStatus(over: Partial<BackfillStatus> = {}): BackfillStatus {
  return {
    status: "done",
    sessions_total: 0,
    sessions_compiled: 0,
    proposals: 0,
    contradicted: 0,
    checks_to_run: [],
    ...over,
  };
}
