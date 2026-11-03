/**
 * A local stand-in for the `/api/v1` routes the CLI foundation uses (docs/25 §Device login, §Repositories,
 * §Client), built from the shared schemas in `@align/core/api` until L20's real routes merge. Requests are
 * validated with the same schemas, so a CLI that drifts from the contract fails here. Synthetic data only.
 * Listens on 127.0.0.1 with an ephemeral port; never reachable from outside the machine.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import {
  BackfillRequest,
  type BackfillStatus,
  CheckResultsRequest,
  DeviceCodeRequest,
  DeviceTokenRequest,
  EventsRequest,
  type EventsResponse,
  MOCK_ORG,
  MOCK_USER,
  mockBackfillStatus,
  mockClient,
  mockDeviceCode,
  mockMe,
  mockRepo,
  mockRepoState,
  OptinRequest,
  type Repo,
  RepoIdentity,
} from "@align/core/api";
import { CLIENT_HEADER, UPGRADE_HEADER } from "@align/core/brand";

export type MockOptions = {
  /** Polls answered `authorization_pending` before the code is approved. */
  pendingPolls?: number;
  /** Answer the first poll with `slow_down`. */
  slowDownOnce?: boolean;
  /** How the device flow ends. */
  deviceOutcome?: "approve" | "deny" | "expire";
  /** Repositories that already exist: remote_norm → owner ("mine" or another organisation's name). */
  repos?: Record<
    string,
    {
      owner: "mine" | string;
      opted_in?: boolean;
      auto_join_url?: string;
      /** The stored root commit (the clone proof); absent → none stored. */
      root_commit?: string;
      /** Whether the person already holds a live `repo_access` row (default: true when opted in). */
      access?: boolean;
    }
  >;
  /** The person's role in the organisation (L20, PR #30): owners and admins get access without clone proof. */
  role?: "owner" | "admin" | "member";
  plan?: "free" | "beta" | "team" | "business";
  /** `GET /repos/:id/state` limits (default `{backfill_days: 30}`, as `mockRepoState`). */
  limits?: Record<string, number | null>;
  /** Answer every response with `X-Align-Upgrade: required`. */
  upgradeRequired?: boolean;
  latest?: string;
  /** Skew the Date header by this many milliseconds. */
  clockSkewMs?: number;
  /** Send a verification URI on another origin. */
  foreignVerification?: boolean;
  /**
   * D517: how the console confirmation of a pending opt-in goes: confirmed after this many polls (default 0, the first
   * poll), or never (`expire`: the poll answers expired).
   */
  optin?: { confirmAfterPolls?: number; outcome?: "confirm" | "expire" };
  /** The ledger routes (L17): inbox, entries, confirm, reject, supersede, share, record, ask. */
  ledger?: import("./mock-ledger").MockLedger;
};

/**
 * The capture side (`POST /events`, `GET /sessions/:id/notice`), mutable while the server runs so a test can take the
 * network away, refuse a token or answer a code for chosen events. Stores events by `event_id` (a replay is a
 * duplicate) and transcript lines by session and `n`, as ingest does (docs/10 §Ingest).
 */
export type CaptureControl = {
  /** Every request to /events or /sessions is dropped (connection destroyed): "offline". */
  down: boolean;
  /** Answer /events with this status for the whole batch (401, 413, 429, 500, …), `times` times. */
  batchStatus: {
    status: number;
    code: string;
    times: number;
    retryAfterS?: number;
    details?: Record<string, unknown>;
  } | null;
  /** Called on each /events request before it is answered (tests change local state mid-pass here). */
  onEvents: (() => void) | null;
  /** Per-event code for events matching the predicate. */
  rejectWhen: ((e: Record<string, unknown>) => string | null) | null;
  /** Notices to answer per session id; absent → 404. */
  notices: Map<string, unknown>;
  /** The answer to `POST /pack` (L16; the route is L24's, PR #48); null → 404 `repo_not_connected`. */
  pack: unknown | null;
  /** Wait this long before answering `/pack` (the timeout path). */
  packDelayMs: number;
  /** Answer `/pack` with this error status (401, 403, 404, 503, …) instead. */
  packStatus: number | null;
  /**
   * `POST /backfill` and `GET /backfill/:id` (L23b's routes, mocked for L15): `enabled: false` answers 404 with no
   * JSON body, as a server without the route does; `polls` are answered in order (then `done`); `posts` records the
   * requests (validated with `BackfillRequest`; every session id must have been stored by `/events`).
   */
  backfill: { enabled: boolean; polls: Partial<BackfillStatus>[]; posts: BackfillRequest[]; failPolls?: boolean };
  /**
   * `GET /checks` (paged by `limit`, the cursor is the next index) and `POST /check-results` (validated with the strict
   * `CheckResultsRequest`; every raw body is kept in `results` for payload-shape assertions). L22's routes, mocked.
   */
  checks: {
    items: Record<string, unknown>[];
    results: unknown[];
    status: number | null;
    resultsDown?: boolean;
    /** `GET /entries?status=proposed` without a mock ledger: the proposals and whether each is the caller's private one. */
    proposals?: { key: string; private: boolean }[];
    /** Answer `/check-results` with this error, after `after` successful requests, `times` times. */
    fail?: { status: number; code: string; after: number; times: number };
  };
};

