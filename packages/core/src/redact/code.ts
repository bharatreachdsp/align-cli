/**
 * docs/10 §Code blocks: fenced code blocks (``` or ~~~, three or more) in user and assistant text become
 * `‹code: N lines›`, where N counts the lines inside the fences; inline code spans stay. As in CommonMark, a
 * block closes only at a line that is nothing but a fence of the same character, at least as long as the
 * opening one; an unclosed fence runs to the end of the text, so a truncated block never leaks its tail. A
 * fence opened at the end of a line of prose (`Here it is: ```ts`) is a fence too: over-stripping is safe,
 * leaking code is not (D201). Every line is scanned once, from its end, so the cost is linear. The text is
 * normalised first (`normalizeText`), so a zero-width or fullwidth character cannot hide a fence, and stripping
 * then redacting is a fixed point.
 */
import { normalizeText } from "./normalize";
import { codeMarker } from "./version";

interface Fence {
  char: "`" | "~";
  length: number;
  /** Columns of indentation before the opening fence; a closing fence may be indented at most 3 more. */
  indent: number;
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v";

/** Skips leading whitespace and blockquote markers (`> `); returns the index after them and the indentation width. */
function lead(line: string): { i: number; indent: number } {
  let i = 0;
  let indent = 0;
  for (;;) {
    const c = line[i];
    if (c === " " || c === "\r" || c === "\f" || c === "\v") indent++;
    else if (c === "\t") indent += 4;
    else if (c === ">") indent = 0;
    else break;
    i++;
  }
  return { i, indent };
}

/** A line that is only whitespace (or quote markers) and a run of the fence's character, at least as long and indented at most 3 more than the opening. */
function closesFence(line: string, fence: Fence): boolean {
  const { i: start, indent } = lead(line);
  if (indent > fence.indent + 3) return false;
  let i = start;
  let n = 0;
  while (line[i] === fence.char) {
    i++;
    n++;
  }
  if (n < fence.length) return false;
  while (isSpace(line[i])) i++;
  return i === line.length;
}

function openFence(line: string): { fence: Fence; prefix: string | null } | null {
  // A fence at the start of the line (after whitespace or quote markers), with an info string after it. An
  // info string with a backtick (```js `x`) is not a fence in CommonMark, but it is treated as one here: if it
  // was meant as one, stripping is the safe reading (D201).
  const { i, indent } = lead(line);
  const c = line[i];
  if (c === "`" || c === "~") {
    let n = 0;
    while (line[i + n] === c) n++;
    if (n >= 3) return { fence: { char: c, length: n, indent }, prefix: null };
  }
  // A fence at the end of a line of prose: the last run of three or more fence characters, followed only by an
  // info string (a word, then attributes such as `{1,3}`, `{r}` or `title="a.py"`). Only the tail of the line
  // is looked at, so a long line costs nothing extra.
  if (!line.includes("```") && !line.includes("~~~")) return null;
  const tail = line.length > 400 ? line.slice(-400) : line;
  const m = INFO_AT_END.exec(tail);
  if (!m) return null;
  const fc = (m[1] ?? "")[0] as "`" | "~";
  const start = line.length - tail.length + m.index;
  const length = (m[1] ?? "").length;
  const prefix = line.slice(0, start).replace(/[ \t]+$/, "");
  if (prefix.trim().length === 0 || prefix.includes(fc.repeat(3))) return null;
  return { fence: { char: fc, length, indent: lead(line).indent }, prefix };
}

/** A fence run at the end of a line, then an optional info word and attributes; the run is not preceded by its own character. */
const INFO_AT_END =
  /(?<![`~])(`{3,}|~{3,})[ \t]*(?:[\w+#.-]+|\{[^`{}\n]{0,120}\})?(?:[ \t]+(?:\{[^`{}\n]{0,120}\}|[\w-]{1,40}=(?:"[^"`\n]{0,120}"|'[^'`\n]{0,120}'|[^\s`]{0,120})))*[ \t\r]*$/;

export function stripCodeBlocks(input: string): { text: string; blocks: number } {
  const text = normalizeText(input);
  if (!text.includes("```") && !text.includes("~~~")) return { text, blocks: 0 };
  const lines = text.split("\n");
  const out: string[] = [];
  let blocks = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const open = openFence(line);
    if (!open) {
      out.push(line);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !closesFence(lines[j] ?? "", open.fence)) j++;
    const marker = codeMarker(j - i - 1);
    out.push(open.prefix === null ? marker : `${open.prefix} ${marker}`);
    blocks++;
    i = j + 1;
  }
  return { text: out.join("\n"), blocks };
}
