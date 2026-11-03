/**
 * The pack at session start (docs/14 §Delivery, docs/15 §The hook fast path step 5): a fresh cache is used as it
 * is; otherwise the pack is fetched with a 1.2 s timeout (less when the hook's 1.4 s deadline is nearer). A cached pack
 * up to a day old stands in only when the server did not answer (timeout, offline, 5xx), marked "may be out of date",
 * and with no line for the person. A refusal (401/403/404), a refused token or no credential record purges the
 * repository's caches and resets Cursor's rule to the pending text, as does a cache older than a day (D402). The
 * session is never blocked: every failure is "no pack". A fetched pack refreshes the cache and, where `init` wrote it,
 * Cursor's rule file.
 *
 * The output per harness (golden files in `__fixtures__/session-start/`):
 * - Claude Code and Codex: `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": <pack>},
 *   "systemMessage": <line>}`; Codex adds `additionalContext` as a developer message and shows the line as a warning.
 * - Cursor: `{"additional_context": <pack>}` (Cursor has no informational channel, so no line).
 * Both texts are capped at 10,000 characters (the pack at a whole line, its marker kept first).
 *
 * The line (docs/19 §Quiet-by-default budgets): only on the first sighting of a session, and only when something
 * applies or needs the person (D250): the server's `notice_line` when the pack lists an entry or says proposals wait;
 * the "uploads paused" line when the uploader's token was refused.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { redactText } from "@align/core/redact";
import type { FetchLike } from "../api";
import { isRecord, isString } from "../check";
import { stripControl } from "../control";
import { copy } from "../copy";
import type { Keychain } from "../credentials";
import { cwdRel, type Repo, readDenyFile, redactionContext } from "../hook/events";
import { MAX_NOTICE_CHARS } from "../hook/notice";
import type { Paths } from "../paths";
import { loginRequired } from "../upload/state";
import { type CacheKey, markStale, purgePackCaches, readPackCache, writePackCache } from "./cache";
import { HARNESS_TEXT_CAP, isHintPath, type Pack, type PackRequestBody } from "./check";
import { refreshRule } from "./cursor-rule";
import { cleanHint, pathsHint } from "./hint";

/** docs/14 §Delivery: the pack request's own timeout. */
export const PACK_FETCH_TIMEOUT_MS = 1200;
/** Below this, a request is not worth starting: the stale cache (or nothing) is served at once. */
const MIN_FETCH_MS = 150;

export type ServeDeps = {
  paths: Paths;
  now: number;
  fetch?: FetchLike;
  keychain?: Keychain | null;
  /** What is left of the caller's deadline, in ms (the hook: 1.4 s since its process started). */
  remainingMs?: () => number;
};

export type Served = { pack: Pack; stale: boolean; ageMs: number };

/** Why nothing (or a stale pack) was served, for `align pack`'s message. */
export type ResolveOutcome = "fresh" | "fetched" | "stale" | "signed_out" | "refused" | "unanswered" | "invalid";

/** The server the credential record of this organisation names (read without zod, before loading the client). */
export function recordServer(paths: Paths, orgId: string): string | null {
  try {
    const v = JSON.parse(readFileSync(paths.credentials, "utf8")) as unknown;
    const rec = isRecord(v) && isRecord(v.orgs) ? v.orgs[orgId] : null;
    return isRecord(rec) && isString(rec.server) ? rec.server : null;
  } catch {
    return null;
  }
}

/** This repository may no longer get packs here: its caches go and Cursor's rule shows the pending text again. */
export function forgetPacks(paths: Paths, root: string): void {
  try {
    purgePackCaches(paths, root);
    refreshRule(paths, root, null);
  } catch {
    // best effort: nothing cached is ever served without matching its key anyway
  }
}

/**
 * The paths hint and the branch as sent: identity and secret redaction run on them first (docs/17 §Identity), so a
 * username or hostname in a branch or a path never leaves the laptop; a path redaction changed is sent redacted.
 */
function redactedRequest(paths: Paths, repo: Repo, hint: string[], branch: string) {
  const ctx = redactionContext(paths, repo);
  const red = (t: string) => redactText(t, ctx).text;
  return { paths: cleanHint(hint.map(red).filter(isHintPath), []), branch: red(branch) || "HEAD" };
}

