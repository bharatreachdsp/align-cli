/**
 * The CLI side of the ALIGN Claude Code plugin (L41): `--via plugin` on the hook fast path, `alignPluginEnabled`, and
 * no double capture in either install order (plugin first, or `align init` first), with `align doctor`'s offer to
 * remove the hooks left from before the plugin. These read nothing under `plugins/`, so they ship in the public mirror;
 * the launcher and the plugin's own files are tested in `plugin.test.ts`, which stays in this repository. Temporary
 * HOME, mock server; never the real home.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_REL } from "../src/harness/claude-code/install";
import { alignPluginEnabled } from "../src/harness/claude-code/plugin";
import { alignPaths } from "../src/paths";
import { readRegistry, upsertRepo } from "../src/registry";
import { cli, gitIn, type Sandbox, sandbox, testPath } from "./helpers";
import { type MockServer, startMockServer } from "./mock-server";

const FIX = join(import.meta.dirname, "..", "src", "harness", "claude-code", "__fixtures__", "claude-code-2.1.307");

let sb: Sandbox;
let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  sb?.cleanup();
});

// ---------------------------------------------------------------------------------------------------------------
// The hook fast path: --via plugin, and settings-file hooks yielding to the plugin

type Payloads = Record<"SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd", Record<string, unknown>>;
const payloads = (cwd: string): Payloads =>
  JSON.parse(readFileSync(join(FIX, "payloads.json"), "utf8").replaceAll("__ROOT__", cwd)) as Payloads;

function register(harnesses: string[] = ["claude-code"]) {
  upsertRepo(alignPaths(sb.alignHome), sb.repo, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses,
    installed_at: new Date().toISOString(),
  });
}

/** Claude Code's install record for the plugin (user scope unless a project path is given). */
function installPlugin(id = "align@align-marketplace", projectPath?: string) {
  const dir = join(sb.home, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  const entry = {
    scope: projectPath ? "project" : "user",
    installPath: join(dir, "cache", "x"),
    version: "0.0.0",
    ...(projectPath ? { projectPath } : {}),
  };
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [entry] } }));
}

function enablePlugin(where: "user" | "repo", on = true, install = true) {
  if (install) installPlugin();
  const file = where === "user" ? join(sb.home, ".claude", "settings.json") : join(sb.repo, SETTINGS_REL);
  mkdirSync(join(file, ".."), { recursive: true });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    current = {};
  }
  writeFileSync(file, JSON.stringify({ ...current, enabledPlugins: { "align@align-marketplace": on } }, null, 2));
}

let clock = Date.parse("2026-10-26T09:00:00Z");
let promptN = 0;
async function hook(event: "prompt" | "stop" | "session-start", via: string[] = []) {
  clock += 5000;
  const p = payloads(sb.repo);
  const payload =
    event === "prompt"
      ? { ...p.UserPromptSubmit, prompt: `synthetic prompt number ${++promptN}`, transcript_path: null }
      : event === "stop"
        ? { ...p.Stop, transcript_path: null }
        : { ...p.SessionStart, transcript_path: null };
  return cli(["hook", event, "--harness", "claude-code", ...via], sb, {
    internalHome: sb.alignHome,
    readStdin: async () => Buffer.from(JSON.stringify(payload)),
    spawnUploader: () => {},
    now: () => clock,
  });
}
const VIA = ["--via", "plugin"];

function spoolFiles(): number {
  const dir = join(sb.alignHome, "spool");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((d) => /^[0-9a-f]{16}$/.test(d))
    .reduce((n, d) => n + readdirSync(join(dir, d)).filter((f) => f.endsWith(".json")).length, 0);
}

