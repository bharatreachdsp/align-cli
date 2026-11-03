/** Removes exactly ALIGN's Claude Code hook entries (docs/15 §Guarantees 6); see `../hooks-file.ts`. */
import { join } from "node:path";
import type { Paths } from "../../paths";
import { type FileUninstallResult, removeHooks as remove, uninstallHooksFile } from "../hooks-file";
import { CLAUDE_SPEC, recordFile, SETTINGS_REL } from "./install";

export const removeHooks = (text: string, shim: string) => remove(CLAUDE_SPEC, text, shim);

export type UninstallResult = FileUninstallResult;

export function uninstallClaudeCode(paths: Paths, root: string, shim: string): UninstallResult {
  return uninstallHooksFile(CLAUDE_SPEC, {
    file: join(root, SETTINGS_REL),
    recordFile: recordFile(paths, root),
    shim,
    guard: [join(root, ".claude")],
  });
}
