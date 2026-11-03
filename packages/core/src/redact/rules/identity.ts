/**
 * docs/17 §Redaction rule 5, identity: home-directory prefixes (`/Users/<name>/` → `~/`), IP addresses,
 * hostnames and OS usernames are removed. `machine_id` is a salted hash (`machineId` in `../paths`).
 *
 * The hostnames the CLI knows (`os.hostname()`, full and short form) are removed wherever they appear as a
 * whole token, in any case. The OS usernames it knows are removed everywhere as whole tokens, case-sensitively
 * (D75): `riya` goes, `Riya` (capitalised, it reads as the person's name, which rule 4 keeps) stays; a `-`
 * does not protect a username (`-Users-riya-code`, `riya-feature`). Generic shapes are caught without
 * context: home prefixes (also Claude Code's encoded project folders, `-Users-<name>-…`, and WSL's
 * `\\wsl$\<distro>\home\<name>`), `*.local`, `*.lan`, `*.internal`, `*.localdomain`, `*.home.arpa`, and
 * shell prompts (`user@host:~/…`, `[user@host dir]$`, `user@host dir %`, `user@host ~/x>`).
 */
import { MARKER } from "../version";
import { escapeRegExp, type RuleResult, replaceCounting, replaceOutsideMarkers } from "./rule";

const NAME_SEGMENT = "[^\\\\/\\s\"'`:;,()<>|*?]+";
const AFTER_NAME = "(?=\\\\|\\/|$|[\\s\"'`:;,()<>|])";

/**
 * Home prefixes anywhere in text: `/Users/<name>`, `/home/<name>`, `/var/home/<name>`, `/root`,
 * `/mnt/<drive>/Users/<name>` (WSL), `C:\Users\<name>` (also with `/` or `\\`), and the same after `file://`.
 */
