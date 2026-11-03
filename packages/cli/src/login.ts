/**
 * Device-code sign-in (docs/25 §Device login, RFC 8628): ask for a code, print the URL and code, open the
 * browser when there is a terminal, poll at the server's `interval` (+5 s on `slow_down`) until approved,
 * denied or expired, then store the token for that organisation. The token is never printed.
 */
import { spawn } from "node:child_process";
import { DeviceCodeResponse, DeviceTokenResponse, MeResponse } from "@align/core/api";
import { CLI_BIN } from "@align/core/brand";
import { ApiError, isOffline } from "./api";
import { updateConfig } from "./config";
import { type Ctx, UserError } from "./context";
import { copy } from "./copy";
import type { CredentialMeta } from "./credentials";
import { clearLoginRequired } from "./upload/state";
import { VERSION } from "./version";

/** Opens a URL with `open` (macOS) or `xdg-open`; failures are ignored (the code is printed anyway). */
export function openBrowser(url: string, platform = process.platform): void {
  if (!/^https?:\/\//.test(url)) return;
  try {
    const child = spawn(platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no opener: the printed code is enough
  }
}

export async function deviceLogin(ctx: Ctx): Promise<CredentialMeta> {
  const api = ctx.client();
  const { data: code } = await api.request("POST", "/device/code", DeviceCodeResponse, {
    client_name: CLI_BIN,
    client_version: VERSION,
  });
  // The sign-in page must be this server's own (a hostile or confused server cannot send people elsewhere).
  const origin = new URL(api.server).origin;
  const sameOrigin = (u: string) => {
    try {
      return new URL(u).origin === origin;
    } catch {
      return false;
    }
  };
  if (!sameOrigin(code.verification_uri) || !sameOrigin(code.verification_uri_complete)) {
    throw new UserError(copy.foreignSignInUrl);
  }
  ctx.line(copy.signInOpen(code.verification_uri, code.user_code));
  if (ctx.io.isTTY && !ctx.env.ALIGN_NO_BROWSER) (ctx.deps.openBrowser ?? openBrowser)(code.verification_uri_complete);

  const deadline = ctx.now() + code.expires_in * 1000;
  // RFC 8628 §3.5: never faster than the server asks, and never faster than every 5 s.
  let intervalMs = Math.max(code.interval, 5) * 1000;
  let backoffMs = 1000;
  for (;;) {
    await ctx.sleep(intervalMs);
    if (ctx.now() > deadline) throw new UserError(copy.codeExpired);
    try {
      const { data } = await api.request("POST", "/device/token", DeviceTokenResponse, {
        device_code: code.device_code,
      });
      const meta = ctx.credentials.put(
        { org: data.org, user: data.user, expires_at: data.expires_at, server: api.server },
        data.access_token,
      );
      // A fresh token: the uploader may send this organisation's spool again (L14).
      clearLoginRequired(ctx.paths, data.org.id);
      ctx.line(copy.signedIn(data.user.display_name));
      await refreshOrgCache(ctx, data.org.id);
      return meta;
    } catch (e) {
      if (e instanceof ApiError && e.code === "authorization_pending") continue;
      if (e instanceof ApiError && e.code === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (e instanceof ApiError && e.code === "expired_token") throw new UserError(copy.codeExpired);
      if (e instanceof ApiError && e.code === "access_denied") throw new UserError(copy.accessDenied);
      if (isOffline(e)) {
        // a dropped connection while the person approves: keep polling until the code expires
        await ctx.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
        continue;
      }
      throw e;
    }
  }
}

/** Caches the organisation's email domains for redaction (docs/17) from `GET /me`. Best effort. */
export async function refreshOrgCache(ctx: Ctx, orgId: string): Promise<"ok" | "invalid" | "unavailable"> {
  const api = ctx.clientFor(orgId);
  if (!api) return "invalid";
  try {
    const { data } = await api.request("GET", "/me", MeResponse, undefined, { timeoutMs: 5000 });
    updateConfig(ctx.paths, (c) => {
      c.orgs[data.org.id] = {
        slug: data.org.slug,
        name: data.org.name,
        email_domains: data.org.email_domains,
        updated_at: ctx.now(),
      };
    });
    return "ok";
  } catch (e) {
    if (e instanceof ApiError && (e.code === "unauthorized" || e.code === "token_expired")) {
      ctx.credentials.remove(orgId);
      return "invalid";
    }
    return "unavailable";
  }
}

/**
 * The organisation to act for: `--org SLUG` when given, else the only one signed in on this server, else the
 * person chooses (a terminal) or is told to pass --org. Signs in when nothing fits. A token the server no
 * longer accepts is dropped and the person signs in again.
 */
export async function ensureSignedIn(ctx: Ctx, opts: { org?: string } = {}): Promise<CredentialMeta> {
  const server = ctx.server();
  const usable = () =>
    ctx.credentials.list().filter((m) => m.server === server && ctx.credentials.tokenFor(m.org.id, server));
  let metas = usable();
  if (opts.org) metas = metas.filter((m) => m.org.slug === opts.org);
  let chosen: CredentialMeta | undefined;
  if (metas.length === 1) chosen = metas[0];
  else if (metas.length > 1) {
    const slugs = metas.map((m) => m.org.slug).sort();
    const answer = ctx.io.isTTY ? (await ctx.ask(copy.orgQuestion(slugs)))?.trim() : null;
    chosen = metas.find((m) => m.org.slug === answer);
    if (!chosen) throw new UserError(copy.chooseOrg(slugs));
  }
  // offline: keep the token; the next call reports the network
  if (chosen && (await refreshOrgCache(ctx, chosen.org.id)) !== "invalid") return chosen;
  const fresh = await deviceLogin(ctx);
  if (opts.org && fresh.org.slug !== opts.org) throw new UserError(copy.unknownOrg(opts.org));
  return fresh;
}
