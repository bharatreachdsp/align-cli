/**
 * The open export (docs/11 §Export, `schemas/export.schema.json`, format version 1): `buildExport` assembles the JSON
 * from rows the server already filtered for the requester (entries they can see, live evidence they may read), and
 * applies the leave-out rules once more on its own (tombstoned receipts, scrubbed entries), so a caller's mistake
 * cannot put either into a file. `renderMarkdown` renders it in two layouts: `single` (one `DECISIONS.md`) and `adr`
 * (one file per entry with front matter). Both include receipts as quotes with their locators. Isomorphic: the CLI
 * (`align export`) and the console use the same code. Words are docs/19 §Export's.
 */
import { EXPORT_COPY as C } from "./copy";

export const EXPORT_FORMAT_VERSION = 1;
/** What `tombstone_session` leaves in a scrubbed revision and a tombstoned receipt (docs/11). */
export const DELETED_PLACEHOLDER = "‹deleted with its session›";

export type ExportPerson = { display_name: string; github_login: string | null } | null;

export type ExportRevision = {
  revision: number;
  statement: string;
  rationale: string | null;
  alternatives_rejected: string[];
  scope_paths: string[];
  due_date: string | null;
  reason: string | null;
  created_at: string;
};

export type ExportEvidence = {
  kind: "transcript" | "commit" | "source_text" | "event" | "confirmation";
  locator: string;
  quote: string;
  url: string | null;
  added_in_revision: number;
  created_at: string;
};

export type ExportCheck = {
  kind: string;
  spec: Record<string, unknown>;
  status: "proposed" | "active" | "disabled";
  last_result: "pass" | "fail" | "error" | "skipped" | null;
  last_run_at: string | null;
};

export type ExportConflict = {
  origin: "pr" | "default_branch" | "local";
  pr_number: number | null;
  status: "open" | "resolved_superseded" | "resolved_changed" | "dismissed";
  summary: string;
  created_at: string;
  resolved_at: string | null;
};

export type ExportEntry = {
  key: string;
  kind: "decision" | "commitment";
  status: "proposed" | "confirmed" | "rejected" | "superseded" | "withdrawn";
  verification: "unverified" | "verified" | "drifted" | "not_checkable";
  created_at: string;
  confirmed_at: string | null;
  confirmed_by: ExportPerson;
  owner: ExportPerson;
  superseded_by: string | null;
  revisions: ExportRevision[];
  evidence: ExportEvidence[];
  links: { relation: "supersedes" | "refines" | "duplicates" | "conflicts_with" | "answers"; to_key: string }[];
  checks: ExportCheck[];
  conflicts: ExportConflict[];
  /** Present (true) only for the requester's own author-only proposals, exported on request (D145). */
  private?: boolean;
};

export type ExportQuestion = {
  key: string;
  status: "open" | "answered" | "dismissed" | "withdrawn";
  text: string;
  owner: ExportPerson;
  created_at: string;
  answered_by_key: string | null;
  private?: boolean;
};

export type LedgerExport = {
  format_version: 1;
  exported_at: string;
  org: { name: string; prefix: string };
  repo: { remote: string; default_branch: string | null };
  entries: ExportEntry[];
  questions: ExportQuestion[];
};

/** A receipt as the server read it; `tombstoned` ones are dropped here whatever the caller did. */
export type ExportEvidenceInput = ExportEvidence & { tombstoned?: boolean };
export type ExportEntryInput = Omit<ExportEntry, "evidence"> & { evidence: ExportEvidenceInput[] };
export type ExportQuestionInput = ExportQuestion & { scrubbed?: boolean };

export type ExportInput = {
  exportedAt: Date | string;
  org: { name: string; prefix: string };
  repo: { remote: string; default_branch: string | null };
  entries: ExportEntryInput[];
  questions: ExportQuestionInput[];
};

const iso = (d: Date | string) => (typeof d === "string" ? new Date(d) : d).toISOString();

/** An entry every revision of which was scrubbed by a session's deletion (docs/11 §Export: left out). */
export function isScrubbed(entry: { revisions: { statement: string }[] }): boolean {
  return entry.revisions.length === 0 || entry.revisions.every((r) => r.statement === DELETED_PLACEHOLDER);
}

const byKey = (a: { key: string }, b: { key: string }) => {
  const [pa, na] = a.key.split("-");
  const [pb, nb] = b.key.split("-");
  return pa === pb ? Number(na) - Number(nb) : (pa as string) < (pb as string) ? -1 : 1;
};

export function buildExport(input: ExportInput): LedgerExport {
  const entries = input.entries
    .filter((e) => !isScrubbed(e))
    .map(
      (e): ExportEntry => ({
        ...e,
        revisions: [...e.revisions].sort((a, b) => a.revision - b.revision),
        evidence: e.evidence
          .filter((x) => !x.tombstoned && x.quote !== DELETED_PLACEHOLDER)
          .map(({ tombstoned: _t, ...x }) => x),
      }),
    )
    .sort(byKey);
  const questions = input.questions
    .filter((q) => !q.scrubbed && q.text !== DELETED_PLACEHOLDER)
    .map(({ scrubbed: _s, ...q }) => q)
    .sort(byKey);
  return {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: iso(input.exportedAt),
    org: { name: input.org.name, prefix: input.org.prefix },
    repo: { remote: input.repo.remote, default_branch: input.repo.default_branch },
    entries,
    questions,
  };
}

export type MarkdownFile = { path: string; content: string };

