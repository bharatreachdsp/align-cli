/** Picks the harness's payload parser (docs/10 §Hook fields used). */
import { parseClaudeCode } from "./claude-code/map";
import { parseCodex } from "./codex/map";
import { parseCursor } from "./cursor/map";
import type { Harness, HookName, MapResult } from "./hooks";

export function parseFor(harness: Harness, hook: HookName, payload: unknown, env: NodeJS.ProcessEnv): MapResult {
  if (harness === "claude-code") return parseClaudeCode(hook, payload);
  if (harness === "cursor") return parseCursor(hook, payload, env);
  return parseCodex(hook, payload);
}
