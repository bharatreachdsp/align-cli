/**
 * Registering `align mcp` with Claude Code, Cursor and Codex at `init`, and removing it at `uninstall` (docs/14
 * §Local MCP server, docs/15 §Files; L18, D416). The rules are those of the hooks files (hooks-file.ts, D219):
 *
 * - Someone else's server named `align` is never replaced or removed. ALIGN's entry is recognised by a command that is
 *   an ALIGN shim (`/.align/bin/align`, or this installation's own) with `mcp` as its first argument.
 * - A symbolic link is never written through, and a file that does not parse is left alone and named.
 * - Cursor's JSON file keeps one backup, ever. It gets its exact bytes back while untouched since ALIGN wrote it;
 *   once edited, only ALIGN's entry is removed. Codex's appended table is removed byte-exact.
 * - Claude Code's local scope (`~/.claude.json`) and Codex's `config.toml` are changed only through their own CLIs
 *   (`claude mcp add|remove`, `codex mcp add|remove`). With no binary on PATH, the Claude Code command is printed
 *   and the Codex table appended. Claude Code is skipped when the ALIGN plugin is enabled: the plugin brings the
 *   server (L41).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import { readJsonFile, writeJsonAtomic, writeUserFileAtomic } from "../fsx";
import { alignPluginEnabled } from "../harness/claude-code/plugin";
import { FORMAT, isSymlink, shellWord } from "../harness/hooks-file";

/** `foreign_repo`: the repository itself (a committed `.mcp.json` or `.cursor/mcp.json`) defines a server named align. */
export type McpOutcome =
  | "added"
  | "present"
  | "printed"
  | "plugin"
  | "foreign"
  | "foreign_repo"
  | "symlink"
  | "unparseable"
  | "failed";
export type McpRemoval = { removed: boolean; printed?: string; skipped?: "symlink" | "unparseable" | "foreign" };

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Whether a server entry (`{command, args}`) is ALIGN's: an ALIGN shim, `mcp` first. */
export function isAlignServer(v: unknown, shim: string): boolean {
  if (!isRecord(v) || typeof v.command !== "string") return false;
  const ours = v.command === shim || v.command.endsWith(`/.${CLI_BIN}/bin/${CLI_BIN}`);
  return ours && Array.isArray(v.args) && v.args[0] === "mcp";
}

