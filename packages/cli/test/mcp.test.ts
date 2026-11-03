/**
 * `align mcp` in-process (L18): an MCP client from the SDK talks to the server over a pipe (two streams), with the
 * tools API stood in by a fetch that records every request. Covers listing the tools, calling each one, the error
 * paths, redaction of a planted secret, `repo_path` never leaving, only `/api/v1/tools/*` requests, and no retries.
 * The built bundle through the real shim is `mcp-bundle.test.ts`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TOOL_NAMES, TOOLS, type ToolResult } from "@align/core/tools";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpDeps, mcpCommand } from "../src/mcp/server";
import { alignPaths } from "../src/paths";
import { setOptedIn, upsertRepo } from "../src/registry";
import { gitIn, type Sandbox, sandbox } from "./helpers";
import { testCredentials } from "./pack-fixture";

const SERVER = "http://127.0.0.1:9";
type Req = { url: string; auth: string | null; idem: string | null; body: Record<string, unknown> };

let sb: Sandbox;
let reqs: Req[];
let answer: (name: string, body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;
let client: Client | null;
let closeServer: (() => void) | null;

const ok = (r: ToolResult) =>
  new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, headers: Record<string, string> = {}, details = {}) =>
  new Response(JSON.stringify({ error: { code, message: "server text that must not reach the agent", details } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The fake secret, assembled at run time (AGENTS.md rule 12). */
const SECRET = ["ghp", "Qk7xR2mN9pL4vB8sT1wZ6yH3jD5fG0aC2eK9"].join("_");

beforeEach(() => {
  sb = sandbox();
  const paths = alignPaths(sb.alignHome);
  upsertRepo(paths, sb.repo, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses: ["claude-code"],
    installed_at: new Date().toISOString(),
  });
  writeFileSync(paths.credentials, testCredentials(SERVER), { mode: 0o600 });
  reqs = [];
  answer = (name) => ok({ content: [{ type: "text", text: `answer from ${name}` }], structured: { tool: name } });
  client = null;
  closeServer = null;
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  closeServer?.();
  sb.cleanup();
});

async function connect(cwd: string, args: string[] = [], extra: Partial<McpDeps> = {}): Promise<Client> {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    reqs.push({ url, auth, idem: headers.get("idempotency-key"), body });
    return answer(url.split("/").at(-1) ?? "", body, init);
  };
  void mcpCommand(args, {
    paths: alignPaths(sb.alignHome),
    cwd,
    out: () => {},
    err: () => {},
    fetch,
    keychain: null,
    stdin: toServer,
    stdout: fromServer,
    ...extra,
  });
  closeServer = () => toServer.end();
  // The SDK's stream transport works both ways: here it carries the client's side of the pipe.
  const c = new Client({ name: "test-harness", version: "1.0.0" });
  await c.connect(new StdioServerTransport(fromServer, toServer));
  client = c;
  return c;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;

