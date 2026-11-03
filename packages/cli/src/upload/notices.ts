/**
 * Notices for the Stop hook (docs/15 §The uploader, docs/19 §In-session lines): after uploading, the uploader asks
 * `GET /sessions/:id/notice` for Claude Code sessions that are still running (the only harness that shows a Stop
 * hook's line) and writes `~/.align/sessions/<id>.notice.json` as `{id, text}`; the Stop hook shows it under the
 * budget. A 404 means "no notice" (the route arrives in L23b); any other failure is ignored. At most one request per
 * session a minute.
 */
import { createHash } from "node:crypto";
import { SessionNoticeResponse } from "@align/core/api";
import { ApiClient, ApiError, type FetchLike } from "../api";
import { copy } from "../copy";
import { CredentialStore, type Keychain } from "../credentials";
import { writeJsonAtomic } from "../fsx";
import { MAX_NOTICES_PER_SESSION, shownKeys } from "../hook/notice";
import { readState } from "../hook/state";
import type { Paths } from "../paths";

export const NOTICE_FETCH_GAP_MS = 60_000;
const NOTICE_TIMEOUT_MS = 3000;

export type NoticeDeps = { paths: Paths; now: () => number; fetch?: FetchLike; keychain: Keychain | null };

/** Fetches notices for these sessions; returns how many notice files were written. */
export async function fetchNotices(
  deps: NoticeDeps,
  sessions: Map<string, { orgId: string; server: string }>,
  lastFetch: Map<string, number>,
): Promise<number> {
  const store = new CredentialStore(deps.paths, deps.keychain);
  let written = 0;
  for (const [id, { orgId, server }] of sessions) {
    const now = deps.now();
    const last = lastFetch.get(id);
    if (last !== undefined && now - last < NOTICE_FETCH_GAP_MS) continue;
    const st = readState(deps.paths, id);
    if (st?.harness !== "claude-code" || st.ended_at !== null) continue;
    if (st.notices_shown.length >= MAX_NOTICES_PER_SESSION) continue;
    const token = store.tokenFor(orgId, server);
    if (!token) continue;
    lastFetch.set(id, now);
    const shown = st.notices_shown.reduce((m, s) => Math.max(m, s.at), 0);
    const query = shown > 0 ? `?since=${encodeURIComponent(new Date(shown).toISOString())}` : "";
    try {
      const { data } = await new ApiClient({ server, token, fetch: deps.fetch }).request(
        "GET",
        `/sessions/${encodeURIComponent(id)}/notice${query}`,
        SessionNoticeResponse,
        undefined,
        { timeoutMs: NOTICE_TIMEOUT_MS },
      );
      // Only proposals no earlier notice of this session named (docs/19: "only when new proposals exist").
      const seen = shownKeys(st);
      const fresh = data.new_proposals.filter((p) => !seen.has(p.key));
      const first = fresh[0];
      if (!first) continue;
      const keys = fresh.map((p) => p.key).sort();
      const noticeId = `n-${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16)}`;
      writeJsonAtomic(deps.paths.sessionNotice(id), {
        id: noticeId,
        text: copy.candidateNotice(fresh.length, first.statement),
        keys,
      });
      written++;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      // offline, refused or unreadable: no notice this time
    }
  }
  return written;
}
