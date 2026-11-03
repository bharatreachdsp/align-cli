import { z } from "zod";

/** `POST /api/v1/internal/github/attach-test-installation` (L31b, D66): the attached connection. No request body. */
export const AttachTestInstallationResponse = z.strictObject({
  connection_id: z.uuid(),
  installation_id: z.number().int().positive(),
});
export type AttachTestInstallationResponse = z.infer<typeof AttachTestInstallationResponse>;
