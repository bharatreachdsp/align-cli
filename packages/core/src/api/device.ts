/** Device login and the calling token (docs/25 §Device login; RFC 8628). Routes arrive in L20. */
import { z } from "zod";
import { Id, OrgSummary, Timestamp, UserSummary } from "./common";

export const DeviceCodeRequest = z.object({
  client_name: z.string().min(1).max(64),
  client_version: z.string().min(1).max(32),
});
export type DeviceCodeRequest = z.infer<typeof DeviceCodeRequest>;

export const DeviceCodeResponse = z.object({
  device_code: z.string().min(16).max(256),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  /** Seconds between polls (RFC 8628 §3.2; the CLI waits at least 5); `slow_down` adds 5. */
  interval: z.number().int().min(1).max(60),
  expires_in: z.number().int().positive().max(3600),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponse>;

export const DeviceTokenRequest = z.object({ device_code: z.string().min(16).max(256) });
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>;

export const DeviceTokenResponse = z.object({
  access_token: z.string().regex(/^aln_[A-Za-z0-9]+_[A-Za-z0-9_-]+$/),
  expires_at: Timestamp,
  org: OrgSummary,
  user: UserSummary,
});
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>;

/** The 400 codes `POST /device/token` answers with while the person has not approved yet (RFC 8628 §3.5). */
export const DEVICE_TOKEN_ERRORS = ["authorization_pending", "slow_down", "expired_token", "access_denied"] as const;
export type DeviceTokenError = (typeof DEVICE_TOKEN_ERRORS)[number];

export const LogoutResponse = z.object({ revoked: z.literal(true) });

export const MeResponse = z.object({
  user: UserSummary,
  org: OrgSummary.extend({ email_domains: z.array(z.string()) }),
  token: z.object({ id: Id, prefix: z.string(), expires_at: Timestamp, scopes: z.array(z.string()) }),
  terms: z.object({ accepted_version: z.string().nullable(), current_version: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponse>;
