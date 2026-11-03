/** Cursor's and Codex's user-level hooks files: merge, idempotence, exact restore, edits kept (docs/15 §Guarantees 6). */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alignPaths, type Paths } from "../paths";
import { codexHooksFile, installCodex, uninstallCodex } from "./codex/install";
import { cursorHooksFile, cursorInstalled, installCursor, uninstallCursor } from "./cursor/install";
import { alignCommandKind, parseSettings } from "./hooks-file";

let dir: string;
let home: string;
let paths: Paths;
const shim = "/home/someone/.align/bin/align";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "align-user-hooks-"));
  home = join(dir, "home");
  mkdirSync(home);
  paths = alignPaths(join(home, ".align"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("~/.cursor/hooks.json", () => {
  it("writes version 1 and the five flat entries", () => {
    installCursor(paths, home, shim);
    expect(parseSettings(readFileSync(cursorHooksFile(home), "utf8"))).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command: `${shim} hook session-start --harness cursor`, timeout: 3 }],
        beforeSubmitPrompt: [{ command: `${shim} hook prompt --harness cursor`, timeout: 5 }],
        afterAgentResponse: [{ command: `${shim} hook response --harness cursor`, timeout: 5 }],
        stop: [{ command: `${shim} hook stop --harness cursor`, timeout: 5 }],
        sessionEnd: [{ command: `${shim} hook session-end --harness cursor`, timeout: 5 }],
      },
    });
    expect(cursorInstalled(home, shim)).toBe(true);
  });

  for (const [name, original] of [
    ["absent", null],
    [
      "someone else's hooks",
      '{\n  "version": 1,\n  "hooks": {\n    "stop": [{ "command": "./audit.sh", "loop_limit": 3 }]\n  }\n}\n',
    ],
  ] as const) {
    it(`install then uninstall gives back the original bytes (${name}); one backup, once`, () => {
      if (original !== null) {
        mkdirSync(join(home, ".cursor"));
        writeFileSync(cursorHooksFile(home), original);
      }
      expect(installCursor(paths, home, shim, 1).changed).toBe(true);
      expect(installCursor(paths, home, shim, 2).changed).toBe(false);
      const backups = existsSync(join(home, ".cursor"))
        ? readdirSync(join(home, ".cursor")).filter((f) => f.includes(".align-backup-"))
        : [];
      expect(backups).toHaveLength(original === null ? 0 : 1);
      uninstallCursor(paths, home, shim);
      if (original === null) expect(existsSync(cursorHooksFile(home))).toBe(false);
      else expect(readFileSync(cursorHooksFile(home), "utf8")).toBe(original);
    });
  }

  it("keeps the person's later edits and removes only ALIGN's entries", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorHooksFile(home), '{"version": 1, "hooks": {"stop": [{"command": "./audit.sh"}]}}\n');
    installCursor(paths, home, shim);
    const s = parseSettings(readFileSync(cursorHooksFile(home), "utf8")) as { hooks: Record<string, unknown[]> };
    s.hooks.preToolUse = [{ command: "./guard.sh", matcher: "Shell" }];
    writeFileSync(cursorHooksFile(home), JSON.stringify(s, null, 2));
    uninstallCursor(paths, home, shim);
    expect(parseSettings(readFileSync(cursorHooksFile(home), "utf8"))).toEqual({
      version: 1,
      hooks: { stop: [{ command: "./audit.sh" }], preToolUse: [{ command: "./guard.sh", matcher: "Shell" }] },
    });
  });
});

describe("a person's wrapper around ALIGN's command", () => {
  it("is left alone by install (nothing added beside it) and by uninstall, which says so", () => {
    mkdirSync(join(home, ".cursor"));
    const wrapper = `${shim} hook stop --harness cursor; ./audit.sh`;
    const original = JSON.stringify({ version: 1, hooks: { stop: [{ command: wrapper }] } }, null, 2);
    writeFileSync(cursorHooksFile(home), original);
    installCursor(paths, home, shim);
    const after = parseSettings(readFileSync(cursorHooksFile(home), "utf8")) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(after.hooks.stop).toEqual([{ command: wrapper }]);
    expect(cursorInstalled(home, shim)).toBe(true);
    // Edited since, so the structural path runs: ALIGN's exact entries go, the wrapper stays.
    writeFileSync(cursorHooksFile(home), `${readFileSync(cursorHooksFile(home), "utf8")}\n`);
    const r = uninstallCursor(paths, home, shim);
    expect(r.wrappers).toBe(1);
    const left = parseSettings(readFileSync(cursorHooksFile(home), "utf8")) as { hooks: Record<string, unknown> };
    expect(left.hooks).toEqual({ stop: [{ command: wrapper }] });
    expect(alignCommandKind(`'${shim}' hook stop --harness cursor`, shim, "cursor", "stop")).toBe("exact");
    expect(alignCommandKind(`${shim} hook stop --harness cursor && x`, shim, "cursor", "stop")).toBe("wrapper");
    expect(alignCommandKind(`${shim} hook stop --harness cursor-x`, shim, "cursor", "stop")).toBeNull();
    // Wrappers: inside a shell string, or redirected.
    expect(alignCommandKind(`sh -c "${shim} hook stop --harness cursor"`, shim, "cursor", "stop")).toBe("wrapper");
    expect(alignCommandKind(`${shim} hook stop --harness cursor>>/tmp/log`, shim, "cursor", "stop")).toBe("wrapper");
    // Shell syntax in the path is never ALIGN's own command.
    for (const lead of ["`./audit.sh`", "$(./x)", "a\\b", "x<y", "X=/x", "{a,b}"])
      expect(alignCommandKind(`${lead}/.align/bin/align hook stop --harness cursor`, shim, "cursor", "stop")).not.toBe(
        "exact",
      );
    expect(alignCommandKind("$HOME/.align/bin/align hook stop --harness cursor", shim, "cursor", "stop")).toBe("exact");
    expect(alignCommandKind("~/.align/bin/align hook stop --harness cursor", shim, "cursor", "stop")).toBe("exact");
  });
});

