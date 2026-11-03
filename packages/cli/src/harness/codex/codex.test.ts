import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignPaths } from "../../paths";
import type { RawLine } from "../../transcripts/reader";
import { codexTrusted, installCodex, trustedKeys } from "./install";
import { parseCodex } from "./map";
import { convertCodexLines } from "./transcript";

const FIX = join(import.meta.dirname, "__fixtures__", "codex-0.163.0");
const ROOT = "/work/checkout";
const payloads = () =>
  JSON.parse(readFileSync(join(FIX, "payloads.json"), "utf8").replaceAll("__ROOT__", ROOT)) as Record<
    string,
    Record<string, unknown>
  >;
const raw = (name: string, root = ROOT): RawLine[] =>
  readFileSync(join(FIX, name), "utf8")
    .split("\n")
    .filter((l, i, all) => i < all.length - 1 || l !== "")
    .map((text, i) => ({ text: text.replaceAll("__ROOT__", root), lineNo: i + 1 }));
const texts = (name: string) =>
  convertCodexLines(raw(name), { root: ROOT, nextN: 1 }).lines.map((l) => `${l.role}: ${l.text}`);

describe("Codex hook payloads (generated schemas at rust-v0.163.0)", () => {
  it("maps the documented fields; a subagent's prompt is marked; a null transcript path stays null", () => {
    const p = payloads();
    expect(parseCodex("prompt", p.UserPromptSubmit)).toMatchObject({
      ok: true,
      input: { subagent: false, prompt: "Use a Redis lock for the cart checkout." },
    });
    // A subagent's hook is not captured at all (its prompt and its Stop text alike).
    expect(parseCodex("prompt", p.UserPromptSubmitSubagent)).toEqual({ ok: false, code: "subagent" });
    expect(parseCodex("stop", { ...p.Stop, agent_id: "agent-1" })).toEqual({ ok: false, code: "subagent" });
    expect(parseCodex("stop", { ...p.Stop, transcript_path: null })).toMatchObject({
      ok: true,
      input: { transcriptPath: null },
    });
    expect(parseCodex("session-end", p.SessionEnd)).toMatchObject({ ok: true, input: { reason: "other" } });
    expect(parseCodex("stop", p.SessionStart)).toEqual({ ok: false, code: "event_mismatch" });
  });
});

describe("Codex rollout reader", () => {
  it("paginated: user and agent messages, tool lines (paths only for FileChange), nothing from response items", () => {
    const r = convertCodexLines(raw("paginated.jsonl"), { root: ROOT, nextN: 1 });
    expect(r.lines.map((l) => `${l.role}: ${l.text}`)).toEqual([
      "user: Use a Redis lock for the cart checkout; keep the TTL at 30 seconds.",
      expect.stringMatching(/^tool: ‹tool: CommandExecution, \d+ bytes›$/),
      expect.stringMatching(/^tool: ‹tool: FileChange, \d+ bytes›$/),
      expect.stringMatching(/^tool: ‹tool: McpToolCall, \d+ bytes›$/),
      "assistant: Done: the lock now lives in Redis.\n‹code: 1 lines›",
    ]);
    expect(r.lines[1]?.tool?.paths).toEqual([]);
    expect(r.lines[2]?.tool?.paths).toEqual([`${ROOT}/lib/cart/lock.ts`, `${ROOT}/lib/cart/new.ts`]);
    expect(r.lines[3]?.tool?.paths).toEqual([]);
    expect(JSON.stringify(r.lines)).not.toMatch(/synthetic/i);
    expect(r.version).toBe("0.163.0");
    expect(r.stats.malformed).toBe(1);
    for (const l of r.lines) expect(l.ts).toMatch(/^2026-10-22T09:00:/);
  });

  it("drops items of another thread forwarded into the rollout", () => {
    const lines = raw("paginated.jsonl").map((l) =>
      l.lineNo === 5 ? { ...l, text: l.text.replace(/"thread_id": ?"[^"]+"/, '"thread_id":"other-thread"') } : l,
    );
    const r = convertCodexLines(lines, { root: ROOT, nextN: 1 });
    expect(r.lines.map((l) => l.role)).toEqual(["tool", "tool", "tool", "assistant"]);
  });

  it("with no session_meta read yet, an event that names a thread counts as another's", () => {
    const lines = raw("paginated.jsonl").slice(4, 5);
    expect(convertCodexLines(lines, { root: ROOT, nextN: 1, carry: { owned: true } }).lines).toEqual([]);
  });

  it("legacy rollouts: user_message and agent_message events only", () => {
    expect(texts("legacy.jsonl")).toEqual(["user: Before the resume: use Redis.", "assistant: Using Redis now."]);
  });

  it("drops a subagent's rollout whole, and lines after a working directory outside the repository", () => {
    expect(texts("subagent.jsonl")).toEqual([]);
    expect(texts("moved.jsonl")).toEqual(["user: In the repository.", "assistant: Back in the repository."]);
  });

  it("carries the working-directory verdict to the next read of the same file", () => {
    const lines = raw("paginated.jsonl");
    const first = convertCodexLines(lines.slice(0, 2), { root: ROOT, nextN: 1 });
    expect(first.carry).toMatchObject({ owned: true, subagent: false });
    const second = convertCodexLines(lines.slice(2), { root: ROOT, nextN: first.nextN, carry: first.carry });
    expect(second.lines).toHaveLength(5);
    expect(convertCodexLines(lines.slice(2), { root: ROOT, nextN: 1 }).lines).toEqual([]);
  });
});

describe("Codex trust (best effort)", () => {
  it("reads trusted_hash under each ALIGN handler's state key", () => {
    const dir = mkdtempSync(join(tmpdir(), "align-codex-"));
    try {
      const shim = "/h/.align/bin/align";
      const paths = alignPaths(join(dir, "align-home"));
      mkdirSync(join(dir, "codex"));
      installCodex(paths, join(dir, "codex"), shim);
      expect(codexTrusted(join(dir, "codex"), shim)).toBeNull(); // no config.toml yet
      const file = join(dir, "codex", "hooks.json");
      const hash = `sha256:${"a".repeat(64)}`;
      const toml = ["session_start", "user_prompt_submit", "stop", "session_end"]
        .map((e) => `[hooks.state."${file}:${e}:0:0"]\ntrusted_hash = "${hash}"\n`)
        .join("\n");
      writeFileSync(join(dir, "codex", "config.toml"), `model = "x"\n\n${toml}`);
      expect(codexTrusted(join(dir, "codex"), shim)).toBe(true);
      writeFileSync(join(dir, "codex", "config.toml"), toml.replace(/stop:0:0/, "stop:1:0"));
      expect(codexTrusted(join(dir, "codex"), shim)).toBe(false);
      expect(trustedKeys(`[hooks.state.'k']\ntrusted_hash = '${hash}'\n[other]\ntrusted_hash = "${hash}"`)).toEqual(
        new Set(["k"]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
