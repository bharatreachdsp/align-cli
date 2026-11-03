import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RawLine } from "../../transcripts/reader";
import { convertLines, type Line, toolPaths } from "./transcript";

const FIX = join(import.meta.dirname, "__fixtures__", "claude-code-2.1.307");
const ROOT = "/work/checkout";

/** A fixture file as the reader's raw lines, with the synthetic root filled in. */
function raw(name: string, root = ROOT): RawLine[] {
  return readFileSync(join(FIX, name), "utf8")
    .split("\n")
    .filter((l, i, all) => i < all.length - 1 || l !== "")
    .map((text, i) => ({ text: text.replaceAll("__ROOT__", root), lineNo: i + 1 }));
}

const convert = (name: string, nextN = 1) => convertLines(raw(name), { root: ROOT, nextN });
const texts = (lines: Line[]) => lines.map((l) => `${l.role}: ${l.text}`);
/** Every fixture marks what must never be kept with SYNTHETIC (and code with "synthetic"). */
const FORBIDDEN = /synthetic/i;

describe("Claude Code transcript reader (2.1.307 shapes)", () => {
  it("keeps prompts, replies and tool placeholders with paths, nothing else", () => {
    const r = convert("normal.jsonl");
    expect(texts(r.lines)).toEqual([
      "user: Use a Redis lock for the cart checkout instead of the database row lock; keep the TTL at 30 seconds.",
      "assistant: I will switch the checkout to a Redis lock with a 30 second TTL.",
      expect.stringMatching(/^tool: ‹tool: Read, \d+ bytes›$/),
      expect.stringMatching(/^tool: ‹tool: Bash, \d+ bytes›$/),
      "assistant: Done: the lock now lives in Redis. We rejected advisory locks because they do not survive a failover.",
    ]);
    expect(r.lines[2]?.tool).toEqual({ name: "Read", bytes: expect.any(Number), paths: [`${ROOT}/lib/cart/lock.ts`] });
    // A shell tool's command never leaves: no paths, no input.
    expect(r.lines[3]?.tool).toEqual({ name: "Bash", bytes: expect.any(Number), paths: [] });
    expect(JSON.stringify(r.lines)).not.toMatch(FORBIDDEN);
    expect(r.version).toBe("2.1.307");
    expect(r.stats.malformed).toBe(0);
  });

  it("numbers every line in sequence from the cursor and records its source line", () => {
    const r = convert("normal.jsonl", 41);
    expect(r.lines.map((l) => l.n)).toEqual([41, 42, 43, 44, 45]);
    expect(r.nextN).toBe(46);
    for (const l of r.lines) expect(l.src).toMatch(/^jsonl:\d+$/);
    expect(new Set(r.lines.map((l) => l.src)).size).toBe(5);
    for (const l of r.lines) expect(l.ts).toMatch(/^2026-10-22T09:/);
  });

  it("an entry with text and a tool_use gives two lines, two n, one src", () => {
    const r = convert("text-and-tool.jsonl");
    const [, text, tool] = r.lines;
    expect(text?.role).toBe("assistant");
    expect(tool?.role).toBe("tool");
    expect(text?.src).toBe(tool?.src);
    expect([text?.n, tool?.n]).toEqual([2, 3]);
    expect(tool?.tool?.name).toBe("Edit");
    expect(JSON.stringify(r.lines)).not.toMatch(FORBIDDEN);
  });

  it("takes paths only from built-in file tools, and only from the documented input fields", () => {
    const r = convert("text-and-tool.jsonl");
    // Not a built-in file tool: name and size only.
    expect(r.lines[3]?.tool).toEqual({ name: "MultiPathTool", bytes: expect.any(Number), paths: [] });
    const mcp = convertLines(
      [
        {
          text: JSON.stringify({
            type: "assistant",
            cwd: ROOT,
            message: {
              role: "assistant",
              content: [
                { type: "tool_use", name: "mcp__notes__create", input: { path: "Q4 layoffs plan", file_path: "x" } },
              ],
            },
          }),
          lineNo: 1,
        },
      ],
      { root: ROOT, nextN: 1 },
    );
    expect(mcp.lines[0]?.tool).toEqual({ name: "mcp__notes__create", bytes: expect.any(Number), paths: [] });
    expect(
      toolPaths({ path: `${ROOT}/src`, notebook_path: `${ROOT}/n.ipynb`, paths: [`${ROOT}/a.ts`, "/etc/x"] }),
    ).toEqual([`${ROOT}/src`, `${ROOT}/n.ipynb`, `${ROOT}/a.ts`, "/etc/x"]);
    expect(toolPaths({ command: "cat /etc/passwd", url: "https://x", content: "/a/b" })).toEqual([]);
    expect(toolPaths({ paths: Array.from({ length: 80 }, (_, i) => `/r/${i}`) })).toHaveLength(50);
    expect(toolPaths(null)).toEqual([]);
  });

  it("replaces fenced code blocks and keeps inline code", () => {
    const r = convert("fenced.jsonl");
    expect(texts(r.lines)).toEqual([
      "user: Here is the failing function:\n‹code: 3 lines›\nWhy does it fail? Use `retry()` inline.",
      "assistant: Replace it with this:\n‹code: 1 lines›\nThat keeps `retry()` as is.",
    ]);
    expect(JSON.stringify(r.lines)).not.toMatch(FORBIDDEN);
  });

  it("drops any text carrying the pack marker, in any case", () => {
    const r = convert("pack.jsonl");
    expect(texts(r.lines)).toEqual(["user: Thanks, now continue with the refactor."]);
  });

  it("drops sidechains, meta entries, wrappers, reminders, redacted thinking, API errors and other repositories", () => {
    const r = convert("sidechain.jsonl");
    expect(texts(r.lines)).toEqual([
      "user: Start a subagent to look for callers.",
      "user: Please also check the README.",
      "assistant: The subagent found two callers.",
    ]);
    expect(JSON.stringify(r.lines)).not.toMatch(FORBIDDEN);
  });

  it("drops the compact summary and keeps the turns on both sides of a compaction", () => {
    const r = convert("compacted.jsonl");
    expect(texts(r.lines)).toEqual([
      "user: First prompt before compaction.",
      "assistant: First reply before compaction.",
      "user: Prompt after compaction.",
      "assistant: Reply after compaction.",
    ]);
  });

  it("reads a resumed session straight through", () => {
    expect(convert("resumed.jsonl").lines).toHaveLength(4);
  });

  it("skips malformed and unknown lines without failing", () => {
    const r = convert("malformed.jsonl");
    expect(texts(r.lines)).toEqual([
      "user: A prompt before the broken line.",
      "assistant: A reply after the broken line.",
    ]);
    expect(r.stats.malformed).toBe(3);
    expect(r.recognised).toBe(4);
  });

  it("drops entries whose working directory is outside the repository, including a sibling with the same prefix", () => {
    const r = convertLines(raw("resumed.jsonl", "/work/checkout-other"), { root: ROOT, nextN: 1 });
    expect(r.lines).toEqual([]);
  });

  it("never outputs tool inputs, tool results or thinking, whatever the block order (generated entries)", () => {
    const secretish = ["INPUT-CONTENT", "RESULT-CONTENT", "THINKING-CONTENT"];
    const entries: RawLine[] = [];
    for (let i = 0; i < 200; i++) {
      const blocks = [
        {
          type: "tool_use",
          id: `t${i}`,
          name: "Write",
          input: { file_path: `${ROOT}/f${i}.ts`, content: secretish[0] },
        },
        { type: "thinking", thinking: secretish[2], signature: "s" },
        { type: "tool_result", tool_use_id: `t${i}`, content: secretish[1] },
        { type: "text", text: `reply ${i}` },
      ].sort(() => (((i * 7919) % 3) - 1) as number);
      const type = i % 2 ? "assistant" : "user";
      entries.push({
        text: JSON.stringify({ type, cwd: ROOT, message: { role: type, content: blocks } }),
        lineNo: i + 1,
      });
    }
    const out = JSON.stringify(convertLines(entries, { root: ROOT, nextN: 1 }).lines);
    for (const s of secretish) expect(out).not.toContain(s);
  });

  it("drops lines from a nested repository under the root, and entries without a cwd before any had one", () => {
    const dir = mkdtempSync(join(tmpdir(), "align-nested-"));
    try {
      const root = join(dir, "repo");
      mkdirSync(join(root, "vendor", "other", ".git"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      const entry = (cwd: string | undefined, text: string) =>
        JSON.stringify({ type: "user", ...(cwd ? { cwd } : {}), message: { role: "user", content: text } });
      const lines = [
        entry(undefined, "no cwd yet"),
        entry(join(root, "src"), "in the repository"),
        entry(undefined, "inherits the repository"),
        entry(join(root, "vendor", "other", "lib"), "in the nested repository"),
        entry(undefined, "inherits the nested repository"),
      ].map((text, i) => ({ text, lineNo: i + 1 }));
      expect(convertLines(lines, { root, nextN: 1 }).lines.map((l) => l.text)).toEqual([
        "in the repository",
        "inherits the repository",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops any user string that is wholly one tag (new harness wrappers)", () => {
    const lines = ["<memory-input>remember this</memory-input>", "<b>bold</b> but more after", "plain"].map((t, i) => ({
      text: JSON.stringify({ type: "user", cwd: ROOT, message: { role: "user", content: t } }),
      lineNo: i + 1,
    }));
    expect(convertLines(lines, { root: ROOT, nextN: 1 }).lines.map((l) => l.text)).toEqual([
      "<b>bold</b> but more after",
      "plain",
    ]);
  });
});
