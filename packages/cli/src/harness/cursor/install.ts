/**
 * Cursor's hook entries (docs/10 §Hooks installed per harness, docs/15 §Hook entries written): merged into the
 * user-level `~/.cursor/hooks.json` (`"version": 1`; backed up once before ALIGN's first change), because a project
 * `.cursor/hooks.json` is usually committed. The hooks exit at once outside registered, opted-in repositories.
 * Merge and exact restore: `../hooks-file.ts`; the record is `~/.align/harness/cursor.json`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../../paths";
import {
  type FileInstallResult,
  type FileUninstallResult,
  type HooksFileSpec,
  hooksInstalled,
  installHooksFile,
  uninstallHooksFile,
} from "../hooks-file";

export const CURSOR_SPEC: HooksFileSpec = {
  harness: "cursor",
  shape: "flat",
  ensureTop: { version: 1 },
  entries: [
    { hook: "session-start", event: "sessionStart", timeout: 3 },
    { hook: "prompt", event: "beforeSubmitPrompt", timeout: 5 },
    { hook: "response", event: "afterAgentResponse", timeout: 5 },
    { hook: "stop", event: "stop", timeout: 5 },
    { hook: "session-end", event: "sessionEnd", timeout: 5 },
  ],
};

export const cursorDir = (home: string) => join(home, ".cursor");
export const cursorHooksFile = (home: string) => join(cursorDir(home), "hooks.json");

export function installCursor(paths: Paths, home: string, shim: string, now?: number): FileInstallResult {
  return installHooksFile(CURSOR_SPEC, {
    file: cursorHooksFile(home),
    recordFile: paths.harnessRecord("cursor"),
    shim,
    guard: [cursorDir(home)],
    backup: true,
    now,
  });
}

export function uninstallCursor(paths: Paths, home: string, shim: string): FileUninstallResult {
  return uninstallHooksFile(CURSOR_SPEC, {
    file: cursorHooksFile(home),
    recordFile: paths.harnessRecord("cursor"),
    shim,
    guard: [cursorDir(home)],
  });
}

export function cursorInstalled(home: string, shim: string): boolean {
  try {
    return hooksInstalled(CURSOR_SPEC, readFileSync(cursorHooksFile(home), "utf8"), shim);
  } catch {
    return false;
  }
}
