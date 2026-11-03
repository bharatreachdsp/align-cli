/**
 * The ledger API (docs/25 §Ledger, §Capture (sessions), §Backfill and local checks (checks, check results); L22).
 * Requests are strict (an unknown key is refused); responses are what the server sends. Free text in requests is
 * redacted again on the server before it is stored (docs/17 rule 2), so these limits are on what the client sends.
 */
import { z } from "zod";
import { Id, Timestamp } from "./common";

const Uuid = z.uuid();
/** `AL-12`, `Q-3` (docs/11 §Identifiers). */
export const EntryKey = z.string().regex(/^[A-Z][A-Z0-9]{0,5}-[1-9][0-9]{0,8}$/);
const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A repository-relative POSIX path or glob (docs/13): no leading `/`, no `..` segment, no backslash. */
export const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), "repository-relative path");

const Statement = z.string().min(12).max(280);
const Rationale = z.string().max(2000);
const Alternatives = z.array(z.string().min(1).max(280)).max(10);
const ScopePaths = z.array(RepoPath).max(50);
const Reason = z.string().min(1).max(500);

export const EntryKind = z.enum(["decision", "commitment", "question"]);
export const EntryStatus = z.enum([
  "proposed",
  "confirmed",
  "rejected",
  "superseded",
  "withdrawn",
  "open",
  "answered",
  "dismissed",
]);
export const Verification = z.enum(["unverified", "verified", "drifted", "not_checkable"]);
export const CheckKind = z.enum([
  "forbid_import",
  "forbid_dependency",
  "forbid_pattern",
  "require_pattern",
  "path_exists",
  "path_absent",
]);
export const CheckStatus = z.enum(["proposed", "active", "disabled"]);
export const CheckResult = z.enum(["pass", "fail", "error", "skipped"]);
export const ConflictStatus = z.enum(["open", "resolved_superseded", "resolved_changed", "dismissed"]);

export const PersonRef = z.object({ id: Id, display_name: z.string() });
export type PersonRef = z.infer<typeof PersonRef>;

// ---------------------------------------------------------------------------------------------------------------
// Responses.

export const EntrySummary = z.object({
  key: z.string(),
  kind: EntryKind,
  status: EntryStatus,
  statement: z.string(),
  scope_paths: z.array(z.string()),
  verification: Verification,
  /** The entry is author-only (a proposal of the caller's that nobody else sees yet). */
  private: z.boolean(),
  confirmed_by: PersonRef.nullable().optional(),
  confirmed_at: Timestamp.nullable().optional(),
  owner: PersonRef.nullable().optional(),
  due_date: DateOnly.nullable().optional(),
  open_conflicts: z.number().int().min(0),
  /** The current revision: what a confirm of this summary's wording passes as `revision` (D419). */
  revision: z.number().int().min(1).optional(),
});
export type EntrySummary = z.infer<typeof EntrySummary>;

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

export const EntriesPage = Page(EntrySummary);
export type EntriesPage = z.infer<typeof EntriesPage>;

export const Revision = z.object({
  revision: z.number().int().min(1),
  statement: z.string(),
  rationale: z.string().nullable(),
  alternatives_rejected: z.array(z.string()),
  scope_paths: z.array(z.string()),
  due_date: DateOnly.nullable(),
  owner_hint: z.string().nullable(),
  reason: z.string().nullable(),
  by: z.enum(["person", "align"]),
  created_at: Timestamp,
});

export const EvidenceView = z.object({
  kind: z.enum(["transcript", "commit", "source_text", "event", "confirmation"]),
  locator: z.string(),
  quote: z.string(),
  url: z.string().nullable(),
  added_in_revision: z.number().int().min(1),
  created_at: Timestamp,
});
export type EvidenceView = z.infer<typeof EvidenceView>;

export const CheckRunView = z.object({
  result: CheckResult,
  context: z.enum(["default_branch", "pr", "local"]),
  sha: z.string(),
  ran_at: Timestamp,
});

export const CheckView = z.object({
  id: Id,
  entry_key: z.string(),
  kind: CheckKind,
  spec: z.record(z.string(), z.unknown()),
  status: CheckStatus,
  revision: z.number().int().min(1),
  last_run: CheckRunView.nullable(),
});
export type CheckView = z.infer<typeof CheckView>;

