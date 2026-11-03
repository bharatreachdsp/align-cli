/**
 * Whether a run of letters and digits reads as an identifier made of words (`handleXMLHttpRequest`,
 * `ERR_HTTP2_STREAM_ERROR`) rather than a generated value. Shared by the glued vendor rules (`./secrets`) and the
 * credential line sweep (`./credential`) (L10b-3 D1202, L10b-4).
 */

/** Runs of one kind in a piece: capitals before a capitalised word (`JSON` in `JSONParser`), a word, capitals, digits. */
const WORD_PARTS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+|[^A-Za-z0-9]/g;

/**
 * The 350 letter pairs most common in the words of identifiers (counted over 4,000 type declarations of this
 * repository's dependencies, 23 Oct 2026). A word may hold two pairs outside it (`Submit`, `kubernetes`, `Webhook`); a
 * random lower-case run holds many.
 */
const WORD_PAIRS = new Set(
  (
    "abacadafagaiakalamanaparasatauavawaxayazbabebibjblbobrbsbtbubycacccechcickclcmcocpcrcsctcucydadddedg" +
    "didldodrdsdtdudyeaebecedeeefegeheiejelemeneoepeqereseteuevewexeyfafcfefffiflfofrfsftfufygageggghgigl" +
    "gmgngogrgsgtguhahehihmhohrhshthuhyiaibicidieifigikiliminioipiqirisitivixizjajejojsjukakekgkiknkskuky" +
    "lalblcldlelflilklllolplrlsltlulvlwlymambmemimlmmmnmompmsmunancndnenfngninknlnmnnnonpnrnsntnunvnyoaob" +
    "ocodoeofogoiojokolomonoooporosotouovowoxoyozpapcpdpephpiplpoppprpsptpupyqlqurarbrcrdrerfrgrirkrlrmrn" +
    "rorprrrsrtrurvrwrysasbscsesfshsiskslsmsnsospsqsrssstsuswsytatctdtetftgthtitltmtntotptrtstttutwtxtyua" +
    "ubucudueufuguiulumunuoupurusutvavevivowawewhwiwnwowrwswwxaxcxexixpxtxyyeyiylymynyoypyrysytywzazezizo"
  ).match(/../g) ?? [],
);

/** Two-letter words an identifier is made of (`getUserById`, `writeToDir`, `clockSkewMs`, `isRetryableDbError`). */
const TWO_LETTER_WORDS = new Set(
  "by is on to of in at id or if up no do go me my we he as be an it us ip ms db fs js ts io os ui ok ai".split(" "),
);

/** Capital runs an identifier is made of (`handleXMLHttpRequest`, `parseJSONResponse`); one single capital is allowed too. */
const ACRONYMS = new Set(
  (
    "XML HTML JSON HTTP HTTPS URL URI API SQL ID IDS UI CLI SDK TLS SSH DNS JWT CSS PDF PNG SVG AWS GCP IAM KMS RPC " +
    "MCP PR OS IO DB UTC CSV XHR UUID LLM AI CI CD TTL MB KB GB MS PEM RSA SHA MD JS TS CJS ESM DOM CPU GPU RAM TCP UDP " +
    "IP JSX TSX YAML TOML OK EOF IPC SMS OTP PII RLS"
  ).split(" "),
);

const CONSTANT_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+$/;
const CONSTANT_PIECE = /^[A-Z]{2,}[0-9]{0,3}$|^[A-Z][0-9]{1,3}[A-Z]?$/;

/** A capital run made of known acronyms (`XMLHTTP` = `XML` + `HTTP`), at most 12 letters. */
function acronyms(run: string): boolean {
  if (run.length > 12) return false;
  const ok: boolean[] = [true];
  for (let i = 1; i <= run.length; i++) {
    ok[i] = false;
    for (let k = Math.max(0, i - 5); k < i - 1 && !ok[i]; k++) if (ok[k] && ACRONYMS.has(run.slice(k, i))) ok[i] = true;
  }
  return ok[run.length] === true;
}

/**
 * Made of words (`RotationScheduleDocsV2-for-team`, `12345678-12345678-handlerFactoryName`, `handleXMLHttpRequest`,
 * `ERR_HTTP2_STREAM_ERROR`): CONSTANT_CASE, or every piece between separators that is not all digits splits into words
 * of three letters or more (capitalised or not; at most two letter pairs in the body outside `WORD_PAIRS`, and at most
 * 15% of them), two-letter words (`By`, `Ms`), runs of known acronyms (`XMLHTTP`; six capitals in all, at most one
 * single capital besides) and digit runs at the end of a piece or before a capital (`V2`, `oauth2Callback`; at most
 * three digits), with at least one word, and 60% of its characters lower case; a hex piece with a digit is never words.
 * Used only where a body that is not token-shaped would be taken for its prefix alone (`shape`). Measured 23 Oct 2026
 * (#90 re-review): the mixed-case or digit-holding identifiers of this repository's sources stay behind every glued
 * prefix (glued.test.ts); of 4,000,000 random base62 or base64url bodies per length, those with a digit or both cases,
 * not token-shaped and still words: 21 of 761,553 at 20 characters, 2 of 435,926 at 24, 0 of 256,565 at 28, 0 of
 * 155,977 at 32, 0 of 61,410 at 40. Linear: one scan of `WORD_PARTS` per piece.
 */
export function madeOfWords(b: string): boolean {
  // CONSTANT_CASE (`ERR_HTTP2_STREAM_ERROR`, `SESSION_START_P95_MS`): capital words between underscores.
  if (CONSTANT_CASE.test(b) && b.split("_").every((p) => CONSTANT_PIECE.test(p))) return true;
  const pieces = b.split(/[-_./+=$:]+/).filter((p) => p.length > 0 && !/^[0-9]+$/.test(p));
  if (pieces.length === 0) return false;
  let digits = 0;
  let singles = 0;
  let caps = 0;
  let rare = 0;
  let pairs = 0;
  let lower = 0;
  let all = 0;
  for (const p of pieces) {
    if (/^[0-9a-f]+$/.test(p) && /[0-9]/.test(p)) return false;
    const parts = p.match(WORD_PARTS) ?? [];
    let word = false;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k] ?? "";
      all += part.length;
      if (/^[A-Z]?[a-z]+$/.test(part)) {
        const w = part.toLowerCase();
        lower += /^[A-Z]/.test(part) ? part.length - 1 : part.length;
        if (w.length >= 3) {
          word = true;
          for (let i = 1; i < w.length; i++) {
            pairs++;
            if (!WORD_PAIRS.has(w.slice(i - 1, i + 1))) rare++;
          }
        } else if (!TWO_LETTER_WORDS.has(w)) return false;
      } else if (/^[0-9]+$/.test(part)) {
        if (k + 1 < parts.length && !/^[A-Z]/.test(parts[k + 1] ?? "")) return false;
        digits += part.length;
      } else if (/^[A-Z]+$/.test(part)) {
        caps += part.length;
        if (part.length === 1) singles++;
        else if (!acronyms(part)) return false;
      } else return false;
    }
    if (!word) return false;
  }
  return singles <= 1 && caps <= 6 && digits <= 3 && rare <= 2 && rare <= 0.15 * pairs && lower >= 0.6 * all;
}