function parseJsonc(text: string): Rec | null {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && isRecord(v) ? v : null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The absolute path of `bin` on the person's PATH, or null. */
export function findOnPath(env: NodeJS.ProcessEnv, bin: string): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

function runCli(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(bin, args, { cwd, env, stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code: local scope, through `claude mcp add|remove`

export const claudeAddArgs = (shim: string) => [
  "mcp",
  "add",
  "--scope",
  "local",
  "--transport",
  "stdio",
  CLI_BIN,
  "--",
  shim,
  "mcp",
];
export const claudeRemoveArgs = () => ["mcp", "remove", "--scope", "local", CLI_BIN];
const shown = (bin: string, args: string[]) => [bin, ...args].map(shellWord).join(" ");

/**
 * The `align` servers Claude Code would see in this repository: local scope (`~/.claude.json` `projects[root]`),
 * project scope (`<root>/.mcp.json`), user scope (`~/.claude.json` `mcpServers`). Read only, never written.
 */
function claudeEntries(home: string, root: string): { local: unknown; user: unknown; proj: unknown } {
  const state = parseJsonc(readText(join(home, ".claude.json")) ?? "") ?? {};
  const projects = isRecord(state.projects) ? state.projects : {};
  const project = isRecord(projects[root]) ? projects[root] : {};
  const local = isRecord(project.mcpServers) ? project.mcpServers[CLI_BIN] : undefined;
  const user = isRecord(state.mcpServers) ? state.mcpServers[CLI_BIN] : undefined;
  const mcpJson = parseJsonc(readText(join(root, ".mcp.json")) ?? "") ?? {};
  const proj = isRecord(mcpJson.mcpServers) ? mcpJson.mcpServers[CLI_BIN] : undefined;
  return { local, user, proj };
}

/** The `mcpServers.align` entry of a JSON file someone else owns (read only), or undefined. */
export function jsonServerEntry(file: string): unknown {
  const v = parseJsonc(readText(file) ?? "");
  return v && isRecord(v.mcpServers) ? v.mcpServers[CLI_BIN] : undefined;
}

export function registerClaudeCode(o: { home: string; root: string; shim: string; env: NodeJS.ProcessEnv }): {
  outcome: McpOutcome;
  command?: string;
} {
  if (alignPluginEnabled(o.home, o.root)) return { outcome: "plugin" };
  const { local, user, proj } = claudeEntries(o.home, o.root);
  // A server named align that is not ALIGN's, at any scope, stays as it is (local scope would shadow it).
  if (proj !== undefined && !isAlignServer(proj, o.shim)) return { outcome: "foreign_repo" };
  if ([local, user].some((v) => v !== undefined && !isAlignServer(v, o.shim))) return { outcome: "foreign" };
  if (local !== undefined && isRecord(local) && local.command === o.shim) return { outcome: "present" };
  const bin = findOnPath(o.env, "claude");
  const args = claudeAddArgs(o.shim);
  if (!bin) return { outcome: "printed", command: shown("claude", args) };
  // An older ALIGN entry (another shim path) is replaced through the CLI as well.
  if (local !== undefined) runCli(bin, claudeRemoveArgs(), o.root, o.env);
  return runCli(bin, args, o.root, o.env) ? { outcome: "added" } : { outcome: "failed" };
}

/** Claude Code's local-scope `align` server for `root` is ALIGN's (doctor: a duplicate of the plugin's server). */
export function claudeLocalIsAlign(home: string, root: string, shim: string): boolean {
  const { local } = claudeEntries(home, root);
  return local !== undefined && isAlignServer(local, shim);
}

export function unregisterClaudeCode(o: {
  home: string;
  root: string;
  shim: string;
  env: NodeJS.ProcessEnv;
}): McpRemoval {
  const { local } = claudeEntries(o.home, o.root);
  if (local === undefined) return { removed: false };
  if (!isAlignServer(local, o.shim)) return { removed: false, skipped: "foreign" };
  const bin = findOnPath(o.env, "claude");
  if (!bin) return { removed: false, printed: shown("claude", claudeRemoveArgs()) };
  return runCli(bin, claudeRemoveArgs(), o.root, o.env)
    ? { removed: true }
    : { removed: false, printed: shown("claude", claudeRemoveArgs()) };
}

// ---------------------------------------------------------------------------------------------------------------
// Cursor: `mcpServers.align` in a JSON file

type JsonRecord = {
  file: string;
  existed: boolean;
  before: string | null;
  after_sha256: string;
  created_dir?: boolean;
  backup?: string;
};

function readJsonRecord(recordFile: string): JsonRecord | null {
  try {
    return readJsonFile<JsonRecord | null>(
      recordFile,
      (v) =>
        isRecord(v) && typeof v.file === "string" && typeof v.after_sha256 === "string" ? (v as JsonRecord) : null,
      () => null,
    );
  } catch {
    return null;
  }
}

/** Cursor expands this in a project's `mcp.json` to the workspace folder (it is not a template string here). */
const WORKSPACE_FOLDER = ["$", "{workspaceFolder}"].join("");

export const cursorServer = (shim: string, project: boolean) => ({
  command: shim,
  args: project ? ["mcp", "--cwd", WORKSPACE_FOLDER] : ["mcp"],
});

export function installJsonServer(o: {
  file: string;
  recordFile: string;
  shim: string;
  value: Rec;
  guard?: string[];
  backup?: boolean;
  now?: number;
}): McpOutcome {
  if ([o.file, ...(o.guard ?? [])].some(isSymlink)) return "symlink";
  const existed = existsSync(o.file);
  const before = existed ? (readText(o.file) ?? "") : "";
  const parsed = parseJsonc(before);
  if (!parsed) return "unparseable";
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) return "unparseable";
  const current = isRecord(parsed.mcpServers) ? parsed.mcpServers[CLI_BIN] : undefined;
  if (current !== undefined && !isAlignServer(current, o.shim)) return "foreign";
  if (JSON.stringify(current) === JSON.stringify(o.value)) return "present";
  const base = before.trim() === "" ? "{}\n" : before;
  const merged = applyEdits(base, modify(base, ["mcpServers", CLI_BIN], o.value, { formattingOptions: FORMAT }));
  const prior = readJsonRecord(o.recordFile);
  const untouched = !!prior && prior.after_sha256 === sha256(before);
  let backup = prior?.backup;
  const hasBackup = (() => {
    try {
      return readdirSync(dirname(o.file)).some((n) => n.startsWith(`${basename(o.file)}.${CLI_BIN}-backup-`));
    } catch {
      return false;
    }
  })();
  // A file whose servers carry `env` or `headers` values (often API keys) is never copied: no backup and no copy
  // of its bytes in the record, so uninstall removes only ALIGN's entry (D223; L43 review).
  const secrets = holdsSecretValues(parsed);
  if (o.backup && existed && !backup && !hasBackup && !secrets) {
    backup = `${o.file}.${CLI_BIN}-backup-${o.now ?? Date.now()}`;
    copyFileSync(o.file, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, 0o600);
  }
  // The original bytes are kept only from before ALIGN's first change, while the file is as ALIGN left it.
  const record: JsonRecord =
    secrets && existed
      ? { file: o.file, existed: true, before: null, after_sha256: "", ...(backup ? { backup } : {}) }
      : current === undefined && !prior
        ? {
            file: o.file,
            existed,
            before: existed ? before : null,
            after_sha256: sha256(merged),
            created_dir: !existed && !existsSync(dirname(o.file)),
            ...(backup ? { backup } : {}),
          }
        : untouched && prior
          ? { ...prior, after_sha256: sha256(merged) }
          : { file: o.file, existed: true, before: null, after_sha256: "", ...(backup ? { backup } : {}) };
  const mode = existed ? statSync(o.file).mode & 0o777 : 0o644;
  if (!existed) mkdirSync(dirname(o.file), { recursive: true });
  writeUserFileAtomic(o.file, merged, mode);
  writeJsonAtomic(o.recordFile, record);
  return "added";
}

export function uninstallJsonServer(o: {
  file: string;
  recordFile: string;
  shim: string;
  guard?: string[];
}): McpRemoval {
  const record = readJsonRecord(o.recordFile);
  const file = record?.file ?? o.file;
  if ([file, ...(o.guard ?? [])].some(isSymlink)) return { removed: false, skipped: "symlink" };
  const text = readText(file);
  const done = (r: McpRemoval) => {
    rmSync(o.recordFile, { force: true });
    return r;
  };
  if (text === null) return done({ removed: false });
  const mode = statSync(file).mode & 0o777;
  if (record && record.after_sha256 === sha256(text)) {
    if (record.existed && record.before !== null) writeUserFileAtomic(file, record.before, mode);
    else {
      rmSync(file, { force: true });
      if (record.created_dir) {
        try {
          if (readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
        } catch {
          // not empty or gone
        }
      }
    }
    return done({ removed: true });
  }
  const parsed = parseJsonc(text);
  if (!parsed) return { removed: false, skipped: "unparseable" };
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  if (!servers || servers[CLI_BIN] === undefined) return done({ removed: false });
  if (!isAlignServer(servers[CLI_BIN], o.shim)) return done({ removed: false, skipped: "foreign" });
  let next = applyEdits(text, modify(text, ["mcpServers", CLI_BIN], undefined, { formattingOptions: FORMAT }));
  const rest = parseJsonc(next);
  if (rest && isRecord(rest.mcpServers) && Object.keys(rest.mcpServers).length === 0)
    next = applyEdits(next, modify(next, ["mcpServers"], undefined, { formattingOptions: FORMAT }));
  if (record && !record.existed && Object.keys(parseJsonc(next) ?? { x: 1 }).length === 0)
    rmSync(file, { force: true });
  else writeUserFileAtomic(file, next, mode);
  return done({ removed: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Codex: `[mcp_servers.align]` in config.toml

export const codexAddArgs = (shim: string) => ["mcp", "add", CLI_BIN, "--", shim, "mcp"];
export const codexRemoveArgs = () => ["mcp", "remove", CLI_BIN];

const TABLE = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${CLI_BIN}"|'${CLI_BIN}'|${CLI_BIN})\\s*\\]\\s*(?:#.*)?$`,
);
const ANY_HEADER = /^\s*\[/;

/**
 * What `config.toml` says about a server named align: null (none), `ours` (its `command` is an ALIGN shim) or
 * `foreign`. Any other spelling that may define it (an inline table, dotted keys) counts as `foreign`, so the person's
 * own definition is never shadowed or doubled.
 */
export function codexAlignEntry(text: string, shim: string): null | "ours" | "foreign" {
  const lines = text.split(/\r?\n/);
  let state: null | "ours" | "foreign" = null;
  let table: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (ANY_HEADER.test(l)) {
      table = l.trim();
      if (TABLE.test(l)) {
        let command: string | null = null;
        for (let j = i + 1; j < lines.length && !ANY_HEADER.test(lines[j] as string); j++) {
          const m = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(lines[j] as string);
          if (m?.[1] !== undefined) {
            try {
              command = JSON.parse(`"${m[1]}"`) as string;
            } catch {
              command = null;
            }
          }
        }
        const ours = command !== null && (command === shim || command.endsWith(`/.${CLI_BIN}/bin/${CLI_BIN}`));
        state = state === "foreign" || !ours ? "foreign" : "ours";
      }
      continue;
    }
    const inServers = table !== null && /^\[\s*mcp_servers\s*\]/.test(table);
    const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*["']?${CLI_BIN}["']?\\s*[.=]`);
    const inline = new RegExp(`^\\s*["']?${CLI_BIN}["']?\\s*[.=]`);
    if ((table === null && dotted.test(l)) || (inServers && inline.test(l))) state = "foreign";
  }
  return state;
}

export const codexTable = (shim: string) =>
  `\n# Added by ${CLI_BIN} init; ${CLI_BIN} uninstall removes this table.\n[mcp_servers.${CLI_BIN}]\ncommand = ${JSON.stringify(shim)}\nargs = ["mcp"]\n`;

export type CodexRecord = { mode: "cli" | "appended"; file: string; block?: string; created?: boolean };

export function registerCodex(o: {
  dir: string;
  shim: string;
  env: NodeJS.ProcessEnv;
  recordFile: string;
}): McpOutcome {
  const file = join(o.dir, "config.toml");
  if ([file, o.dir].some(isSymlink)) return "symlink";
  const text = readText(file) ?? "";
  const entry = codexAlignEntry(text, o.shim);
  if (entry === "foreign") return "foreign";
  if (entry === "ours") return "present";
  const bin = findOnPath(o.env, "codex");
  if (bin) {
    // CODEX_HOME (when absolute) is the person's own choice of directory, passed as it is.
    if (!runCli(bin, codexAddArgs(o.shim), existsSync(o.dir) ? o.dir : "/", o.env)) return "failed";
    writeJsonAtomic(o.recordFile, { mode: "cli", file } satisfies CodexRecord);
    return "added";
  }
  const block = codexTable(o.shim);
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  const existed = existsSync(file);
  const mode = existed ? statSync(file).mode & 0o777 : 0o600;
  writeUserFileAtomic(file, `${text}${sep}${block}`, mode);
  writeJsonAtomic(o.recordFile, {
    mode: "appended",
    file,
    block,
    ...(existed ? {} : { created: true }),
  } satisfies CodexRecord);
  return "added";
}

export function unregisterCodex(o: {
  dir: string;
  shim: string;
  env: NodeJS.ProcessEnv;
  recordFile: string;
}): McpRemoval {
  let record: CodexRecord | null = null;
  try {
    record = readJsonFile<CodexRecord | null>(
      o.recordFile,
      (v) => (isRecord(v) && (v.mode === "cli" || v.mode === "appended") ? (v as CodexRecord) : null),
      () => null,
    );
  } catch {
    record = null;
  }
  const file = record?.file ?? join(o.dir, "config.toml");
  if ([file, dirname(file)].some(isSymlink)) return { removed: false, skipped: "symlink" };
  const done = (r: McpRemoval) => {
    rmSync(o.recordFile, { force: true });
    return r;
  };
  const text = readText(file);
  if (text === null) return done({ removed: false });
  const entry = codexAlignEntry(text, o.shim);
  if (entry === null) return done({ removed: false });
  if (entry === "foreign") return done({ removed: false, skipped: "foreign" });
  const block = record?.block;
  if (block && text.split(block).length === 2) {
    const rest = text.replace(block, "");
    if (record?.created && rest.trim() === "") rmSync(file, { force: true });
    else writeUserFileAtomic(file, rest, statSync(file).mode & 0o777);
    return done({ removed: true });
  }
  const bin = findOnPath(o.env, "codex");
  if (bin && runCli(bin, codexRemoveArgs(), existsSync(dirname(file)) ? dirname(file) : "/", o.env))
    return done({ removed: true });
  return { removed: false, printed: shown("codex", codexRemoveArgs()) };
}

/** Whether any MCP server in the file carries `env` or `headers` values (D223: such a file is never copied). */
function holdsSecretValues(parsed: Record<string, unknown>): boolean {
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  return Object.values(servers).some(
    (s) =>
      isRecord(s) &&
      ((isRecord(s.env) && Object.keys(s.env).length > 0) ||
        (isRecord(s.headers) && Object.keys(s.headers).length > 0)),
  );
}
