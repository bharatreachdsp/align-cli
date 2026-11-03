/**
 * Registering `align mcp` at `init` and removing it at `uninstall` (L18, D416): golden files for Claude Code (through a
 * fake `claude` CLI), Cursor (user-level and an untracked project file) and Codex (a fake `codex` CLI, and the
 * appended table without one). Someone else's `align` server is never touched; a byte-exact restore where the file is
 * untouched. Temporary HOME, mock server; never the developer's own harness CLIs (helpers.testPath).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAlignEntry } from "../src/mcp/register";
import { printConfig } from "../src/mcp/snippets";
import { cli, gitIn, type Sandbox, sandbox, testPath } from "./helpers";
import { type MockServer, startMockServer } from "./mock-server";

const GOLDEN = join(import.meta.dirname, "__golden__", "mcp");
let sb: Sandbox;
let server: MockServer;
let fakeBin: string;
let log: string;

afterEach(async () => {
  await server?.close();
  sb?.cleanup();
});

/** Compares with the golden file (temporary paths masked); `UPDATE_GOLDEN=1` rewrites it. */
function golden(name: string, actual: string) {
  const masked = actual.split(sb.repo).join("<REPO>").split(sb.home).join("<HOME>");
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, masked);
  }
  expect(masked).toBe(readFileSync(file, "utf8"));
}

/**
 * Fake `claude` and `codex` CLIs: each logs its working directory and arguments, and does what the real one does to
 * its own file for `mcp add` / `mcp remove` (enough for the next read).
 */
function fakes(which: ("claude" | "codex")[]) {
  fakeBin = join(sb.dir, "fake-bin");
  log = join(sb.dir, "fake.log");
  mkdirSync(fakeBin, { recursive: true });
  const node = process.execPath;
  const claude = `#!/bin/sh
echo "claude $PWD $*" >> '${log}'
exec '${node}' -e '
const fs = require("fs"); const f = process.env.HOME + "/.claude.json";
const a = process.argv.slice(1); const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
s.projects ??= {}; const p = (s.projects[process.cwd()] ??= {}); p.mcpServers ??= {};
if (a[1] === "add") p.mcpServers[a[6]] = { type: "stdio", command: a[8], args: a.slice(9), env: {} };
if (a[1] === "remove") delete p.mcpServers[a[4]];
fs.writeFileSync(f, JSON.stringify(s, null, 2));' -- "$@"
`;
  const codex = `#!/bin/sh
echo "codex $PWD $*" >> '${log}'
exec '${node}' -e '
const fs = require("fs"); const d = process.env.CODEX_HOME || process.env.HOME + "/.codex"; const f = d + "/config.toml";
const a = process.argv.slice(1); fs.mkdirSync(d, { recursive: true });
const t = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
if (a[1] === "add") fs.writeFileSync(f, t + "\\n[mcp_servers." + a[2] + "]\\ncommand = " + JSON.stringify(a[4]) + "\\nargs = [\\"mcp\\"]\\n");
if (a[1] === "remove") fs.writeFileSync(f, t.replace(/\\n\\[mcp_servers\\.align\\][^[]*/, ""));' -- "$@"
`;
  if (which.includes("claude")) writeFileSync(join(fakeBin, "claude"), claude);
  if (which.includes("codex")) writeFileSync(join(fakeBin, "codex"), codex);
  for (const b of which) chmodSync(join(fakeBin, b), 0o755);
}

const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

async function setup(which: ("claude" | "codex")[] = []) {
  sb = sandbox();
  server = await startMockServer();
  fakes(which);
}
const env = (extra: Record<string, string> = {}) => ({
  ALIGN_SERVER: server.url,
  PATH: testPath([fakeBin]),
  ...extra,
});
const init = (harness: string, extra: Record<string, string> = {}) =>
  cli(["init", "--yes", "--no-backfill", "--harness", harness], sb, { env: env(extra) });
