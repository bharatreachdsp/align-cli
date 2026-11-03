/**
 * The ALIGN Claude Code plugin (L41, docs/24 §Listings): whether it is enabled, and what that changes.
 *
 * The plugin brings the four hooks (`… hook <event> --harness claude-code --via plugin`), the MCP server and the
 * `/align:align` command. So, in either install order, only one set of hooks captures a session (docs/15 step 6):
 * - `align init` skips Claude Code's settings-file hooks, MCP entry and `/align` command when the plugin is enabled;
 * - a settings-file hook (no `--via plugin`) exits at once when the plugin is enabled (hook/run.ts);
 * - `align doctor` offers to remove settings-file hooks left from before the plugin.
 *
 * "Enabled" follows Claude Code: `enabledPlugins` merged key by key (managed > local > project > user), and the
 * plugin installed on this machine (`installed_plugins.json`, or `plugins/synced/` for `align@synced`, which is on by
 * default). Read only, never written. Small on purpose: the hook fast path loads it.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { type ParseError, parse } from "jsonc-parser";

/** The value of `--via` a plugin hook passes (hooks/hooks.json in plugins/claude-code/align). */
export const VIA_PLUGIN = "plugin";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The settings files whose `enabledPlugins` Claude Code reads for a session in `root`, lowest precedence first. */
export const pluginSettingsFiles = (home: string, root: string) => [
  join(home, ".claude", "settings.json"),
  join(root, ".claude", "settings.json"),
  join(root, ".claude", "settings.local.json"),
];

/**
 * Managed settings (highest precedence; `true` forces, `false` blocks): Linux, macOS and Windows locations. The CLI
 * refuses to run on Windows today (docs/15 preflight), so the Windows path matters only if that changes.
 */
const MANAGED = [
  "/etc/claude-code/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "C:\\Program Files\\ClaudeCode\\managed-settings.json",
];

function readJsonc(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (text.length > 4 * 1024 * 1024) return null;
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && isRecord(v) ? v : null;
}

/** The `align@…` entries of one settings file's `enabledPlugins`. */
function entriesIn(file: string): [string, boolean][] {
  const plugins = readJsonc(file)?.enabledPlugins;
  if (!isRecord(plugins)) return [];
  return Object.entries(plugins).filter(
    (e): e is [string, boolean] => e[0].startsWith(`${CLI_BIN}@`) && typeof e[1] === "boolean",
  );
}

/**
 * The value Claude Code applies to each `align@…` id (docs: plugin loading, "Find where a plugin is enabled"): the
 * sources merge key by key and the highest-precedence source that mentions an id decides it — managed > local >
 * project > user. A plugin synced from claude.ai (`align@synced`) is on unless a source sets it to `false`.
 */
function resolvedIds(files: readonly string[]): Map<string, boolean> {
  const out = new Map<string, boolean>([[`${CLI_BIN}@synced`, true]]);
  for (const f of [...files, ...MANAGED]) for (const [id, on] of entriesIn(f)) out.set(id, on);
  return out;
}

const samePath = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

/**
 * Whether Claude Code has the plugin on disk for `root`: a marketplace install recorded in
 * `~/.claude/plugins/installed_plugins.json` (an install with a project path counts only for that project), or, for
 * `align@synced`, a copy under `~/.claude/plugins/synced/`. Read only; an unreadable record counts as not installed.
 */
function installed(home: string, root: string, id: string): boolean {
  const pluginsDir = join(home, ".claude", "plugins");
  if (id === `${CLI_BIN}@synced`) {
    try {
      return readdirSync(join(pluginsDir, "synced")).some(
        // Exactly ALIGN's: another synced plugin whose name merely starts with it (`align-lint`) must not count.
        (n) => n === CLI_BIN || n.startsWith(`${CLI_BIN}@`),
      );
    } catch {
      return false;
    }
  }
  const record = readJsonc(join(pluginsDir, "installed_plugins.json"));
  const table = isRecord(record?.plugins) ? record.plugins : record;
  const installs = isRecord(table) ? table[id] : undefined;
  const list = Array.isArray(installs) ? installs : installs !== undefined ? [installs] : [];
  return list.some((inst) => {
    if (!isRecord(inst)) return inst === true;
    const project = inst.projectPath;
    return typeof project !== "string" || samePath(project, root);
  });
}

/**
 * The ALIGN plugin is on in Claude Code for `root`: some `align@…` id resolves to `true` under Claude Code's settings
 * precedence and that plugin is actually installed. A repository's settings alone (an id it enables but nobody
 * installed) never count, so they cannot switch the settings-file hooks off.
 */
export function alignPluginEnabled(home: string, root: string): boolean {
  for (const [id, on] of resolvedIds(pluginSettingsFiles(home, root))) if (on && installed(home, root, id)) return true;
  return false;
}

/** On for the user everywhere: the user's own settings (and managed ones) enable an installed, unscoped copy. */
export function alignPluginEnabledForUser(home: string): boolean {
  for (const [id, on] of resolvedIds([join(home, ".claude", "settings.json")]))
    if (on && installed(home, "/nonexistent-project-path", id)) return true;
  return false;
}
