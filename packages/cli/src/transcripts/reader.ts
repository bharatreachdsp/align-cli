/**
 * Reads the new complete lines of a transcript file from a byte offset (docs/15 §The uploader). A line is
 * complete only when its newline has been written, so a file that grows while it is read yields its finished
 * lines now and the rest on the next read. A file that shrank or was replaced (another inode) cannot be
 * continued: the caller switches the session to hooks mode (docs/10 §Transcript modes). "The same file" is the same
 * inode on the same device: an inode number alone repeats across file systems (a file on another mount swapped in).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** `dev` is optional so a cursor saved before it was recorded still reads (its inode alone is then compared). */
export type Cursor = { byte_offset: number; line_no: number; ino: number | null; dev?: number | null };

export type RawLine = { text: string; lineNo: number };

export type Delta =
  | { ok: true; lines: RawLine[]; cursor: Cursor; more: boolean }
  | { ok: false; reason: "missing" | "not_file" | "shrunk" | "replaced" };

/** At most this much is read per call; the rest comes on the next call (`more`). */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** A single line longer than this is skipped whole (a transcript line that size is a tool result or an image). */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export function readDelta(
  path: string,
  cursor: Cursor,
  maxBytes = MAX_READ_BYTES,
  o: { noFollow?: boolean } = {},
): Delta {
  let fd: number;
  try {
    // Non-blocking, so a FIFO named as a transcript cannot hang the reader; anything but a regular file is refused.
    // `noFollow` (backfill): a transcript that is a symbolic link is never followed out of the harness's folder.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (o.noFollow ? constants.O_NOFOLLOW : 0));
  } catch (e) {
    // A link refused by `noFollow` is not "missing" (which waits for the file): it is never read.
    if (o.noFollow && (e as NodeJS.ErrnoException).code === "ELOOP") return { ok: false, reason: "not_file" };
    return { ok: false, reason: "missing" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not_file" };
    if (cursor.ino !== null && st.ino !== cursor.ino) return { ok: false, reason: "replaced" };
    if (cursor.ino !== null && cursor.dev != null && st.dev !== cursor.dev) return { ok: false, reason: "replaced" };
    if (st.size < cursor.byte_offset) return { ok: false, reason: "shrunk" };
    const available = st.size - cursor.byte_offset;
    const want = Math.min(available, maxBytes);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, cursor.byte_offset + got);
      if (n === 0) break;
      got += n;
    }
    const lines: RawLine[] = [];
    let start = 0;
    let lineNo = cursor.line_no;
    for (let i = buf.indexOf(0x0a, 0); i !== -1 && i < got; i = buf.indexOf(0x0a, start)) {
      lineNo++;
      if (i - start <= MAX_LINE_BYTES) lines.push({ text: buf.toString("utf8", start, i), lineNo });
      start = i + 1;
    }
    let consumed = start;
    // A partial line longer than one whole read can never complete inside the window: skip what was read. Its
    // tail arrives as the next "line", which is not JSON and is dropped as malformed by the harness reader.
    if (start === 0 && got === maxBytes && available > maxBytes) consumed = got;
    return {
      ok: true,
      lines,
      cursor: { byte_offset: cursor.byte_offset + consumed, line_no: lineNo, ino: st.ino, dev: st.dev },
      more: available > want,
    };
  } finally {
    closeSync(fd);
  }
}