/** One line of Markdown text: no raw newlines (a statement never starts a heading or a list by accident). */
const inline = (s: string) => s.replace(/\s+/g, " ").trim();
const quoteBlock = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
const day = (s: string | null) => (s ? s.slice(0, 10) : null);
const who = (p: ExportPerson) =>
  p ? (p.github_login ? `${p.display_name} (@${p.github_login})` : p.display_name) : null;
const current = (e: ExportEntry) => e.revisions.at(-1) as ExportRevision;

function entryBody(e: ExportEntry, level: number): string {
  const r = current(e);
  const h = "#".repeat(level);
  const out: string[] = [];
  const facts = [
    `${C.status}: ${e.status}`,
    `${C.kind}: ${e.kind}`,
    `${C.verification}: ${e.verification}`,
    e.confirmed_at
      ? `${C.confirmed}: ${day(e.confirmed_at)}${who(e.confirmed_by) ? ` · ${who(e.confirmed_by)}` : ""}`
      : null,
    who(e.owner) ? `${C.owner}: ${who(e.owner)}` : null,
    r.due_date ? `${C.due}: ${r.due_date}` : null,
    e.superseded_by ? `${C.supersededBy}: ${e.superseded_by}` : null,
  ].filter(Boolean);
  out.push(facts.join(" · "));
  if (r.scope_paths.length) out.push(`${C.scope}: ${r.scope_paths.map((p) => `\`${inline(p)}\``).join(", ")}`);
  if (r.rationale) out.push(`${h}# ${C.why}\n\n${r.rationale.trim()}`);
  if (r.alternatives_rejected.length) {
    out.push(`${h}# ${C.alternatives}\n\n${r.alternatives_rejected.map((a) => `- ${inline(a)}`).join("\n")}`);
  }
  if (e.evidence.length) {
    out.push(
      `${h}# ${C.receipts}\n\n${e.evidence
        .map((x) => `${quoteBlock(x.quote)}\n\n— \`${x.locator}\` (${x.kind}${x.url ? `, ${x.url}` : ""})`)
        .join("\n\n")}`,
    );
  }
  if (e.links.length) out.push(`${h}# ${C.links}\n\n${e.links.map((l) => `- ${l.relation} ${l.to_key}`).join("\n")}`);
  if (e.checks.length) {
    out.push(
      `${h}# ${C.checks}\n\n${e.checks
        .map(
          (c) =>
            `- ${c.kind} (${c.status})${c.last_result ? `: ${c.last_result} ${day(c.last_run_at) ?? ""}`.trimEnd() : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (e.conflicts.length) {
    out.push(
      `${h}# ${C.conflicts}\n\n${e.conflicts.map((c) => `- ${c.origin}${c.pr_number ? ` #${c.pr_number}` : ""}: ${c.status} · ${inline(c.summary)}`).join("\n")}`,
    );
  }
  if (e.revisions.length > 1) {
    out.push(
      `${h}# ${C.history}\n\n${e.revisions
        .map(
          (v) =>
            `- ${C.revision} ${v.revision} (${day(v.created_at)}${v.reason ? `, ${inline(v.reason)}` : ""}): ${inline(v.statement)}`,
        )
        .join("\n")}`,
    );
  }
  return out.join("\n\n");
}

function questionLine(q: ExportQuestion): string {
  const owner = who(q.owner);
  return `- ${q.key} (${q.status}${owner ? `, ${owner}` : ""}${q.answered_by_key ? `, ${C.answeredBy} ${q.answered_by_key}` : ""}): ${inline(q.text)}`;
}

/** YAML front matter values: always double-quoted JSON strings, so a statement can never break the block. */
const yaml = (v: string | null) => (v === null ? "null" : JSON.stringify(v));

export function renderMarkdown(data: LedgerExport, layout: "single" | "adr"): MarkdownFile[] {
  const header = `${C.exportedFrom(data.org.name, data.repo.remote)} · ${day(data.exported_at)}`;
  if (layout === "single") {
    const parts = [`# ${C.title(data.repo.remote)}`, header];
    if (data.entries.length === 0) parts.push(C.empty);
    for (const e of data.entries) parts.push(`## ${e.key} · ${inline(current(e).statement)}\n\n${entryBody(e, 2)}`);
    if (data.questions.length) parts.push(`## ${C.questions}\n\n${data.questions.map(questionLine).join("\n")}`);
    return [{ path: "DECISIONS.md", content: `${parts.join("\n\n")}\n` }];
  }
  const files = data.entries.map((e) => {
    const r = current(e);
    const front = [
      "---",
      `key: ${yaml(e.key)}`,
      `kind: ${yaml(e.kind)}`,
      `status: ${yaml(e.status)}`,
      `verification: ${yaml(e.verification)}`,
      `created_at: ${yaml(e.created_at)}`,
      `confirmed_at: ${yaml(e.confirmed_at)}`,
      `superseded_by: ${yaml(e.superseded_by)}`,
      `scope_paths: [${r.scope_paths.map((p) => yaml(p)).join(", ")}]`,
      "---",
    ].join("\n");
    return {
      path: `decisions/${e.key}.md`,
      content: `${front}\n\n# ${e.key} · ${inline(r.statement)}\n\n${entryBody(e, 1)}\n`,
    };
  });
  const index = [`# ${C.title(data.repo.remote)}`, header];
  index.push(
    data.entries.length
      ? data.entries.map((e) => `- [${e.key}](${e.key}.md) · ${e.status} · ${inline(current(e).statement)}`).join("\n")
      : C.empty,
  );
  if (data.questions.length) index.push(`## ${C.questions}\n\n${data.questions.map(questionLine).join("\n")}`);
  files.push({ path: "decisions/README.md", content: `${index.join("\n\n")}\n` });
  return files;
}