const uninstall = (extra: Record<string, string> = {}) => cli(["uninstall"], sb, { env: env(extra) });

describe("MCP registration: Claude Code", () => {
  it("claude mcp add at local scope in the root; claude mcp remove at uninstall", async () => {
    await setup(["claude"]);
    const r = await init("claude-code");
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ Claude Code            MCP server align (local scope, ~/.claude.json)");
    const state = JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8"));
    expect(state.projects[sb.repo].mcpServers.align.command).toBe(join(sb.alignHome, "bin", "align"));
    // Again: already there, nothing run twice.
    await init("claude-code");
    const u = await uninstall();
    expect(u.code).toBe(0);
    golden("claude-code.calls", calls());
    expect(JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8")).projects[sb.repo].mcpServers).toEqual({});
  });

  it("someone else's align server (local, project or user scope) is left alone, at init and at uninstall", async () => {
    await setup(["claude"]);
    const theirs = { mcpServers: { align: { command: "/opt/other/align-server", args: [] } } };
    writeFileSync(join(sb.repo, ".mcp.json"), JSON.stringify(theirs));
    const r = await init("claude-code");
    expect(r.out).toContain(
      "× Claude Code            this repository defines its own MCP server named align in .mcp.json, which is not ALIGN's; nothing was added",
    );
    writeFileSync(join(sb.home, ".claude.json"), JSON.stringify({ projects: { [sb.repo]: theirs } }));
    await uninstall();
    expect(calls()).toBe("");
    expect(JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8")).projects[sb.repo]).toEqual(theirs);
  });

  it("skipped when the ALIGN plugin is enabled; the command is printed when claude is not on PATH", async () => {
    await setup(["claude"]);
    mkdirSync(join(sb.home, ".claude"), { recursive: true });
    writeFileSync(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "align@align": true } }),
    );
    mkdirSync(join(sb.home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(sb.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "align@align": [{ scope: "user", installPath: "/x", version: "0" }] } }),
    );
    const r = await init("claude-code");
    expect(r.out).toContain("hooks, MCP server and /align:align come with the ALIGN plugin (nothing added)");
    expect(calls()).toBe("");
    sb.cleanup();
    await server.close();
    await setup([]);
    const p = await init("claude-code");
    golden(
      "claude-code-printed.out",
      p.out
        .split("\n")
        .filter((l) => l.includes("MCP server"))
        .join("\n"),
    );
  });
});

