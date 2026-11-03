/**
 * What a secret looks like, and what ordinary English after a credential word looks like (D75, review round 4).
 * The name-keyed rules use these to tell `the token is stored hashed` (kept) from `the token is Zq81kd0Lw`
 * (redacted). Everything here is a closed list or a linear check; no regex has nested quantifiers.
 */

/**
 * Algorithm and encoding names that look like letters and digits but are never secrets (`SHA-256`, `argon2id`).
 * The digit sizes are bounded (1, 128, 224, 256, 384, 512, 4096, 25519, …), so `P4-…` or `p69347494` is not one.
 */
const ALGORITHM =
  /^(?:sha|sha3|aes|hs|rs|es|ps|md|crc|rsa|ecdsa|chacha|blake|blake2b|blake2s|curve|ed|x|p|tls|ssl|utf|ucs|ipv|http)-?(?:1|2|3|4|5|6|8|16|20|32|64|128|160|192|224|256|384|448|512|521|1024|2048|3072|4096|8192|25519)(?:-(?:128|256|512|gcm|cbc|ctr|poly1305))?$|^(?:argon2(?:id|i|d)?|base(?:32|36|58|62|64)(?:url)?|oauth2|scrypt|bcrypt|x25519|ed25519|ed448|secp256k1|secp256r1|prime256v1|hkdf|pbkdf2|hmac-sha(?:1|256|384|512)|chacha20-poly1305|xchacha20|aes-gcm|aes-(?:128|192|256)-(?:gcm|cbc|ctr)|tls1\.[0-3]|utf-8|x509|pkcs(?:1|7|8|11|12)|webauthn2?|uuidv[1-8]|ulid)$/i;

export function isAlgorithmName(word: string): boolean {
  return ALGORITHM.test(word);
}

const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Strips the punctuation a word carries in prose (`(x),` → `x`). */
export function bareWord(word: string): string {
  let a = 0;
  let b = word.length;
  while (a < b && `("'\`“«‘[{<*`.includes(word[a] ?? "")) a++;
  while (b > a && `.,;:!?"'\`”»’)]}>*`.includes(word[b - 1] ?? "")) b--;
  return word.slice(a, b);
}

/** Short letter-and-digit names that are words, not secrets (`oauth2`, `k8s`, `ec2`, `x86`). */
const KNOWN_MIXED = new Set(
  "oauth2 oauth1 http2 http3 ipv4 ipv6 utf8 utf16 x86 x64 arm64 amd64 aarch64 k8s k3s ec2 s3 gcp2 web3 web2 i18n l10n a11y b2b b2c e2e p2p 2fa mfa2 h2 h3 v1 v2 v3 v4 py3 es6 es2015 es2020 es2022 node18 node20 node22 node24 win32 win64 md5 sha1 sha2 gpt4 gpt5 o1 o3 4k 1080p 5g 4g".split(
    " ",
  ),
);

/** The `-`/`_`/`.`-separated pieces of a word: how many mix letters and digits, the longest such, the alnum total. */
function pieces(word: string): { mixed: number; longestMixed: number; alnum: number; numberAndLongWord: boolean } {
  let digitPiece = false;
  let longLetters = false;
  let mixed = 0;
  let longestMixed = 0;
  let alnum = 0;
  let start = 0;
  for (let i = 0; i <= word.length; i++) {
    const c = word[i] ?? "-";
    if (c === "-" || c === "_" || c === ".") {
      const seg = word.slice(start, i);
      let l = false;
      let d = false;
      for (const ch of seg) {
        if (isLetter(ch)) {
          l = true;
          alnum++;
        } else if (isDigit(ch)) {
          d = true;
          alnum++;
        }
      }
      if (l && d && !ALGORITHM.test(seg) && !KNOWN_MIXED.has(seg.toLowerCase())) {
        mixed++;
        longestMixed = Math.max(longestMixed, seg.length);
      }
      if (d && !l) digitPiece = true;
      if (l && !d && seg.length > 10) longLetters = true;
      start = i + 1;
    }
  }
  return { mixed, longestMixed, alnum, numberAndLongWord: digitPiece && longLetters };
}

