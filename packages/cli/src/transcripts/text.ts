/**
 * The text every reader and hooks mode keep from a prompt or a reply (docs/10 §Transcript readers, §Code
 * blocks): harness-injected `<system-reminder>` spans removed, fenced code blocks replaced by `‹code: N lines›`
 * (L10's `stripCodeBlocks`), and nothing at all when the text carries the pack marker. Secret redaction runs
 * afterwards on the whole event (`redactEvent`).
 */
import { PACK_MARKER_RE } from "@align/core/brand";
import { normalizeText, stripCodeBlocks } from "@align/core/redact";

/** The prefix of the pack injected at session start (docs/10), in any case and spacing (brand.ts). */
export const PACK_MARKER = PACK_MARKER_RE;

const REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** The kept text, or null when nothing is left to keep. */
export function keepText(raw: string): string | null {
  const normalized = normalizeText(raw);
  if (PACK_MARKER.test(normalized)) return null;
  const text = stripCodeBlocks(normalized.replace(REMINDER, "")).text.trim();
  return text.length > 0 ? text : null;
}

/**
 * True when any text block of one message carries the pack marker: the whole message is dropped, so a pack a harness
 * splits over several blocks never leaves its later blocks behind (docs/15 §Guarantees 3, L16).
 */
export function carriesPack(blocks: readonly unknown[]): boolean {
  for (const b of blocks) {
    const t = typeof b === "string" ? b : typeof b === "object" && b !== null ? (b as { text?: unknown }).text : null;
    if (typeof t === "string" && PACK_MARKER.test(normalizeText(t))) return true;
  }
  return false;
}

/** Claude Code's known wrappers (docs/10), kept as documentation; `isWrapper` also drops any wholly tag-wrapped text. */
const KNOWN_WRAPPER =
  /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|system-reminder)>/;
// Tag names with `_` too: Cursor's and Codex's wrappers are spelled that way (`<cursor_commands>`, `<environment_context>`).
const TAG_WRAPPED = /^\s*<([a-z][a-z0-9_-]*)>[\s\S]*<\/\1>\s*$/;

/** True for a user string that is a harness wrapper rather than something the person typed (dropped, D88). */
export function isWrapper(text: string): boolean {
  const t = normalizeText(text);
  return KNOWN_WRAPPER.test(t) || TAG_WRAPPED.test(t);
}