/** `PackRequest` as on PR #48 (strict: these keys only; ≤ 200 repository-relative paths of ≤ 1,024 characters). */
function packRequestOk(b: unknown): boolean {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  const allowed = new Set(["repo_id", "branch", "head", "paths", "session_id", "harness"]);
  if (!Object.keys(o).every((k) => allowed.has(k))) return false;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && v.length <= max;
  if (!str(o.repo_id, 100) || !str(o.branch, 255) || !str(o.head, 255)) return false;
  if (o.session_id !== undefined && !/^[0-9a-f-]{36}$/.test(String(o.session_id))) return false;
  if (o.harness !== undefined && !str(o.harness, 64)) return false;
  return (
    Array.isArray(o.paths) &&
    o.paths.length <= 200 &&
    o.paths.every(
      (p) =>
        str(p, 1024) &&
        !(p as string).startsWith("/") &&
        !(p as string).includes("\\") &&
        !(p as string).split("/").includes(".."),
    )
  );
}

export type CaptureStore = {
  events: Map<string, Record<string, unknown>>;
  /** session id → line numbers stored */
  lines: Map<string, number[]>;
  /** harness:harness_session_id → the session id first stored for it */
  sessions: Map<string, string>;
  batches: number;
  duplicates: number;
  /** batch sizes in arrival order */
  sizes: number[];
};

export type RecordedRequest = {
  method: string;
  path: string;
  client: string | null;
  /** An Authorization header was sent at all (whatever its value). */
  bearer: boolean;
  /** It carried a token this server issued. */
  authorized: boolean;
  body: unknown;
};

export type MockServer = {
  url: string;
  requests: RecordedRequest[];
  /** Tokens issued and not revoked (kept server-side only; tests compare against output). */
  tokens: Set<string>;
  repos: Map<
    string,
    Repo & {
      owner: string;
      opted_in: boolean;
      /** D517: whether the person has ever opted in here (a `PUT` may only return them). */
      ever_opted_in: boolean;
      pilot_accepted: boolean;
      root_commit: string | null;
      access: string | null;
    }
  >;
  /** D517: the pending opt-ins the CLI asked for, with how they were asked. */
  optinRequests: { id: string; repo_id: string; via: string; polls: number; confirmed: boolean }[];
  capture: CaptureControl;
  store: CaptureStore;
  close(): Promise<void>;
};

