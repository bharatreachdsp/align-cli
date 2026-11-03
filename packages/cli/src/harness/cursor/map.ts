/**
 * Cursor hook payloads (docs/10 §Hook fields used: `conversation_id`, `hook_event_name`, `cursor_version`,
 * `workspace_roots[]`, `transcript_path`; `session_id`, `is_background_agent`, `composer_mode` on sessionStart;
 * `prompt` on beforeSubmitPrompt; `text` on afterAgentResponse; `status` / `reason` on stop / sessionEnd).
 * `user_email` is never read. The repository is `workspace_roots[0]`, else `CURSOR_PROJECT_DIR`. Shapes from
 * Cursor's hooks reference and the installed agent CLI (2026.10.19) are in `__fixtures__/cursor-2026.10.19/`.
 */
import { type HookName, MAX_TEXT, type MapResult, reasonOf, record, SESSION_ID, str, VERSION } from "../hooks";

export const CURSOR_HOOKS: readonly HookName[] = ["session-start", "prompt", "response", "stop", "session-end"];

export const CURSOR_EVENT: Record<string, string> = {
  "session-start": "sessionStart",
  prompt: "beforeSubmitPrompt",
  response: "afterAgentResponse",
  stop: "stop",
  "session-end": "sessionEnd",
};

export function parseCursor(hook: HookName, payload: unknown, env: NodeJS.ProcessEnv): MapResult {
  const p = record(payload);
  const expected = CURSOR_EVENT[hook];
  if (!p || !expected) return { ok: false, code: "shape" };
  const name = str(p.hook_event_name, 64);
  if (name !== null && name !== expected) return { ok: false, code: "event_mismatch" };
  const sessionId = str(p.conversation_id, 200) ?? str(p.session_id, 200);
  if (!sessionId || !SESSION_ID.test(sessionId)) return { ok: false, code: "no_session" };
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  // A multi-root workspace mixes repositories in one conversation: not captured (D95), so no prompt about one
  // repository is ever filed under another.
  if (roots.length > 1) return { ok: false, code: "multi_root" };
  const cwd = str(roots[0]) ?? str(env.CURSOR_PROJECT_DIR);
  if (!cwd?.startsWith("/")) return { ok: false, code: "no_cwd" };
  const version = str(p.cursor_version, 64);
  const transcript = str(p.transcript_path);
  return {
    ok: true,
    input: {
      hook,
      hookEvent: expected,
      sessionId,
      transcriptPath: transcript?.startsWith("/") ? transcript : null,
      cwd,
      // Cursor's sessionStart has no source; a new composer conversation is a start.
      source: hook === "session-start" ? "startup" : "unknown",
      prompt: hook === "prompt" ? str(p.prompt, MAX_TEXT) : null,
      lastAssistantMessage: hook === "response" ? str(p.text, MAX_TEXT) : null,
      reason: hook === "session-end" ? reasonOf(p.reason) : reasonOf(p.status),
      stopHookActive: false,
      subagent: false,
      version: version && VERSION.test(version) ? version : null,
    },
  };
}