/**
 * Letters only, twelve or more, with capitals that camel case does not explain (`pNjeFWHNbhTYjk`,
 * `ZqgvuylxWvBn`): an upper-case letter after another and before a lower-case one, a one-letter hump (`WvB`), or
 * three or more lower-to-upper steps. `timingSafeEqual` and `PostgreSQL` are not.
 */
function irregularCapitals(w: string, min = 12): boolean {
  if (w.length < min || !/^[A-Za-z]+$/.test(w) || !/[a-z]/.test(w)) return false;
  const up = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";
  const low = (c: string | undefined) => c !== undefined && c >= "a" && c <= "z";
  let steps = 0;
  for (let i = 1; i < w.length; i++) {
    const p = w[i - 1];
    const c = w[i];
    const n = w[i + 1];
    if (low(p) && up(c)) steps++;
    if (up(p) && up(c) && low(n) && i < w.length - 2) return true;
    if (up(p) && low(c) && up(n) && i >= 2) return true;
  }
  return steps >= 3;
}

/**
 * A camel-case identifier whose parts all read as words or acronyms (`verifyIdToken`, `getAccessTokenFromRequest`,
 * `createSecretManagerClient`, `parseJSONBody`): every part is an acronym of two to five capitals, or two or more
 * letters with a vowel and no run of four consonants. Generated letters (`ZqgvuylxWvBn`, `pNjeFWHNbhTYjk`) are not.
 */
export function cleanCamel(w: string): boolean {
  const parts = camelParts(w);
  return (
    parts !== null && parts.length >= 2 && parts.every((p) => (/^[A-Z]{2,}$/.test(p) ? ACRONYMS.has(p) : wordish(p)))
  );
}

/** Acronyms that stand as a camel part (`parseJSON`, `getURLPath`, `userID`); `JSR`, `GK` are not words. */
const ACRONYMS = new Set(
  "JSON URL URI URLS HTTP HTTPS HTML XML API APIS ID IDS IO SQL DB UI UUID JWT KMS TLS SSL AWS GCP CLI SDK CSV PDF OK IP DNS SSH RPC PEM RSA AES SHA MFA OTP PR CI CD NPM TTL UTC CSRF CORS SSO SAML OIDC JS TS CSS DOM MS IAM ARN SMS MCP LLM AI PII DTO ORM CDN TCP UDP".split(
    " ",
  ),
);

/** Camel-case parts (`getURLPath` → get, URL, Path), or null when the word is not letters only. */
function camelParts(w: string): string[] | null {
  const parts = w.match(/[A-Z]{2,5}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]/g) ?? [];
  return parts.join("") === w ? parts : null;
}

/** Consonant pairs that start English words. */
const INITIAL_PAIRS = new Set(
  "bl br ch cl cr dr dw fl fr gh gl gn gr kl kn kr ph pl pn pr ps pt rh sc sh sk sl sm sn sp sq st sw th tr ts tw wh wr".split(
    " ",
  ),
);
/** Technical words that start with another pair. */
const TECH_WORDS = new Set([
  "json",
  "jsonb",
  "bcrypt",
  "pkce",
  "xhr",
  "hmac",
  "npm",
  "pnpm",
  "gpt",
  "llm",
  "tsx",
  "jsx",
  "mjs",
  "cjs",
  "zsh",
  "nginx",
  "pdf",
  "svg",
  "png",
  "jpg",
  "dsn",
  "jwks",
  "mkdir",
  "fs",
  "vm",
  "mysql",
  "nfc",
]);

/** Technical words with no vowel that are still words. */
const NO_VOWEL_WORDS = new Set([
  "http",
  "https",
  "html",
  "xml",
  "sql",
  "css",
  "dns",
  "tls",
  "jwt",
  "url",
  "rpc",
  "sdk",
  "cli",
  "kms",
  "db",
  "pg",
  "sms",
  "tcp",
  "ssh",
  "nfs",
  "gcp",
  "grpc",
  "mfa",
  "crc",
  "md",
]);

/**
 * A part that reads as a word: two or more letters, a vowel (`y` counts), no run of four consonants, and no `q`
 * without a `u` after it (round 7: `zqawb`, `Vanpq` are not words; `string`, `fetch` are).
 */
