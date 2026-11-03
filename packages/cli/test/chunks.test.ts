/** Transcript chunks stay under ingest's per-event cap (256 KB serialized; we keep ≤ 192 KB). */
import { describe, expect, it } from "vitest";
import type { Line } from "../src/harness/claude-code/transcript";
import { MAX_EVENT_BYTES, redactedChunks } from "../src/hook/read";
import { newState } from "../src/hook/state";

const root = "/work/checkout";
const state = newState({
  id: "0192f6a7-0000-7000-8000-000000000001",
  harness: "claude-code",
  harness_session_id: "s",
  root,
  mode: "jsonl",
  transcript_path: "/t.jsonl",
  now: 0,
});
const repo = {
  root,
  entry: {
    repo_id: "r",
    org_id: "o",
    remote_norm: "github.com/acme/checkout",
    root_commit: "a".repeat(40),
    default_branch: "main",
    opted_in: true,
    harnesses: [],
    installed_at: "x",
  },
  facts: { toplevel: root, head: null, branch: "main" },
};
const rctx = { orgDomains: null, denyGlobs: [], repoRoot: root, salt: "s" };
const opts = { state, repo, mode: "jsonl" as const, truncated: false, now: 0, machineId: null };
const bytes = (e: unknown) => Buffer.byteLength(JSON.stringify(e), "utf8");
type Out = { payload: { lines: Line[]; truncated: boolean } };

describe("transcript chunk size", () => {
  it("splits many long multi-byte lines into events of at most 192 KB, keeping order and every n", () => {
    const lines: Line[] = Array.from({ length: 600 }, (_, i) => ({
      n: i + 1,
      src: `jsonl:${i + 1}`,
      role: "assistant",
      text: `Entscheidung ${i}: ${"ü€字 ".repeat(1900)}`,
    }));
    const events = redactedChunks(lines, opts, rctx) as unknown as Out[];
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) expect(bytes(e)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(events.flatMap((e) => e.payload.lines.map((l) => l.n))).toEqual(lines.map((l) => l.n));
  }, 60_000);

  it("a single huge line is capped by redaction and fits; truncated is set on the last chunk only", () => {
    const lines: Line[] = [
      { n: 1, src: "jsonl:1", role: "user", text: "x ".repeat(2 * 1024 * 1024) },
      {
        n: 2,
        src: "jsonl:2",
        role: "tool",
        text: "‹tool: Read, 1 bytes›",
        tool: {
          name: "Read",
          bytes: 1,
          paths: Array.from({ length: 50 }, (_, i) => `${root}/${"d/".repeat(400)}${i}.ts`),
        },
      },
    ];
    const events = redactedChunks(lines, { ...opts, truncated: true }, rctx) as unknown as Out[];
    for (const e of events) expect(bytes(e)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(events.map((e) => e.payload.truncated)).toEqual([...events.slice(1).map(() => false), true]);
    expect(events.flatMap((e) => e.payload.lines.map((l) => l.n))).toEqual([1, 2]);
  }, 60_000);
});

describe("round 4 · the last-resort cut never splits a secret (finding 1)", () => {
  // Fake secrets assembled at run time (AGENTS.md rule 12): a known prefix plus a body that must never surface.
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const body = (n: number) => Array.from({ length: n }, (_, i) => ALNUM[(i * 7 + 3) % ALNUM.length]).join("");
  const secrets: Record<string, { lead: string; body: string }> = {
    github: { lead: ["gh", "p_"].join(""), body: body(36) },
    anthropic: { lead: ["sk", "-ant-api03-"].join(""), body: `${body(93)}AA` },
    aws: { lead: "aws_secret_access_key=", body: body(40) },
  };
  // Over 192 KB serialized after redaction, every line short: only the last-resort cut can make it fit.
  const filler = `\n${Array.from({ length: 5200 }, (_, i) => `log line ${i} lorem ipsum dolor sit amet`).join("\n")}`;
  const textOf = (events: Out[]) => events.map((e) => e.payload.lines.map((l) => l.text).join("\n")).join("\n");

  const leaked = (out: string, b: string) => {
    for (let i = 0; i + 8 <= b.length; i++) if (out.includes(b.slice(i, i + 8))) return i;
    return -1;
  };
  const cutRun = (text: string) => {
    const events = redactedChunks([{ n: 1, src: "jsonl:1", role: "user", text }], opts, rctx) as unknown as Out[];
    for (const e of events) expect(bytes(e)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    return textOf(events);
  };
  // No whitespace anywhere near the secret (round 5): a cut that fell back to the raw text would split the secret and
  // leave a prefix no rule recognises. Each delimiter is one redaction recognises in full text; letters glued to a
  // vendor token are not recognised even uncut today (L10b), so they are tried only on the name-keyed AWS shape.
  const delimiters: Record<string, string[]> = {
    github: ["key:", "url=", "/", "_", "-", ".", " "],
    anthropic: ["key:", "url=", "/", "_", "-", ".", " "],
    aws: ["key:", "=", "/", "x", "xxxx", " "],
  };

  for (const [name, s] of Object.entries(secrets)) {
    it(`${name}: no 8 characters of the secret survive, whatever the offset at the cut`, { timeout: 300_000 }, () => {
      const secret = s.lead + s.body;
      // Every offset for the short secrets, a sample for the long one (the fix is structural: the cut never sees raw
      // text).
      const step = secret.length > 70 ? 9 : 1;
      for (const d of delimiters[name] ?? []) {
        let cuts = 0;
        for (let keep = 1; keep < secret.length; keep += step) {
          const text = `${"x".repeat(1000 - keep - d.length)}${d}${secret}${filler}`;
          const out = cutRun(text);
          if (out.endsWith("[truncated]")) cuts++;
          const at = leaked(out, s.body);
          if (at >= 0) throw new Error(`${name} after ${JSON.stringify(d)} keep=${keep}: body[${at}..] leaked`);
        }
        // The last-resort cut really ran for this delimiter (a name-keyed value can swallow the rest of the line).
        expect(cuts, `${name} ${JSON.stringify(d)}`).toBeGreaterThan(0);
      }
    });
  }

  it("a vendor token glued to letters is redacted, even uncut (L10b-2 fixed the rule)", () => {
    const secret = (secrets.github?.lead ?? "") + (secrets.github?.body ?? "");
    const at = leaked(cutRun(`${"x".repeat(500)}${secret}${filler}`), secrets.github?.body ?? "");
    expect(at).toBe(-1);
  });

  it("the cut is on a code-point boundary and marked", () => {
    for (let shift = 0; shift < 4; shift++) {
      const text = `${"a".repeat(shift)}${"😀".repeat(2000)}${filler}`;
      const events = redactedChunks([{ n: 1, src: "jsonl:1", role: "user", text }], opts, rctx) as unknown as Out[];
      const t = events[0]?.payload.lines[0]?.text ?? "";
      expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      // The marker is redacted with the text, so it arrives normalised (`...[truncated]`), as the server would store it.
      expect(t.endsWith("[truncated]")).toBe(true);
      expect(t.length).toBeLessThanOrEqual(1000 + "...[truncated]".length);
    }
  });
});
