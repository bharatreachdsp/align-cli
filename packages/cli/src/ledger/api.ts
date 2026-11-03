/**
 * The ledger responses the CLI reads (docs/25 §Ledger), mirroring `@align/core/api/ledger.ts` as it is on PR #45
 * (`l22b-ledger-routes` @ d5a1c9b) until that merges (D264); the requests are built to #45's strict shapes in
 * `ledger/client.ts`. Server text is shown only after `stripControl` (confirm/card.ts).
 */
import { z } from "zod";

/** `AL-12`, `Q-3` (docs/11 §Identifiers). */
export const ENTRY_KEY = /^[A-Z][A-Z0-9]{0,5}-[1-9][0-9]{0,8}$/;
export const STATEMENT_MIN = 12;
export const STATEMENT_MAX = 280;
export const REASON_MAX = 500;

const Timestamp = z.string();
const PersonRef = z.object({ id: z.string(), display_name: z.string() });

export const EntrySummary = z.object({
  key: z.string(),
  kind: z.string(),
  status: z.string(),
  statement: z.string(),
  scope_paths: z.array(z.string()),
  verification: z.string(),
  private: z.boolean(),
  confirmed_by: PersonRef.nullable().optional(),
  confirmed_at: Timestamp.nullable().optional(),
  owner: PersonRef.nullable().optional(),
  due_date: z.string().nullable().optional(),
  open_conflicts: z.number().int().min(0),
});
export type EntrySummary = z.infer<typeof EntrySummary>;

export const EntriesPage = z.object({ items: z.array(EntrySummary), next_cursor: z.string().nullable() });

export const CheckView = z.object({
  id: z.string(),
  entry_key: z.string(),
  kind: z.string(),
  spec: z.record(z.string(), z.unknown()),
  status: z.string(),
  revision: z.number().int(),
  last_run: z.unknown().nullable(),
});
export type CheckView = z.infer<typeof CheckView>;

export const ConflictView = z.object({
  id: z.string(),
  entry_key: z.string(),
  origin: z.string(),
  pr_number: z.number().int().nullable(),
  sha: z.string(),
  method: z.string(),
  summary: z.string(),
  status: z.string(),
  created_at: Timestamp,
  resolved_at: Timestamp.nullable(),
});
export type ConflictView = z.infer<typeof ConflictView>;

export const EvidenceView = z.object({
  kind: z.string(),
  locator: z.string(),
  quote: z.string(),
  url: z.string().nullable(),
  added_in_revision: z.number().int(),
  created_at: Timestamp,
});
export type EvidenceView = z.infer<typeof EvidenceView>;

export const Entry = EntrySummary.extend({
  rationale: z.string().nullable(),
  alternatives_rejected: z.array(z.string()),
  owner_hint: z.string().nullable(),
  origin: z.string(),
  created_at: Timestamp,
  superseded_by: z.string().nullable(),
  revision: z.number().int(),
  revisions: z.array(z.unknown()),
  evidence: z.array(EvidenceView),
  links: z.array(z.object({ relation: z.string(), direction: z.string(), key: z.string() })),
  checks: z.array(CheckView),
  conflicts: z.array(ConflictView),
  events: z.array(z.unknown()),
});
export type Entry = z.infer<typeof Entry>;

export const KeyResponse = z.object({ key: z.string() });
export const ShareResponse = z.object({ shared: z.array(z.string()) });
export const SupersedeResponse = z.object({ old: Entry, new: Entry });
