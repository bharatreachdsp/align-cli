/**
 * Claude Code's hook entries (docs/15 §Hook entries written): the four entries merged into
 * `<repo>/.claude/settings.local.json` (added to `.git/info/exclude` by the caller, so `git status` stays clean).
 * The merge, the exact restore and the symlink refusal are `../hooks-file.ts`; the original settings are kept in
 * `~/.align/repos/<hash>/claude-code.json` (0600).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paths } from "../../paths";
import type { HookName } from "../hooks";
import {
  type HooksFileSpec,
  hookCommand as hookCommandFor,
  hooksInstalled,
  installHooksFile,
  isSymlink,
  mergeHooks as merge,
  parseSettings,
  pruneStale,
} from "../hooks-file";

export { FORMAT, parseSettings, SettingsParseError, SettingsShapeError, sha256 } from "../hooks-file";

export const SETTINGS_REL = ".claude/settings.local.json";
export const HARNESS = "claude-code";

/** docs/10 §Hooks installed per harness: SessionStart 3 s, the others 5 s. Fixed before the first release. */
/** Settings that hold `env` values: a copy of them is never kept (they are often credentials), D223. */
export const holdsEnvValues = (text: string) => {
  if (text.trim() === "") return false;
  try {
    const env = parseSettings(text).env;
    return typeof env === "object" && env !== null && Object.keys(env).length > 0;
  } catch {
    return true;
  }
};

export const CLAUDE_SPEC: HooksFileSpec = {
  harness: "claude-code",
  shape: "grouped",
  noCopy: holdsEnvValues,
  entries: [
    { hook: "session-start", event: "SessionStart", timeout: 3 },
    { hook: "prompt", event: "UserPromptSubmit", timeout: 5 },
    { hook: "stop", event: "Stop", timeout: 5 },
    { hook: "session-end", event: "SessionEnd", timeout: 5 },
  ],
};

export const hookCommand = (shim: string, hook: HookName) => hookCommandFor(shim, hook, "claude-code");
export const mergeHooks = (text: string, shim: string) => merge(CLAUDE_SPEC, text, shim);
export const recordFile = (paths: Paths, root: string) => join(dirname(paths.installed(root)), "claude-code.json");
const guard = (root: string) => [join(root, ".claude")];

/** True when `.claude` or the settings file is a symbolic link (a repository could plant one): never written. */
export const settingsIsSymlink = (root: string) => [join(root, ".claude"), join(root, SETTINGS_REL)].some(isSymlink);

export type InstallResult = { changed: boolean; file: string; skipped?: "symlink" | "unparseable" | "shape" };

/** Drops the kept original when the settings file changed since ALIGN wrote it. */
export const pruneStaleRecord = (paths: Paths, root: string) =>
  pruneStale(recordFile(paths, root), join(root, SETTINGS_REL));

export function installClaudeCode(paths: Paths, root: string, shim: string): InstallResult {
  const file = join(root, SETTINGS_REL);
  return {
    file,
    ...installHooksFile(CLAUDE_SPEC, { file, recordFile: recordFile(paths, root), shim, guard: guard(root) }),
  };
}

/** For doctor: all four entries present and pointing at this shim. */
export function claudeCodeInstalled(root: string, shim: string): boolean {
  try {
    return hooksInstalled(CLAUDE_SPEC, readFileSync(join(root, SETTINGS_REL), "utf8"), shim);
  } catch {
    return false;
  }
}