const PILOT = { version: "2026-10", path: "/legal/pilot-terms" };

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const tokens = new Set<string>();
  const repos: MockServer["repos"] = new Map();
  const requests: RecordedRequest[] = [];
  const codes = new Map<string, { polls: number; slowed: boolean }>();
  const optinRequests: MockServer["optinRequests"] = [];
  let n = 0;
  for (const [remote_norm, r] of Object.entries(opts.repos ?? {})) {
    n++;
    repos.set(remote_norm, {
      ...mockRepo({ id: `0192f0a0-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`, remote_norm }),
      owner: r.owner,
      opted_in: r.opted_in ?? false,
      ever_opted_in: r.opted_in ?? false,
      pilot_accepted: false,
      root_commit: r.root_commit ?? null,
      access: (r.access ?? r.opted_in ?? false) ? "clone" : null,
    });
  }
  let base = "";

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.upgradeRequired) headers[UPGRADE_HEADER] = "required";
    headers.date = new Date(Date.now() + (opts.clockSkewMs ?? 0)).toUTCString();
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string) =>
    send(res, status, { error: { code, message: code, details: {} } });

  const capture: CaptureControl = {
    down: false,
    batchStatus: null,
    rejectWhen: null,
    notices: new Map(),
    pack: null,
    packDelayMs: 0,
    packStatus: null,
    onEvents: null,
    backfill: { enabled: true, polls: [], posts: [] },
    checks: { items: [], results: [], status: null },
  };
  const store: CaptureStore = {
    events: new Map(),
    lines: new Map(),
    sessions: new Map(),
    batches: 0,
    duplicates: 0,
    sizes: [],
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      let raw = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
  };

  const ingest = (events: unknown[]): EventsResponse => {
    const out: EventsResponse = { accepted: 0, duplicates: 0, rejected: [] };
    for (const [index, raw] of events.entries()) {
      const e = raw as Record<string, unknown> & {
        event_id: string;
        kind: string;
        session: { id: string | null };
        harness: { name?: string; session_id?: string | null };
        payload: { lines?: { n: number }[] };
      };
      const code = capture.rejectWhen?.(e) ?? null;
      if (code) {
        out.rejected.push({ event_id: e.event_id, index, code: code as never });
        continue;
      }
      if (store.events.has(e.event_id)) {
        out.duplicates++;
        store.duplicates++;
        continue;
      }
      const hkey = `${e.harness.name}:${e.harness.session_id}`;
      const sid = e.session?.id;
      if (e.harness.session_id && sid) {
        const known = store.sessions.get(hkey);
        if (known && known !== sid) {
          out.rejected.push({ event_id: e.event_id, index, code: "session_conflict", session_id: known });
          continue;
        }
        store.sessions.set(hkey, sid);
      }
      store.events.set(e.event_id, e);
      if (e.kind === "transcript.chunk" && sid) {
        const have = store.lines.get(sid) ?? [];
        for (const l of e.payload.lines ?? []) if (!have.includes(l.n)) have.push(l.n);
        store.lines.set(
          sid,
          have.sort((a, b) => a - b),
        );
      }
      out.accepted++;
    }
    return out;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const authorized = token !== null && tokens.has(token);
    const body = await readBody(req);
    requests.push({
      method: req.method ?? "",
      path,
      client: (req.headers[CLIENT_HEADER.toLowerCase()] as string) ?? null,
      bearer: req.headers.authorization !== undefined,
      authorized,
      body,
    });
    if (!url.pathname.startsWith("/api/v1/")) return error(res, 404, "invalid_request");
    const key = `${req.method} ${path}`;
    if (capture.down && (path === "/events" || path === "/pack" || path.startsWith("/sessions/"))) {
      req.socket.destroy();
      return;
    }

    // Unauthenticated routes
    if (key === "GET /client") return send(res, 200, mockClient({ latest: opts.latest ?? "0.0.0" }));
    if (key === "POST /device/code") {
      if (!DeviceCodeRequest.safeParse(body).success) return error(res, 400, "invalid_request");
      const code = mockDeviceCode(opts.foreignVerification ? "https://evil.example" : base, {
        device_code: `dc_${randomBytes(12).toString("hex")}`,
      });
      codes.set(code.device_code, { polls: 0, slowed: false });
      return send(res, 200, code);
    }
    if (key === "POST /device/token") {
      const parsed = DeviceTokenRequest.safeParse(body);
      const state = parsed.success ? codes.get(parsed.data.device_code) : undefined;
      if (!parsed.success || !state) return error(res, 400, "invalid_request");
      state.polls++;
      if (opts.slowDownOnce && !state.slowed) {
        state.slowed = true;
        return error(res, 400, "slow_down");
      }
      if (state.polls <= (opts.pendingPolls ?? 1)) return error(res, 400, "authorization_pending");
      if (opts.deviceOutcome === "deny") return error(res, 400, "access_denied");
      if (opts.deviceOutcome === "expire") return error(res, 400, "expired_token");
      codes.delete(parsed.data.device_code);
      const access_token = ["aln", "mock", randomBytes(16).toString("hex")].join("_");
      tokens.add(access_token);
      return send(res, 200, { access_token, expires_at: "2027-01-01T00:00:00.000Z", org: MOCK_ORG, user: MOCK_USER });
    }

    if (!authorized) return error(res, 401, "unauthorized");

    if (key === "POST /events") {
      capture.onEvents?.();
      const b = capture.batchStatus;
      if (b && b.times > 0) {
        b.times--;
        if (b.retryAfterS !== undefined) res.setHeader("retry-after", String(b.retryAfterS));
        return send(res, b.status, { error: { code: b.code, message: b.code, details: b.details ?? {} } });
      }
      const parsed = EventsRequest.safeParse(body);
      if (!parsed.success) return error(res, 400, "invalid_request");
      store.batches++;
      store.sizes.push(parsed.data.events.length);
      return send(res, 200, ingest(parsed.data.events));
    }
    const notice = /^\/sessions\/([^/]+)\/notice$/.exec(path);
    if (notice && req.method === "GET") {
      const n = capture.notices.get(decodeURIComponent(notice[1] ?? ""));
      return n === undefined ? error(res, 404, "entry_not_found") : send(res, 200, n);
    }
    if (opts.ledger) {
      const r = opts.ledger.handle(req.method ?? "", path, url.searchParams, body, req.headers);
      if (r) return send(res, r.status, r.body);
    }
    if (key === "POST /pack") {
      if (!packRequestOk(body)) return error(res, 400, "invalid_request");
      if (capture.packDelayMs > 0) await new Promise((r) => setTimeout(r, capture.packDelayMs));
      if (res.destroyed) return;
      if (capture.packStatus !== null)
        return error(
          res,
          capture.packStatus,
          capture.packStatus >= 500
            ? "internal"
            : capture.packStatus === 404
              ? "repo_not_connected"
              : capture.packStatus === 403
                ? "forbidden"
                : "unauthorized",
        );
      return capture.pack === null ? error(res, 404, "repo_not_connected") : send(res, 200, capture.pack);
    }
    if (key === "GET /checks") {
      if (capture.checks.status !== null) return error(res, capture.checks.status, "internal");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const items = capture.checks.items.slice(from, from + limit);
      const next = from + limit < capture.checks.items.length ? String(from + limit) : null;
      return send(res, 200, { items, next_cursor: next });
    }
    if (key === "GET /entries" && !opts.ledger && capture.checks.proposals) {
      const items = capture.checks.proposals.map((p) => ({
        key: p.key,
        kind: "decision",
        status: "proposed",
        statement: "A synthetic proposal for the tests.",
        scope_paths: [],
        verification: "unverified",
        private: p.private,
        open_conflicts: 0,
      }));
      return send(res, 200, { items, next_cursor: null });
    }
    if (key === "POST /check-results") {
      if (capture.checks.resultsDown) {
        req.socket.destroy();
        return;
      }
      const f = capture.checks.fail;
      if (f && f.times > 0) {
        if (f.after > 0) f.after--;
        else {
          f.times--;
          return error(res, f.status, f.code);
        }
      }
      capture.checks.results.push(body);
      const parsed = CheckResultsRequest.safeParse(body);
      if (!parsed.success) return error(res, 400, "invalid_request");
      const fails = parsed.data.results.filter((r) => r.result === "fail").length;
      return send(res, 200, { conflicts_opened: fails, conflicts_resolved: 0 });
    }
    if (key === "POST /backfill") {
      if (!capture.backfill.enabled) {
        res.writeHead(404, { "content-type": "text/html" });
        return res.end("<!doctype html><title>404</title>");
      }
      const parsed = BackfillRequest.safeParse(body);
      if (!parsed.success) return error(res, 400, "invalid_request");
      const stored = new Set(store.sessions.values());
      if (!parsed.data.session_ids.every((id) => stored.has(id))) return error(res, 400, "invalid_request");
      capture.backfill.posts.push(parsed.data);
      return send(res, 200, { backfill_id: `bf_${capture.backfill.posts.length}` });
    }
    if (/^\/backfill\/[^/]+$/.test(path) && req.method === "GET") {
      if (capture.backfill.failPolls) return error(res, 500, "internal");
      const total = capture.backfill.posts.at(-1)?.session_ids.length ?? 0;
      const next = capture.backfill.polls.shift() ?? {};
      return send(
        res,
        200,
        mockBackfillStatus({ sessions_total: total, sessions_compiled: total, proposals: 3, contradicted: 1, ...next }),
      );
    }
    if (key === "GET /me") return send(res, 200, mockMe());
    if (key === "POST /auth/logout") {
      if (token) tokens.delete(token);
      return send(res, 200, { revoked: true });
    }
    if (key === "POST /repos/resolve" || key === "POST /repos/claim") {
      const id = RepoIdentity.safeParse(body);
      if (!id.success) return error(res, 400, "invalid_request");
      const existing = repos.get(id.data.remote_norm);
      if (key === "POST /repos/resolve") {
        if (!existing) return send(res, 200, { status: "unclaimed" });
        if (existing.owner !== "mine") {
          const r = opts.repos?.[id.data.remote_norm];
          return send(res, 200, {
            status: "other_org",
            org_name: existing.owner,
            ...(r?.auto_join_url ? { auto_join_url: r.auto_join_url } : {}),
          });
        }
        const { owner: _o, opted_in, pilot_accepted: _p, root_commit: _r, access: row, ...repo } = existing;
        // L20 (PR #30): `owner`/`admin` from the person's role, else the live repo_access row's source, else null.
        const role = opts.role ?? "owner";
        const access = role === "owner" || role === "admin" ? role : row;
        return send(res, 200, { status: "connected", repo, access, opted_in });
      }
      if (existing && existing.owner !== "mine") return error(res, 409, "repo_other_org");
      if (existing) {
        // Claim on the organisation's own repository proves a clone: the root commit must match the stored one
        // (`forbidden` otherwise). The CLI claims only when resolve said `access: null`.
        if (existing.root_commit !== null && existing.root_commit === id.data.root_commit) existing.access = "clone";
        else return error(res, 403, "forbidden");
        const { owner: _o, opted_in: _i, pilot_accepted: _p, root_commit: _r, access: _a, ...repo } = existing;
        return send(res, 200, { repo });
      }
      n++;
      const repo = mockRepo({
        id: `0192f0a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
        remote_norm: id.data.remote_norm,
        default_branch: id.data.default_branch,
      });
      repos.set(id.data.remote_norm, {
        ...repo,
        owner: "mine",
        opted_in: false,
        ever_opted_in: false,
        pilot_accepted: false,
        root_commit: id.data.root_commit,
        access: "clone",
      });
      return send(res, 200, { repo });
    }
    // D517: pending opt-ins confirmed in the console (here: after `optin.confirmAfterPolls` polls).
    const rq = /^\/repos\/([^/]+)\/optin\/requests(?:\/([^/]+))?$/.exec(path);
    if (rq) {
      const r = [...repos.values()].find((x) => x.id === decodeURIComponent(rq[1] ?? ""));
      if (r?.owner !== "mine") return error(res, 404, "repo_not_connected");
      if (req.method === "POST" && !rq[2]) {
        const via = (body as { via?: string } | undefined)?.via;
        if (via !== "person" && via !== "agent") return error(res, 400, "invalid_request");
        const id = `0192f0a0-0000-4000-8000-${String(optinRequests.length + 1).padStart(12, "0")}`;
        optinRequests.push({ id, repo_id: r.id, via, polls: 0, confirmed: false });
        return send(res, 201, {
          id,
          url: `${base}/optin/${id}`,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          interval: 1,
        });
      }
      const q = optinRequests.find((x) => x.id === decodeURIComponent(rq[2] ?? "") && x.repo_id === r.id);
      if (req.method === "GET" && q) {
        q.polls++;
        if (opts.optin?.outcome === "expire") return send(res, 200, { status: "expired" });
        if (!q.confirmed && q.polls > (opts.optin?.confirmAfterPolls ?? 0)) {
          q.confirmed = true;
          r.opted_in = true;
          r.ever_opted_in = true;
          if (opts.plan === "beta") r.pilot_accepted = true;
        }
        return send(res, 200, { status: q.confirmed ? "confirmed" : "pending" });
      }
      return error(res, 404, "invalid_request");
    }
    const m = /^\/repos\/([^/]+)\/(optin|state)$/.exec(path);
    const repo = m ? [...repos.values()].find((r) => r.id === decodeURIComponent(m[1] ?? "")) : undefined;
    if (m && repo?.owner !== "mine") return error(res, 404, "repo_not_connected");
    if (repo && key === `PUT /repos/${repo.id}/optin`) {
      const parsed = OptinRequest.safeParse(body);
      if (!parsed.success) return error(res, 400, "invalid_request");
      // Opting in needs existing repository access (the role, or a row) and never grants it.
      if (repo.access === null && (opts.role ?? "owner") === "member") return error(res, 403, "forbidden");
      // D517 (amended): on only re-affirms a live opt-in; anything else is the console.
      if (
        parsed.data.opted_in &&
        (parsed.data.via === "agent" ||
          parsed.data.accept_pilot_terms_version !== undefined ||
          !repo.opted_in ||
          (opts.plan === "beta" && !repo.pilot_accepted))
      ) {
        return error(res, 403, "confirmation_required");
      }
      repo.opted_in = parsed.data.opted_in;
      return send(res, 200, { opted_in: repo.opted_in, at: new Date().toISOString() });
    }
    if (repo && key === `GET /repos/${repo.id}/state`) {
      return send(
        res,
        200,
        mockRepoState({
          opted_in: repo.opted_in,
          plan: opts.plan ?? "free",
          ...(opts.limits ? { limits: opts.limits } : {}),
          pilot_terms:
            opts.plan === "beta"
              ? { version: PILOT.version, url: `${base}${PILOT.path}`, accepted: repo.pilot_accepted }
              : null,
          confirm_in_console: !repo.opted_in || (opts.plan === "beta" && !repo.pilot_accepted),
        }),
      );
    }
    return error(res, 404, "invalid_request");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    requests,
    tokens,
    repos,
    optinRequests,
    capture,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