function wordish(p: string): boolean {
  const l = p.toLowerCase();
  if (NO_VOWEL_WORDS.has(l)) return true;
  if (l.length < 2) return false;
  if (!/[aeiouy]/.test(l)) return false;
  if (/[bcdfghjklmnpqrstvwxz]{4}/.test(l)) return false;
  if (/q(?!u)/.test(l)) return false;
  // Two consonants that start no English word (`zq…`, `xv…`) mark generated letters; tech words are listed.
  const head = /^[bcdfghjklmnpqrstvwxz]{2}/.exec(l)?.[0];
  return head === undefined || INITIAL_PAIRS.has(head) || TECH_WORDS.has(l);
}

/**
 * An identifier that reads as code, not as a generated value (round 7): lower-case or capitalised words, snake_case
 * or SCREAMING_CASE words (digits only as a short suffix), clean camel case, a versioned name (`secretV2`), or a
 * known algorithm or technology name (`sha256`, `base64`, `k8s`). `T8tFi`, `Bx3s`, `itdkFYL` are not.
 */
export function cleanIdentifier(raw: string): boolean {
  const t = raw.replace(/^\$+/, "").replace(/!$/, "");
  if (t.length === 0) return true;
  if (ALGORITHM.test(t) || KNOWN_MIXED.has(t.toLowerCase())) return true;
  if (/^[a-z]{3,}(?:[A-Z][a-z]+)*V\d{1,2}$/.test(t)) return true;
  if (/^[a-z]+(?:_[a-z]+)*(?:_?\d{1,3})?$/.test(t))
    return t.split("_").every((w) => w.length <= 3 || wordish(w) || /^\d+$/.test(w));
  if (/^[A-Z][a-z]+$/.test(t)) return wordish(t);
  if (/^_*[A-Z][A-Z]*(?:_[A-Z]+)*(?:_?\d{1,3})?_*$/.test(t)) return true;
  return cleanCamel(t);
}

/** Code punctuation that splits a call chain or an expression into pieces (`res.status(401).end();`). */
const CODE_PUNCT = /[()[\]{};,]/;
/**
 * A piece of a code expression: empty, an identifier (TypeScript's `x!` too), a number, a quoted literal (or the
 * half of one a whitespace split leaves) or operators. Each piece is still judged on its own.
 */
