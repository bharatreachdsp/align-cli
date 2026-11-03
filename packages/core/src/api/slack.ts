import { z } from "zod";

/**
 * `POST /api/v1/internal/slack/attach-test-installation` (L37d, D522; staging only): the attached connection and the
 * test workspace's team id. No request body.
 */
export const AttachTestSlackResponse = z.strictObject({
  connection_id: z.uuid(),
  team_id: z.string().regex(/^T[A-Z0-9]{2,20}$/),
});
export type AttachTestSlackResponse = z.infer<typeof AttachTestSlackResponse>;
