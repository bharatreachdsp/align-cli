/**
 * The Codex rollout reader (docs/10 §Transcript readers): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`,
 * lines `{timestamp, ordinal?, type, payload}` (shapes from rust-v0.163.0: `codex-rs/history`, `codex-rs/protocol`).
 *
 * Paginated rollouts (default since 0.158.0): `event_msg` with `payload.type = "item_completed"` and `item.type`
 * `UserMessage` (text inputs) / `AgentMessage` (`Text` content) → user / assistant lines; `FileChange` → a tool line
 * with the changed paths (never the diff or content); `CommandExecution`, `McpToolCall`, `DynamicToolCall` → a tool
 * line without paths (never the command, arguments or output). Legacy rollouts: `event_msg` `user_message` /
 * `agent_message`. Always dropped: `response_item` lines (they carry injected AGENTS.md, environment context and
 * developer messages), `turn_context`, `compacted`, reasoning, hook prompts and everything else. `session_meta` and
 * `turn_context` give the working directory: lines after one outside the repository, or in a nested repository,
 * are dropped (hard rule 6), and a subagent's rollout is dropped whole.
 */

import { resolve } from "node:path";
import type { RawLine } from "../../transcripts/reader";
import { carriesPack, isWrapper, keepText } from "../../transcripts/text";
import {
  type ConvertOptions,
  type ConvertResult,
  inputBytes,
  type Line,
  ownedByRoot,
  realUnderRoot,
  throughLinks,
} from "../claude-code/transcript";

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const VERSION = /^[\w.+-]{1,64}$/;

type Partial = Omit<Line, "n" | "src" | "ts">;

const userText = (text: unknown, out: Partial[]) => {
  if (typeof text !== "string" || isWrapper(text)) return;
  const kept = keepText(text);
  if (kept !== null) out.push({ role: "user", text: kept });
};
const agentText = (text: unknown, out: Partial[]) => {
  if (typeof text !== "string") return;
  const kept = keepText(text);
  if (kept !== null) out.push({ role: "assistant", text: kept });
};
const tool = (name: string, payload: unknown, paths: string[]): Partial => {
  const bytes = inputBytes(payload);
  return { role: "tool", text: `‹tool: ${name}, ${bytes} bytes›`, tool: { name, bytes, paths } };
};

function itemLines(item: Rec, mapPath: (p: string) => string): Partial[] {
  const out: Partial[] = [];
  if (Array.isArray(item.content) && carriesPack(item.content)) return out;
  switch (item.type) {
    case "UserMessage":
      for (const c of Array.isArray(item.content) ? item.content : [])
        if (isRecord(c) && c.type === "text") userText(c.text, out);
      break;
    case "AgentMessage":
      for (const c of Array.isArray(item.content) ? item.content : [])
        if (isRecord(c) && (c.type === "Text" || c.type === "text")) agentText(c.text, out);
      break;
    case "FileChange": {
      const changes = isRecord(item.changes) ? item.changes : {};
      out.push(
        tool(
          "FileChange",
          changes,
          Object.keys(changes)
            .filter((p) => p.length <= 1024)
            .slice(0, 50)
            .map(mapPath),
        ),
      );
      break;
    }
    case "CommandExecution":
      out.push(tool("CommandExecution", item.command, []));
      break;
    case "McpToolCall":
      out.push(tool("McpToolCall", item.arguments, []));
      break;
    case "DynamicToolCall":
      out.push(tool("DynamicToolCall", item.arguments, []));
      break;
    // Reasoning, Plan, HookPrompt, FunctionCallOutput, WebSearch, SubAgentActivity, …: dropped.
  }
  return out;
}

export function convertCodexLines(raw: RawLine[], o: ConvertOptions): ConvertResult {
  const lines: Line[] = [];
  const stats = { entries: 0, kept: 0, dropped: 0, malformed: 0 };
  let n = o.nextN;
  let recognised = 0;
  let version: string | null = null;
  let owned = o.carry?.owned ?? false;
  let subagent = o.carry?.subagent ?? false;
  let thread: string | null = o.carry?.thread ?? null;
  // The owned working directory of the session (or of the turn), for relative tool paths; else the root.
  let cwd: string | null = o.carry?.cwd ?? null;
  const cache = new Map<string, boolean>();
  const ownedCwd = (cwd: unknown) => {
    if (typeof cwd !== "string") return false;
    let v = cache.get(cwd);
    if (v === undefined) {
      v = ownedByRoot(cwd, o.root);
      cache.set(cwd, v);
    }
    return v;
  };
  for (const { text, lineNo } of raw) {
    if (text.trim() === "") continue;
    stats.entries++;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      stats.malformed++;
      continue;
    }
    if (!isRecord(line) || typeof line.type !== "string") {
      stats.malformed++;
      continue;
    }
    recognised++;
    const payload = isRecord(line.payload) ? line.payload : {};
    let out: Partial[] = [];
    if (line.type === "session_meta") {
      owned = ownedCwd(payload.cwd);
      cwd = owned && typeof payload.cwd === "string" && payload.cwd.startsWith("/") ? payload.cwd : null;
      if (typeof payload.id === "string") thread = payload.id;
      subagent = isRecord(payload.source) && ("subagent" in payload.source || "sub_agent" in payload.source);
      if (typeof payload.cli_version === "string" && VERSION.test(payload.cli_version)) version = payload.cli_version;
    } else if (line.type === "turn_context") {
      owned = ownedCwd(payload.cwd);
      cwd = owned && typeof payload.cwd === "string" && payload.cwd.startsWith("/") ? payload.cwd : null;
    } else if (line.type === "event_msg" && owned && !subagent) {
      // An event of another thread (a subagent's, forwarded) is not this session's; with no session_meta seen, any
      // event that names a thread is treated as another's.
      const otherThread = typeof payload.thread_id === "string" && payload.thread_id !== thread;
      if (otherThread) {
        // dropped
      } else if (payload.type === "item_completed" && isRecord(payload.item))
        out = itemLines(payload.item, (p) => {
          // A relative path is resolved against the owned cwd, else the root, before the link check (#67 review).
          const abs = p.startsWith("/") || p.startsWith("~") ? p : resolve(cwd ?? o.root, p);
          return throughLinks(realUnderRoot(abs, o.root), o.root, o.denied);
        });
      else if (payload.type === "user_message") userText(payload.message, out);
      else if (payload.type === "agent_message") agentText(payload.message, out);
    }
    // response_item, compacted and every other line type: dropped.
    if (out.length === 0) {
      stats.dropped++;
      continue;
    }
    stats.kept++;
    const ts = typeof line.timestamp === "string" && ISO_TS.test(line.timestamp) ? line.timestamp : undefined;
    for (const l of out) lines.push({ n: n++, src: `jsonl:${lineNo}`, ...l, ...(ts ? { ts } : {}) });
  }
  return {
    lines,
    nextN: n,
    stats,
    version,
    recognised,
    carry: { owned, subagent, ...(thread ? { thread } : {}), ...(cwd && cwd.length <= 4096 ? { cwd } : {}) },
  };
}