describe("align hook --via plugin", () => {
  it("captures in an opted-in repository that lists Claude Code", async () => {
    sb = sandbox();
    register();
    enablePlugin("user");
    await hook("prompt", VIA);
    expect(spoolFiles()).toBe(1);
  });

  it("captures nothing where the person did not choose Claude Code at init (D1245)", async () => {
    sb = sandbox();
    register(["cursor"]);
    enablePlugin("user");
    const r = await hook("prompt", VIA);
    expect(r).toMatchObject({ code: 0, out: "", err: "" });
    expect(spoolFiles()).toBe(0);
  });

  it("refuses an unknown --via value, and --via on another harness", async () => {
    sb = sandbox();
    register(["claude-code", "codex"]);
    await hook("prompt", ["--via", "elsewhere"]);
    expect(spoolFiles()).toBe(0);
    const p = payloads(sb.repo);
    await cli(["hook", "prompt", "--harness", "codex", "--via", "plugin"], sb, {
      internalHome: sb.alignHome,
      readStdin: async () => Buffer.from(JSON.stringify({ ...p.UserPromptSubmit, prompt: "x y z" })),
      spawnUploader: () => {},
    });
    expect(spoolFiles()).toBe(0);
  });

  it("a settings-file hook exits at once, printing nothing, while the plugin is enabled (user or repository)", async () => {
    sb = sandbox();
    register();
    enablePlugin("user");
    for (const event of ["session-start", "prompt", "stop"] as const) {
      const r = await hook(event);
      expect(r).toMatchObject({ code: 0, out: "", err: "" });
    }
    expect(spoolFiles()).toBe(0);
    sb.cleanup();
    sb = sandbox();
    register();
    enablePlugin("repo");
    await hook("prompt");
    expect(spoolFiles()).toBe(0);
    // Disabled again: the settings-file hook captures as before.
    enablePlugin("repo", false);
    await hook("prompt");
    expect(spoolFiles()).toBe(1);
  });

  it("alignPluginEnabled reads enabledPlugins only (true, a key starting align@), JSON with comments included", () => {
    sb = sandbox();
    installPlugin("align@x");
    mkdirSync(join(sb.home, ".claude"), { recursive: true });
    const user = join(sb.home, ".claude", "settings.json");
    writeFileSync(user, '{ // comment\n "enabledPlugins": { "alignment@x": true, "align@x": false, },\n}');
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
    writeFileSync(user, '{ "enabledPlugins": { "align@x": true } }');
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(true);
    writeFileSync(user, "not json {");
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
  });

  it("follows Claude Code's precedence (local > project > user) and needs the plugin installed", () => {
    sb = sandbox();
    const set = (file: string, value: boolean) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ enabledPlugins: { "align@align-marketplace": value } }));
    };
    const user = join(sb.home, ".claude", "settings.json");
    const project = join(sb.repo, ".claude", "settings.json");
    const local = join(sb.repo, SETTINGS_REL);
    // A repository enabling a plugin nobody installed changes nothing.
    set(project, true);
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
    installPlugin();
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(true);
    // User true, local false: local wins, the plugin is off here.
    set(user, true);
    set(local, false);
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
    // Project false over user true; local true over both.
    set(local, true);
    set(project, false);
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(true);
    // An install scoped to another project does not count here.
    installPlugin("align@align-marketplace", join(sb.dir, "elsewhere"));
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
    installPlugin("align@align-marketplace", sb.repo);
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(true);
  });

  it("a plugin synced from claude.ai is on by default when present, off when a setting says false", () => {
    sb = sandbox();
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
    // Another synced plugin whose name starts the same way is not ALIGN's.
    mkdirSync(join(sb.home, ".claude", "plugins", "synced", "align-lint"), { recursive: true });
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
    mkdirSync(join(sb.home, ".claude", "plugins", "synced", "align"), { recursive: true });
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(true);
    writeFileSync(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "align@synced": false } }),
    );
    expect(alignPluginEnabled(sb.home, sb.repo)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// No double capture in either install order

async function startServer() {
  server = await startMockServer();
}
const env = () => ({ ALIGN_SERVER: server?.url ?? "", PATH: testPath() });
const init = () => cli(["init", "--yes", "--no-backfill", "--harness", "claude-code"], sb, { env: env() });
const settingsHooks = () => {
  const f = join(sb.repo, SETTINGS_REL);
  if (!existsSync(f)) return 0;
  const hooks = (JSON.parse(readFileSync(f, "utf8")).hooks ?? {}) as Record<string, unknown[]>;
  return Object.values(hooks).flat().length;
};
const commandFile = () => join(sb.home, ".claude", "commands", `${CLI_BIN}.md`);

describe("one set of hooks in either install order", () => {
  it("plugin first: init adds no settings hooks, MCP entry or /align file; the plugin's hooks capture", async () => {
    sb = sandbox();
    await startServer();
    enablePlugin("user");
    const r = await init();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("hooks, MCP server and /align:align come with the ALIGN plugin (nothing added)");
    expect(settingsHooks()).toBe(0);
    expect(existsSync(commandFile())).toBe(false);
    expect(existsSync(join(sb.home, ".claude.json"))).toBe(false);
    expect(readRegistry(alignPaths(sb.alignHome)).repos[sb.repo]?.harnesses).toContain("claude-code");
    await hook("prompt", VIA);
    await hook("prompt"); // no settings-file hook exists; were one there, it would yield
    expect(spoolFiles()).toBe(1);
    // Re-running init keeps it that way.
    await init();
    expect(settingsHooks()).toBe(0);
  });

  it("init first: the settings-file hooks yield once the plugin is enabled; doctor offers to remove them", async () => {
    sb = sandbox();
    await startServer();
    const r = await init();
    expect(r.code, r.err).toBe(0);
    expect(settingsHooks()).toBe(4);
    await hook("prompt");
    expect(spoolFiles()).toBe(1);

    enablePlugin("user");
    await hook("prompt"); // the settings-file hook: exits at once
    await hook("prompt", VIA); // the plugin's hook: captures
    expect(spoolFiles()).toBe(2);

    const report = await cli(["doctor", "--json"], sb, { env: env() });
    const checks = JSON.parse(report.out).checks as { id: string; ok: boolean }[];
    expect(checks.find((c) => c.id === "claude_code_duplicate")?.ok).toBe(false);
    expect(checks.find((c) => c.id === "claude_code_hooks")?.ok).toBe(true);

    // Declined: nothing changes.
    const no = await cli(["doctor"], sb, { env: env(), tty: true, answers: ["n"] });
    expect(no.out).toContain("Remove the hooks ALIGN added to .claude/settings.local.json before the plugin?");
    expect(settingsHooks()).toBe(4);

    const yes = await cli(["doctor"], sb, { env: env(), tty: true, answers: ["y"] });
    expect(yes.out).toContain("Removed ALIGN's hooks from .claude/settings.local.json (backup: ");
    expect(settingsHooks()).toBe(0);
    // The backup is outside the repository (L43): nothing new for `git add -A` to pick up.
    const claudeDir = join(sb.repo, ".claude");
    expect(existsSync(claudeDir) ? readdirSync(claudeDir).filter((f) => f.includes(".align-backup-")) : []).toEqual([]);
    const backups = readdirSync(alignPaths(sb.alignHome).repoDir(sb.repo)).filter((f) =>
      f.startsWith("settings.local.json.align-backup-"),
    );
    expect(backups).toHaveLength(1);
    expect(existsSync(commandFile())).toBe(false); // the plugin is enabled for the user: /align:align replaces it
    const after = await cli(["doctor", "--json"], sb, { env: env() });
    const again = JSON.parse(after.out).checks as { id: string; ok: boolean }[];
    expect(again.find((c) => c.id === "claude_code_duplicate")?.ok).toBe(true);

    // And capture continues through the plugin alone.
    await hook("prompt", VIA);
    expect(spoolFiles()).toBe(3);
  });

  it("L43: a settings file that holds env values is never copied", async () => {
    sb = sandbox();
    await startServer();
    mkdirSync(join(sb.repo, ".claude"), { recursive: true });
    const secret = ["zz", "env", "value", "1"].join("-");
    writeFileSync(join(sb.repo, SETTINGS_REL), `${JSON.stringify({ env: { SOME_TOKEN: secret } }, null, 2)}\n`);
    await init();
    enablePlugin("repo");
    const yes = await cli(["doctor"], sb, { env: env(), tty: true, answers: [""] });
    expect(yes.out).toContain("Removed ALIGN's hooks");
    expect(yes.out).not.toContain("backup:");
    const claudeDir = join(sb.repo, ".claude");
    expect(existsSync(claudeDir) ? readdirSync(claudeDir).filter((f) => f.includes(".align-backup-")) : []).toEqual([]);
    const dir = alignPaths(sb.alignHome).repoDir(sb.repo);
    expect(existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".align-backup-")) : []).toEqual([]);
  });

  it("a settings file ALIGN never wrote keeps its bytes when only ALIGN's entries are removed", async () => {
    sb = sandbox();
    await startServer();
    mkdirSync(join(sb.repo, ".claude"), { recursive: true });
    writeFileSync(
      join(sb.repo, SETTINGS_REL),
      `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2)}\n`,
    );
    await init();
    enablePlugin("repo");
    const yes = await cli(["doctor"], sb, { env: env(), tty: true, answers: [""] });
    expect(yes.out).toContain("Removed ALIGN's hooks");
    const left = JSON.parse(readFileSync(join(sb.repo, SETTINGS_REL), "utf8"));
    expect(left.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(left.enabledPlugins).toEqual({ "align@align-marketplace": true });
    expect(left.hooks ?? {}).toEqual({});
    const dir = alignPaths(sb.alignHome).repoDir(sb.repo);
    const backup = readdirSync(dir).find((f) => f.includes(".align-backup-")) ?? "";
    copyFileSync(join(dir, backup), join(sb.dir, "backup.json"));
    expect(Object.keys(JSON.parse(readFileSync(join(sb.dir, "backup.json"), "utf8")).hooks)).toHaveLength(4);
  });
});
