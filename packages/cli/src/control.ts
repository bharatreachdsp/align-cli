/**
 * Removes C0 (except newline) and C1 control characters, including ESC, so no terminal escape sequence from a
 * server or a file reaches the terminal; also bidirectional overrides and isolates and zero-width characters, which
 * can make a printed URL or name read differently from what it is.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\u061c\u180e\ufeff]/g;

export const stripControl = (s: string) => s.replace(CONTROL, "");

/** A zero-width joiner between two emoji (👨‍💻): part of the emoji, not an invisible character in the text. */
const EMOJI_ZWJ = /(\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\ufe0f)?)\u200d(?=\p{Extended_Pictographic})/gu;

/**
 * True when `s` holds a character `stripControl` would remove, other than the spacing characters tab, CR and LF and a
 * zero-width joiner inside an emoji sequence.
 */
export const hasControl = (s: string) => {
  const spaced = s.replace(/[\t\r\n]/g, " ").replace(EMOJI_ZWJ, "$1");
  return stripControl(spaced) !== spaced;
};
