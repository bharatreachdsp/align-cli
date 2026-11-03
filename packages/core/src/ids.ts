/**
 * Identifiers (docs/04 §Code conventions, docs/11 §Identifiers). Isomorphic: Web Crypto only.
 */
import { QUESTION_PREFIX } from "./brand";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * A UUID version 7 (RFC 9562): 48-bit Unix time in milliseconds, then random bits. Matches Postgres 18's
 * `uuidv7()` layout, so ids sort by creation time in both places.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10
  const h = Array.from(bytes, (b) => HEX[b]).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_V7.test(value);
}

/** An organisation's entry prefix: `^[A-Z][A-Z0-9]{1,5}$` (docs/11). */
export const ENTRY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;

export type EntryKey =
  | { kind: "entry"; prefix: string; number: number }
  | { kind: "question"; prefix: typeof QUESTION_PREFIX; number: number };

/** Formats `AL-12` (decisions and commitments) or `Q-3` (questions). Throws on an invalid prefix or number. */
export function formatEntryKey(prefix: string, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("entry number must be a positive integer");
  if (prefix !== QUESTION_PREFIX && !ENTRY_PREFIX_PATTERN.test(prefix)) throw new RangeError("invalid entry prefix");
  return `${prefix}-${number}`;
}

/** Parses `AL-12`, `al-12` or `Q-3`; returns null for anything else. */
export function parseEntryKey(value: string): EntryKey | null {
  const m = /^([A-Za-z][A-Za-z0-9]{0,5})-([1-9][0-9]{0,15})$/.exec(value.trim());
  if (!m?.[1] || !m[2]) return null;
  const prefix = m[1].toUpperCase();
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number)) return null;
  if (prefix === QUESTION_PREFIX) return { kind: "question", prefix: QUESTION_PREFIX, number };
  if (!ENTRY_PREFIX_PATTERN.test(prefix)) return null;
  return { kind: "entry", prefix, number };
}
