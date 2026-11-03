/**
 * Claude Code hook payloads → trace events (docs/10 §Hook fields used, §Kinds and payloads). Only the fields
 * docs/10 lists are read; everything else in the payload is ignored and never stored. A missing field never
 * throws: a payload without a session id or a working directory is an unknown shape (the caller counts it and
 * exits 0). Shapes recorded from Claude Code 2.1.307 are in `__fixtures__/claude-code-2.1.307/`.
 */
import {
  type HookInput,
  type HookName,
  MAX_TEXT,
  type MapResult,
  reasonOf,
  record,
  SESSION_ID,
  sourceOf,
  str,
} from "../hooks";

/** Claude Code's hooks: the four of docs/15 §Hook entries written. */
export const CLAUDE_HOOKS: readonly HookName[] = ["session-start", "prompt", "stop", "session-end"];

/** The Claude Code event each ALIGN hook entry is installed under (docs/15 §Hook entries written). */
export const CLAUDE_EVENT: Record<string, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  stop: "Stop",
  "session-end": "SessionEnd",
};

export function parseClaudeCode(hook: HookName, payload: unknown): MapResult {
  const p = record(payload);
  const expected = CLAUDE_EVENT[hook];
  if (!p || !expected) return { ok: false, code: "shape" };
  const name = str(p.hook_event_name, 64);
  // A payload for another event (or another harness's shape) is not ours to map.
  if (name !== null && name !== expected) return { ok: false, code: "event_mismatch" };
  const sessionId = str(p.session_id, 200);
  if (!sessionId || !SESSION_ID.test(sessionId)) return { ok: false, code: "no_session" };
  const cwd = str(p.cwd);
  if (!cwd?.startsWith("/")) return { ok: false, code: "no_cwd" };
  const transcript = str(p.transcript_path);
  return {
    ok: true,
    input: {
      hook,
      hookEvent: expected,
      sessionId,
      transcriptPath: transcript?.startsWith("/") ? transcript : null,
      cwd,
      source: sourceOf(p.source),
      prompt: hook === "prompt" ? str(p.prompt, MAX_TEXT) : null,
      lastAssistantMessage: hook === "stop" ? str(p.last_assistant_message, MAX_TEXT) : null,
      reason: reasonOf(p.reason),
      stopHookActive: p.stop_hook_active === true,
      subagent: false,
      version: null,
    },
  };
}

export type { HookInput, HookName, MapResult };
