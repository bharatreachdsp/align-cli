/**
 * The server side of local checks (docs/25 §Backfill and local checks; D406, D423): `GET /checks` and `POST
 * /check-results` (context `local`). Which checks run: every **active** check, and a **proposed** check only when its
 * entry is the person's own private proposal (`GET /entries?status=proposed`, `private: true`). Another person's
 * unreviewed check is never run on this laptop (D423 (d)). The request carries exactly the contracted keys,
 * `{repo_id, context, sha, results: [{check_id, result, matches: [{path, line, rule}], duration_ms}]}`, built field by
 * field here, so nothing else can ride along. At most 200 results a request; more go in further requests.
 */
import { z } from "zod";
import type { ApiClient } from "../api";
import { CheckView, EntriesPage } from "../ledger/api";
import type { LocalCheck, LocalResult } from "./fs-local";

const ChecksPage = z.object({ items: z.array(CheckView), next_cursor: z.string().nullable() });
const CheckResultsResponse = z.object({
  conflicts_opened: z.number().int().min(0),
  conflicts_resolved: z.number().int().min(0),
});
export const RESULTS_PER_REQUEST = 200;
const MAX_PAGES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function pages<T>(
  api: ApiClient,
  path: (cursor: string | null) => string,
  schema: z.ZodType<{ items: T[]; next_cursor: string | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data }: { data: { items: T[]; next_cursor: string | null } } = await api.request(
      "GET",
      path(cursor),
      schema,
    );
    out.push(...data.items);
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return out;
}

const q = (repoId: string, extra: string, cursor: string | null) =>
  `repo_id=${encodeURIComponent(repoId)}&${extra}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/** The keys of the person's own private proposals in this repository (their unreviewed checks may run here). */
async function ownProposals(api: ApiClient, repoId: string): Promise<Set<string>> {
  const items = await pages(api, (c) => `/entries?${q(repoId, "status=proposed", c)}`, EntriesPage);
  return new Set(items.filter((e) => e.private).map((e) => e.key));
}

/** The checks that may run here: active ones, and proposed ones of the person's own private proposals. */
export async function fetchChecks(api: ApiClient, repoId: string): Promise<LocalCheck[]> {
  const checks = await pages(api, (c) => `/checks?${q(repoId, "status=active,proposed", c)}`, ChecksPage);
  const proposed = checks.some((c) => c.status === "proposed") ? await ownProposals(api, repoId) : new Set<string>();
  return checks
    .filter((c) => c.status === "active" || (c.status === "proposed" && proposed.has(c.entry_key)))
    .map((c) => ({ check_id: c.id, entry_key: c.entry_key, kind: c.kind, spec: c.spec }));
}

/** The request bodies for `results`, exactly the contracted keys, in pages of 200. */
export function resultBodies(repoId: string, sha: string, results: readonly LocalResult[]): unknown[] {
  const rows = results
    .filter((r) => UUID.test(r.check_id))
    .map((r) => ({
      check_id: r.check_id,
      result: r.result,
      matches: r.matches.map((m) => ({ path: m.path, line: m.line, rule: m.rule })),
      duration_ms: r.duration_ms,
    }));
  const bodies: unknown[] = [];
  for (let i = 0; i < rows.length; i += RESULTS_PER_REQUEST)
    bodies.push({ repo_id: repoId, context: "local", sha, results: rows.slice(i, i + RESULTS_PER_REQUEST) });
  return bodies;
}

/** Reporting stopped part-way: `sent` of `total` results reached the server before `cause`. */
export class ReportError extends Error {
  override readonly name = "ReportError";
  constructor(
    readonly sent: number,
    readonly total: number,
    override readonly cause: unknown,
  ) {
    super("report incomplete");
  }
}

export type Reported = { conflicts_opened: number; conflicts_resolved: number };

/** Sends the results; the conflicts opened and resolved, summed over the requests. Throws `ReportError` part-way. */
export async function postResults(
  api: ApiClient,
  repoId: string,
  sha: string,
  results: readonly LocalResult[],
): Promise<Reported> {
  const total = { conflicts_opened: 0, conflicts_resolved: 0 };
  const bodies = resultBodies(repoId, sha, results) as { results: unknown[] }[];
  const count = bodies.reduce((n, b) => n + b.results.length, 0);
  let sent = 0;
  for (const body of bodies) {
    try {
      const { data } = await api.request("POST", "/check-results", CheckResultsResponse, body);
      total.conflicts_opened += data.conflicts_opened;
      total.conflicts_resolved += data.conflicts_resolved;
      sent += body.results.length;
    } catch (e) {
      throw new ReportError(sent, count, e);
    }
  }
  return total;
}

/** Decisions the current code contradicts: distinct entry keys with a failing check. */
export const contradicted = (results: readonly LocalResult[]) =>
  new Set(results.filter((r) => r.result === "fail").map((r) => r.entry_key)).size;
