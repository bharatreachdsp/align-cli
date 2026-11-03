/**
 * `align init` steps 6–7 for Claude Code and git (docs/15): detect, ask, install the hook entries, the git hook
 * wrappers and the `.git/info/exclude` lines; and their removal for `align uninstall`. What was installed for a
 * repository is recorded in `~/.align/repos/<hash>/installed.json`, so uninstall removes exactly that.
 * Cursor and Codex join in L13.
 */
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { invalidDenyGlobs } from "@align/core/redact";
import { z } from "zod";
import type { Ctx } from "../context";
import { copy } from "../copy";
import { readJsonFile, writeJsonAtomic } from "../fsx";
import { git, INTERACTIVE_GIT_TIMEOUT_MS } from "../git";
import { addExcludes, excludeFile, removeExcludes, restoreExcludes } from "../git/exclude";
import {
  GIT_HOOKS,
  gitHooksInstalled,
  gitHooksPlan,
  hookManagerLine,
  installGitHooks,
  uninstallGitHooks,
} from "../git/install";
import { commandInstalled, installCommand, uninstallCommand } from "../harness/claude-code/command";
import {
  claudeCodeInstalled,
  holdsEnvValues,
  installClaudeCode,
  pruneStaleRecord,
  SETTINGS_REL,
  settingsIsSymlink,
} from "../harness/claude-code/install";
import { alignPluginEnabled, alignPluginEnabledForUser } from "../harness/claude-code/plugin";
import { convertLines } from "../harness/claude-code/transcript";
import { removeHooks, uninstallClaudeCode } from "../harness/claude-code/uninstall";
import { codexDir, codexInstalled, codexTrusted, installCodex, uninstallCodex } from "../harness/codex/install";
import { cursorDir, cursorInstalled, installCursor, uninstallCursor } from "../harness/cursor/install";
import {
  alignAllowRules,
  CURSOR_CLI_REL,
  installCursorPermissions,
  uninstallCursorPermissions,
} from "../harness/cursor/permissions";
import { convertCursorLines, encodeCursorProject } from "../harness/cursor/transcript";
import { readDenyFile } from "../hook/events";
import { listStates } from "../hook/state";
import {
  claudeLocalIsAlign,
  cursorServer,
  installJsonServer,
  isAlignServer,
  jsonServerEntry,
  type McpOutcome,
  type McpRemoval,
  registerClaudeCode,
  registerCodex,
  uninstallJsonServer,
  unregisterClaudeCode,
  unregisterCodex,
} from "../mcp/register";
import { RULE_REL, removeRule, ruleIsOurs, writeRule } from "../pack/cursor-rule";
import { readRegistry } from "../registry";
import { readDelta } from "../transcripts/reader";

export const SUPPORTED_HARNESSES = ["claude-code", "cursor", "codex"] as const;
export type HarnessName = (typeof SUPPORTED_HARNESSES)[number];

const Installed = z.object({
  version: z.literal(1).default(1),
  harnesses: z.array(z.string()).default([]),
  exclude_file: z.string().nullable().default(null),
  exclude_added: z.array(z.string()).default([]),
  /** The exclude file before ALIGN's first line (null: ALIGN created it) and its hash after, for an exact restore. */
  exclude_before: z.string().nullable().optional(),
  exclude_after_sha256: z.string().optional(),
  git_hooks_dir: z.string().nullable().default(null),
  /** The directories `init` created for Cursor's rule file (removed again when empty). */
  cursor_rule_dirs: z.array(z.string()).optional(),
  /** init wrote `.cursor/rules/align.mdc` here (the hook and `align pack` refresh only such a file). */
  cursor_rule: z.boolean().optional(),
  /** What `init` did about the MCP server per harness (L18): `added`, `present`, `printed`, `plugin`, … */
  mcp: z.record(z.string(), z.string()).optional(),
  /** The untracked project `.cursor/mcp.json` ALIGN's server was merged into (else the user-level file). */
  cursor_mcp_file: z.string().optional(),
  /** The untracked `.cursor/cli.json` ALIGN's allow rules for its read-only tools were merged into (D534). */
  cursor_cli_file: z.string().optional(),
});
type Installed = z.infer<typeof Installed>;

export function readInstalled(ctx: Ctx, root: string): Installed {
  try {
    return readJsonFile(
      ctx.paths.installed(root),
      (v) => {
        const r = Installed.safeParse(v);
        return r.success ? r.data : null;
      },
      () => Installed.parse({}),
    );
  } catch {
    return Installed.parse({});
  }
}

const homeDir = (ctx: Ctx) => ctx.env.HOME || homedir();

