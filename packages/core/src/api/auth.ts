/**
 * Browser sign-in (`/api/auth/*`, docs/25 §Sign-in). Request and response schemas; the source of truth for the
 * routes in `apps/web/app/api/auth/` and their tests.
 */
import { z } from "zod";

/** An email address as the sign-in form sends it: trimmed, at most 320 characters, one `@`, no spaces. */
export const EmailAddress = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);

export const EmailLinkRequest = z.object({ email: EmailAddress }).strict();
export type EmailLinkRequest = z.infer<typeof EmailLinkRequest>;

export const EmailLinkResponse = z.object({ sent: z.literal(true) });
export type EmailLinkResponse = z.infer<typeof EmailLinkResponse>;

/** The Identity Platform ID token, sent once after GitHub or email-link sign-in (a JWT: three base64url parts). */
export const SessionRequest = z
  .object({
    id_token: z
      .string()
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/),
    /**
     * GitHub sign-in only: the GitHub OAuth access token of the same sign-in, so the server can ask GitHub whether the
     * address is the account's primary verified one (D525). Used for that and nothing else; never stored or logged.
     */
    // Length only: a token of another shape is never sent to GitHub (`GITHUB_ACCESS_TOKEN`), and never fails sign-in.
    github_access_token: z.string().min(1).max(512).optional(),
  })
  .strict();
export type SessionRequest = z.infer<typeof SessionRequest>;

/**
 * `POST /api/auth/github-relink` (D531): the GitHub OAuth access token of a GitHub sign-in that Identity Platform
 * refused with `auth/account-exists-with-different-credential`. Used for one `GET /user`; never stored or logged.
 */
export const GithubRelinkRequest = z.object({ github_access_token: z.string().min(1).max(512) }).strict();
export type GithubRelinkRequest = z.infer<typeof GithubRelinkRequest>;

/** `queued`: the GitHub identity is being linked back; continue with GitHub again shortly. `none`: nothing to do. */
export const GithubRelinkResponse = z.object({ relink: z.enum(["queued", "none"]) }).strict();
export type GithubRelinkResponse = z.infer<typeof GithubRelinkResponse>;

export const SignoutRequest = z.object({ everywhere: z.boolean().optional() }).strict();
export type SignoutRequest = z.infer<typeof SignoutRequest>;

/** The cookie that carries our own session (docs/17 §Access model). */
export const SESSION_COOKIE = "__Host-align_session";

/** Where the browser keeps the address between `/login` and `/login/finish` on the same device. */
export const EMAIL_FOR_SIGN_IN_KEY = "align.emailForSignIn";
/** Where `/login` keeps the same-origin path to return to after `/login/finish`. */
export const NEXT_AFTER_SIGN_IN_KEY = "align.nextAfterSignIn";

/**
 * A same-origin path to return to after sign-in, or `/app`. Only `/`-rooted paths without a second `/` or `\`
 * at the start (no protocol-relative or backslash tricks), at most 512 characters, no control characters.
 */
export function safeNextPath(value: string | null | undefined): string {
  // 2,048: an OAuth authorization request (L41b) carries a client URL, a redirect URI, a challenge and a state.
  if (!value || value.length > 2048) return "/app";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return "/app";
  }
  return value;
}