describe("align mcp over a pipe", () => {
  it("lists the seven tools straight from TOOLS: title, description, schema, annotations", async () => {
    const c = await connect(sb.repo);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      const def = TOOLS[t.name as keyof typeof TOOLS];
      expect(t.title).toBe(def.title);
      expect(t.description).toBe(def.description);
      expect(t.annotations).toMatchObject(def.annotations);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeUndefined();
    }
    const ctx = tools.find((t) => t.name === "get_context");
    expect(Object.keys(ctx?.inputSchema.properties ?? {}).sort()).toEqual(["branch", "paths", "repo", "repo_path"]);
  });

  it("calls each tool through POST /api/v1/tools/:name with the repository the laptop resolved", async () => {
    const c = await connect(sb.repo);
    const args: Record<string, Record<string, unknown>> = {
      get_context: { paths: ["lib/money.ts"] },
      get_decision: { key: "AL-12" },
      search_decisions: { query: "feature flags" },
      list_open_questions: {},
      get_contract: {},
      record_decision: { statement: "Money is stored as integer cents everywhere." },
      ask_owner: { question: "Who owns the cart lock timeout now?" },
    };
    for (const name of TOOL_NAMES) {
      const r = await c.callTool({ name, arguments: args[name] });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toBe(`answer from ${name}`);
      expect(r.structuredContent).toEqual({ tool: name });
    }
    expect(reqs.map((r) => r.url)).toEqual(TOOL_NAMES.map((n) => `${SERVER}/api/v1/tools/${n}`));
    const root = gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD");
    for (const r of reqs) {
      expect(r.auth).toBe(`Bearer ${["aln", "test", "0123456789abcdef"].join("_")}`);
      expect(r.body.repo).toEqual({ remote_norm: "github.com/acme/checkout", root_commit: root });
      expect(r.body.branch).toBe("main");
    }
    expect(reqs[0]?.body.args).toEqual({ paths: ["lib/money.ts"] });
  });

  it("a planted secret in record_decision arrives redacted; nothing else in the body changed", async () => {
    const c = await connect(sb.repo);
    await c.callTool({
      name: "record_decision",
      arguments: {
        statement: `Deploy with the token ${SECRET} from now on.`,
        alternatives_rejected: [`keep ${SECRET} in the repo`],
      },
    });
    const sent = JSON.stringify(reqs[0]?.body);
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain("Deploy with the token");
    expect(
      (reqs[0]?.body.args as { alternatives_rejected?: string[] } | undefined)?.alternatives_rejected,
    ).toHaveLength(1);
  });

  it("repo_path finds the repository from elsewhere and is never forwarded; body.repo is set", async () => {
    const c = await connect(sb.dir);
    const r = await c.callTool({ name: "get_context", arguments: { repo_path: sb.repo, repo: "evil/other" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(reqs[0]?.body)).not.toContain(sb.repo);
    expect(reqs[0]?.body.args).toEqual({ repo: "evil/other" });
    expect(reqs[0]?.body.repo).toMatchObject({ remote_norm: "github.com/acme/checkout" });
  });

  it("--cwd names the repository when the server starts elsewhere (Cursor's workspaceFolder variable)", async () => {
    const c = await connect(sb.dir, ["--cwd", sb.repo]);
    await c.callTool({ name: "search_decisions", arguments: { query: "cents" } });
    expect(reqs[0]?.body.repo).toMatchObject({ remote_norm: "github.com/acme/checkout" });
  });

  it("no repository found and no repo argument: isError asking for repo_path, nothing sent", async () => {
    writeFileSync(alignPaths(sb.alignHome).credentials, "{}\n", { mode: 0o600 });
    const c = await connect(sb.dir);
    const r = await c.callTool({ name: "get_context", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("repo_path");
    expect(reqs).toEqual([]);
  });

  it("only the model's repo, not registered here, one organisation signed in: the server resolves the name", async () => {
    const c = await connect(sb.dir);
    await c.callTool({ name: "search_decisions", arguments: { query: "cents", repo: "acme/billing" } });
    expect(reqs[0]?.body.repo).toBeUndefined();
    expect(reqs[0]?.body.args).toMatchObject({ repo: "acme/billing" });
  });

  it("the model's repo names a registered repository (any spelling): the request carries the registry's identity", async () => {
    const c = await connect(sb.dir);
    const root = gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD");
    for (const repo of ["acme/checkout", "GitHub.com/Acme/Checkout", "github.com/acme/checkout.git"]) {
      await c.callTool({ name: "search_decisions", arguments: { query: "cents", repo } });
    }
    for (const r of reqs) expect(r.body.repo).toEqual({ remote_norm: "github.com/acme/checkout", root_commit: root });
    expect(reqs).toHaveLength(3);
  });

  it("an ambiguous name with an opted-out match: nothing is sent", async () => {
    const paths = alignPaths(sb.alignHome);
    upsertRepo(paths, `${sb.dir}/other-clone`, {
      repo_id: "repo_2",
      org_id: "org_1",
      remote_norm: "github.com/acme/checkout",
      root_commit: "0".repeat(40),
      default_branch: "main",
      opted_in: false,
      harnesses: [],
      installed_at: new Date().toISOString(),
    });
    const c = await connect(sb.dir);
    const r = await c.callTool({ name: "search_decisions", arguments: { query: "cents", repo: "acme/checkout" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("repo_path");
    expect(reqs).toEqual([]);
  });

  it("a 200 is_error with repositories to choose from stays an isError result with its structure", async () => {
    answer = () =>
      ok({
        content: [{ type: "text", text: "Which repository? github.com/acme/checkout, github.com/acme/api" }],
        structured: { repositories: ["github.com/acme/checkout", "github.com/acme/api"] },
        is_error: true,
      });
    const c = await connect(sb.repo);
    const r = await c.callTool({ name: "get_decision", arguments: { key: "AL-3" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ repositories: ["github.com/acme/checkout", "github.com/acme/api"] });
  });

  it("HTTP errors become isError with a fixed message, never the server's text", async () => {
    const cases: [Response, string][] = [
      [err(429, "rate_limited", { "retry-after": "17" }), "try again in 17 s"],
      [err(429, "rate_limited", { "retry-after": "86400" }), "try again in 24 hours"],
      [err(504, "timeout"), "did not answer in time"],
      [err(403, "not_opted_in"), "has not opted in"],
      [err(404, "entry_not_found"), "No entry with that key"],
      [err(401, "unauthorized"), "align login"],
      [err(403, "forbidden"), "may not read this repository"],
      [err(500, "internal"), "had a problem"],
      [err(400, "invalid_request", {}, { first_field_id: "args.key", first_field_kind: "invalid_format" }), "args.key"],
    ];
    const c = await connect(sb.repo);
    for (const [res, want] of cases) {
      answer = () => res;
      const r = await c.callTool({ name: "get_decision", arguments: { key: "AL-12" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(want);
      expect(text(r)).not.toContain("server text");
    }
  });

  it("the server unreachable: isError; a write is never retried", async () => {
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const c = await connect(sb.repo);
    const r = await c.callTool({
      name: "record_decision",
      arguments: { statement: "Money is stored as integer cents everywhere." },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("could not be reached");
    answer = () => err(504, "timeout");
    await c.callTool({ name: "ask_owner", arguments: { question: "Who owns the cart lock timeout now?" } });
    expect(reqs.map((x) => x.url.split("/").at(-1))).toEqual(["record_decision", "ask_owner"]);
  });

  it("writes carry their own Idempotency-Key; reads none; a duplicate answer keeps its structure", async () => {
    answer = (name) =>
      ok({
        content: [{ type: "text", text: `answer from ${name}` }],
        structured: { key: "AL-7", duplicate: true },
      });
    const c = await connect(sb.repo);
    const r = await c.callTool({
      name: "record_decision",
      arguments: { statement: "Money is stored as integer cents everywhere." },
    });
    await c.callTool({
      name: "record_decision",
      arguments: { statement: "Money is stored as integer cents everywhere." },
    });
    await c.callTool({ name: "ask_owner", arguments: { question: "Who owns the cart lock timeout now?" } });
    await c.callTool({ name: "get_decision", arguments: { key: "AL-7" } });
    expect(r.structuredContent).toEqual({ key: "AL-7", duplicate: true });
    const keys = reqs.map((x) => x.idem);
    for (const k of keys.slice(0, 3)) expect(k).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(keys[3]).toBeNull();
  });

  it("arguments the tool's strict schema refuses never reach the server", async () => {
    const c = await connect(sb.repo);
    const r = await c.callTool({ name: "get_decision", arguments: { key: "AL-12", status: "confirmed" } });
    expect(r.isError).toBe(true);
    expect(reqs).toEqual([]);
  });

  it("an unknown tool is refused by the SDK and nothing is sent", async () => {
    const c = await connect(sb.repo);
    const r = await c.callTool({ name: "confirm_entry", arguments: { key: "AL-12" } }).catch((e: Error) => e);
    expect(r instanceof Error ? true : (r as { isError?: boolean }).isError).toBe(true);
    expect(reqs).toEqual([]);
  });

  describe("round 2", () => {
    it("a repository opted out here (align off) gets nothing sent, from its directory or by name", async () => {
      setOptedIn(alignPaths(sb.alignHome), sb.repo, false);
      const c = await connect(sb.repo);
      const r = await c.callTool({ name: "get_context", arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("has not opted in");
      await client?.close();
      closeServer?.();
      const outside = await connect(sb.dir);
      const named = await outside.callTool({
        name: "search_decisions",
        arguments: { query: "x", repo: "acme/checkout" },
      });
      expect(named.isError).toBe(true);
      expect(text(named)).toContain("has not opted in");
      expect(reqs).toEqual([]);
    });

    it("the writes go only to the repository the agent runs in, never one the model names", async () => {
      const c = await connect(sb.dir);
      for (const [name, args] of [
        ["record_decision", { statement: "Money is stored as integer cents everywhere.", repo: "acme/checkout" }],
        ["ask_owner", { question: "Who owns the cart lock timeout now?", repo: "acme/checkout" }],
      ] as const) {
        const r = await c.callTool({ name, arguments: args });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain("only for the repository this agent runs in");
      }
      // A read may still name it.
      const read = await c.callTool({ name: "get_context", arguments: { repo_path: sb.repo } });
      expect(read.isError).toBeFalsy();
      expect(reqs.map((x) => x.url.split("/").at(-1))).toEqual(["get_context"]);
    });

    it("the model's paths and scope_paths pass the deny globs and the path shape before they leave", async () => {
      writeFileSync(join(sb.repo, ".aligndeny"), "secrets/**\n");
      const c = await connect(sb.repo);
      const bad = ["lib/money.ts", "secrets/prod.key", "lib/a\u0007b.ts", "SECRETS/Other.key", "lib/money.ts"];
      await c.callTool({ name: "get_context", arguments: { paths: bad } });
      await c.callTool({ name: "list_open_questions", arguments: { paths: bad } });
      await c.callTool({
        name: "record_decision",
        arguments: { statement: "Money is stored as integer cents everywhere.", scope_paths: bad },
      });
      expect(reqs[0]?.body.args).toHaveProperty("paths");
      expect((reqs[0]?.body.args as { paths: string[] } | undefined)?.paths).toEqual(["lib/money.ts"]);
      expect(reqs[1]?.body.args).toHaveProperty("paths");
      expect((reqs[1]?.body.args as { paths: string[] } | undefined)?.paths).toEqual(["lib/money.ts"]);
      expect((reqs[2]?.body.args as { scope_paths: string[] } | undefined)?.scope_paths).toEqual(["lib/money.ts"]);
    });

    it("control characters are stripped from structuredContent too", async () => {
      const esc = String.fromCharCode(27);
      answer = () =>
        ok({
          content: [{ type: "text", text: `a${esc}[31mb` }],
          structured: { note: `x${esc}[2Jy`, list: [`p\u202eq`], nested: { k: `z${esc}]0;t` } },
        });
      const c = await connect(sb.repo);
      const r = await c.callTool({ name: "get_decision", arguments: { key: "AL-12" } });
      expect(text(r)).toBe("a[31mb");
      expect(JSON.stringify(r.structuredContent)).not.toContain(esc);
      expect(JSON.stringify(r.structuredContent)).not.toContain("\u202e");
    });

    it("the laptop's own deadline: a server that never answers is an isError timeout", async () => {
      answer = (_n, _b, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
          );
        });
      const c = await connect(sb.repo, [], { timeoutMs: 400 });
      const t0 = Date.now();
      const r = await c.callTool({ name: "get_decision", arguments: { key: "AL-12" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("did not answer in time");
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(reqs).toHaveLength(1);
    });

    it("a redaction that does not settle sends nothing", async () => {
      const c = await connect(sb.repo, [], { redact: (t) => ({ text: t, hits: { unsettled: 1 } }) });
      const r = await c.callTool({ name: "search_decisions", arguments: { query: "anything" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("could not be redacted safely");
      expect(reqs).toEqual([]);
    });
  });
});