describe("MCP registration: Cursor", () => {
  it("merges into ~/.cursor/mcp.json (one backup) and gives the exact bytes back at uninstall", async () => {
    await setup();
    const original = '// mine\n{\n  "mcpServers": {\n    "notes": { "command": "/opt/notes", "args": [] }\n  }\n}\n';
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    writeFileSync(join(sb.home, ".cursor", "mcp.json"), original);
    const r = await init("cursor");
    expect(r.out).toContain("✓ Cursor                 MCP server align (~/.cursor/mcp.json)");
    golden("cursor-user.json.txt", readFileSync(join(sb.home, ".cursor", "mcp.json"), "utf8"));
    expect(readdirSync(join(sb.home, ".cursor")).filter((n) => n.startsWith("mcp.json.align-backup-"))).toHaveLength(1);
    await uninstall();
    expect(readFileSync(join(sb.home, ".cursor", "mcp.json"), "utf8")).toBe(original);
  });

  it("L43: a file whose servers hold env values gets no backup and no copy, and uninstall removes only ALIGN's entry", async () => {
    await setup();
    const secret = ["zz", "mcp", "env", "1"].join("-");
    const original = `{\n  "mcpServers": {\n    "notes": { "command": "/opt/notes", "env": { "NOTES_TOKEN": "${secret}" } }\n  }\n}\n`;
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    writeFileSync(join(sb.home, ".cursor", "mcp.json"), original);
    await init("cursor");
    expect(readdirSync(join(sb.home, ".cursor")).filter((n) => n.includes("-backup-"))).toEqual([]);
    const records = readdirSync(sb.alignHome, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFileSync(join(sb.alignHome, f), "utf8"));
    expect(records.join("\n")).not.toContain(secret);
    await uninstall();
    const after = readFileSync(join(sb.home, ".cursor", "mcp.json"), "utf8");
    expect(after).toContain(secret);
    expect(after).not.toContain('"align"');
  });

  it("the backup is user-only (0600)", async () => {
    await setup();
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    writeFileSync(join(sb.home, ".cursor", "mcp.json"), '{ "mcpServers": {} }\n');
    await init("cursor");
    const backup = readdirSync(join(sb.home, ".cursor")).find((n) => n.startsWith("mcp.json.align-backup-")) ?? "";
    expect(statSync(join(sb.home, ".cursor", backup)).mode & 0o777).toBe(0o600);
  });

  it("edited since: only ALIGN's entry goes, the person's edit stays; a file ALIGN created is deleted", async () => {
    await setup();
    await init("cursor");
    const file = join(sb.home, ".cursor", "mcp.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.mcpServers.mine = { command: "/opt/mine", args: [] };
    writeFileSync(file, JSON.stringify(edited, null, 2));
    await uninstall();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: { mine: { command: "/opt/mine", args: [] } },
    });
  });

  it("an untracked project .cursor/mcp.json gets the server with --cwd and the workspaceFolder variable; the user file is untouched", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".cursor"), { recursive: true });
    writeFileSync(join(sb.repo, ".cursor", "mcp.json"), "{}\n");
    const r = await init("cursor");
    expect(r.out).toContain("✓ Cursor                 MCP server align (.cursor/mcp.json)");
    golden("cursor-project.json.txt", readFileSync(join(sb.repo, ".cursor", "mcp.json"), "utf8"));
    expect(existsSync(join(sb.home, ".cursor", "mcp.json"))).toBe(false);
    // It now names this laptop's shim: kept out of git status, so it is never committed by accident.
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).toContain("/.cursor/mcp.json");
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
    await uninstall();
    expect(readFileSync(join(sb.repo, ".cursor", "mcp.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).not.toContain("/.cursor/mcp.json");
  });

  it("someone else's align entry and a symbolic link are left alone", async () => {
    await setup();
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    const theirs = JSON.stringify({ mcpServers: { align: { command: "/opt/other", args: ["serve"] } } });
    writeFileSync(join(sb.home, ".cursor", "mcp.json"), theirs);
    const r = await init("cursor");
    expect(r.out).toContain("× Cursor                 ~/.cursor/mcp.json already has an MCP server named align");
    await uninstall();
    expect(readFileSync(join(sb.home, ".cursor", "mcp.json"), "utf8")).toBe(theirs);
    sb.cleanup();
    await server.close();
    await setup();
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    writeFileSync(join(sb.dir, "elsewhere.json"), "{}");
    symlinkSync(join(sb.dir, "elsewhere.json"), join(sb.home, ".cursor", "mcp.json"));
    const s = await init("cursor");
    expect(s.out).toContain("× Cursor                 the MCP server could not be added to ~/.cursor/mcp.json");
    expect(readFileSync(join(sb.dir, "elsewhere.json"), "utf8")).toBe("{}");
  });

  it("git cannot say whether the project file is tracked: it counts as tracked; the user-level file is used", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".cursor"), { recursive: true });
    writeFileSync(join(sb.repo, ".cursor", "mcp.json"), "{}\n");
    // A damaged index: git ls-files fails, which must never read as "untracked".
    writeFileSync(join(sb.repo, ".git", "index"), "not an index");
    const r = await init("cursor");
    expect(r.out).toContain("✓ Cursor                 MCP server align (~/.cursor/mcp.json)");
    expect(readFileSync(join(sb.repo, ".cursor", "mcp.json"), "utf8")).toBe("{}\n");
  });

  it("a committed project .cursor/mcp.json with its own align server: nothing is added anywhere", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".cursor"), { recursive: true });
    const theirs = JSON.stringify({ mcpServers: { align: { command: "npx", args: ["their-align"] } } });
    writeFileSync(join(sb.repo, ".cursor", "mcp.json"), theirs);
    gitIn(sb.repo, "add", ".cursor/mcp.json");
    gitIn(sb.repo, "commit", "-q", "-m", "their server");
    const r = await init("cursor");
    expect(r.out).toContain("this repository defines its own MCP server named align in .cursor/mcp.json");
    expect(existsSync(join(sb.home, ".cursor", "mcp.json"))).toBe(false);
    expect(readFileSync(join(sb.repo, ".cursor", "mcp.json"), "utf8")).toBe(theirs);
  });
});

