import { z } from "zod";

/** Ids are server-issued opaque strings (uuidv7 in practice); clients never parse them. */
export const Id = z.string().min(1).max(200);

/** An ISO-8601 timestamp with an offset, as the server sends it. */
export const Timestamp = z.iso.datetime({ offset: true });

/** The error body of docs/25 §Conventions. `code` stays a string: device login adds RFC 8628 codes. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(1000).default(""),
    details: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const OrgSummary = z.object({ id: Id, slug: z.string().min(1), name: z.string().min(1), prefix: z.string() });
export type OrgSummary = z.infer<typeof OrgSummary>;

export const UserSummary = z.object({ id: Id, display_name: z.string() });
export type UserSummary = z.infer<typeof UserSummary>;