const CODE_PIECE = /^(?:|[A-Za-z_$][\w$]*!?|\d+(?:\.\d+)?|["'`]?[\w.:/-]*["'`]?|[=!<>+\-*/%&|?:.]+)$/;

/**
 * Letters and symbols with no digit (`QwErTy!Ui#op`, `~mYbsfJaWvAe`): ten or more characters, both cases, and a
 * symbol that is not path, URL or e-mail punctuation; code operators (`&&`, `===`, `=>`, `?.`) are not passwords.
 */
function symbolLetters(w: string): boolean {
  if (w.length < 10 || !/[a-z]/.test(w) || !/[A-Z]/.test(w) || /[0-9./:\\=]/.test(w)) return false;
  if (/&&|\|\||!=|=>|\+\+|\?\?|\?\./.test(w)) return false;
  // Anywhere in the word left after prose punctuation is stripped (`bareWord` drops a trailing `!` or `?`).
  return /[!@#$%^&*+~?]/.test(w);
}

/** A code piece that is clean: a clean identifier, a plain number, a quoted literal half, operators or nothing. */
function cleanCodePiece(p: string): boolean {
  if (!CODE_PIECE.test(p)) return false;
  if (/^[A-Za-z_$]/.test(p)) return cleanIdentifier(p);
  if (/^\d/.test(p)) return /^\d+(?:\.\d+)?$/.test(p);
  return true;
}

/** Whether a word stands where code does: backticks around it, or a call, member access or assignment on it. */
function codePositionOf(raw: string): boolean {
  return /^`|`$/.test(raw) || /[A-Za-z0-9_$]\(|[A-Za-z0-9_$)\]]\.[A-Za-z_$]|[A-Za-z0-9_$]=/.test(raw);
}

/** One marker-free piece of a word: secret-shaped or not (see `isSecretShaped`). */
function pieceShaped(raw: string, codePosition?: boolean): boolean {
  let w = bareWord(raw);
  while (w.length > 0 && ":,/;|=".includes(w[0] ?? "")) w = w.slice(1);
  while (w.length > 0 && ":,/;|=".includes(w[w.length - 1] ?? "")) w = w.slice(0, -1);
  if (w.length < 8) return false;
  // A call chain or expression (`res.status(401).end();`, `Buffer.alloc(32)`, `sha256(raw)`) is judged piece by
  // piece, but only when every identifier piece is clean and every number plain (round 7), so `MUk8(QP2N5t)`,
  // `T8tFi[muTD8]` and `xLN3G;kEj5Nb` are judged whole.
  if (CODE_PUNCT.test(w)) {
    const parts = w.split(/[()[\]{};,]+|\.(?=[A-Za-z_$])/);
    if (parts.every(cleanCodePiece)) return parts.some((p) => p.length >= 8 && pieceShaped(p, true));
  }
  // Clean camel case is exempt only where code stands (`verifyIdToken(`, `` `getAccessTokenFromRequest` ``); in
  // prose a PascalCase word of three or more parts and twelve or more letters is a passphrase (`RiverPurpleLampCorrect`).
  const lettersOnly = /^[A-Za-z]+$/.test(w);
  const codePos = codePosition ?? codePositionOf(raw);
  const parts = lettersOnly && /[a-z][A-Z]/.test(w) ? camelParts(w) : null;
  if (!codePos && parts && parts.length >= 3 && w.length >= 12 && /^[A-Z]/.test(w) && /[a-z][A-Z]/.test(w)) return true;
  if (irregularCapitals(w) && !(codePos && cleanCamel(w))) return true;
  if (symbolLetters(w)) return true;
  // Apple-style app-specific passwords: `abcd-efgh-ijkl-mnop`.
  if (/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(w)) return true;
  // Diceware with a number: `blue-monkey-42`, `tiger-lamp-orbit-7`.
  if (/^[a-z]{3,12}(?:-[a-z]{3,12}){1,7}-?\d{1,4}$/.test(w) && !REGION.test(w)) return true;
  let letters = 0;
  let digits = 0;
  for (const ch of w) {
    if (isLetter(ch)) letters++;
    else if (isDigit(ch)) digits++;
  }
  if (digits === 0) {
    // Letters only: generated when three or more short pieces mix cases irregularly (`VYf_yQL_CYh`).
    const parts = w.split(/[-_.]/);
    const joined = parts.join("");
    return parts.length >= 3 && parts.every((p) => p.length <= 4) && joined.length >= 8 && irregularCapitals(joined, 8);
  }
  if (letters === 0) return false;
  if (ALGORITHM.test(w)) return false;
  if (/^[a-z]{3,}(?:[A-Z][a-z]+)*V\d{1,2}$/.test(w)) return false; // a versioned name: `secretV2`, `apiKeyV3`
  if (/^v?\d+(?:\.\d+)+[a-z]?(?:-[a-z]{1,12}\d{0,4})?$/i.test(w)) return false; // versions, 1.2.3-rc1
  if (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(w)) return false; // dates
  if (/^\d{1,6}(?:[.,]\d+)?-[a-z]{1,10}(?:-[a-z]{1,10})?$/i.test(w)) return false; // 15-minute, 256-bit, 30-day
  if (/^\d{1,6}(?:[.,]\d+)?(?:ms|s|m|h|d|w|y|x|px|em|rem|kb|mb|gb|tb|kib|mib|gib|tib|kbps|mbps|gbps|k|g|t)$/i.test(w))
    return false; // 64MiB
  if (REGION.test(w)) return false; // us-central1, europe-west1, us-east-1
  if (/^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5}$/.test(w)) return false; // host:port
  if (w.includes("/")) return w.split("/").some((p) => p.length >= 8 && pieceShaped(p));
  const { mixed, longestMixed, alnum, numberAndLongWord } = pieces(w);
  if (numberAndLongWord) return true; // `4587-wvzofdfqzwsaae`: no unit is that long
  // A compound of words and one short id (`L21-ingest-api`): no mixed piece of four or more, and not two or more
  // mixed pieces (`aB3-x9Q-7kL`, `9P.M9.5d.7Y` are secrets).
  // Three or more short pieces (`b8J_9rd_2LD`, `Bu6-6yR-iD8`) with letters and digits are generated, not words.
  const allShort = w.split(/[-_.]/).every((p) => p.length <= 4);
  const shortPieces = w.split(/[-_.]/).length >= 3 && allShort && mixed >= 1 && alnum >= 8;
  // The one-short-mixed-piece exemption does not hold for a long value (16 or more) or for pieces with capitals
  // inside (`aBc-ingest`): those are generated, not compounds of words (review round 6).
  const capitalsInside = w.split(/[-_.]/).some((p) => /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(p));
  const exemptionHolds = !(mixed >= 1 && (w.length >= 16 || capitalsInside));
  if (/[-_.]/.test(w) && longestMixed < 4 && !(mixed >= 2 && alnum >= 8) && !shortPieces && exemptionHolds)
    return false;
  return true;
}

/** Cloud regions (`us-central1`, `europe-west1`, `us-east-1`, `ap-southeast-2`). */
const REGION =
  /^(?:us|eu|europe|asia|ap|me|sa|ca|af|il|mx|northamerica|southamerica|australia|cn|gov)-[a-z]+(?:-[a-z]+)?-?\d$/;

const MARKER_SPLIT = /‹(?:secret|email|phone|ip|host|user|code: \d{1,9} lines)›|…\[truncated\]/;

/**
 * A secret-shaped word: eight or more characters with letters and digits; or twelve or more letters with
 * capitals that camel case does not explain; or diceware words joined with a number. Not an algorithm or
 * encoding name (bounded sizes), a version (`1.2.3-rc1`), a date, a number with a unit (`15-minute`, `64MiB`),
 * a cloud region, `host:port`, or a compound with a single short mixed piece (`L21-ingest-api`). A word glued
 * to a marker is judged piece by piece (`‹secret›:Zq81kd0Lw`), and a path by its pieces.
 */
export function isSecretShaped(raw: string): boolean {
  if (raw.length < 8) return false;
  if (!raw.includes("‹") && !raw.includes("…[")) return pieceShaped(raw);
  return raw.split(MARKER_SPLIT).some((p) => p.length > 0 && pieceShaped(p));
}

/**
 * The secret-shaped pieces of a whitespace-delimited token, as [start, end) offsets into it, with markers and
 * edge punctuation (`:`, `,`, `/`, `;`, quotes, brackets) left out.
 */
export function secretPieces(raw: string, codeLine = false): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (raw.length < 8) return out;
  const re = new RegExp(MARKER_SPLIT.source, "g");
  let last = 0;
  const consider = (a: number, b: number) => {
    let s = a;
    let e = b;
    while (s < e && `("'\`“«‘[{<*:,/;|=`.includes(raw[s] ?? "")) s++;
    while (e > s && `.,;:!?"'\`”»’)]}>*,/;|=`.includes(raw[e - 1] ?? "")) e--;
    const piece = raw.slice(s, e);
    if (e - s < 8) return;
    const codePos =
      codeLine || "`.".includes(raw[s - 1] ?? " ") || "`(.=".includes(raw[e] ?? " ") || codePositionOf(piece);
    if (pieceShaped(piece, codePos)) out.push([s, e]);
  };
  if (!raw.includes("‹") && !raw.includes("…")) {
    consider(0, raw.length);
    return out;
  }
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    if (m.index > last) consider(last, m.index);
    last = m.index + m[0].length;
  }
  if (last < raw.length) consider(last, raw.length);
  return out;
}

