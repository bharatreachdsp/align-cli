/** The transcript reader of each harness (docs/10 §Transcript readers). */

import type { RawLine } from "../transcripts/reader";
import { type ConvertOptions, type ConvertResult, convertLines } from "./claude-code/transcript";
import { convertCodexLines } from "./codex/transcript";
import { convertCursorLines } from "./cursor/transcript";

export type Reader = (raw: RawLine[], o: ConvertOptions) => ConvertResult;

export function readerFor(harness: string): Reader | null {
  if (harness === "claude-code") return convertLines;
  if (harness === "codex") return convertCodexLines;
  if (harness === "cursor") return convertCursorLines;
  return null;
}
