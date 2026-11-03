/**
 * Codex hook payloads (docs/10 §Hook fields used: `session_id`, `transcript_path` (the rollout file; null for
 * non-local stores), `cwd`, `hook_event_name`, `turn_id`; `source` / `prompt` / `stop_hook_active`,
 * `last_assistant_message` / `reason`). A prompt carrying `agent_id` is a subagent's and never becomes the person's
 * line. Shapes from the generated hook schemas at rust-v0.163.0 (`codex-rs/hooks/schema/generated`) are in
 * `__fixtures__/codex-0.163.0/`.
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

export const CODEX_HOOKS: readonly HookName[] = ["session-start", "prompt", "stop", "session-end"];

export const CODEX_EVENT: Record<string, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  stop: "Stop",
  "session-end": "SessionEnd",
};

export function parseCodex(hook: HookName, payload: unknown): MapResult {
  const p = record(payload);
  const expected = CODEX_EVENT[hook];
  if (!p || !expected) return { ok: false, code: "shape" };
  const name = str(p.hook_event_name, 64);
  if (name !== null && name !== expected) return { ok: false, code: "event_mismatch" };
  const sessionId = str(p.session_id, 200);
  if (!sessionId || !SESSION_ID.test(sessionId)) return { ok: false, code: "no_session" };
  // A subagent's hook (`agent_id`): its prompts and replies are never the person's lines, so nothing is captured.
  if (p.agent_id !== undefined && p.agent_id !== null) return { ok: false, code: "subagent" };
  const cwd = str(p.cwd);
  if (!cwd?.startsWith("/")) return { ok: false, code: "no_cwd" };
  const transcript = str(p.transcript_path);
  const input: HookInput = {
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
    subagent: p.agent_id !== undefined && p.agent_id !== null,
    version: null,
  };
  return { ok: true, input };
}