/**
 * Words that begin ordinary prose after `<credential> is` or a `<credential>:` label: describing a credential,
 * never holding one. A closed list. Never a credential word, and never `admin`, `root`, `guest`, `default`,
 * `password`, `secret`, `correct`, `changeme`, which are common passwords.
 */
const COMMON = new Set(
  (
    "a an the this that these those it its our their your my his her not never no now still only always also " +
    "just already usually often sometimes rarely each every all any some both either neither one two three " +
    "in on at to of for from by with without through via into under over after before during per across inside " +
    "outside within between behind beyond against about around until unless if when where while because so " +
    "and or but nor then than as like " +
    "is are was were be been being has have had do does did can could will would should must may might shall " +
    "we you they he she i us them " +
    "stored hashed salted encrypted decrypted rotated revoked expired issued signed verified checked validated " +
    "generated derived kept held cached saved sent passed bound scoped tied attached exchanged refreshed renewed " +
    "created deleted removed moved migrated leaked exposed compromised printed logged shown displayed masked " +
    "hidden used needed required optional valid invalid short long short-lived long-lived single-use one-time " +
    "opaque random unique static dynamic temporary permanent per-environment per-user per-org per-repository " +
    "per-workspace per-session read-only write-only fine-grained encoded handled managed configured injected " +
    "loaded read written fetched provided supplied unset changed empty missing none null undefined true false " +
    "fine ok okay good bad safe unsafe weak strong too very quite much more less same different " +
    "separate shared private public internal external local remote available unavailable present absent there " +
    "here what which who how why whatever going enforced applied limited capped done disabled enabled " +
    "supported unsupported deprecated obsolete outdated current new old previous next first last " +
    "something nothing everything anything someone nobody everyone " +
    "described documented defined specified listed explained mentioned set reset " +
    "sent received returned accepted rejected denied allowed blocked granted needed " +
    "automatic automated manual manually auto rotating expiring rotates expires lives sits " +
    "e.g. i.e. etc see per-request per-call per-connection hardcoded hard-coded plaintext cleartext " +
    "xoxb-shaped jwt-shaped opaque-to-clients base62 base64 hex json text " +
    "minimum maximum least most at " +
    "dropped replaced added introduced chosen picked approved switched removed renamed split merged kept " +
    "recommended discouraged forbidden banned preferred planned scheduled tracked audited reviewed tested " +
    "issued minted parsed compared matched hashed, stored, encrypted, rotated, revoked, enforced, " +
    "httponly samesite wrong incorrect malformed truncated corrupted corrupt stale revoked, expired, " +
    "case-sensitive case-insensitive per-tenant per-team per-project per-device per-install longer shorter " +
    "four five six seven eight nine ten eleven twelve twenty thirty sixty hundred " +
    "rsa ecdsa aes hmac sha jwt json yaml base62, base64, ascii unicode numeric alphanumeric"
  ).split(/\s+/),
);

