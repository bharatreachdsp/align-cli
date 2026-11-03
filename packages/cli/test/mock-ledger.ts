/**
 * The ledger routes (docs/25 §Ledger, as on PR #45) for the CLI's L17 tests: proposals in an inbox, entry detail,
 * confirm, reject, supersede, share, record, ask. Requests are checked against #45's strict shapes (unknown keys,
 * lengths, `via`), and every mutation must carry an `Idempotency-Key`. Synthetic data only.
 */
import type { IncomingHttpHeaders } from "node:http";
import type { Entry } from "../src/ledger/api";

export type MockLedger = {
  entries: Map<string, Entry>;
  calls: { method: string; path: string; body: unknown; idempotency: string | null }[];
  /** My sessions (`GET /sessions`, `GET`/`DELETE /sessions/:id`). */
  sessions: Map<string, Record<string, unknown>>;
  /** The `GET /export` answer, and the query of the last export request. */
  exportBody: unknown;
  exportQuery: string;
  /** Sessions per page of `GET /sessions` (follow `next_cursor`). */
  pageSize: number;
  /** Answer the next request to a path with this error code. */
  failNext: Map<string, { status: number; code: string }>;
  /** Called with every request as it arrives (before it is answered). */
  onCall?: (c: { method: string; path: string }) => void;
  handle(
    method: string,
    path: string,
    q: URLSearchParams,
    body: unknown,
    h: IncomingHttpHeaders,
  ): { status: number; body: unknown } | null;
};

export function mockEntry(over: Partial<Entry> = {}): Entry {
  return {
    key: "P-7",
    kind: "decision",
    status: "proposed",
    statement: "Use Postgres advisory locks for cart checkout, not Redis.",
    scope_paths: ["lib/cart/"],
    verification: "unverified",
    private: true,
    confirmed_by: null,
    confirmed_at: null,
    owner: null,
    due_date: null,
    open_conflicts: 0,
    rationale: "Redis would add an ops dependency we do not run in production.",
    alternatives_rejected: ["Redis SETNX lock", "a distributed-lock library"],
    owner_hint: null,
    origin: "compile",
    created_at: "2026-09-12T10:00:00.000Z",
    superseded_by: null,
    revision: 1,
    revisions: [],
    evidence: [
      {
        kind: "transcript",
        locator: "transcript lines 212–219",
        quote: "let's not pull in redis for this, advisory locks are enough and we already have postgres",
        url: null,
        added_in_revision: 1,
        created_at: "2026-09-12T10:00:00.000Z",
      },
    ],
    links: [],
    checks: [],
    conflicts: [],
    events: [],
    ...over,
  };
}

