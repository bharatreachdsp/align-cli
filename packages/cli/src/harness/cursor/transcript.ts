/**
 * The Cursor agent-transcript reader (docs/10 §Transcript readers): `~/.cursor/projects/<encoded root>/
 * agent-transcripts/<id>/<id>.jsonl`, rows `{role, message: {content: [{type: "text", text}, {type: "tool_use",
 * name, input}]}}` and `{type: "turn_ended", …}`, written by Cursor's transcript store (agent CLI 2026.10.19).
 *
 * Kept: the person's text from inside `<user_query>…</user_query>` (nothing else of a user row: attached files,
 * `<timestamp>`, `<cursor_commands>` and other wrappers stay out), and `tool_use` blocks as tool lines with paths.
 * Dropped: assistant text — Cursor writes the model's reasoning into the same text block as the reply, so no
 * reader can keep the reply without the reasoning (docs/15 §Guarantees 3; live capture takes replies from
 * `afterAgentResponse` in hooks mode instead, D95) — `turn_ended` rows, system rows and anything unexpected. Cursor
 * transcripts hold no tool outputs and no timestamps. Used for backfill (L15) and `align doctor`.
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { RawLine } from "../../transcripts/reader";
import { carriesPack, keepText } from "../../transcripts/text";
import {
  type ConvertOptions,
  type ConvertResult,
  inputBytes,
  type Line,
  realUnderRoot,
  throughLinks,
  toolPaths,
} from "../claude-code/transcript";

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
/**
 * The person's text: a `<user_query>` block that ends the row's text (only whitespace after `</user_query>`).
 * Cursor writes it after every attached block (`<attached_files>`, `<user_info>`, …); the opening tag taken is the
 * last one before that final close, so an attached file holding the tags — closed or not, anywhere before — never
 * becomes the person's text, and a row that does not end with a query gives nothing (security review of L13).
 */
export function userQuery(text: string): string | null {
  const close = "</user_query>";
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(close)) return null;
  const end = trimmed.length - close.length;
  const open = "<user_query>";
  const start = trimmed.lastIndexOf(open, end);
  if (start < 0) return null;
  const inner = trimmed.slice(start + open.length, end);
  // A close tag inside means the "query" spans attached text: refuse rather than guess.
  return inner.includes(close) ? null : inner;
}

/** Cursor's project folder for a root: non-alphanumerics → `-`, runs collapsed, ends trimmed. */
export const encodeCursorProject = (root: string) =>
  root
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The conversation's own transcript, for a Cursor session that reaches sessionEnd with no hook line: print mode
 * (`agent -p`) fires no prompt, reply or stop hook and names its transcript only at sessionEnd (agent CLI 2026.10.19,
 * D519). The payload's path is used only when it is exactly
 * `<home>/.cursor/projects/<encode(root or workspace root)>/agent-transcripts/<id>/<id>.jsonl` for this conversation's
 * id, a regular file (never a link), and its folder resolves inside the real `~/.cursor/projects` (no linked folder on
 * the way). Its inode and device are returned so the reader refuses a file swapped in later (`replaced`). Otherwise null.
 */
export function cursorPrintTranscript(
  home: string,
  roots: readonly string[],
  conversationId: string,
  path: string | null,
): { path: string; ino: number; dev: number } | null {
  if (!path || !SESSION_DIR.test(conversationId)) return null;
  const projects = join(home, ".cursor", "projects");
  const ok = roots.some(
    (r) =>
      join(projects, encodeCursorProject(r), "agent-transcripts", conversationId, `${conversationId}.jsonl`) === path,
  );
  if (!ok) return null;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    const realProjects = realpathSync(projects);
    if (!realpathSync(dirname(path)).startsWith(realProjects + sep)) return null;
    return { path, ino: st.ino, dev: st.dev };
  } catch {
    return null;
  }
}
const SESSION_DIR = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** Cursor's built-in file tools (agent CLI 2026.10.19); any other tool, MCP included, keeps name and bytes only (D94). */
export const CURSOR_FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "StrReplace",
  "MultiEdit",
  "Delete",
  "Grep",
  "Glob",
  "List",
  "LS",
]);

/** Cursor's tools name their path in a few fields; only these are read. */
export function cursorToolPaths(input: unknown): string[] {
  const out = toolPaths(input);
  if (isRecord(input) && typeof input.target_file === "string" && input.target_file.length <= 1024 && out.length < 50)
    if (!out.includes(input.target_file)) out.push(input.target_file);
  return out;
}

/** A relative tool path resolved against `base` (the root), so links on its way are seen (#67 security review). */
const absolute = (p: string, base: string) => (p.startsWith("/") || p.startsWith("~") ? p : resolve(base, p));

export function convertCursorLines(raw: RawLine[], o: ConvertOptions): ConvertResult {
  const lines: Line[] = [];
  const stats = { entries: 0, kept: 0, dropped: 0, malformed: 0 };
  let n = o.nextN;
  let recognised = 0;
  for (const { text, lineNo } of raw) {
    if (text.trim() === "") continue;
    stats.entries++;
    let row: unknown;
    try {
      row = JSON.parse(text);
    } catch {
      stats.malformed++;
      continue;
    }
    if (!isRecord(row) || (typeof row.role !== "string" && typeof row.type !== "string")) {
      stats.malformed++;
      continue;
    }
    recognised++;
    const out: Omit<Line, "n" | "src">[] = [];
    const content = isRecord(row.message) && Array.isArray(row.message.content) ? row.message.content : [];
    if (row.role === "user") {
      // Only the row's last text block carries the query; earlier blocks are attachments.
      const texts = content.filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string");
      const last = carriesPack(texts) ? undefined : (texts[texts.length - 1] as { text: string } | undefined);
      const q = last ? userQuery(last.text) : null;
      const kept = q === null ? null : keepText(q);
      if (kept !== null) out.push({ role: "user", text: kept });
    } else if (row.role === "assistant") {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" && TOOL_NAME.test(block.name) ? block.name : "unknown";
          const bytes = inputBytes(block.input);
          out.push({
            role: "tool",
            text: `‹tool: ${name}, ${bytes} bytes›`,
            tool: {
              name,
              bytes,
              // Through links and onto the root's real spelling, as Claude Code's reader does (#43 chain re-review).
              paths: CURSOR_FILE_TOOLS.has(name)
                ? cursorToolPaths(block.input).map((p) =>
                    throughLinks(realUnderRoot(absolute(p, o.root), o.root), o.root, o.denied),
                  )
                : [],
            },
          });
        }
        // assistant text (reply and reasoning together), images, files and anything new: dropped.
      }
    }
    if (out.length === 0) {
      stats.dropped++;
      continue;
    }
    stats.kept++;
    for (const l of out) lines.push({ n: n++, src: `jsonl:${lineNo}`, ...l });
  }
  return { lines, nextN: n, stats, version: null, recognised, carry: { owned: true } };
}