export const ConflictView = z.object({
  id: Id,
  entry_key: z.string(),
  origin: z.enum(["pr", "default_branch", "local"]),
  pr_number: z.number().int().nullable(),
  sha: z.string(),
  method: z.enum(["check", "judge"]),
  summary: z.string(),
  status: ConflictStatus,
  created_at: Timestamp,
  resolved_at: Timestamp.nullable(),
});
export type ConflictView = z.infer<typeof ConflictView>;

export const Entry = EntrySummary.extend({
  rationale: z.string().nullable(),
  alternatives_rejected: z.array(z.string()),
  owner_hint: z.string().nullable(),
  origin: z.string(),
  created_at: Timestamp,
  superseded_by: z.string().nullable(),
  revision: z.number().int().min(1),
  revisions: z.array(Revision),
  evidence: z.array(EvidenceView),
  links: z.array(
    z.object({
      relation: z.enum(["supersedes", "refines", "duplicates", "conflicts_with", "answers"]),
      direction: z.enum(["out", "in"]),
      key: z.string(),
    }),
  ),
  checks: z.array(CheckView),
  conflicts: z.array(ConflictView),
  events: z.array(z.object({ kind: z.string(), by: z.enum(["person", "align", "system"]), created_at: Timestamp })),
});
export type Entry = z.infer<typeof Entry>;

// ---------------------------------------------------------------------------------------------------------------
// Requests.

export const ListEntriesQuery = z.object({
  repo_id: Uuid,
  status: z.string().max(200).optional(),
  kind: z.string().max(100).optional(),
  path: RepoPath.optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
});
export type ListEntriesQuery = z.infer<typeof ListEntriesQuery>;

export const RecordEntryRequest = z.strictObject({
  repo_id: Uuid,
  kind: z.enum(["decision", "commitment"]),
  statement: Statement,
  rationale: Rationale.optional(),
  alternatives_rejected: Alternatives.default([]),
  scope_paths: ScopePaths.default([]),
  due_date: DateOnly.optional(),
  owner_user_id: Uuid.optional(),
  owner_email: z.email().max(320).optional(),
  via: z.enum(["cli", "console"]),
});
export type RecordEntryRequest = z.infer<typeof RecordEntryRequest>;

export const KeyResponse = z.object({ key: z.string() });

export const ShareRequest = z.strictObject({ keys: z.array(EntryKey).min(1).max(100) });
export const ShareResponse = z.object({ shared: z.array(z.string()) });

const Edits = z.strictObject({
  statement: Statement.optional(),
  rationale: Rationale.optional(),
  scope_paths: ScopePaths.optional(),
});
/** A revision the person saw (hard rule 3, D419): an action on any other current revision is refused. */
const SeenRevision = z.number().int().min(1).max(10_000);