describe("Cursor's permission for ALIGN's read-only tools (D534)", () => {
  const cliJson = () => join(sb.repo, ".cursor", "cli.json");
  const READ_ONLY = ["get_context", "get_decision", "search_decisions", "list_open_questions", "get_contract"].map(
    (t) => `Mcp(align:${t})`,
  );

  it("init allows exactly the read-only tools in an untracked .cursor/cli.json; uninstall removes the file", async () => {
    await setup();
    const r = await init("cursor");
    expect(r.out).toContain(
      "✓ Cursor                 Cursor's agent may call align's read-only tools without asking (.cursor/cli.json)",
    );
    golden("cursor-cli.json.txt", readFileSync(cliJson(), "utf8"));
    const allow = JSON.parse(readFileSync(cliJson(), "utf8")).permissions.allow as string[];
    expect(allow).toEqual(READ_ONLY);
    // The tools that write are never allowed: Cursor keeps asking for them.
    expect(allow.join(" ")).not.toMatch(/record_decision|ask_owner|\*/);
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).toContain("/.cursor/cli.json");
    expect(gitIn(sb.repo, "status", "--porcelain")).toBe("");
    // Again: nothing doubled.
    await init("cursor");
    expect(JSON.parse(readFileSync(cliJson(), "utf8")).permissions.allow).toEqual(READ_ONLY);
    expect((await uninstall()).code).toBe(0);
    expect(existsSync(cliJson())).toBe(false);
    expect(existsSync(join(sb.repo, ".cursor"))).toBe(false);
    expect(readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8")).not.toContain("/.cursor/cli.json");
  });

  it("the person's own untracked file: rules merged after theirs, exact bytes back; edited since, only ALIGN's go", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".cursor"), { recursive: true });
    const original = '// mine\n{\n  "permissions": { "allow": ["Shell(ls)"], "deny": ["Shell(rm)"] }\n}\n';
    writeFileSync(cliJson(), original);
    await init("cursor");
    const merged = JSON.parse(
      readFileSync(cliJson(), "utf8")
        .split("\n")
        .filter((l) => !l.startsWith("//"))
        .join("\n"),
    );
    expect(merged.permissions).toEqual({ allow: ["Shell(ls)", ...READ_ONLY], deny: ["Shell(rm)"] });
    await uninstall();
    expect(readFileSync(cliJson(), "utf8")).toBe(original);
    await init("cursor");
    writeFileSync(cliJson(), `${readFileSync(cliJson(), "utf8")}// edited\n`);
    await uninstall();
    const left = readFileSync(cliJson(), "utf8");
    expect(left).toContain("// edited");
    expect(left).toContain("Shell(ls)");
    expect(left).not.toContain("Mcp(align:");
  });

  it("a committed .cursor/cli.json, a symbolic link or someone else's align server: nothing written, the rules are named", async () => {
    await setup();
    mkdirSync(join(sb.repo, ".cursor"), { recursive: true });
    const committed = '{ "permissions": { "allow": [] } }\n';
    writeFileSync(cliJson(), committed);
    gitIn(sb.repo, "add", ".cursor/cli.json");
    gitIn(sb.repo, "commit", "-q", "-m", "cursor permissions");
    const r = await init("cursor");
    expect(r.out).toContain(".cursor/cli.json is committed or could not be changed");
    expect(r.out).toContain(READ_ONLY.join(", "));
    expect(readFileSync(cliJson(), "utf8")).toBe(committed);
    sb.cleanup();
    await server.close();

    await setup();
    mkdirSync(join(sb.repo, ".cursor"), { recursive: true });
    writeFileSync(join(sb.dir, "elsewhere.json"), "{}");
    symlinkSync(join(sb.dir, "elsewhere.json"), cliJson());
    const s = await init("cursor");
    expect(s.out).toContain(".cursor/cli.json is committed or could not be changed");
    expect(readFileSync(join(sb.dir, "elsewhere.json"), "utf8")).toBe("{}");
    sb.cleanup();
    await server.close();

    await setup();
    mkdirSync(join(sb.home, ".cursor"), { recursive: true });
    writeFileSync(
      join(sb.home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { align: { command: "/opt/other", args: [] } } }),
    );
    const f = await init("cursor");
    expect(f.out).not.toContain(".cursor/cli.json");
    expect(existsSync(cliJson())).toBe(false);
  });
});

