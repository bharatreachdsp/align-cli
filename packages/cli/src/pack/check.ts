/**
 * The pack's wire shapes (docs/14 §The pack, docs/25 §Packs), checked without zod so the session-start hook can read
 * a cached pack inside the fast path's budget (D218). They mirror `PackRequest` and `PackResponse` in
 * `@align/core/api/pack.ts` (L24, PR #48): a request carries at most 200 repository-relative paths of at most 1,024
 * characters; an answer is the Markdown starting with the marker line, its items (key, kind, status, reason), the token
 * estimate (≤ 1,500), when it was made, how long it may be reused and the session-start line.
 */
import { PACK_MARKER_RE } from "@align/core/brand";
import { isInt, isRecord, isString } from "../check";

export const PACK_MAX_PATHS = 200;
export const PACK_PATH_MAX_CHARS = 1024;
export const PACK_MAX_TOKENS = 1500;
/** docs/14 §Caching: a pack is reused for at most ten minutes, whatever the server says. */
export const PACK_TTL_SECONDS = 600;
/** Claude Code and Codex cap `additionalContext` and `systemMessage` at 10,000 characters (docs/14 §Delivery). */
export const HARNESS_TEXT_CAP = 10_000;

const KINDS = new Set(["decision", "commitment", "question"]);
const STATUSES = new Set([
  "proposed",
  "confirmed",
  "rejected",
  "superseded",
  "withdrawn",
  "open",
  "answered",
  "dismissed",
]);
const REASONS = new Set(["scope", "conflict", "owner", "due", "recent", "fallback", "listed"]);
/** Entry keys (`AL-12`, `Q-3`); the schema says only "a string", so this is generous but keeps it one short word. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export type PackItem = { key: string; kind: string; status: string; reason: string };
export type Pack = {
  markdown: string;
  items: PackItem[];
  tokens_estimate: number;
  generated_at: string;
  ttl_seconds: number;
  notice_line: string;
};

export type PackRequestBody = {
  repo_id: string;
  branch: string;
  head: string;
  paths: string[];
  session_id?: string;
  harness?: string;
};

/** A path the server accepts as a hint (`RepoPath`): relative, no backslash, no `..` segment, no control characters. */
export function isHintPath(p: string): boolean {
  if (p.length === 0 || p.length > PACK_PATH_MAX_CHARS) return false;
  if (p.startsWith("/") || p.includes("\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(p)) return false;
  return !p.split("/").includes("..");
}

/** The pack answer, or null when it does not match the contract (a wrong server, a version skew, a damaged cache). */
export function parsePack(v: unknown): Pack | null {
  if (!isRecord(v)) return null;
  const { markdown, items, tokens_estimate, generated_at, ttl_seconds, notice_line } = v;
  if (!isString(markdown) || !isString(notice_line) || !isString(generated_at)) return null;
  // The marker is what keeps the pack out of compile (every transcript reader drops text containing it).
  const first = markdown.split("\n", 1)[0] ?? "";
  if (!PACK_MARKER_RE.test(first)) return null;
  if (!isInt(tokens_estimate, 0) || tokens_estimate > PACK_MAX_TOKENS) return null;
  if (!isInt(ttl_seconds, 1)) return null;
  if (Number.isNaN(Date.parse(generated_at))) return null;
  if (!Array.isArray(items) || items.length > 100) return null;
  const out: PackItem[] = [];
  for (const it of items) {
    if (!isRecord(it)) return null;
    const { key, kind, status, reason } = it;
    if (!isString(key) || !KEY.test(key)) return null;
    if (!isString(kind) || !KINDS.has(kind) || !isString(status) || !STATUSES.has(status)) return null;
    if (!isString(reason) || !REASONS.has(reason)) return null;
    out.push({ key, kind, status, reason });
  }
  return { markdown, items: out, tokens_estimate, generated_at, ttl_seconds, notice_line };
}
