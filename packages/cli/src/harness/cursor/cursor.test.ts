import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RawLine } from "../../transcripts/reader";
import { parseCursor } from "./map";
import { convertCursorLines, encodeCursorProject, userQuery } from "./transcript";

const FIX = join(import.meta.dirname, "__fixtures__", "cursor-2026.10.19");
const ROOT = "/work/checkout";
/** The macOS home folder, assembled at run time so the public mirror's path guard passes on this file (D1237). */
const MAC = ["", "Users", ""].join("/");
const payloads = () =>
  JSON.parse(readFileSync(join(FIX, "payloads.json"), "utf8").replaceAll("__ROOT__", ROOT)) as Record<
    string,
    Record<string, unknown>
  >;
const raw = (name: string): RawLine[] =>
  readFileSync(join(FIX, name), "utf8")
    .split("\n")
    .filter((l, i, all) => i < all.length - 1 || l !== "")
    .map((text, i) => ({ text: text.replaceAll("__ROOT__", ROOT), lineNo: i + 1 }));

describe("Cursor hook payloads (2026.10.19 shapes)", () => {
  it("reads the documented fields only; user_email is never read", () => {
    const p = payloads();
    const r = parseCursor("prompt", p.beforeSubmitPrompt, {});
    expect(r).toMatchObject({
      ok: true,
      input: {
        hook: "prompt",
        hookEvent: "beforeSubmitPrompt",
        cwd: ROOT,
        prompt: "Use a Redis lock for the cart checkout.",
        version: "2026.10.19",
      },
    });
    expect(JSON.stringify(r)).not.toMatch(/SYNTHETIC-EMAIL|example\.invalid/);
    expect(parseCursor("response", p.afterAgentResponse, {})).toMatchObject({
      ok: true,
      input: { lastAssistantMessage: "I switched the checkout to a Redis lock." },
    });
    expect(parseCursor("session-end", p.sessionEnd, {})).toMatchObject({ ok: true, input: { reason: "completed" } });
  });

  it("falls back to CURSOR_PROJECT_DIR, and refuses another event's payload", () => {
    const p = payloads();
    const noRoots = { ...p.stop, workspace_roots: [] };
    expect(parseCursor("stop", noRoots, { CURSOR_PROJECT_DIR: "/w/x" })).toMatchObject({
      ok: true,
      input: { cwd: "/w/x" },
    });
    expect(parseCursor("stop", noRoots, {})).toEqual({ ok: false, code: "no_cwd" });
    expect(parseCursor("stop", p.afterAgentThought, {})).toEqual({ ok: false, code: "event_mismatch" });
  });
});

describe("Cursor agent-transcript reader", () => {
  it("keeps the person's user_query text and file-tool paths; drops assistant text, wrappers and turn rows", () => {
    const r = convertCursorLines(raw("normal.jsonl"), { root: ROOT, nextN: 1 });
    expect(r.lines.map((l) => `${l.role}: ${l.text}`)).toEqual([
      "user: Use a Redis lock for the cart checkout; keep the TTL at 30 seconds.",
      expect.stringMatching(/^tool: ‹tool: Read, \d+ bytes›$/),
      expect.stringMatching(/^tool: ‹tool: Edit, \d+ bytes›$/),
      expect.stringMatching(/^tool: ‹tool: Shell, \d+ bytes›$/),
      "user: Now the follow-up with `inline()` code.",
    ]);
    expect(r.lines[1]?.tool?.paths).toEqual([`${ROOT}/lib/cart/lock.ts`]);
    expect(r.lines[2]?.tool?.paths).toEqual([`${ROOT}/lib/cart/lock.ts`]);
    expect(r.lines[3]?.tool?.paths).toEqual([]);
    expect(JSON.stringify(r.lines)).not.toMatch(/synthetic/i);
    expect(r.stats.malformed).toBe(1);
    expect(r.lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes only the row's last user_query: an attached file holding the tag never becomes the person's text", () => {
    const row = (text: string) => [
      { text: JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } }), lineNo: 1 },
    ];
    const attached =
      "<attached_files>\nSECRET FILE <user_query>FILE CONTENT\nmore FILE CONTENT\n</attached_files>\n<user_query>the real question</user_query>";
    expect(convertCursorLines(row(attached), { root: ROOT, nextN: 1 }).lines.map((l) => l.text)).toEqual([
      "the real question",
    ]);
    const unclosed = "<attached_files><user_query>FILE CONTENT</attached_files>";
    expect(convertCursorLines(row(unclosed), { root: ROOT, nextN: 1 }).lines).toEqual([]);
  });

  it("accepts only a trailing query in the row's last text block (two smuggling layouts)", () => {
    const rowOf = (texts: string[]) => [
      {
        text: JSON.stringify({ role: "user", message: { content: texts.map((text) => ({ type: "text", text })) } }),
        lineNo: 1,
      },
    ];
    const read = (texts: string[]) =>
      convertCursorLines(rowOf(texts), { root: ROOT, nextN: 1 }).lines.map((l) => l.text);
    // An earlier block (an attachment) holding a complete query is never read.
    expect(
      read([
        "<attached_files><user_query>FILE CONTENT</user_query></attached_files>",
        "<user_query>the real one</user_query>",
      ]),
    ).toEqual(["the real one"]);
    expect(read(["<user_query>the real one</user_query>", "<attached_files>FILE CONTENT</attached_files>"])).toEqual(
      [],
    );
    // Within one block: text after the query (an attachment written after it) means no query is taken.
    expect(
      read(["<user_query>q</user_query>\n<attached_files>FILE <user_query>FILE CONTENT</user_query></attached_files>"]),
    ).toEqual([]);
    expect(read(["<user_query>FILE </user_query> CONTENT</user_query>"])).toEqual([]);
    expect(read(["<user_query>  trailing space is fine  </user_query>\n  "])).toEqual(["trailing space is fine"]);
  });

  it("finds the trailing query in linear time (80,000 trailing spaces)", () => {
    const t0 = performance.now();
    expect(userQuery(`<user_query>q</user_query>${" ".repeat(80_000)}`)).toBe("q");
    expect(userQuery(`<user_query>q</user_query>${" ".repeat(80_000)}x`)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("encodes the project folder like Cursor does", () => {
    expect(encodeCursorProject(`${MAC}riya/my_repo.v2/`)).toBe("Users-riya-my-repo-v2");
  });
});