export const ConfirmRequest = z.strictObject({
  edits: Edits.optional(),
  accept_checks: z.array(Uuid).max(20).optional(),
  via: z.enum(["cli", "console"]).optional(),
  /**
   * The revision the person saw (hard rule 3): when given, a confirm of any other current revision is refused with
   * `invalid_transition`, so nobody confirms wording they never read (L33 review, D419).
   */
  revision: SeenRevision.optional(),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;

export const ReasonRequest = z.strictObject({ reason: Reason });

export const SupersedeRequest = z.union([
  z.strictObject({ by_key: EntryKey, revision: SeenRevision.optional(), reason: Reason }),
  z.strictObject({
    statement: Statement,
    rationale: Rationale.optional(),
    alternatives_rejected: Alternatives.optional(),
    scope_paths: ScopePaths.optional(),
    reason: Reason,
  }),
]);
export type SupersedeRequest = z.infer<typeof SupersedeRequest>;
export const SupersedeResponse = z.object({ old: Entry, new: Entry });

export const ReviseRequest = z.strictObject({
  changes: z
    .strictObject({
      statement: Statement.optional(),
      rationale: Rationale.nullable().optional(),
      alternatives_rejected: Alternatives.optional(),
      scope_paths: ScopePaths.optional(),
      due_date: DateOnly.nullable().optional(),
      owner_user_id: Uuid.nullable().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, "at least one change"),
  reason: Reason,
});
export type ReviseRequest = z.infer<typeof ReviseRequest>;

export const AskRequest = z.strictObject({
  repo_id: Uuid,
  /** A question is stored as its first revision's statement, so the revision's limit (280) holds. */
  text: Statement,
  owner_user_id: Uuid.optional(),
  owner_email: z.email().max(320).optional(),
  owner_hint: z.string().min(1).max(200).optional(),
  /** `agent`: `align ask` run by a coding agent (L43, F9, D514); stored as an agent's question (`origin = 'mcp'`). */
  via: z.enum(["person", "agent"]).optional(),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const AnswerRequest = z.strictObject({ statement: Statement, rationale: Rationale.optional() });
export const AnswerResponse = z.object({ question_key: z.string(), decision_key: z.string() });

export const QuestionView = z.object({
  key: z.string(),
  status: EntryStatus,
  text: z.string(),
  owner: PersonRef.nullable(),
  owner_hint: z.string().nullable(),
  private: z.boolean(),
  created_at: Timestamp,
  answered_by_key: z.string().nullable(),
});
export type QuestionView = z.infer<typeof QuestionView>;

export const ResolveConflictRequest = z.union([
  z.strictObject({ resolution: z.literal("dismissed"), note: Reason }),
  z.strictObject({
    resolution: z.literal("superseded"),
    note: Reason,
    superseded_by: EntryKey,
    /** The revision of `superseded_by` the person saw (D419). */
    revision: SeenRevision.optional(),
  }),
]);
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequest>;

export const AcceptCheckRequest = z.strictObject({ spec: z.record(z.string(), z.unknown()).optional() });

// ---------------------------------------------------------------------------------------------------------------
// Sessions (author only) and local check results.

export const SessionSummary = z.object({
  id: Id,
  repo_id: Id,
  harness: z.string(),
  source: z.enum(["live", "backfill"]),
  started_at: Timestamp,
  ended_at: Timestamp.nullable(),
  lines: z.number().int().min(0),
  proposed: z.number().int().min(0),
  cited: z.number().int().min(0),
});
export type SessionSummary = z.infer<typeof SessionSummary>;
export const SessionsPage = Page(SessionSummary);

export const SessionDetail = SessionSummary.extend({
  branch: z.string().nullable(),
  compile_state: z.string(),
  entries: z.array(EntrySummary),
});

export const SessionLinesQuery = z.object({
  from: z.coerce.number().int().min(1).max(2_000_000_000).default(1),
  to: z.coerce.number().int().min(1).max(2_000_000_000).optional(),
});
export const SessionLines = z.object({
  lines: z.array(
    z.object({ n: z.number().int(), role: z.enum(["user", "assistant", "tool", "system"]), text: z.string() }),
  ),
});
export const MAX_SESSION_LINES = 500;

/** `GET /sessions/:id/notice?since=` (L23b; the Stop hook's in-session notice; the CLI keeps docs/19's budget). */
export const SessionNoticeQuery = z.object({ since: Timestamp.optional() });
export const MAX_NOTICE_PROPOSALS = 20;
export const SessionNotice = z.object({
  new_proposals: z
    .array(z.object({ key: z.string(), kind: z.enum(["decision", "commitment", "question"]), statement: z.string() }))
    .max(MAX_NOTICE_PROPOSALS),
  open_conflicts_on_branch: z.number().int().min(0),
});
export type SessionNotice = z.infer<typeof SessionNotice>;

export const DeleteSessionResponse = z.object({
  deleted: z.literal(true),
  withdrawn: z.number().int().min(0),
  scrubbed: z.number().int().min(0),
  kept_confirmed: z.number().int().min(0),
});

const PageQuery = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
};
export const ListChecksQuery = z.object({ repo_id: Uuid, status: z.string().max(100).optional(), ...PageQuery });
export const ListQuestionsQuery = z.object({ repo_id: Uuid, status: z.string().max(100).optional(), ...PageQuery });
export const ListConflictsQuery = z.object({ repo_id: Uuid, status: z.string().max(200).optional(), ...PageQuery });

const Match = z.strictObject({
  path: RepoPath,
  line: z.number().int().min(0).max(10_000_000),
  rule: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
});
export const CheckResultsRequest = z.strictObject({
  repo_id: Uuid,
  context: z.literal("local"),
  sha: Sha,
  results: z
    .array(
      z.strictObject({
        check_id: Uuid,
        result: CheckResult,
        matches: z.array(Match).max(100).default([]),
        duration_ms: z.number().int().min(0).max(600_000).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type CheckResultsRequest = z.infer<typeof CheckResultsRequest>;
export const CheckResultsResponse = z.object({
  conflicts_opened: z.number().int().min(0),
  conflicts_resolved: z.number().int().min(0),
});

export const ExportQuery = z.object({
  repo_id: Uuid,
  include_private: z.enum(["true", "false"]).optional(),
  /** `agent`: read by an agent; another person's agent's open questions are left out (L43, D514). */
  for: z.enum(["person", "agent"]).optional(),
});