/** A short camel-case product or technology name. */
const CAMEL_NAME = /^(?:[A-Z]{1,2}|[A-Z]?[a-z]{1,10})(?:[A-Z][a-z]{1,10}){0,3}(?:[A-Z]{1,3})?$/;
/** A number glued to its unit (`4KB`, `64MiB`, `30d`). */
const NUMBER_UNIT = /^\d{1,6}(?:[.,]\d+)?(?:ms|s|m|h|d|w|y|x|px|kb|mb|gb|tb|kib|mib|gib|k)$/i;

/** A count: up to twelve digits, or thousands separated (`1209600`, `8,000`, `2.5`). */
const NUMBER = /^(?:\d{1,12}|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

/** Unit words after a number (`30 days`, `32 bytes`, `RSA 4096`'s bits). */
const UNITS = new Set(
  "ms milliseconds second seconds sec secs s minute minutes min mins m hour hours h day days d week weeks month months year years byte bytes bit bits kb mb gb kib mib character characters chars char digit digits letter letters word words attempts tries times requests calls items entries keys tokens users bit, bits, bytes, days. days, seconds. bytes. digits.".split(
    " ",
  ),
);

/** Words skipped before the value after a copula (`is now X`, `was changed to X`). */
export const FILLERS = new Set([
  "now",
  "still",
  "currently",
  "temporarily",
  "just",
  "actually",
  "literally",
  "simply",
  "set",
  "changed",
  "reset",
  "to",
  "probably",
  "basically",
  "really",
  "again",
  "being",
  "going",
  "be",
]);

/** Function words: a value with one of them (after its first word) reads as a sentence, not a passphrase. */
const FUNCTION = new Set(
  "the a an of to in on at for from by with and or but not is are was were be as into per via than then that this which when where while so if because after before until unless since during about over under through without within they it we".split(
    " ",
  ),
);

/** Whether `word` (as written) begins ordinary English. */
export function isCommonWord(word: string): boolean {
  const b = bareWord(word).toLowerCase();
  if (b.length === 0) return false;
  return COMMON.has(b) || ALGORITHM.test(b) || /^per-[a-z]{3,20}$/.test(b);
}

export type ProseVerdict = "keep" | "redact";

/**
 * The verdict on the words after a credential word and a prose separator (a copula or a colon label), for an
 * unquoted value: redact when any word is secret-shaped; keep when the first word is ordinary English (or an
 * algorithm name); keep a clause of three or more words that holds a function word after its first (a
 * sentence, not a passphrase); otherwise redact. So `Password: must be at least 12 characters` and `Token:
 * we use opaque tokens` are kept; `password: correct horse battery staple`, `the token is Zq81kd0Lw` and
 * `pin: 4821` are not.
 */
export function proseVerdict(words: readonly string[], wordList = false, nested = false): ProseVerdict {
  if (words.length === 0) return "keep";
  for (const w of words) if (isSecretShaped(w)) return "redact";
  const first = bareWord(words[0] ?? "");
  const second = bareWord(words[1] ?? "").toLowerCase();
  // A count with a unit or a function word (`10 per user`, `1209600 seconds`, `8,000 input tokens`).
  if (NUMBER.test(first) && (UNITS.has(second) || FUNCTION.has(second))) return "keep";
  // After `mnemonic`, `seed`, `passphrase` or recovery codes a value is a word list (the caller keeps only a
  // whole prose word or literal).
  if (wordList) return "redact";
  if (isCommonWord(first)) return "keep";
  // A number with a unit: `30 days`, `3600 seconds`, `4 digits`, `RSA 4096`.
  if (NUMBER.test(first) && UNITS.has(second)) return "keep";
  // `value is X`: a noun then a copula, judged (once) by what follows the copula.
  if (!nested) {
    for (let i = 1; i < Math.min(words.length, 4); i++) {
      if (/^(?:is|was|are|were)$/i.test(words[i] ?? "")) return proseVerdict(words.slice(i + 1), wordList, true);
    }
  }
  if (NUMBER_UNIT.test(first)) return "keep"; // `4KB at most`
  // A first word with capitals inside does not start prose (`pNjeFWHNbhTYjk`, `ZqgvuylxWvBn`), unless it is a
  // short camel-case name (`GitHub`, `OAuth`, `PostgreSQL`, `macOS`).
  if (/[A-Z]/.test(first.slice(1)) && !/^[A-Z]+$/.test(first) && (first.length >= 12 || !CAMEL_NAME.test(first))) {
    return "redact";
  }
  // A sentence: three or more words, a function word after the first, and every word before it an ordinary
  // word shape (lower case or capitalised, no capital inside, at most 15 letters).
  if (words.length >= 3) {
    for (let i = 1; i < words.length; i++) {
      const w = bareWord(words[i] ?? "");
      if (FUNCTION.has(w.toLowerCase())) return "keep";
      // Plain words, short camel-case names, numbers and standard numbers (`800-63B`) continue the sentence.
      if (!/^[A-Za-z][a-z'-]{0,14}$/.test(w) && !CAMEL_NAME.test(w) && !/^\d{1,12}(?:-\d{0,6}[A-Za-z]?)*$/.test(w))
        break;
    }
  }
  return "redact";
}

/**
 * Lookalike letters folded to Latin, one UTF-16 unit for one, so positions in the folded text are positions in
 * the original (`pаssword` with a Cyrillic `а`, `pαssword` with a Greek alpha).
 */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
  ԛ: "q",
  ԝ: "w",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  І: "I",
  Ѕ: "S",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ι: "I",
  Κ: "K",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  Ζ: "Z",
};
const CONFUSABLE_CLASS = `[${Object.keys(CONFUSABLES).join("")}]`;
const HAS_CONFUSABLE = new RegExp(CONFUSABLE_CLASS);

/** `text` with lookalike letters folded (same length). No regex state is shared between calls. */
export function foldConfusables(text: string): string {
  if (!HAS_CONFUSABLE.test(text)) return text;
  return text.replace(new RegExp(CONFUSABLE_CLASS, "g"), (c) => CONFUSABLES[c] ?? c);
}
