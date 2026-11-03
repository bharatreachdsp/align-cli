/**
 * docs/17 §Redaction rule 4, personal data: emails outside the organisation's domains become `‹email›`
 * (every email while the domains are unknown, `orgDomains: null`), phone numbers become `‹phone›`. Names are
 * left: they are part of the record.
 */
import { MARKER } from "../version";
import { type RuleResult, replaceCounting } from "./rule";

/** An address, also percent-encoded (`bob%40gmail.com`) and with an internationalised domain (`bob@例え.jp`). */
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])([\p{L}\p{N}._%+-]+?)(?:@|%40)((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[A-Za-z]{2,24}|[\p{L}]{2,24}|xn--[a-z0-9-]{1,59}))(?![\p{L}\p{N}-])/gu;

/** True when `domain` is one of `orgDomains` or a subdomain of one (case-insensitive). */
export function isOrgDomain(domain: string, orgDomains: readonly string[] | null): boolean {
  if (!orgDomains) return false;
  const d = domain.toLowerCase();
  return orgDomains.some((o) => {
    const org = o.toLowerCase().replace(/^@/, "");
    return org.length > 0 && (d === org || d.endsWith(`.${org}`));
  });
}

/** Emails outside `orgDomains`. `git@host` (SSH remotes) is an address of a service, not a person, and stays. */
export function email(text: string, orgDomains: readonly string[] | null): RuleResult {
  return replaceCounting(text, EMAIL, (m) => {
    const local = m[1] ?? "";
    const domain = m[2] ?? "";
    if (local === "git") return null;
    return isOrgDomain(domain, orgDomains) ? null : MARKER.email;
  });
}

const PHONE_CONTEXT =
  /(?:\b(?:call|phone|mobile|mob|cell|tel|telephone|whatsapp|contact|ph|sms|text me|number)\b|फ़ोन|फोन|मोबाइल|नंबर)[^\n]{0,20}$/i;

function digits(value: string): number {
  return value.replace(/[^0-9]/g, "").length;
}

/**
 * Phone numbers: international (`+` and 8–15 digits with spaces, dots, dashes or brackets), North American
 * (`415-555-0100`, `(415) 555 0100`) and Indian mobile numbers (10 digits starting 6–9) when split 5+5, prefixed
 * with `+91` or `0`, or after a word such as "call", "phone", "mobile" or "WhatsApp"; a bare 10-digit number
 * elsewhere is an id far more often than a phone number.
 */
export function phone(text: string): RuleResult {
  const intl = replaceCounting(text, /(?<![\w+])\+\d[\d ().-]{6,18}\d(?![\w]|[.-]\d)/g, (m) => {
    const n = digits(m[0]);
    return n >= 8 && n <= 15 ? MARKER.phone : null;
  });
  const nanp = replaceCounting(
    intl.text,
    /(?<![\w.+-])(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w-]|\.\d)/g,
    () => MARKER.phone,
  );
  // A bare ten-digit number counts only after a phone word within 32 characters of the text as rewritten so far in
  // this pass (earlier numbers already replaced), so one word cannot reach along a run of numbers further each pass
  // (#65 security review). Only a rolling 32-character tail of that text is kept, so the cost stays linear.
  const CONTEXT = 32;
  let tail = "";
  let upTo = 0;
  const india = replaceCounting(
    nanp.text,
    /(?<![\w.+-])((?:\+91|0)[ -]?)?[6-9]\d{4}([ -]?)\d{5}(?![\w-]|\.\d)/g,
    (m) => {
      tail = (tail + nanp.text.slice(Math.max(upTo, m.index - CONTEXT), m.index)).slice(-CONTEXT);
      upTo = m.index + m[0].length;
      const replace = m[1] || m[2] || PHONE_CONTEXT.test(tail);
      tail = (tail + (replace ? MARKER.phone : m[0])).slice(-CONTEXT);
      return replace ? MARKER.phone : null;
    },
  );
  return { text: india.text, count: intl.count + nanp.count + india.count };
}
