/**
 * `POST /api/v1/pack` (docs/25 §Packs). Loaded with a dynamic import only when no fresh pack is cached, so the
 * fast path never loads zod or the API client otherwise (D218). The token and the server come from the credential
 * record of the repository's organisation (D240: never `ALIGN_SERVER`, `ALIGN_HOME` or `HOME` from the environment,
 * which a repository's harness configuration can set; the Keychain is chosen by the record). Nothing here prints,
 * logs or returns the token, and every failure is just "no pack".
 */
import { z } from "zod";
import { ApiClient, ApiError, type FetchLike } from "../api";
import { CredentialStore, defaultKeychain, type Keychain } from "../credentials";
import type { Paths } from "../paths";
import { type Pack, type PackRequestBody, parsePack } from "./check";

export type FetchPackDeps = { paths: Paths; fetch?: FetchLike; keychain?: Keychain | null };

/**
 * `timeout`, `offline` and `server_error` (5xx) are "the server did not answer": a cached pack may stand in. `refused`
 * (401/403/404 and `no_token`) means this person may not have this repository's pack: its caches are purged. Anything
 * else (`invalid`, other 4xx) serves nothing and keeps nothing new.
 */
export type FetchOutcome =
  | { ok: true; pack: Pack }
  | { ok: false; code: "timeout" | "offline" | "server_error" | "refused" | "invalid" };

export async function fetchPack(
  deps: FetchPackDeps,
  orgId: string,
  server: string,
  body: PackRequestBody,
  timeoutMs: number,
): Promise<FetchOutcome> {
  try {
    const store = new CredentialStore(deps.paths, deps.keychain === undefined ? defaultKeychain({}) : deps.keychain);
    const token = store.tokenFor(orgId, server);
    if (!token) return { ok: false, code: "refused" };
    const { data } = await new ApiClient({ server, token, fetch: deps.fetch }).request(
      "POST",
      "/pack",
      z.unknown(),
      body,
      { timeoutMs },
    );
    const pack = parsePack(data);
    return pack ? { ok: true, pack } : { ok: false, code: "invalid" };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError") return { ok: false, code: "timeout" };
    if (name === "NetworkError") return { ok: false, code: "offline" };
    if (e instanceof ApiError) {
      if (e.status >= 500) return { ok: false, code: "server_error" };
      if (e.status === 401 || e.status === 403 || e.status === 404) return { ok: false, code: "refused" };
    }
    return { ok: false, code: "invalid" };
  }
}