export async function resolvePack(
  deps: ServeDeps,
  repo: Repo,
  o: { harness: string; sessionId?: string; cwd: string | null; explicitPaths?: string[]; interactiveGit?: number },
): Promise<{ served: Served | null; outcome: ResolveOutcome }> {
  const { paths, now } = deps;
  const orgId = repo.entry.org_id;
  const server = recordServer(paths, orgId);
  // Signed out, or the token was refused: nothing old may be shown any more.
  if (!server || loginRequired(paths, orgId)) {
    forgetPacks(paths, repo.root);
    return { served: null, outcome: "signed_out" };
  }
  const branch = repo.facts.branch ?? "HEAD";
  const key: CacheKey = { root: repo.root, repoId: repo.entry.repo_id, orgId, server, branch };
  const explicit = o.explicitPaths !== undefined;
  let cached = explicit ? null : readPackCache(paths, key, now);
  if (cached === "expired") {
    forgetPacks(paths, repo.root);
    cached = null;
  }
  if (cached?.fresh)
    return { served: { pack: cached.pack, stale: false, ageMs: now - cached.fetched_at }, outcome: "fresh" };
  const fallback = cached ? { pack: cached.pack, stale: true, ageMs: now - cached.fetched_at } : null;
  const unanswered = () => ({ served: fallback, outcome: (fallback ? "stale" : "unanswered") as ResolveOutcome });
  const remaining = deps.remainingMs ?? (() => PACK_FETCH_TIMEOUT_MS);
  if (remaining() < MIN_FETCH_MS) return unanswered();

  const denyGlobs = [
    ...readDenyFile(join(repo.root, ".aligndeny")).globs,
    ...readDenyFile(paths.deny(repo.root)).globs,
  ];
  const hint = explicit
    ? cleanHint(o.explicitPaths ?? [], denyGlobs)
    : await pathsHint({
        root: repo.root,
        cwdRel: cwdRel(repo.root, o.cwd),
        defaultBranch: repo.entry.default_branch,
        denyGlobs,
        ...(o.interactiveGit ? { timeoutMs: o.interactiveGit } : {}),
      });
  const sent = redactedRequest(paths, repo, hint, branch);
  const body: PackRequestBody = {
    repo_id: repo.entry.repo_id,
    branch: sent.branch,
    head: repo.facts.head ?? "HEAD",
    paths: sent.paths,
    ...(o.sessionId ? { session_id: o.sessionId } : {}),
    harness: o.harness,
  };
  // Loaded only now: zod and the API client stay off the fresh-cache path (D218). The timeout is taken after the
  // import, so loading the module never eats into the request's own budget unseen.
  const { fetchPack } = await import("./fetch");
  const timeoutMs = Math.floor(Math.min(PACK_FETCH_TIMEOUT_MS * (explicit || o.interactiveGit ? 4 : 1), remaining()));
  if (timeoutMs < MIN_FETCH_MS) return unanswered();
  const r = await fetchPack({ paths, fetch: deps.fetch, keychain: deps.keychain }, orgId, server, body, timeoutMs);
  if (r.ok) {
    if (!explicit) {
      try {
        writePackCache(paths, key, r.pack, now);
        refreshRule(paths, repo.root, safeText(r.pack.markdown));
      } catch {
        // a full disk: the pack is still served this time
      }
    }
    return { served: { pack: r.pack, stale: false, ageMs: 0 }, outcome: "fetched" };
  }
  if (r.code === "refused") {
    forgetPacks(paths, repo.root);
    return { served: null, outcome: "refused" };
  }
  if (r.code === "invalid") return { served: null, outcome: "invalid" };
  return unanswered();
}

export async function servePack(
  deps: ServeDeps,
  repo: Repo,
  o: { harness: string; sessionId: string; cwd: string | null },
): Promise<Served | null> {
  return (await resolvePack(deps, repo, o)).served;
}

/** Control characters out (newlines kept), at most 10,000 characters, cut at a whole line. */
export function safeText(markdown: string, cap = HARNESS_TEXT_CAP): string {
  const text = stripControl(markdown.replace(/\r\n?/g, "\n"));
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf("\n", cap - 1);
  return `${text.slice(0, cut > 0 ? cut : cap)}\n`;
}

/** The pack as delivered: stale line after the marker when it stands in for a fresh one, capped. */
export function packText(served: Served): string {
  const md = served.stale ? markStale(served.pack.markdown, served.ageMs) : served.pack.markdown;
  return safeText(md);
}

/** The session-start line, or null when nothing applies and nothing needs the person (docs/19 budgets, D250). */
export function startLine(served: Served | null, uploadsPaused: boolean): string | null {
  if (uploadsPaused) return copy.captureOnLoginRequired;
  // A stand-in pack is the agent's, marked; the person is not told "N decisions apply" on old information.
  if (!served || served.stale) return null;
  const line = stripControl(served.pack.notice_line.replace(/\s+/g, " ")).trim().slice(0, MAX_NOTICE_CHARS);
  if (!line) return null;
  const needsPerson = served.pack.items.length > 0 || line.includes(`${CLI_BIN} confirm`);
  return needsPerson ? line : null;
}

/**
 * The one JSON line a session-start hook prints for its harness, or null when there is nothing to print. `firstSighting`
 * is false for a `resume` or `compact` of a known session: the agent gets the pack again (its context was rebuilt), the
 * person sees no second line.
 */
export function sessionStartJson(
  harness: string,
  served: Served | null,
  o: { firstSighting: boolean; uploadsPaused: boolean },
): string | null {
  const pack = served ? packText(served) : null;
  if (harness === "cursor") return pack ? `${JSON.stringify({ additional_context: pack })}\n` : null;
  const line = o.firstSighting ? startLine(served, o.uploadsPaused) : null;
  const out: Record<string, unknown> = {};
  if (pack) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: pack };
  if (line) out.systemMessage = line;
  return Object.keys(out).length > 0 ? `${JSON.stringify(out)}\n` : null;
}