export function homePrefix(text: string): RuleResult {
  // A Windows profile folder may hold spaces (`C:\\Users\\Riya Sharma\\`): taken up to the next separator when
  // one follows within 64 characters, otherwise up to the first space.
  const windows = replaceCounting(
    text,
    new RegExp(
      `(?:(?<![\\w])[A-Za-z]:(?:\\\\{1,2}|\\/)|(?<![\\w\\\\])\\\\{1,2})Users(?:\\\\{1,2}|\\/)(?:[^\\\\/\\s"'\`:;,()<>|*?][^\\\\/\\n\\r\\t"'\`:;,()<>|*?]{0,63}(?=\\\\|\\/)|${NAME_SEGMENT}${AFTER_NAME})`,
      "gi",
    ),
    () => "~",
  );
  const unix = replaceCounting(
    windows.text,
    new RegExp(
      `(?:(file:\\/\\/)|(?<![\\w.~\\/\\\\-]))(?:(?:\\/mnt\\/[A-Za-z]|\\/var)?\\/(?:Users|home)\\/(?!Shared(?:\\/|$))${NAME_SEGMENT}|\\/root)${AFTER_NAME}`,
      "g",
    ),
    (m) => `${m[1] ?? ""}~`,
  );
  const encoded = replaceCounting(
    unix.text,
    /(?<![A-Za-z0-9])-(?:Users|home)-[A-Za-z0-9.]{1,64}(?=-|\/|\\|$|[\s"'`])/g,
    () => "-~",
  );
  const wsl = replaceCounting(encoded.text, /\\\\wsl(?:\$|\.localhost)\\[^\\\s]+\\home\\[^\\\s"'`]+/gi, () => "~");
  // `~riya/.bashrc`: another way to name a home directory.
  const tilde = replaceCounting(wsl.text, /(?<![\w~/.-])~[a-z_][a-z0-9_.-]{0,31}(?=\/)/g, () => "~");
  return { text: tilde.text, count: unix.count + windows.count + encoded.count + wsl.count + tilde.count };
}

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?![\\w]|\\.\\d)`, "g");
/** Version context right before a dotted quad: `v1.2.3.4`, `version 1.2.3.4`, `semver: 1.2.3.4`. */
const VERSION_BEFORE =
  /(?:\bv|\b(?:version|ver|semver|release|build|firmware|chrome|edge|windows|assembly|file ?version)\b[ \t]*[:=]?[ \t]*)$/i;

/** Private and shared address ranges (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16): never read as a version. */
const PRIVATE_V4 =
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;

/** IPv4 addresses, except loopback (`127.*`), `0.0.0.0` and four-part versions after version context (never a private address). */
export function ipv4(text: string): RuleResult {
  return replaceCounting(text, IPV4, (m) => {
    if (m[0].startsWith("127.") || m[0] === "0.0.0.0") return null;
    if (!PRIVATE_V4.test(m[0]) && VERSION_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) return null;
    return MARKER.ip;
  });
}

function isIpv6(value: string): boolean {
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h.length === 0 ? [] : h.split(":")));
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  if (halves.length === 1) return groups.length === 8;
  return groups.length >= 3 && groups.length <= 7;
}

/** IPv6 addresses (full, or compressed with `::` and at least three groups; `::1` stays). */
export function ipv6(text: string): RuleResult {
  return replaceCounting(text, /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g, (m) =>
    isIpv6(m[0]) ? MARKER.ip : null,
  );
}

const PROMPT_USER = "[A-Za-z_][A-Za-z0-9_.-]{0,31}";
const PROMPT_HOST = "[A-Za-z0-9][A-Za-z0-9-]{0,62}";

/**
 * Generic local hostnames and shell prompts: `riya@riyas-mbp:~/code`, `[riya@mbp code]$`, `riya@mbp ~ %`,
 * `riya@mbp align-v1 %` (macOS zsh), `riya@mbp ~/code>` (fish). Runs before the known-hostname and username
 * rules so a prompt is recognised before its parts are replaced.
 */
export function hostname(text: string): RuleResult {
  const prompt = replaceCounting(
    text,
    new RegExp(
      `(?<=\\[)${PROMPT_USER}@${PROMPT_HOST}(?=[\\s\\]])|(?<![\\w.-])${PROMPT_USER}@${PROMPT_HOST}(?=:[~/]|[ \\t]+[~/$%#>]|[ \\t]+[^\\s@]{1,64}[ \\t]+[%$#>](?:\\s|$)|\\])`,
      "g",
    ),
    () => `${MARKER.user}@${MARKER.host}`,
  );
  const local = replaceCounting(
    prompt.text,
    /(?<![\w.-])[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*\.(?:local|lan|internal|localdomain|home\.arpa)(?!\.?[\w-])/gi,
    () => MARKER.host,
  );
  return { text: local.text, count: prompt.count + local.count };
}

function replaceTokens(text: string, tokens: readonly string[], marker: string, flags: string): RuleResult {
  const list = [...new Set(tokens.filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  if (list.length === 0) return { text, count: 0 };
  // Markers are matched first and kept, so a username such as `user` or `code` never touches `‹user›`.
  const pattern = `(?<![A-Za-z0-9_])(?:${list.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`;
  return replaceOutsideMarkers(text, pattern, flags, () => marker);
}

/** The machine's own hostnames (full and short form) as whole tokens, in any case. */
export function knownHostnames(text: string, hostnames: readonly string[]): RuleResult {
  const all = hostnames.flatMap((h) => {
    const short = h.split(".")[0] ?? "";
    return short && short !== h ? [h, short] : [h];
  });
  return replaceTokens(text, all, MARKER.host, "gi");
}

/**
 * The OS usernames as whole tokens, case-sensitively (D75), also in their path-encoded form (`riya_k` as
 * `riya-k` in `-Users-riya-k-code`).
 */
export function knownUsernames(text: string, usernames: readonly string[]): RuleResult {
  const encoded = usernames.map((u) => u.replace(/[^A-Za-z0-9]/g, "-")).filter((e) => !usernames.includes(e));
  // The all-capitals form too (`USER=RIYA`): it never reads as the person's name the way `Riya` does.
  const upper = usernames.map((u) => u.toUpperCase()).filter((u) => /[A-Z]/.test(u));
  // A mixed-case account name (`Riya` on Windows) also in its lower-case form (`riya` in paths and remotes).
  const lower = usernames.filter((u) => /[A-Z]/.test(u) && /[a-z]/.test(u)).map((u) => u.toLowerCase());
  return replaceTokens(text, [...usernames, ...encoded, ...upper, ...lower], MARKER.user, "g");
}
