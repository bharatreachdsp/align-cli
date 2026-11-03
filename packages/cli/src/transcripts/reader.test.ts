import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDelta } from "./reader";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "align-reader-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const start = { byte_offset: 0, line_no: 0, ino: null };

describe("readDelta", () => {
  it("returns complete lines only and continues from the cursor", () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, 'a\n"é"\npart');
    const r1 = readDelta(f, start);
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.lines).toEqual([
      { text: "a", lineNo: 1 },
      { text: '"é"', lineNo: 2 },
    ]);
    expect(r1.cursor.byte_offset).toBe(Buffer.byteLength('a\n"é"\n'));
    appendFileSync(f, "ial\nnext\n");
    const r2 = readDelta(f, r1.cursor);
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.lines).toEqual([
      { text: "partial", lineNo: 3 },
      { text: "next", lineNo: 4 },
    ]);
    const r3 = readDelta(f, r2.cursor);
    expect(r3.ok && r3.lines).toEqual([]);
  });

  it("reports a file that shrank, was replaced, is missing or is not a regular file", () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, "one\ntwo\n");
    const r = readDelta(f, start);
    if (!r.ok) throw new Error("expected ok");
    writeFileSync(f, "x\n");
    expect(readDelta(f, r.cursor)).toEqual({ ok: false, reason: "shrunk" });
    // A new file renamed over the old one (both exist at once, so the inode differs).
    writeFileSync(join(dir, "new.jsonl"), "one\ntwo\nthree\n");
    renameSync(join(dir, "new.jsonl"), f);
    expect(readDelta(f, r.cursor)).toEqual({ ok: false, reason: "replaced" });
    expect(readDelta(join(dir, "missing.jsonl"), start)).toEqual({ ok: false, reason: "missing" });
    expect(readDelta(dir, start)).toEqual({ ok: false, reason: "not_file" });
    const fifo = join(dir, "fifo.jsonl");
    execFileSync("mkfifo", [fifo]);
    expect(readDelta(fifo, start)).toEqual({ ok: false, reason: "not_file" });
  });

  it("the same inode number on another device is another file (replaced); a cursor without a device still reads", () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, "one\n");
    const r = readDelta(f, start);
    if (!r.ok) throw new Error("expected ok");
    expect(r.cursor.dev).toEqual(expect.any(Number));
    appendFileSync(f, "two\n");
    expect(readDelta(f, { ...r.cursor, dev: (r.cursor.dev ?? 0) + 1 })).toEqual({ ok: false, reason: "replaced" });
    const { dev: _dev, ...older } = r.cursor;
    const r2 = readDelta(f, older);
    expect(r2.ok && r2.lines.map((l) => l.text)).toEqual(["two"]);
    expect(r2.ok && r2.cursor.dev).toBe(r.cursor.dev);
  });

  it("reads at most maxBytes per call and says there is more", () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, "aaaa\nbbbb\ncccc\n");
    const r = readDelta(f, start, 10);
    if (!r.ok) throw new Error("expected ok");
    expect(r.lines.map((l) => l.text)).toEqual(["aaaa", "bbbb"]);
    expect(r.more).toBe(true);
    const r2 = readDelta(f, r.cursor, 10);
    expect(r2.ok && r2.lines.map((l) => l.text)).toEqual(["cccc"]);
  });

  it("skips past a partial line longer than a whole read", () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, `${"x".repeat(30)}\nok\n`);
    const r = readDelta(f, start, 10);
    if (!r.ok) throw new Error("expected ok");
    expect(r.lines).toEqual([]);
    expect(r.cursor.byte_offset).toBe(10);
  });
});
