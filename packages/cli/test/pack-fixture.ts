/**
 * A small synthetic pack in the shape of `PackResponse` on PR #48 (`@align/core/api/pack.ts`, `mockPack`), for the
 * delivery tests until the route merges. Synthetic data only.
 */
import type { Pack } from "../src/pack/check";

export function testPack(over: Partial<Pack> = {}): Pack {
  const markdown = [
    "<!-- align-pack v1 -->",
    "## Team decisions for github.com/acme/checkout (lib/money) · verified 2 hours ago",
    "Follow these unless the user explicitly decides otherwise. If a request conflicts with one, say so and ask",
    "before proceeding. Cite ids (e.g. AL-12) when relevant. More: the align MCP tools.",
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
    notice_line: "ALIGN · 1 decision applies here; your agent has them. /align to read.",
    ...over,
  };
}

/** A credentials file holding a file-stored token for `org_1` on `server` (the token is built at run time). */
export function testCredentials(server: string): string {
  const token = ["aln", "test", "0123456789abcdef"].join("_");
  return `${JSON.stringify({
    version: 1,
    orgs: {
      org_1: {
        org: { id: "org_1", slug: "acme", name: "Acme", prefix: "AL" },
        user: { id: "user_1", display_name: "Test" },
        expires_at: "2027-01-01T00:00:00.000Z",
        server,
        store: "file",
        token,
      },
    },
  })}\n`;
}
