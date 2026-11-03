/**
 * The injected pack never re-enters compile (docs/14 §Selection and ranking, docs/15 §Guarantees 3; L16): the pack
 * exactly as each harness's session-start hook delivers it is written into that harness's transcript in every shape
 * it could take (a hook-context reminder, a plain or split user message, an attachment, `/align`'s output, a Codex
 * developer or user message, a Cursor query), and every reader, hooks mode and the event redaction drop all of it.
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactEvent } from "@align/core/redact";
import { describe, expect, it } from "vitest";
import { convertLines } from "../src/harness/claude-code/transcript";
import { convertCodexLines } from "../src/harness/codex/transcript";
import { convertCursorLines } from "../src/harness/cursor/transcript";
import { sessionStartJson } from "../src/pack/serve";
import type { RawLine } from "../src/transcripts/reader";
import { keepText } from "../src/transcripts/text";
import { testPack } from "./pack-fixture";

const ROOT = "/work/checkout";
const served = { pack: testPack(), stale: false, ageMs: 0 };
const stale = { pack: testPack(), stale: true, ageMs: 40 * 60 * 1000 };

/** What the agent receives, per harness, from the real output function. */
function delivered(harness: string, s = served): string {
  const o = JSON.parse(sessionStartJson(harness, s, { firstSighting: true, uploadsPaused: false }) ?? "{}");
  return (o.hookSpecificOutput?.additionalContext ?? o.additional_context) as string;
}

/** Any line of the pack after its marker; none may survive. */
const PACK_LINES = testPack()
  .markdown.split("\n")
  .slice(1)
  .filter((l) => l.trim().length > 0);
const leaks = (texts: string[]) => texts.filter((t) => PACK_LINES.some((l) => t.includes(l.slice(0, 40))));

const raw = (rows: unknown[]): RawLine[] => rows.map((r, i) => ({ text: JSON.stringify(r), lineNo: i + 1 }));
const KEEP = "Thanks, now continue with the refactor.";

describe("the injected pack is stripped by every transcript reader", () => {
  for (const s of [served, stale]) {
    const label = s.stale ? " (stale form)" : "";

    it(`Claude Code: every shape the session-start context or /align can take${label}`, () => {
      const pack = delivered("claude-code", s);
      const base = { cwd: ROOT, sessionId: "s", version: "2.1.307", timestamp: "2026-10-22T09:00:00.000Z" };
      const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
        ...base,
        type: "user",
        message: { role: "user", content },
        ...extra,
      });
      const rows = [
        user(`<system-reminder>\nSessionStart:startup hook additional context: ${pack}\n</system-reminder>`),
        user(`SessionStart hook additional context: ${pack}`),
        user([{ type: "text", text: `SessionStart:startup hook additional context: ${pack}` }]),
        // a harness splitting the context over several blocks: the later blocks carry no marker of their own
        user(pack.split("\n\n").map((text) => ({ type: "text", text }))),
        user(pack, { isMeta: true }),
        { ...base, type: "attachment", attachment: { type: "hook_additional_context", content: [pack] } },
        // /align: the command's output (`!` runs it) as the person's message, and as local-command output
        user(`<command-name>/align</command-name>\n${pack}`),
        user(`<local-command-stdout>${pack}</local-command-stdout>`),
        user(pack.toUpperCase().replace("<!-- ALIGN-PACK", "<!--   align-PACK")),
        user(KEEP),
      ];
      const r = convertLines(raw(rows), { root: ROOT, nextN: 1 });
      expect(r.lines.map((l) => l.text)).toEqual([KEEP]);
      expect(leaks(r.lines.map((l) => l.text))).toEqual([]);
    });

    it(`Codex: developer message, user message, paginated items${label}`, () => {
      const pack = delivered("codex", s);
      const at = (i: number) => `2026-10-22T09:00:0${i}.000Z`;
      const rows = [
        { timestamp: at(0), type: "session_meta", payload: { id: "t", cwd: ROOT, cli_version: "0.163.0" } },
        { timestamp: at(1), type: "turn_context", payload: { cwd: ROOT } },
        {
          timestamp: at(2),
          type: "response_item",
          payload: { type: "message", role: "developer", content: [{ type: "input_text", text: pack }] },
        },
        { timestamp: at(3), type: "event_msg", payload: { type: "user_message", message: pack } },
        {
          timestamp: at(4),
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: { type: "UserMessage", content: pack.split("\n\n").map((text) => ({ type: "text", text })) },
          },
        },
        {
          timestamp: at(5),
          type: "event_msg",
          payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: pack }] } },
        },
        { timestamp: at(6), type: "event_msg", payload: { type: "user_message", message: KEEP } },
      ];
      const r = convertCodexLines(raw(rows), { root: ROOT, nextN: 1 });
      expect(leaks(r.lines.map((l) => l.text))).toEqual([]);
      expect(r.lines.map((l) => l.text)).toEqual([KEEP]);
    });

    it(`Cursor: the context and the rule file's text in a user row${label}`, () => {
      const pack = delivered("cursor", s);
      const rule = readFileSync(join(import.meta.dirname, "__golden__", "session-start", "align.mdc"), "utf8");
      const row = (blocks: string[]) => ({
        role: "user",
        message: { content: blocks.map((text) => ({ type: "text", text })) },
      });
      const rows = [
        row([`<user_query>\n${pack}\n</user_query>`]),
        row([`<rules>${rule}</rules>`, `<user_query>\n${pack.split("\n\n").slice(1).join("\n\n")}\n</user_query>`]),
        row([`<user_query>\n${KEEP}\n</user_query>`]),
      ];
      const r = convertCursorLines(raw(rows), { root: ROOT, nextN: 1 });
      expect(leaks(r.lines.map((l) => l.text))).toEqual([]);
      expect(r.lines.map((l) => l.text)).toEqual([KEEP]);
    });
  }

  it("hooks mode keeps nothing of a prompt or reply carrying the pack", () => {
    for (const h of ["claude-code", "codex", "cursor"]) expect(keepText(`see: ${delivered(h)}`)).toBeNull();
  });

  it("the event redaction drops a transcript line carrying the pack, in any case or spacing", () => {
    const e = {
      schema_version: 2,
      event_id: "0192f0a0-0000-7000-8000-00000000ab01",
      ts: "2026-10-22T09:00:00.000Z",
      kind: "transcript.chunk",
      harness: { name: "claude-code", session_id: "s", hook_event: "Stop" },
      session: { id: "0192f0a0-0000-7000-8000-00000000ab02" },
      repo: { remote_norm: "github.com/acme/checkout", root_commit: "a".repeat(40), branch: "main", head: null },
      cwd_rel: "",
      machine_id: null,
      capture: "live",
      payload: {
        mode: "hooks",
        lines: [
          { n: 1, src: "hooks:1", role: "user", text: delivered("claude-code") },
          {
            n: 2,
            src: "hooks:2",
            role: "user",
            text: delivered("claude-code").replace("<!-- align-pack", "<!--ALIGN-PACK"),
          },
          { n: 3, src: "hooks:3", role: "user", text: KEEP },
        ],
        truncated: false,
      },
    };
    const r = redactEvent(e, { orgDomains: null, denyGlobs: [], repoRoot: ROOT, salt: "0".repeat(64) });
    const lines = (r.event?.payload as { lines: { text: string }[] } | undefined)?.lines.map((l) => l.text);
    expect(lines).toEqual([KEEP]);
  });
});