function onPath(ctx: Ctx, bin: string): boolean {
  for (const dir of (ctx.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      if (statSync(join(dir, bin)).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * docs/15 step 6: Claude Code is `claude` on PATH or `~/.claude`; Cursor `~/.cursor` or `cursor` (or its terminal
 * agent, `cursor-agent`) on PATH; Codex `codex` on PATH or `~/.codex` (`$CODEX_HOME`).
 */
export function detectHarnesses(ctx: Ctx): HarnessName[] {
  const found: HarnessName[] = [];
  const home = homeDir(ctx);
  if (onPath(ctx, "claude") || existsSync(join(home, ".claude"))) found.push("claude-code");
  if (onPath(ctx, "cursor") || onPath(ctx, "cursor-agent") || existsSync(cursorDir(home))) found.push("cursor");
  if (onPath(ctx, "codex") || existsSync(codexDir(ctx.env, home))) found.push("codex");
  return found;
}

/** Cursor and Codex hooks are user-level: still needed while another registered repository uses that harness. */
function usedElsewhere(ctx: Ctx, root: string, harness: HarnessName): boolean {
  return Object.entries(readRegistry(ctx.paths).repos).some(([r, e]) => r !== root && e.harnesses.includes(harness));
}

/** Which harnesses to configure: `--harness`, else the detected ones (asked one by one on a terminal). */
export async function chooseHarnesses(ctx: Ctx, opts: { harness?: string; yes?: boolean }): Promise<HarnessName[]> {
  if (opts.harness) {
    const wanted = opts.harness.split(",").map((h) => h.trim());
    return SUPPORTED_HARNESSES.filter((h) => wanted.includes(h));
  }
  const detected = detectHarnesses(ctx);
  if (opts.yes || !ctx.io.isTTY) return detected;
  const chosen: HarnessName[] = [];
  for (const h of detected) {
    const a = ((await ctx.ask(copy.configureHarness(copy.harnessName[h] ?? h))) ?? "").trim().toLowerCase();
    if (a === "" || a === "y" || a === "yes") chosen.push(h);
  }
  return chosen;
}

/**
 * Installs the chosen harnesses, the git hooks and the exclude lines. Returns the harnesses the repository's registry
 * entry should list — the ones it listed before (`previous`) plus the ones installed now — which is what the
 * fast path's harness gate trusts. What is on disk (`installed.json`'s `harnesses`, kept after a failed uninstall so
 * a second one can finish) is only ever read by uninstall, never fed back into the registry.
 */
export async function installHarnesses(
  ctx: Ctx,
  root: string,
  harnesses: HarnessName[],
  previous: readonly string[] = [],
): Promise<HarnessName[]> {
  const shim = ctx.paths.shim;
  const installed = readInstalled(ctx, root);
  const excludes: string[] = [];
  let ruleDirs: string[] = installed.cursor_rule_dirs ?? [];
  let ruleWritten = installed.cursor_rule === true;
  ctx.line(copy.installing);
  const done: HarnessName[] = [];
  const pluginOnly: HarnessName[] = [];
  for (const h of harnesses) {
    if (h === "claude-code" && alignPluginEnabled(homeDir(ctx), root)) {
      // The plugin brings the hooks, the MCP server and /align:align; init adds none of them (docs/15 step 6, L41).
      // Claude Code is still listed for this repository: the plugin's hooks capture only where it is (D1245).
      pluginOnly.push(h);
      ctx.line(copy.claudeCodePlugin);
    } else if (h === "claude-code") {
      // A committed settings file would show ALIGN's entries in `git status` and could be committed: left alone.
      const tracked = await git(["ls-files", "--error-unmatch", "--", SETTINGS_REL], root, INTERACTIVE_GIT_TIMEOUT_MS);
      const r = tracked !== null ? { skipped: "tracked" as const } : installClaudeCode(ctx.paths, root, shim);
      if (r.skipped) {
        ctx.line(copy.claudeCodeSkipped(r.skipped));
        continue;
      }
      excludes.push(`/${SETTINGS_REL}`);
      done.push(h);
      ctx.line(copy.installedClaudeCode);
      ctx.line(
        installCommand(homeDir(ctx), shim) === "foreign" ? copy.claudeCommandSkipped : copy.installedClaudeCommand,
      );
    } else if (h === "cursor" || h === "codex") {
      const r =
        h === "cursor"
          ? installCursor(ctx.paths, homeDir(ctx), shim, ctx.now())
          : installCodex(ctx.paths, codexDir(ctx.env, homeDir(ctx)), shim, ctx.now());
      if (r.skipped) {
        const shown =
          h === "cursor" ? "~/.cursor/hooks.json" : `${codexShown(ctx, codexDir(ctx.env, homeDir(ctx)))}/hooks.json`;
        ctx.line(copy.userHooksSkipped(h, shown, r.skipped));
        continue;
      }
      done.push(h);
      ctx.line(
        h === "cursor"
          ? copy.installedCursor
          : copy.installedCodex(`${codexShown(ctx, codexDir(ctx.env, homeDir(ctx)))}/hooks.json`),
      );
      if (h === "cursor") {
        const rule = await installCursorRule(ctx, root);
        if (rule) {
          excludes.push(`/${RULE_REL}`);
          ruleDirs = [...new Set([...ruleDirs, ...rule])];
          ruleWritten = true;
        }
      }
    }
  }
  const mcp = { ...(installed.mcp ?? {}) };
  let cursorMcpFile = installed.cursor_mcp_file;
  let cursorCliFile = installed.cursor_cli_file;
  for (const h of done) {
    const r = await registerMcp(ctx, root, h);
    mcp[h] = r.outcome;
    if (r.cursorFile !== undefined) cursorMcpFile = r.cursorFile ?? undefined;
    // The project file now names this laptop's shim (a home path): kept out of `git status`, so it is never committed.
    if (r.cursorFile) excludes.push(`/${CURSOR_MCP_REL}`);
    if (h === "cursor" && (r.outcome === "added" || r.outcome === "present")) {
      const cli = await allowCursorTools(ctx, root);
      if (cli) {
        cursorCliFile = cli;
        excludes.push(`/${CURSOR_CLI_REL}`);
      }
    }
  }
  const plan = await gitHooksPlan(root);
  let hooksDir: string | null = installed.git_hooks_dir;
  if (plan.kind === "hooks_dir") {
    const r = installGitHooks(plan.dir, shim);
    hooksDir = plan.dir;
    const skipped = r.filter((x) => x.skipped).map((x) => x.name);
    ctx.line(skipped.length ? copy.gitHooksSkipped(skipped) : copy.installedGitHooks);
  } else if (plan.kind === "hooks_path") {
    ctx.line(
      copy.gitHooksPath(
        plan.path,
        GIT_HOOKS.map((n) => `${n}: ${hookManagerLine(shim, n)}`),
      ),
    );
  }
  const file = await excludeFile(root);
  let added = installed.exclude_added;
  let exact: { exclude_before?: string | null; exclude_after_sha256?: string } = {
    ...(installed.exclude_after_sha256 !== undefined
      ? { exclude_before: installed.exclude_before ?? null, exclude_after_sha256: installed.exclude_after_sha256 }
      : {}),
  };
  if (file && excludes.length > 0) {
    const change = addExcludes(file, excludes);
    if (change) {
      added = [...new Set([...added, ...change.added])];
      // The exact restore holds only for ALIGN's first change; later additions fall back to removing lines.
      exact =
        added.length === change.added.length
          ? { exclude_before: change.before, exclude_after_sha256: change.after_sha256 }
          : {};
    }
    ctx.line(copy.installedExclude);
  }
  const onDisk = [...new Set([...installed.harnesses, ...done])];
  writeJsonAtomic(ctx.paths.installed(root), {
    version: 1,
    harnesses: onDisk,
    exclude_file: file ?? installed.exclude_file,
    exclude_added: added,
    ...exact,
    git_hooks_dir: hooksDir,
    ...(ruleDirs.length > 0 ? { cursor_rule_dirs: ruleDirs } : {}),
    ...(ruleWritten ? { cursor_rule: true } : {}),
    ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    ...(cursorMcpFile ? { cursor_mcp_file: cursorMcpFile } : {}),
    ...(cursorCliFile ? { cursor_cli_file: cursorCliFile } : {}),
  } satisfies Installed);
  // A "no" is honoured on a re-run: a harness listed before stays only if chosen again (its hooks may stay on disk;
  // the fast path's gate is what stops capture).
  return [
    ...new Set([...previous.filter((h) => (harnesses as readonly string[]).includes(h)), ...done, ...pluginOnly]),
  ].filter((h): h is HarnessName => (SUPPORTED_HARNESSES as readonly string[]).includes(h));
}

const CURSOR_MCP_REL = join(".cursor", "mcp.json");
const cursorMcpRecord = (ctx: Ctx, root: string) => join(ctx.paths.repoDir(root), "cursor-mcp.json");
const userCursorMcp = (ctx: Ctx) => join(cursorDir(homeDir(ctx)), "mcp.json");

/**
 * docs/14 §Local MCP server: `align mcp` registered with one harness, and the init line for it. Cursor's server goes
 * into an untracked project `.cursor/mcp.json` when one exists (with `--cwd ${workspaceFolder}`), else into
 * `~/.cursor/mcp.json`.
 */
async function registerMcp(
  ctx: Ctx,
  root: string,
  h: HarnessName,
): Promise<{ outcome: McpOutcome; cursorFile?: string | null }> {
  const shim = ctx.paths.shim;
  const name = copy.harnessName[h] ?? h;
  const say = (outcome: McpOutcome, where: string, command?: string) => {
    if (outcome === "added" || outcome === "present") ctx.line(copy.mcp.installed(name, where));
    else if (outcome === "printed" && command) ctx.line(copy.mcp.printed(name, command));
    else if (outcome === "plugin") ctx.line(copy.mcp.plugin);
    else if (outcome === "foreign") ctx.line(copy.mcp.foreign(name, where));
    else if (outcome === "foreign_repo") ctx.line(copy.mcp.foreignRepo(name, where));
    else ctx.line(copy.mcp.failed(name, where));
  };
  if (h === "claude-code") {
    const r = registerClaudeCode({ home: homeDir(ctx), root, shim, env: ctx.env });
    say(r.outcome, r.outcome === "foreign_repo" ? ".mcp.json" : "local scope, ~/.claude.json", r.command);
    return { outcome: r.outcome };
  }
  if (h === "cursor") {
    const project = join(root, CURSOR_MCP_REL);
    // Untracked only when git answered and listed nothing: an error or a timeout counts as tracked, so the user-level
    // file is used and nothing in the repository is changed.
    const listed = existsSync(project)
      ? await git(["ls-files", "-z", "--", CURSOR_MCP_REL], root, INTERACTIVE_GIT_TIMEOUT_MS)
      : null;
    const untracked = listed === "";
    // A committed project file with its own align server: Cursor would see both, so nothing is added.
    const committed = !untracked && existsSync(project) ? jsonServerEntry(project) : undefined;
    if (committed !== undefined && !isAlignServer(committed, shim)) {
      say("foreign_repo", CURSOR_MCP_REL);
      return { outcome: "foreign_repo", cursorFile: null };
    }
    const outcome = untracked
      ? installJsonServer({
          file: project,
          recordFile: cursorMcpRecord(ctx, root),
          shim,
          value: cursorServer(shim, true),
          guard: [join(root, ".cursor")],
        })
      : installJsonServer({
          file: userCursorMcp(ctx),
          recordFile: ctx.paths.harnessRecord("cursor-mcp"),
          shim,
          value: cursorServer(shim, false),
          guard: [cursorDir(homeDir(ctx))],
          backup: true,
          now: ctx.now(),
        });
    say(outcome, untracked ? CURSOR_MCP_REL : "~/.cursor/mcp.json");
    return { outcome, cursorFile: untracked && (outcome === "added" || outcome === "present") ? project : null };
  }
  const dir = codexDir(ctx.env, homeDir(ctx));
  const outcome = registerCodex({ dir, shim, env: ctx.env, recordFile: ctx.paths.harnessRecord("codex-mcp") });
  say(outcome, `${codexShown(ctx, dir)}/config.toml`);
  return { outcome };
}

const cursorCliRecord = (ctx: Ctx, root: string) => join(ctx.paths.repoDir(root), "cursor-cli.json");

/**
 * D534: Cursor's CLI rejects an MCP tool call no `permissions.allow` rule matches (always, in print mode), so ALIGN's
 * read-only tools are allowed in the repository's `.cursor/cli.json` — only while that file is untracked (git must
 * answer: an error or a timeout counts as tracked). Returns the file written, or null (the rules are then printed).
 */
async function allowCursorTools(ctx: Ctx, root: string): Promise<string | null> {
  const file = join(root, CURSOR_CLI_REL);
  const listed = await git(["ls-files", "-z", "--", CURSOR_CLI_REL], root, INTERACTIVE_GIT_TIMEOUT_MS);
  const outcome =
    listed === ""
      ? installCursorPermissions({ file, recordFile: cursorCliRecord(ctx, root), guard: [join(root, ".cursor")] })
      : null;
  if (outcome === "added" || outcome === "present") {
    ctx.line(copy.mcp.cursorAllowed);
    return file;
  }
  ctx.line(copy.mcp.cursorAllowSkipped(alignAllowRules()));
  return null;
}

/** Prints what an MCP removal needs from the person; true when something was left behind. */
function mcpRemoved(ctx: Ctx, file: string, r: McpRemoval): boolean {
  if (r.printed) ctx.line(copy.mcp.removePrinted(r.printed));
  if (r.skipped === "symlink" || r.skipped === "unparseable") {
    ctx.line(copy.mcp.left(file));
    return true;
  }
  return false;
}

/**
 * Cursor's rule file (docs/14 §Delivery), created at init with the pending text (the next session start fills it). A committed file,
 * a symbolic link or someone else's rule is left alone. Returns the directories created, or null when nothing was
 * written.
 */
async function installCursorRule(ctx: Ctx, root: string): Promise<string[] | null> {
  const tracked = await git(["ls-files", "--error-unmatch", "--", RULE_REL], root, INTERACTIVE_GIT_TIMEOUT_MS);
  const created = tracked !== null ? null : writeRule(root, null, true);
  ctx.line(created ? copy.installedCursorRule : copy.cursorRuleSkipped);
  return created;
}

/**
 * Removes everything `installHarnesses` added for this repository. Each step stands alone: a file that cannot be
 * changed (someone left it unparseable) is named in the output and the rest still happens.
 */
export function uninstallHarnesses(ctx: Ctx, root: string): boolean {
  const installed = readInstalled(ctx, root);
  let failed = false;
  const step = (file: string, run: () => { skipped?: string } | unknown) => {
    try {
      const r = run() as { skipped?: string; wrappers?: number } | undefined;
      if (r?.wrappers) ctx.line(copy.uninstallWrapperLeft(file));
      if (r?.skipped) {
        failed = true;
        ctx.line(copy.uninstallSkipped(file, r.skipped === "symlink" ? "symlink" : "unreadable"));
      }
    } catch {
      failed = true;
      ctx.line(copy.uninstallSkipped(file));
    }
  };
  if (installed.harnesses.includes("claude-code") || existsSync(join(root, SETTINGS_REL)))
    step(SETTINGS_REL, () => uninstallClaudeCode(ctx.paths, root, ctx.paths.shim));
  // The /align command is user-level: it goes with the last repository that captures Claude Code.
  if (installed.harnesses.includes("claude-code") && !usedElsewhere(ctx, root, "claude-code"))
    step("~/.claude/commands", () => uninstallCommand(homeDir(ctx)));
  // Before the rule file, so the `.cursor` directory init created is empty again when the rule's directories go.
  const cliFile = installed.cursor_cli_file;
  if (cliFile)
    step(CURSOR_CLI_REL, () =>
      uninstallCursorPermissions({
        file: cliFile,
        recordFile: cursorCliRecord(ctx, root),
        guard: [join(root, ".cursor")],
      }),
    );
  if (installed.harnesses.includes("cursor")) step(RULE_REL, () => removeRule(root, installed.cursor_rule_dirs ?? []));
  // User-level hooks go only when no other registered repository still uses them.
  if (installed.harnesses.includes("cursor") && !usedElsewhere(ctx, root, "cursor"))
    step("~/.cursor/hooks.json", () => uninstallCursor(ctx.paths, homeDir(ctx), ctx.paths.shim));
  if (installed.harnesses.includes("codex") && !usedElsewhere(ctx, root, "codex"))
    step(`${codexShown(ctx, codexDir(ctx.env, homeDir(ctx)))}/hooks.json`, () =>
      uninstallCodex(ctx.paths, codexDir(ctx.env, homeDir(ctx)), ctx.paths.shim),
    );
  // The MCP server (L18): Claude Code's is per repository (local scope); Cursor's project file too; the user-level
  // Cursor and Codex entries go with the last repository using that harness.
  const mcpStep = (file: string, run: () => McpRemoval) => {
    try {
      if (mcpRemoved(ctx, file, run())) failed = true;
    } catch {
      failed = true;
      ctx.line(copy.mcp.left(file));
    }
  };
  if (installed.harnesses.includes("claude-code"))
    mcpStep("~/.claude.json", () =>
      unregisterClaudeCode({ home: homeDir(ctx), root, shim: ctx.paths.shim, env: ctx.env }),
    );
  const projectMcp = installed.cursor_mcp_file;
  if (projectMcp)
    mcpStep(CURSOR_MCP_REL, () =>
      uninstallJsonServer({
        file: projectMcp,
        recordFile: cursorMcpRecord(ctx, root),
        shim: ctx.paths.shim,
        guard: [join(root, ".cursor")],
      }),
    );
  if (installed.harnesses.includes("cursor") && !usedElsewhere(ctx, root, "cursor"))
    mcpStep("~/.cursor/mcp.json", () => removeUserCursorMcp(ctx));
  if (installed.harnesses.includes("codex") && !usedElsewhere(ctx, root, "codex"))
    mcpStep(`${codexShown(ctx, codexDir(ctx.env, homeDir(ctx)))}/config.toml`, () => removeCodexMcp(ctx));
  const gitDir = installed.git_hooks_dir;
  if (gitDir) step(gitDir, () => uninstallGitHooks(gitDir));
  const exclude = installed.exclude_file;
  if (exclude)
    step(exclude, () =>
      installed.exclude_after_sha256 !== undefined
        ? restoreExcludes(exclude, {
            added: installed.exclude_added,
            before: installed.exclude_before ?? null,
            after_sha256: installed.exclude_after_sha256,
          })
        : removeExcludes(exclude, installed.exclude_added),
    );
  // Anything left over stays recorded, so running uninstall again finishes the job.
  if (!failed) writeJsonAtomic(ctx.paths.installed(root), Installed.parse({}));
  return !failed;
}

const removeUserCursorMcp = (ctx: Ctx) =>
  uninstallJsonServer({
    file: userCursorMcp(ctx),
    recordFile: ctx.paths.harnessRecord("cursor-mcp"),
    shim: ctx.paths.shim,
    guard: [cursorDir(homeDir(ctx))],
  });
const removeCodexMcp = (ctx: Ctx) =>
  unregisterCodex({
    dir: codexDir(ctx.env, homeDir(ctx)),
    shim: ctx.paths.shim,
    env: ctx.env,
    recordFile: ctx.paths.harnessRecord("codex-mcp"),
  });

/** Whether ALIGN still has something recorded as installed for this repository (uninstall can be run again). */
export function hasInstalled(ctx: Ctx, root: string): boolean {
  const i = readInstalled(ctx, root);
  return i.harnesses.length > 0 || i.git_hooks_dir !== null || i.exclude_added.length > 0;
}

/** How a Codex hooks directory is named to the person: `~/.codex` unless `CODEX_HOME` moved it. */
export const codexShown = (ctx: Ctx, dir: string) => (dir === join(homeDir(ctx), ".codex") ? "~/.codex" : dir);

/** `uninstall --purge`: the user-level Cursor and Codex entries go, whichever repositories used them. */
export function removeUserHooks(ctx: Ctx): void {
  try {
    uninstallCommand(homeDir(ctx));
  } catch {
    ctx.line(copy.uninstallSkipped("~/.claude/commands"));
  }
  // The MCP server: user-level Cursor and Codex entries, and Claude Code's local scope in every registered repository.
  for (const [file, run] of [
    ["~/.cursor/mcp.json", () => removeUserCursorMcp(ctx)],
    [`${codexShown(ctx, codexDir(ctx.env, homeDir(ctx)))}/config.toml`, () => removeCodexMcp(ctx)],
    ...Object.keys(readRegistry(ctx.paths).repos).map(
      (r) =>
        [
          "~/.claude.json",
          () => unregisterClaudeCode({ home: homeDir(ctx), root: r, shim: ctx.paths.shim, env: ctx.env }),
        ] as const,
    ),
  ] as const) {
    try {
      mcpRemoved(ctx, file, run());
    } catch {
      ctx.line(copy.mcp.left(file));
    }
  }
  for (const [file, run] of [
    ["~/.cursor/hooks.json", () => uninstallCursor(ctx.paths, homeDir(ctx), ctx.paths.shim)],
    [
      `${codexShown(ctx, codexDir(ctx.env, homeDir(ctx)))}/hooks.json`,
      () => uninstallCodex(ctx.paths, codexDir(ctx.env, homeDir(ctx)), ctx.paths.shim),
    ],
  ] as const) {
    // Never lets a broken user file stop `--purge` from deleting ~/.align.
    try {
      const r = run();
      if (r.wrappers) ctx.line(copy.uninstallWrapperLeft(file));
      if (r.skipped) ctx.line(copy.uninstallSkipped(file, r.skipped === "symlink" ? "symlink" : "unreadable"));
    } catch {
      ctx.line(copy.uninstallSkipped(file));
    }
  }
}

/** Claude Code's project folder for a root: every non-alphanumeric character becomes `-` (docs/10). */
export const encodeProjectDir = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");

/** doctor: parse the newest local transcript of this repository without uploading; lines kept and dropped. */
export function transcriptCheck(
  ctx: Ctx,
  root: string,
  spellings: string[] = [],
): { ok: boolean; kept: number; dropped: number } | null {
  // Claude Code names the folder after the path it was started in, which may be a symlinked spelling of the root.
  let newest: { file: string; at: number } | null = null;
  for (const r of new Set([root, ...spellings])) {
    const dir = join(homeDir(ctx), ".claude", "projects", encodeProjectDir(r));
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const at = statSync(join(dir, name)).mtimeMs;
        if (!newest || at > newest.at) newest = { file: join(dir, name), at };
      }
    } catch {
      // no folder under this spelling
    }
  }
  if (!newest) return null;
  const delta = readDelta(newest.file, { byte_offset: 0, line_no: 0, ino: null }, 4 * 1024 * 1024);
  if (!delta.ok) return { ok: false, kept: 0, dropped: 0 };
  const r = convertLines(delta.lines, { root, nextN: 1 });
  return {
    ok: r.recognised > 0 || r.stats.entries === 0,
    kept: r.lines.length,
    dropped: r.stats.dropped + r.stats.malformed,
  };
}

export type HarnessCheck = { id: string; ok: boolean; label: string; fix: string };

export async function harnessChecks(ctx: Ctx, root: string, harnesses: string[]): Promise<HarnessCheck[]> {
  const d = copy.doctor;
  const out: HarnessCheck[] = [];
  const plugin = harnesses.includes("claude-code") && alignPluginEnabled(homeDir(ctx), root);
  if (plugin) {
    // The plugin brings the hooks, the MCP server and the command; ALIGN's own copies next to it are duplicates.
    out.push({ id: "claude_code_hooks", ok: true, label: d.claudePlugin, fix: "" });
    out.push({
      id: "claude_code_duplicate",
      ok: !pluginDuplicates(ctx, root),
      label: d.claudeDuplicate,
      fix: d.claudeDuplicateFix,
    });
  }
  if (harnesses.includes("claude-code")) {
    pruneStaleRecord(ctx.paths, root);
    if (!plugin)
      out.push({
        id: "claude_code_hooks",
        ok: claudeCodeInstalled(root, ctx.paths.shim),
        label: d.claudeHooks,
        fix: d.claudeHooksFix,
      });
    const outdated = listStates(ctx.paths).some(
      (st) => st.root === root && st.harness === "claude-code" && st.mode_reason === "parser",
    );
    out.push({ id: "claude_code_parser", ok: !outdated, label: d.parserOutdated, fix: d.transcriptFix });
    if (!plugin)
      out.push({
        id: "claude_code_command",
        ok: commandInstalled(homeDir(ctx), ctx.paths.shim),
        label: d.claudeCommand,
        fix: d.claudeHooksFix,
      });
    const raw = await git(["rev-parse", "--show-toplevel"], ctx.cwd, INTERACTIVE_GIT_TIMEOUT_MS);
    const t = transcriptCheck(ctx, root, raw ? [raw] : []);
    if (t)
      out.push({
        id: "claude_code_transcript",
        ok: t.ok,
        label: d.transcript(t.kept, t.dropped),
        fix: d.transcriptFix,
      });
  }
  if (harnesses.includes("cursor")) {
    out.push({
      id: "cursor_hooks",
      ok: cursorInstalled(homeDir(ctx), ctx.paths.shim),
      label: d.cursorHooks,
      fix: d.harnessHooksFix,
    });
    out.push({ id: "cursor_rule", ok: ruleIsOurs(root), label: d.cursorRule, fix: d.claudeHooksFix });
    const t = cursorTranscriptCheck(ctx, root);
    if (t)
      out.push({ id: "cursor_transcript", ok: t.ok, label: d.cursorTranscript(t.kept), fix: d.cursorTranscriptFix });
  }
  if (harnesses.includes("codex")) {
    const dir = codexDir(ctx.env, homeDir(ctx));
    out.push({
      id: "codex_hooks",
      ok: codexInstalled(dir, ctx.paths.shim),
      label: d.codexHooks(`${codexShown(ctx, dir)}/hooks.json`),
      fix: d.harnessHooksFix,
    });
    const trusted = codexTrusted(dir, ctx.paths.shim);
    // Best effort and not failing until the live check confirms Codex's key format (D95): only a line.
    out.push({
      id: "codex_trust",
      ok: true,
      label:
        trusted === null
          ? d.codexTrustUnknown
          : trusted
            ? d.codexTrust(codexShown(ctx, dir))
            : d.codexTrustNotFound(codexShown(ctx, dir)),
      fix: d.codexTrustFix,
    });
    const outdated = listStates(ctx.paths).some(
      (st) => st.root === root && st.harness === "codex" && st.mode_reason === "parser",
    );
    out.push({ id: "codex_parser", ok: !outdated, label: d.codexParser, fix: d.transcriptFix });
  }
  // A deny file ALIGN cannot use exactly fails closed (paths denied); say so.
  for (const [label, file] of [
    [".aligndeny", join(root, ".aligndeny")],
    ["personal deny file", ctx.paths.deny(root)],
  ] as const) {
    const r = readDenyFile(file);
    const inexact = r.usable ? invalidDenyGlobs(r.globs).length : 0;
    if (!r.usable || inexact > 0)
      out.push({ id: "deny_file", ok: false, label: d.denyFile(label, r.usable, inexact), fix: d.denyFileFix });
    // Simple lower case, not full case folding: a glob with ß never matches the ss spelling (docs/17 §Redaction).
    else if (r.globs.some((g) => /[ßẞ]/.test(g)))
      out.push({ id: "deny_fold", ok: true, label: d.denyFold(label), fix: "" });
  }
  const plan = await gitHooksPlan(root);
  if (plan.kind === "hooks_dir")
    out.push({
      id: "git_hooks",
      ok: gitHooksInstalled(plan.dir, ctx.paths.shim),
      label: d.gitHooks,
      fix: d.gitHooksFix,
    });
  else if (plan.kind === "hooks_path")
    out.push({ id: "git_hooks", ok: true, label: d.gitHooksPath(plan.path), fix: "" });
  return out;
}

/** ALIGN's settings-file hooks for Claude Code in this repository (any installation's shim). */
function settingsHooksPresent(ctx: Ctx, root: string): boolean {
  try {
    const text = readFileSync(join(root, SETTINGS_REL), "utf8");
    return removeHooks(text, ctx.paths.shim) !== text;
  } catch {
    return false;
  }
}

/**
 * doctor, with the plugin enabled: what `init` added for Claude Code before the plugin and now duplicates it — the
 * settings-file hooks (they exit at once while the plugin is enabled, but stay in the file) and the local-scope MCP
 * server (Claude Code would list two `align` servers).
 */
export function pluginDuplicates(ctx: Ctx, root: string): boolean {
  return settingsHooksPresent(ctx, root) || claudeLocalIsAlign(homeDir(ctx), root, ctx.paths.shim);
}

/**
 * doctor's offer (L41): removes those duplicates. The settings file is backed up first, outside the repository
 * (`~/.align/repos/<hash>/settings.local.json.align-backup-<time>`, 0600; never a copy of a file that holds `env`
 * values, D223 — L43: a backup inside the repository was untracked and one `git add -A` from being pushed), then
 * ALIGN's entries go exactly as `uninstall`
 * removes them; the local MCP entry goes through `claude mcp remove`; the user-level `/align` command goes when the
 * plugin is enabled for the user (it then serves every repository). Returns the backup path, or "left" when the
 * settings file could not be changed.
 */
export function removePluginDuplicates(ctx: Ctx, root: string): { backup: string | null; left: boolean } {
  let backup: string | null = null;
  let left = false;
  const file = join(root, SETTINGS_REL);
  if (settingsHooksPresent(ctx, root)) {
    if (settingsIsSymlink(root)) left = true;
    else {
      if (!holdsEnvValues(readFileSync(file, "utf8"))) {
        const dir = ctx.paths.repoDir(root);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        backup = join(dir, `settings.local.json.align-backup-${ctx.now()}`);
        copyFileSync(file, backup, constants.COPYFILE_EXCL);
        chmodSync(backup, 0o600);
      }
      const r = uninstallClaudeCode(ctx.paths, root, ctx.paths.shim);
      if (r.skipped) left = true;
    }
  }
  const mcp = unregisterClaudeCode({ home: homeDir(ctx), root, shim: ctx.paths.shim, env: ctx.env });
  if (mcp.printed) ctx.line(copy.mcp.removePrinted(mcp.printed));
  if (alignPluginEnabledForUser(homeDir(ctx))) uninstallCommand(homeDir(ctx));
  return { backup, left };
}

/** doctor: Cursor's agent transcripts for this repository (used by backfill), read without uploading. */
export function cursorTranscriptCheck(ctx: Ctx, root: string): { ok: boolean; kept: number } | null {
  const dir = join(cursorDir(homeDir(ctx)), "projects", encodeCursorProject(root), "agent-transcripts");
  let newest: { file: string; at: number } | null = null;
  try {
    for (const id of readdirSync(dir)) {
      const f = join(dir, id, `${id}.jsonl`);
      try {
        const at = statSync(f).mtimeMs;
        if (!newest || at > newest.at) newest = { file: f, at };
      } catch {
        // no transcript in this folder
      }
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  const delta = readDelta(newest.file, { byte_offset: 0, line_no: 0, ino: null }, 4 * 1024 * 1024);
  if (!delta.ok) return { ok: false, kept: 0 };
  const r = convertCursorLines(delta.lines, { root, nextN: 1 });
  return { ok: r.recognised > 0 || r.stats.entries === 0, kept: r.lines.length };
}
