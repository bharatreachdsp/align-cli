/** Capture: `POST /api/v1/events` (docs/25 §Capture, docs/10 §Ingest; L21). */
import { z } from "zod";

/** ≤ 500 events per batch; each event is validated on its own (one bad event never fails the batch). */
export const EventsRequest = z.object({ batch_id: z.uuid(), events: z.array(z.unknown()).min(1).max(500) }).strict();
export type EventsRequest = z.infer<typeof EventsRequest>;

/**
 * Per-event rejection codes (docs/15 §The uploader, D86). `rate_limited` is retryable (keep the event in the spool);
 * `session_conflict` with a `session_id` means "this harness session already has that id: re-send under it", and
 * without one "the id is taken: mint a new one"; every other code is final (move the event to `rejected/`):
 * `session_unavailable` means the harness session cannot be captured under this person and repository at all, and
 * `payload_too_large` that this one event is too big (over 256 KB, or alone over the redaction budget): split it.
 */
export const EVENT_REJECTION_CODES = [
  "invalid_request",
  "repo_not_connected",
  "not_opted_in",
  "redaction_outdated",
  "session_conflict",
  "session_unavailable",
  "rate_limited",
  "payload_too_large",
] as const;
export const RETRYABLE_REJECTION_CODES: ReadonlySet<string> = new Set(["rate_limited"]);
export type EventRejectionCode = (typeof EVENT_REJECTION_CODES)[number];

export const EventsResponse = z.object({
  /** Newly stored events. */
  accepted: z.number().int().min(0),
  /** Events whose `event_id` was already stored (a replay changes nothing). */
  duplicates: z.number().int().min(0),
  rejected: z.array(
    z.object({
      /** The event's id, or null when the event had none that parses. */
      event_id: z.string().nullable(),
      /** Its position in `events`. */
      index: z.number().int().min(0),
      code: z.enum(EVENT_REJECTION_CODES),
      /** With `session_conflict`: the id this harness session already has (the caller's own sessions only). */
      session_id: z.uuid().optional(),
    }),
  ),
});
export type EventsResponse = z.infer<typeof EventsResponse>;
