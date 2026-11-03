/**
 * Example values for every schema in `@align/core/api`, so lanes build against the contract before the
 * real routes merge (docs/25). Synthetic only (AGENTS.md rule 12): ids, names and domains are invented.
 * Each factory takes overrides; `mocks.test.ts` proves every default parses.
 */
import { CLI_BIN, CLI_PACKAGE, PRODUCT_NAME } from "../brand";
import type { ClientResponse } from "./client";
import type { DeviceCodeResponse, DeviceTokenResponse, MeResponse } from "./device";
import type { PackResponse } from "./pack";
import type { Repo, RepoState } from "./repos";
import type { SessionNoticeResponse } from "./sessions";

export const MOCK_ORG = {
  id: "0192f0a0-0000-7000-8000-000000000001",
  slug: "acme",
  name: "Acme Example",
  prefix: "AL",
} as const;

export const MOCK_USER = { id: "0192f0a0-0000-7000-8000-000000000002", display_name: "Riya Example" } as const;

export function mockDeviceCode(base: string, over: Partial<DeviceCodeResponse> = {}): DeviceCodeResponse {
  const user_code = over.user_code ?? "WDJB-MJHT";
  return {
    device_code: "dc_mock_0123456789abcdef",
    user_code,
    verification_uri: `${base}/device`,
    verification_uri_complete: `${base}/device#code=${user_code}`,
    interval: 1,
    expires_in: 600,
    ...over,
  };
}

/** A token-shaped string assembled at run time, never a literal (AGENTS.md rule 12). */
export function mockToken(n = 1): string {
  return ["aln", "mock", `${"s".repeat(16)}${n}`].join("_");
}

export function mockDeviceToken(over: Partial<DeviceTokenResponse> = {}): DeviceTokenResponse {
  return {
    access_token: mockToken(),
    expires_at: "2027-01-01T00:00:00.000Z",
    org: { ...MOCK_ORG },
    user: { ...MOCK_USER },
    ...over,
  };
}

export function mockMe(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user: { ...MOCK_USER },
    org: { ...MOCK_ORG, email_domains: ["acme.example"] },
    token: {
      id: "0192f0a0-0000-7000-8000-000000000003",
      prefix: "mock",
      expires_at: "2027-01-01T00:00:00.000Z",
      scopes: ["cli"],
    },
    terms: { accepted_version: "2026-10", current_version: "2026-10" },
    ...over,
  };
}

export function mockRepo(over: Partial<Repo> = {}): Repo {
  return {
    id: "0192f0a0-0000-7000-8000-000000000010",
    remote_norm: "github.com/acme/checkout",
    verified: false,
    default_branch: "main",
    project_id: null,
    ...over,
  };
}

export function mockRepoState(over: Partial<RepoState> = {}): RepoState {
  return {
    opted_in: true,
    plan: "free",
    limits: { backfill_days: 30 },
    email_domains: ["acme.example"],
    client: { latest: "0.0.0", min_supported: "0.0.0" },
    counts: { proposed_for_me: 0, open_conflicts: 0 },
    pilot_terms: null,
    ...over,
  };
}

export function mockClient(over: Partial<ClientResponse> = {}): ClientResponse {
  return { latest: "0.0.0", min_supported: "0.0.0", package: CLI_PACKAGE, ...over };
}

export function mockSessionNotice(over: Partial<SessionNoticeResponse> = {}): SessionNoticeResponse {
  return {
    new_proposals: [{ key: "P-7", kind: "decision", statement: "Use Postgres advisory locks for the cart." }],
    open_conflicts_on_branch: 0,
    ...over,
  };
}

/** A small pack (docs/19 §The pack) for the CLI's delivery tests (L16) before the route is reachable. */
export function mockPack(over: Partial<PackResponse> = {}): PackResponse {
  const markdown = [
    "<!-- align-pack v1 -->",
    "## Team decisions for github.com/acme/checkout (lib/money) · verified 2 hours ago",
    "Follow these unless the user explicitly decides otherwise. If a request conflicts with one, say so and ask",
    `before proceeding. Cite ids (e.g. AL-12) when relevant. More: the ${CLI_BIN} MCP tools.`,
    "",
    "- AL-12 · decision · Money is stored as integer cents. Why: no float rounding.",
    "",
    "To record a new team decision the user states, call record_decision.",
    "",
  ].join("\n");
  return {
    markdown,
    items: [{ key: "AL-12", kind: "decision", status: "confirmed", reason: "scope" }],
    tokens_estimate: Math.ceil(markdown.length / 3.5),
    generated_at: "2026-10-22T12:00:00.000Z",
    ttl_seconds: 600,
    notice_line: `${PRODUCT_NAME} · 1 decision applies here; your agent has them. /${CLI_BIN} to read.`,
    ...over,
  };
}
