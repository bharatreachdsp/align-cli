/**
 * The pack cache (docs/14 §Delivery, docs/15 §Files): the last pack per repository and branch in
 * `~/.align/cache/packs/<repo hash>/<branch hash>.json` (0600). Fresh for the pack's `ttl_seconds`, never more than ten
 * minutes; after that it stands in only when the server did not answer (a timeout, offline, a 5xx), for at most a day
 * (D251, D402), with the "may be out of date" line. A refusal (401/403/404), a refused token, no credential record or
 * an age over a day purges the repository's caches instead. An entry names its repository id, organisation, server and
 * branch, and is read only when all four match.
 */
import { readFileSync, rmSync } from "node:fs";
import { isInt, isRecord, isString } from "../check";
import { copy } from "../copy";
import { writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";
import { PACK_TTL_SECONDS, type Pack, parsePack } from "./check";

/** How long a pack may stand in when the server does not answer (D251). */
export const PACK_STALE_MAX_MS = 24 * 60 * 60 * 1000;

/** What a cache entry must match to be read: the repository, its organisation, the server and the branch. */
export type CacheKey = { root: string; repoId: string; orgId: string; server: string; branch: string };

export type CacheLookup = { pack: Pack; fetched_at: number; fresh: boolean } | "expired" | null;

/** The cached pack, `"expired"` when one is there but older than a day (its owner purges it), or null. */
export function readPackCache(paths: Paths, k: CacheKey, now: number): CacheLookup {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(paths.packCache(k.root, k.branch), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(v) || v.version !== 2) return null;
  if (v.repo_id !== k.repoId || v.org_id !== k.orgId || v.server !== k.server || v.branch !== k.branch) return null;
  if (!isInt(v.fetched_at, 0) || !isString(v.repo_id)) return null;
  const pack = parsePack(v.pack);
  if (!pack) return null;
  const age = now - v.fetched_at;
  // A cache from the future (a clock moved back) is not trusted at all.
  if (age < 0) return null;
  if (age > PACK_STALE_MAX_MS) return "expired";
  const ttl = Math.min(pack.ttl_seconds, PACK_TTL_SECONDS) * 1000;
  return { pack, fetched_at: v.fetched_at, fresh: age < ttl };
}

export function writePackCache(paths: Paths, k: CacheKey, pack: Pack, now: number) {
  writeJsonAtomic(paths.packCache(k.root, k.branch), {
    version: 2,
    repo_id: k.repoId,
    org_id: k.orgId,
    server: k.server,
    branch: k.branch,
    fetched_at: now,
    pack,
  });
}

/** Every cached pack of a repository goes (a refused token, signed out, no record, older than a day). */
export function purgePackCaches(paths: Paths, root: string): void {
  rmSync(paths.packCacheDir(root), { recursive: true, force: true });
}

/** `12 minutes`, `3 hours`: how old a stale pack is, for its stale line. */
export function ageText(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** The pack with the stale line put right after its marker line (the marker stays first, so readers still drop it). */
export function markStale(markdown: string, ageMs: number): string {
  const i = markdown.indexOf("\n");
  const line = copy.pack.stale(ageText(ageMs));
  return i < 0 ? `${markdown}\n${line}\n` : `${markdown.slice(0, i + 1)}${line}\n${markdown.slice(i + 1)}`;
}