describe("~/.codex/hooks.json", () => {
  const codex = () => join(home, ".codex");

  it("writes only the hooks key, matcher groups and the fixed timeouts (SessionEnd 3 s)", () => {
    installCodex(paths, codex(), shim);
    const s = parseSettings(readFileSync(codexHooksFile(codex()), "utf8"));
    expect(Object.keys(s)).toEqual(["hooks"]);
    const g = (e: string, h: string, t: number) => [
      { matcher: "", hooks: [{ type: "command", command: `${shim} hook ${h} --harness codex`, timeout: t }] },
    ];
    expect(s.hooks).toEqual({
      SessionStart: g("SessionStart", "session-start", 3),
      UserPromptSubmit: g("UserPromptSubmit", "prompt", 5),
      Stop: g("Stop", "stop", 5),
      SessionEnd: g("SessionEnd", "session-end", 3),
    });
  });

  it("install then uninstall on an untouched file gives back the original bytes; a file edited since keeps its edits", () => {
    mkdirSync(codex());
    const original =
      '{\n  "description": "mine",\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "notify"}]}]}\n}\n';
    writeFileSync(codexHooksFile(codex()), original);
    installCodex(paths, codex(), shim);
    uninstallCodex(paths, codex(), shim);
    expect(readFileSync(codexHooksFile(codex()), "utf8")).toBe(original);
    installCodex(paths, codex(), shim);
    writeFileSync(codexHooksFile(codex()), readFileSync(codexHooksFile(codex()), "utf8").replace('"mine"', '"edited"'));
    uninstallCodex(paths, codex(), shim);
    expect(parseSettings(readFileSync(codexHooksFile(codex()), "utf8"))).toEqual({
      description: "edited",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
    });
  });

  it("refuses a hooks value that is not a list", () => {
    mkdirSync(codex());
    writeFileSync(codexHooksFile(codex()), '{"hooks": {"Stop": {"x": 1}}}');
    expect(installCodex(paths, codex(), shim).skipped).toBe("shape");
  });

  it("uninstall works on the file it wrote to even when CODEX_HOME changed, and backs up a file once", () => {
    const first = join(dir, "codex-a");
    mkdirSync(first);
    writeFileSync(codexHooksFile(first), '{"hooks": {}}\n');
    installCodex(paths, first, shim, 1);
    writeFileSync(
      codexHooksFile(first),
      readFileSync(codexHooksFile(first), "utf8").replace("{", '{"description": "x",'),
    );
    installCodex(paths, first, shim, 2);
    expect(readdirSync(first).filter((f) => f.includes(".align-backup-"))).toHaveLength(1);
    uninstallCodex(paths, join(dir, "codex-b"), shim);
    expect(readFileSync(codexHooksFile(first), "utf8")).not.toContain("--harness codex");
  });

  it("uninstall leaves an unparseable file alone and says so", () => {
    installCodex(paths, codex(), shim);
    writeFileSync(codexHooksFile(codex()), "{ broken");
    expect(uninstallCodex(paths, codex(), shim)).toMatchObject({ changed: false, skipped: "unparseable" });
    expect(readFileSync(codexHooksFile(codex()), "utf8")).toBe("{ broken");
  });

  it("uninstall says a symlinked file was left alone; duplicate hooks keys are refused", () => {
    const real = join(dir, "real-hooks.json");
    writeFileSync(real, "{}\n");
    mkdirSync(codex());
    symlinkSync(real, codexHooksFile(codex()));
    expect(uninstallCodex(paths, codex(), shim)).toMatchObject({ changed: false, skipped: "symlink" });
    rmSync(codexHooksFile(codex()));
    writeFileSync(codexHooksFile(codex()), '{"hooks": {}, "hooks": {"Stop": []}}');
    expect(installCodex(paths, codex(), shim).skipped).toBe("shape");
    writeFileSync(codexHooksFile(codex()), '{"hooks": {"Stop": [], "Stop": []}}');
    expect(installCodex(paths, codex(), shim).skipped).toBe("shape");
  });
});
