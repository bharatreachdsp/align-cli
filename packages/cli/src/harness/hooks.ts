/**
 * What every harness's hook payload becomes (docs/10 §Hook fields used): one normalised `HookInput`, so the fast
 * path (hook/run.ts) is the same for Claude Code, Cursor and Codex. Each harness's `map.ts` reads only the fields
 * docs/10 lists for it; everything else in a payload is ignored and never stored. A missing field never throws.
 */
import type { Kind } from "../hook/events";

/** ALIGN's hook entry names (`align hook <name> --harness <h>`); `response` is Cursor's `afterAgentResponse`. */
export type HookName = "session-start" | "prompt" | "response" | "stop" | "session-end";
export const HOOK_NAMES: readonly HookName[] = ["session-start", "prompt", "response", "stop", "session-end"];

export type Harness = "claude-code" | "cursor" | "codex";
export const HARNESS_NAMES: readonly Harness[] = ["claude-code", "cursor", "codex"];

export type Source = "startup" | "resume" | "clear" | "compact" | "fork" | "unknown";

export type HookInput = {
  hook: HookName;
  /** The harness's own event name (docs/10), recorded as `harness.hook_event`. */
  hookEvent: string;
  sessionId: string;
  transcriptPath: string | null;
  cwd: string;
  source: Source;
  /** The prompt text (prompt hooks; used in hooks mode only). */
  prompt: string | null;
  /** The reply text: Claude Code and Codex `Stop.last_assistant_message`, Cursor `afterAgentResponse.text`. */
  lastAssistantMessage: string | null;
  reason: string;
  stopHookActive: boolean;
  /** A subagent's prompt (Codex `agent_id`): never captured as the person's line. */
  subagent: boolean;
  /** The harness's version when the payload carries it (Cursor `cursor_version`). */
  version: string | null;
};

export type MapResult = { ok: true; input: HookInput } | { ok: false; code: string };

export const str = (v: unknown, max = 4096): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

export const SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;
export const REASON = /^[A-Za-z0-9_.-]{1,64}$/;
/** A harness session id we are willing to key files and events on. */
export const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
export const VERSION = /^[\w.+-]{1,64}$/;
export const MAX_TEXT = 4 * 1024 * 1024;

export const record = (payload: unknown): Record<string, unknown> | null =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;

export const sourceOf = (v: unknown): Source => SOURCES.find((s) => s === v) ?? "unknown";
export const reasonOf = (v: unknown): string => {
  const r = str(v, 64);
  return r && REASON.test(r) ? r : "other";
};

/**
 * Transcript mode at session start (docs/10 §Transcript modes): jsonl when the harness names a `.jsonl` transcript
 * the CLI can parse; hooks otherwise. Cursor always uses hooks mode for live capture (D95): its agent transcripts
 * merge the model's reasoning into the assistant text, which a reader must never send (docs/15 §Guarantees 3).
 */
export function chooseMode(harness: string, input: HookInput): "jsonl" | "hooks" {
  if (harness === "cursor") return "hooks";
  return input.transcriptPath?.endsWith(".jsonl") ? "jsonl" : "hooks";
}

export type Draft = { kind: Kind; payload: Record<string, unknown> };

/** The lifecycle event a hook emits (hooks-mode transcript lines are added by the fast path). */
export function lifecycleEvent(input: HookInput, mode: "jsonl" | "hooks"): Draft | null {
  switch (input.hook) {
    case "session-start":
      return { kind: "session.start", payload: { source: input.source, transcript_mode: mode } };
    case "stop":
      return { kind: "session.stop", payload: {} };
    case "session-end":
      return { kind: "session.end", payload: { reason: input.reason } };
    default:
      return null;
  }
}

/** The one line hooks mode takes from this hook: the prompt, or the reply. */
export function hooksModeText(harness: string, input: HookInput): { role: "user" | "assistant"; text: string } | null {
  if (input.hook === "prompt" && input.prompt && !input.subagent) return { role: "user", text: input.prompt };
  // Cursor's reply arrives in afterAgentResponse; its stop carries no text. The others end a turn with Stop.
  const replyHook = harness === "cursor" ? "response" : "stop";
  if (input.hook === replyHook && input.lastAssistantMessage)
    return { role: "assistant", text: input.lastAssistantMessage };
  return null;
}
