/** Sessions: the Stop-hook notice (docs/25 §Capture, `GET /sessions/:id/notice?since=`; the route arrives in L23b). */
import { z } from "zod";

/**
 * New proposals from this session since `since` (author only), and the open conflicts on the session's branch.
 * The CLI's uploader fetches it after uploading and writes the local notice file the Stop hook shows (docs/19
 * §In-session lines, budgets in §Quiet by default); a 404 means "no notice".
 */
export const SessionNoticeResponse = z.object({
  new_proposals: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        kind: z.string().min(1).max(32),
        statement: z.string().max(2000),
      }),
    )
    .max(100),
  open_conflicts_on_branch: z.number().int().min(0),
});
export type SessionNoticeResponse = z.infer<typeof SessionNoticeResponse>;
