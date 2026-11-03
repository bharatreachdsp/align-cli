/**
 * The first pass of every redaction (docs/17 §Redaction): one normalised form for the laptop and the server, so
 * a rule never has to know about lookalike characters.
 */
/** Unicode spaces that are not a plain space (NFKC keeps U+1680), mapped to one before matching. */
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
/** Invisible characters (zero-width, bidi controls, tag characters, variation selectors, U+034F, U+3164 …). */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII fast path
const ASCII = /^[\u0000-\u007f]*$/;

/**
 * The normalisation every text goes through before any rule (laptop and server alike): NFKC (fullwidth
 * `ｇｈｐ_`, `：` and `＝` become `ghp_`, `:` and `=`), Unicode spaces to `' '`, default-ignorable code points
 * removed (so they can split neither a token nor a fence), repeated until stable so the result is a fixed
 * point. Idempotent: `normalizeText(normalizeText(x)) === normalizeText(x)`.
 */
export function normalizeText(text: string): string {
  if (ASCII.test(text)) return text;
  let t = text;
  for (let i = 0; i < 4; i++) {
    const next = t.replace(IGNORABLE, "").normalize("NFKC").replace(SPACES, " ");
    if (next === t) break;
    t = next;
  }
  return t;
}
