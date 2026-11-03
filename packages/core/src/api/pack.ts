/**
 * The pack (docs/14 §The pack, docs/25 §Packs; L24): the ≤ 1,500-token Markdown of team decisions served at session
 * start (`POST /api/v1/pack`) and by the `get_context` tool. Requests are strict; the response's items carry keys and
 * reasons only (the Markdown is the content).
 */
import { z } from "zod";
import { Timestamp } from "./common";
import { EntryKind, EntryStatus, RepoPath } from "./ledger";

/** At most 200 hint paths (the CLI's changed files, status and working directory; docs/14 §Request). */
export const PACK_MAX_PATHS = 200;
/** The token budget of a pack (docs/14: `ceil(chars / 3.5)`). */
export const PACK_MAX_TOKENS = 1500;
/** How long a client may reuse a pack (docs/14 §Caching). */
export const PACK_TTL_SECONDS = 600;

/** The harnesses `pack_serves.harness` counts; any other name is counted as `unknown`. */
export const HARNESSES = ["claude-code", "cursor", "codex", "mcp", "unknown"] as const;
export type Harness = (typeof HARNESSES)[number];
/** A harness name; an unknown one (any string up to 64 characters) becomes `unknown`, so the counter set is closed. */
export const Harness = z
  .string()
  .max(64)
  .transform((h): Harness => ((HARNESSES as readonly string[]).includes(h) ? (h as Harness) : "unknown"));

export const PackRequest = z.strictObject({
  repo_id: z.uuid(),
  /** The current branch (a name, or `HEAD` when detached). */
  branch: z.string().min(1).max(255),
  /** The head commit (a SHA, or `HEAD` when the client could not resolve it in its 300 ms budget). */
  head: z.string().min(1).max(255),
  paths: z.array(RepoPath).max(PACK_MAX_PATHS),
  session_id: z.uuid().optional(),
  harness: Harness.optional(),
});
export type PackRequest = z.infer<typeof PackRequest>;

/**
 * Why an item is in the pack, its strongest signal (docs/14 §Selection and ranking): `scope` (a scope path matches a
 * hint path), `conflict` (open on this branch, or drifted on the default branch), `owner` (the asker owns it), `due`
 * (a commitment due within 7 days or overdue), `recent` (confirmed in the last 14 days), `fallback` (no hint
 * matched: one of the most recently confirmed entries).
 */
export const PackReason = z.enum(["scope", "conflict", "owner", "due", "recent", "fallback", "listed"]);
export type PackReason = z.infer<typeof PackReason>;

export const PackItem = z.object({
  key: z.string(),
  kind: EntryKind,
  status: EntryStatus,
  reason: PackReason,
});
export type PackItem = z.infer<typeof PackItem>;

export const PackResponse = z.object({
  markdown: z.string(),
  items: z.array(PackItem),
  tokens_estimate: z.number().int().nonnegative().max(PACK_MAX_TOKENS),
  generated_at: Timestamp,
  ttl_seconds: z.number().int().positive(),
  notice_line: z.string(),
});
export type PackResponse = z.infer<typeof PackResponse>;
