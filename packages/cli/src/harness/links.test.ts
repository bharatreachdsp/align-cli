/**
 * Tool paths reached through a symbolic link are judged by their target in every harness reader (L13 follow-ups of
 * the #43 chain re-review): Claude Code also across read passes (the cwd is carried), Cursor and Codex like Claude
 * Code. Temporary directories only.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveDenyGlobs, isDenied } from "@align/core/redact";
import { afterEach, describe, expect, it } from "vitest";
import type { RawLine } from "../transcripts/reader";
import { convertLines } from "./claude-code/transcript";
import { convertCodexLines } from "./codex/transcript";
import { convertCursorLines } from "./cursor/transcript";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A repository with `notes.txt` → `.env.production` and a `lib/` folder. */
function repo(): string {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "align-links-")));
  const root = join(dir, "checkout");
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".env.production"), "SYNTHETIC=1\n");
  symlinkSync(join(root, ".env.production"), join(root, "notes.txt"));
  return root;
}
const deny = effectiveDenyGlobs([]);
const denied = (rel: string) => isDenied(rel, deny);
const lines = (rows: unknown[]): RawLine[] => rows.map((r, i) => ({ text: JSON.stringify(r), lineNo: i + 1 }));
const toolPathsOf = (r: { lines: { role: string; tool?: { paths: string[] } }[] }) =>
  r.lines.filter((l) => l.role === "tool").flatMap((l) => l.tool?.paths ?? []);

const assistantTool = (path: string, cwd?: string) => ({
  type: "assistant",
  ...(cwd ? { cwd } : {}),
  message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: path } }] },
});

describe("Claude Code: a relative tool path at the start of a read pass", () => {
  it("is resolved against the carried cwd, or the root, before the link check", () => {
    const root = repo();
    // A pass that starts mid-file: the first entries have no cwd; the verdict and the cwd come from the carry.
    const fromRoot = convertLines(lines([assistantTool("notes.txt")]), {
      root,
      nextN: 1,
      carry: { owned: true },
      denied,
    });
    expect(toolPathsOf(fromRoot)).toEqual([join(root, ".env.production")]);
    const fromLib = convertLines(lines([assistantTool("../notes.txt")]), {
      root,
      nextN: 1,
      carry: { owned: true, cwd: join(root, "lib") },
      denied,
    });
    expect(toolPathsOf(fromLib)).toEqual([join(root, ".env.production")]);
  });

  it("carries the last cwd it saw into the next pass", () => {
    const root = repo();
    const r = convertLines(lines([assistantTool(join(root, "lib", "a.ts"), join(root, "lib"))]), {
      root,
      nextN: 1,
      denied,
    });
    expect(r.carry).toEqual({ owned: true, cwd: join(root, "lib") });
  });
});

describe("Cursor and Codex: tool paths through a link inside the repository", () => {
  it("Cursor: a denied target is returned so redaction removes it", () => {
    const root = repo();
    const r = convertCursorLines(
      lines([
        {
          role: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { path: join(root, "notes.txt") } }] },
        },
      ]),
      { root, nextN: 1, denied },
    );
    expect(toolPathsOf(r)).toEqual([join(root, ".env.production")]);
  });

  it("Codex: a FileChange path through the link too", () => {
    const root = repo();
    const r = convertCodexLines(
      lines([
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: "t",
            item: { type: "FileChange", id: "f", changes: { [join(root, "notes.txt")]: { type: "update" } } },
          },
        },
      ]),
      { root, nextN: 1, carry: { owned: true, thread: "t" }, denied },
    );
    expect(toolPathsOf(r)).toEqual([join(root, ".env.production")]);
  });
});

describe("#67 security review round 2 · relative tool paths in Cursor and Codex", () => {
  it("Cursor: a relative path is resolved against the root before the link check", () => {
    const root = repo();
    for (const rel of ["notes.txt", "./notes.txt", "lib/../notes.txt"]) {
      const r = convertCursorLines(
        lines([
          { role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: rel } }] } },
        ]),
        { root, nextN: 1, denied },
      );
      expect(toolPathsOf(r), rel).toEqual([join(root, ".env.production")]);
    }
  });

  it("Codex: against the owned cwd of the session when it has one, else the root", () => {
    const root = repo();
    const change = (path: string) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "t",
        item: { type: "FileChange", id: "f", changes: { [path]: { type: "update" } } },
      },
    });
    const fromLib = convertCodexLines(
      lines([{ type: "session_meta", payload: { id: "t", cwd: join(root, "lib") } }, change("../notes.txt")]),
      { root, nextN: 1, denied },
    );
    expect(toolPathsOf(fromLib)).toEqual([join(root, ".env.production")]);
    expect(fromLib.carry).toMatchObject({ owned: true, cwd: join(root, "lib") });
    const fromRoot = convertCodexLines(lines([change("notes.txt")]), {
      root,
      nextN: 1,
      carry: { owned: true, thread: "t" },
      denied,
    });
    expect(toolPathsOf(fromRoot)).toEqual([join(root, ".env.production")]);
  });
});