const err = (status: number, code: string) => ({ status, body: { error: { code, message: code, details: {} } } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const statementOk = (v: unknown) => typeof v === "string" && v.length >= 12 && v.length <= 280;
const reasonOk = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 500;
const summary = (e: Entry) => {
  const { key, kind, status, statement, scope_paths, verification, open_conflicts } = e;
  return { key, kind, status, statement, scope_paths, verification, private: e.private, open_conflicts };
};

export function mockLedger(entries: Entry[] = []): MockLedger {
  const m: MockLedger = {
    entries: new Map(entries.map((e) => [e.key, e])),
    calls: [],
    sessions: new Map(),
    exportBody: null,
    exportQuery: "",
    pageSize: 100,
    failNext: new Map(),
    handle(method, path, q, body, h) {
      if (!/^\/(inbox|entries|questions|sessions|export)/.test(path) || /\/notice$/.test(path)) return null;
      const idem = typeof h["idempotency-key"] === "string" ? h["idempotency-key"] : null;
      m.calls.push({ method, path, body, idempotency: idem });
      m.onCall?.({ method, path });
      const fail = m.failNext.get(path);
      if (fail) {
        m.failNext.delete(path);
        return err(fail.status, fail.code);
      }
      if ((method === "POST" || method === "DELETE") && !idem) return err(400, "invalid_request");
      if (method === "GET" && path === "/sessions") {
        if (!q.get("repo_id")) return err(400, "invalid_request");
        const all = [...m.sessions.values()];
        const from = Number(q.get("cursor") ?? "0");
        const items = all.slice(from, from + m.pageSize);
        const next = from + m.pageSize < all.length ? String(from + m.pageSize) : null;
        return { status: 200, body: { items, next_cursor: next } };
      }
      const sess = /^\/sessions\/([^/]+)$/.exec(path);
      if (sess) {
        const s = m.sessions.get(decodeURIComponent(sess[1] ?? ""));
        if (!s) return err(404, "entry_not_found");
        if (method === "GET")
          return { status: 200, body: { ...s, branch: "main", compile_state: "done", entries: [] } };
        if (method === "DELETE") {
          m.sessions.delete(String(s.id));
          return { status: 200, body: { deleted: true, withdrawn: 2, scrubbed: 1, kept_confirmed: 1 } };
        }
      }
      if (method === "GET" && path === "/export") {
        if (!q.get("repo_id")) return err(400, "invalid_request");
        m.exportQuery = q.toString();
        return { status: 200, body: m.exportBody };
      }
      if (method === "GET" && path === "/inbox") {
        if (!q.get("repo_id")) return err(400, "invalid_request");
        const items = [...m.entries.values()].filter((e) => e.status === "proposed").map(summary);
        return { status: 200, body: { items, next_cursor: null } };
      }
      const one = /^\/entries\/([^/]+)(?:\/(confirm|reject|supersede))?$/.exec(path);
      if (one && one[1] !== "share") {
        const entry = m.entries.get(decodeURIComponent(one[1] ?? ""));
        if (!entry) return err(404, "entry_not_found");
        if (method === "GET" && !one[2]) return { status: 200, body: entry };
        if (method !== "POST" || !isObj(body)) return err(400, "invalid_request");
        if (one[2] === "confirm") {
          if (!only(body, ["edits", "accept_checks", "via"]) || body.via !== "cli") return err(400, "invalid_request");
          if (entry.status !== "proposed") return err(409, "invalid_transition");
          const edits = body.edits as Record<string, unknown> | undefined;
          if (
            edits !== undefined &&
            (!isObj(edits) || !only(edits, ["statement", "rationale", "scope_paths"]) || !statementOk(edits.statement))
          )
            return err(400, "invalid_request");
          const accepted = (body.accept_checks as string[] | undefined) ?? [];
          entry.status = "confirmed";
          if (edits?.statement) entry.statement = edits.statement as string;
          for (const c of entry.checks) if (accepted.includes(c.id)) c.status = "active";
          return { status: 200, body: entry };
        }
        if (one[2] === "reject") {
          if (!only(body, ["reason"]) || !reasonOk(body.reason)) return err(400, "invalid_request");
          if (entry.status !== "proposed") return err(409, "invalid_transition");
          entry.status = "rejected";
          return { status: 200, body: entry };
        }
        if (one[2] === "supersede") {
          if (!only(body, ["by_key", "reason"]) || !reasonOk(body.reason)) return err(400, "invalid_request");
          const by = m.entries.get(String(body.by_key));
          if (!by) return err(404, "entry_not_found");
          entry.status = "superseded";
          by.status = "confirmed";
          return { status: 200, body: { old: entry, new: by } };
        }
      }
      if (method === "POST" && path === "/entries/share") {
        if (!isObj(body) || !only(body, ["keys"]) || !Array.isArray(body.keys)) return err(400, "invalid_request");
        for (const k of body.keys) {
          const e = m.entries.get(String(k));
          if (!e) return err(404, "entry_not_found");
          e.private = false;
        }
        return { status: 200, body: { shared: body.keys } };
      }
      if (method === "POST" && path === "/entries") {
        const allowed = [
          "repo_id",
          "kind",
          "statement",
          "rationale",
          "alternatives_rejected",
          "scope_paths",
          "due_date",
          "owner_user_id",
          "owner_email",
          "via",
        ];
        if (!isObj(body) || !only(body, allowed) || body.via !== "cli" || !statementOk(body.statement))
          return err(400, "invalid_request");
        const key = `AL-${m.entries.size + 1}`;
        m.entries.set(
          key,
          mockEntry({
            key,
            kind: String(body.kind),
            status: "confirmed",
            statement: String(body.statement),
            origin: "cli",
          }),
        );
        return { status: 201, body: { key } };
      }
      if (method === "POST" && path === "/questions") {
        if (
          !isObj(body) ||
          !only(body, ["repo_id", "text", "owner_user_id", "owner_email", "owner_hint", "via"]) ||
          (body.via !== undefined && body.via !== "person" && body.via !== "agent") ||
          !statementOk(body.text)
        )
          return err(400, "invalid_request");
        return { status: 201, body: { key: "Q-1" } };
      }
      return null;
    },
  };
  return m;
}
