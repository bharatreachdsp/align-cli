/**
 * Small shape checks for the local JSON files the hook path reads (registry, session index, config, session
 * state). They replace zod there because loading zod costs a hook about 20 ms of its 200 ms budget (docs/15
 * §Guarantees 2); every check is strict about types and fills documented defaults.
 */
export type Rec = Record<string, unknown>;

export const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
export const isString = (v: unknown): v is string => typeof v === "string";
export const isInt = (v: unknown, min = Number.MIN_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** `version` must be absent or 1 (every local file is version 1). */
export const versionOk = (o: Rec) => o.version === undefined || o.version === 1;

/** Maps each value of a record through `parse`; null when any value fails. */
export function recordOf<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> | null {
  if (v === undefined) return {};
  if (!isRecord(v)) return null;
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) {
    const p = parse(x);
    if (p === null) return null;
    out[k] = p;
  }
  return out;
}
