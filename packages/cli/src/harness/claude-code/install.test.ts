import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alignPaths, type Paths } from "../../paths";
import {
  claudeCodeInstalled,
  hookCommand,
  installClaudeCode,
  mergeHooks,
  parseSettings,
  SETTINGS_REL,
} from "./install";
import { removeHooks, uninstallClaudeCode } from "./uninstall";

let dir: string;
let root: string;
let paths: Paths;
const shim = "/home/someone/.align/bin/align";
/** The macOS home folder, assembled at run time so the public mirror's path guard passes on this file (D1237). */
const MAC = ["", "Users", ""].join("/");
const file = () => join(root, SETTINGS_REL);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "align-cc-install-"));
  root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  paths = alignPaths(join(dir, "home", ".align"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Golden originals: no file, an empty object, other settings, comments and someone else's hooks. */
const ORIGINALS: Record<string, string | null> = {
  absent: null,
  empty: "{}\n",
  compact: '{"permissions":{"allow":["Bash(ls)"]}}',
  other: '{\n  "permissions": {\n    "allow": ["Bash(npm test)"]\n  },\n  "env": {"FOO": "1"}\n}\n',
  commented:
    '{\n  // my own Stop hook\n  "hooks": {\n    "Stop": [\n      {"hooks": [{"type": "command", "command": "say done"}]}\n    ],\n    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "guard"}]}]\n  },\n  "x": 1, /* trailing */\n}\n',
};

describe("Claude Code hook entries", () => {
  it("writes the four entries of docs/15 exactly", () => {
    installClaudeCode(paths, root, shim);
    expect(parseSettings(readFileSync(file(), "utf8"))).toEqual({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${shim} hook session-start --harness claude-code`, timeout: 3 }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `${shim} hook prompt --harness claude-code`, timeout: 5 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: `${shim} hook stop --harness claude-code`, timeout: 5 }] }],
        SessionEnd: [
          { hooks: [{ type: "command", command: `${shim} hook session-end --harness claude-code`, timeout: 5 }] },
        ],
      },
    });
    expect(claudeCodeInstalled(root, shim)).toBe(true);
  });

  for (const [name, original] of Object.entries(ORIGINALS)) {
    it(`install then uninstall on an untouched file gives back the original bytes (${name})`, () => {
      if (original !== null) {
        mkdirSync(join(root, ".claude"), { recursive: true });
        writeFileSync(file(), original);
      }
      expect(installClaudeCode(paths, root, shim).changed).toBe(true);
      expect(installClaudeCode(paths, root, shim).changed).toBe(false); // idempotent
      const installed = parseSettings(readFileSync(file(), "utf8"));
      expect(claudeCodeInstalled(root, shim)).toBe(true);
      if (original !== null) {
        // Everything that was there is still there.
        const before = parseSettings(original);
        for (const [k, v] of Object.entries(before)) if (k !== "hooks") expect(installed[k]).toEqual(v);
      }
      uninstallClaudeCode(paths, root, shim);
      if (original === null) {
        expect(existsSync(file())).toBe(false);
        expect(existsSync(join(root, ".claude"))).toBe(false);
      } else if (name === "other") {
        // A file with `env` values is never copied into ~/.align, so only ALIGN's entries are removed (D94).
        expect(parseSettings(readFileSync(file(), "utf8"))).toEqual(parseSettings(original));
      } else expect(readFileSync(file(), "utf8")).toBe(original);
    });
  }

  it("keeps the person's edits made after install, and removes only ALIGN's entries", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file(), ORIGINALS.commented as string);
    installClaudeCode(paths, root, shim);
    // The person adds a permission and a SessionStart hook of their own.
    const edited = readFileSync(file(), "utf8").replace('"x": 1', '"x": 2,\n  "permissions": {"deny": ["Read(.env)"]}');
    writeFileSync(
      file(),
      edited.replace(
        '"SessionStart": [',
        '"SessionStart": [\n      {"hooks": [{"type": "command", "command": "echo mine"}]},',
      ),
    );
    uninstallClaudeCode(paths, root, shim);
    const after = readFileSync(file(), "utf8");
    expect(after).toContain("// my own Stop hook");
    expect(after).toContain("/* trailing */");
    expect(after).not.toContain("--harness claude-code");
    expect(parseSettings(after)).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }],
      },
      x: 2,
      permissions: { deny: ["Read(.env)"] },
    });
  });

  it("a re-install over an edited file gives up the exact restore, so uninstall keeps the edits", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file(), '{"env": {"A": "1"}}\n');
    installClaudeCode(paths, root, shim);
    // The person edits the file and drops one of ALIGN's entries; a later init puts it back.
    const s = parseSettings(readFileSync(file(), "utf8")) as {
      env: Record<string, string>;
      hooks: Record<string, unknown>;
    };
    delete s.env.A;
    delete s.hooks.Stop;
    writeFileSync(file(), `${JSON.stringify({ ...s, model: "x" }, null, 2)}\n`);
    installClaudeCode(paths, root, shim);
    uninstallClaudeCode(paths, root, shim);
    expect(parseSettings(readFileSync(file(), "utf8"))).toEqual({ env: {}, model: "x" });
  });

  it("updates an ALIGN entry that points at an older shim in place, and never touches other commands in its group", () => {
    const old = mergeHooks("", "/old/place/.align/bin/align");
    const shared = old.replace(
      '"command": "/old/place/.align/bin/align hook stop --harness claude-code",',
      '"command": "/old/place/.align/bin/align hook stop --harness claude-code",\n            "statusMessage": "x",',
    );
    const merged = mergeHooks(shared, shim);
    const s = parseSettings(merged) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    for (const list of Object.values(s.hooks)) expect(list).toHaveLength(1);
    expect(s.hooks.Stop?.[0]?.hooks[0]?.command).toBe(hookCommand(shim, "stop"));
    expect(merged).not.toContain("/old/place");
  });

  it("quotes a shim path that needs it", () => {
    expect(hookCommand(`${MAC}Riya Example/.align/bin/align`, "stop")).toBe(
      `'${MAC}Riya Example/.align/bin/align' hook stop --harness claude-code`,
    );
  });

  it("never overwrites a hooks setting that is not a list, and keeps no copy of env values", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file(), '{"hooks": {"Stop": "say done"}}\n');
    expect(installClaudeCode(paths, root, shim)).toMatchObject({ changed: false, skipped: "shape" });
    writeFileSync(file(), '{"hooks": "x"}\n');
    expect(installClaudeCode(paths, root, shim).skipped).toBe("shape");
    writeFileSync(file(), '{"env": {"API_TOKEN": "x"}}\n');
    expect(installClaudeCode(paths, root, shim).changed).toBe(true);
    // The record names the file but keeps no copy of it.
    expect(readFileSync(join(dirname(paths.installed(root)), "claude-code.json"), "utf8")).not.toContain("API_TOKEN");
  });

  it("keeps the file's permissions", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file(), "{}\n", { mode: 0o600 });
    installClaudeCode(paths, root, shim);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("refuses a settings file it cannot parse, leaving it as it is", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file(), "{ not json");
    expect(installClaudeCode(paths, root, shim)).toMatchObject({ changed: false, skipped: "unparseable" });
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });

  it("never writes through a symbolic link a repository planted", () => {
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, "{}\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    symlinkSync(target, file());
    expect(installClaudeCode(paths, root, shim)).toMatchObject({ changed: false, skipped: "symlink" });
    expect(readFileSync(target, "utf8")).toBe("{}\n");
    rmSync(file());
    rmSync(join(root, ".claude"), { recursive: true });
    symlinkSync(dir, join(root, ".claude"));
    expect(installClaudeCode(paths, root, shim).skipped).toBe("symlink");
  });

  it("removeHooks leaves a file without ALIGN entries unchanged", () => {
    expect(removeHooks(ORIGINALS.commented as string, shim)).toBe(ORIGINALS.commented);
  });
});
