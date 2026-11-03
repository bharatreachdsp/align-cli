/** Organisations and invitations (console server actions, docs/18 `/app`, `/app/[org]/team`, `/invite/[token]`). */
import { z } from "zod";
import { EmailAddress } from "./auth";

export const OrgSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);

export const CreateOrgRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Derived from the name when absent. */
    slug: OrgSlug.optional(),
    kind: z.enum(["team", "agency"]).default("team"),
  })
  .strict();
export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>;

export const Role = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof Role>;

/** An invitation by email (it then matches only that verified address) or a link (no email). */
export const CreateInviteRequest = z
  .object({ email: EmailAddress.optional(), role: z.enum(["admin", "member"]).default("member") })
  .strict();
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

/** An invitation token in `/invite/<token>`: 43 base64url characters. */
export const InviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A slug from a name: lower case, letters and digits, single hyphens, at most 40 characters. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^ -~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "org";
}