describe("MCP registration: Codex", () => {
  it("codex mcp add, and codex mcp remove at uninstall", async () => {
    await setup(["codex"]);
    const r = await init("codex");
    expect(r.out).toContain("✓ Codex                  MCP server align (~/.codex/config.toml)");
    await uninstall();
    golden("codex.calls", calls().split(join(sb.home, ".codex")).join("<CODEX_HOME>"));
  });

  it("without codex: an appended table, removed byte-exact", async () => {
    await setup();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const original = 'model = "gpt-x"\n\n[mcp_servers.notes]\ncommand = "/opt/notes"\n';
    writeFileSync(join(sb.home, ".codex", "config.toml"), original);
    await init("codex");
    golden("codex-appended.toml.txt", readFileSync(join(sb.home, ".codex", "config.toml"), "utf8"));
    await uninstall();
    expect(readFileSync(join(sb.home, ".codex", "config.toml"), "utf8")).toBe(original);
  });

  it("a foreign align server in config.toml is never doubled or removed", async () => {
    await setup(["codex"]);
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const theirs = '[mcp_servers.align]\ncommand = "/opt/other"\n';
    writeFileSync(join(sb.home, ".codex", "config.toml"), theirs);
    const r = await init("codex");
    expect(r.out).toContain("already has an MCP server named align");
    await uninstall();
    expect(calls()).toBe("");
    expect(readFileSync(join(sb.home, ".codex", "config.toml"), "utf8")).toBe(theirs);
  });

  it("recognises the other spellings of a server named align", () => {
    const shim = "/h/.align/bin/align";
    expect(codexAlignEntry('[mcp_servers."align"]\ncommand = "/h/.align/bin/align"\n', shim)).toBe("ours");
    expect(codexAlignEntry('[mcp_servers]\nalign = { command = "x" }\n', shim)).toBe("foreign");
    expect(codexAlignEntry('mcp_servers.align.command = "x"\n', shim)).toBe("foreign");
    expect(codexAlignEntry('[mcp_servers.alignment]\ncommand = "x"\n', shim)).toBeNull();
  });
});

describe("align mcp --print-config", () => {
  it("prints a snippet for each agent; nothing secret in any", () => {
    const shim = "/home/someone/.align/bin/align";
    const all = ["gemini", "hermes", "openclaw", "generic"].map((a) => `## ${a}\n${printConfig(a, shim)}`).join("\n");
    expect(printConfig("other", shim)).toBeNull();
    expect(all).not.toMatch(/aln_|token/i);
    sb = sandbox();
    golden("print-config.txt", all);
  });
});
