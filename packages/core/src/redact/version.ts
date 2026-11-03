/**
 * Redaction version and markers (docs/17 §Redaction). Bump `REDACTION_VERSION` whenever a rule changes what
 * it removes; raise `MIN_REDACTION_VERSION` when the server must refuse batches from older clients
 * (`redaction_outdated`, docs/10 §Ingest).
 */
export const REDACTION_VERSION = 1;
export const MIN_REDACTION_VERSION = 1;

/** Every marker starts with `‹` and ends with `›`; no rule ever matches inside one, which keeps redaction idempotent. */
export const MARKER = {
  secret: "‹secret›",
  email: "‹email›",
  phone: "‹phone›",
  ip: "‹ip›",
  host: "‹host›",
  user: "‹user›",
} as const;

export function codeMarker(lines: number): string {
  return `‹code: ${lines} lines›`;
}

/** The longest marker a single replacement can add, used by the growth bound (`‹code: N lines›` with a large N). */
export const MAX_MARKER_LENGTH = 32;

/** Hit counts per rule group (`secret`, `env`, `code`, `email`, `phone`, `ip`, `host`, `user`, `home`, `path_outside`, `path_denied`). */
export type RedactionHits = Record<string, number>;

export function addHits(into: RedactionHits, from: RedactionHits): RedactionHits {
  for (const [k, v] of Object.entries(from)) {
    if (v > 0) into[k] = (into[k] ?? 0) + v;
  }
  return into;
}
