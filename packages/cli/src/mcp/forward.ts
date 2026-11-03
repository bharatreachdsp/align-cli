/**
 * One MCP tool call forwarded to `POST /api/v1/tools/:name` (docs/14 §Agent tools, docs/25 §Agent tools; L18).
 *
 * - Only that route is ever called, and only for a name in `TOOLS`. The token is the organisation's CLI token from the
 *   credential record, sent only to the server that issued it. It never reaches another route from here, so no
 *   confirm or reject route can be reached through this process (hard rule 3).
 * - Every string argument, nested ones included, passes the laptop's text redaction (`redactText`: secrets,
 *   credential assignments, identities) before it leaves (docs/17 rule 2; hard rule 5). A string whose redaction
 *   does not settle stops the call: nothing is sent.
 * - `repo_path` is used here to find the repository and is never forwarded (an absolute local path names the
 *   person's home). `body.repo` (what the laptop resolved) takes precedence over the model's `repo` on the server.
 * - A repository the person opted out of on this laptop gets nothing sent (hard rule 6). The two writes go only to the
 *   repository the agent runs in (the process's cwd or `--cwd`), never to one the model names (D420).
 * - Paths the model gives (`paths`, `scope_paths`) pass the same filter as the laptop's own hint: the deny globs
 *   (`.aligndeny`, the personal deny file, the defaults) and the server's path shape, before redaction.
 * - One 10 s deadline covers the whole call: the git calls of the paths hint and the request.
 * - The answer is `{content, structuredContent?, isError?}`. Failures are `isError` results with the fixed messages
 *   in `copy.mcp`, never the server's own text. Nothing is retried: `record_decision` and `ask_owner` write, and a
 *   retry could write twice.
 * - Logs: counts and codes only (`~/.align/logs`), never an argument or a result (hard rule 9).
 */
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { redactText, type TextContext } from "@align/core/redact";
import { forwardableArgs, TOOL_BUDGET_MS, type ToolName, ToolResult } from "@align/core/tools";
import { ApiClient, ApiError, type FetchLike } from "../api";
import { readConfig } from "../config";
import { stripControl } from "../control";
import { copy } from "../copy";
import type { Keychain } from "../credentials";
import { cwdRel, readDenyFile, redactionContext } from "../hook/events";
import { logCount } from "../hook/log";
import { isHintPath } from "../pack/check";
import { cleanHint, pathsHint } from "../pack/hint";
import type { Paths } from "../paths";
import { requestRepo, resolveTarget, type Target } from "./resolve";

/** One call's deadline on the laptop: 10 s; the server gives up at 9.5 s (`TOOL_SERVER_BUDGET_MS`), so its own
 * `timeout` answer arrives before this one. */
export const MCP_CALL_TIMEOUT_MS = TOOL_BUDGET_MS;
/** The paths hint's git calls get at most this much of the deadline. */
const HINT_MAX_MS = 2000;
/**
 * The two writes. This client never retries them. Each request carries a fresh Idempotency-Key, so if anything below
 * it (a proxy, the platform) replays the request, the server answers the first write instead of writing twice.
 */
const WRITES = new Set<ToolName>(["record_decision", "ask_owner"]);
/** The tools that take `paths`: the laptop adds its hint (working directory, changed files) when the model gave none. */
const HINTED = new Set<ToolName>(["get_context", "list_open_questions"]);

export type McpResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type ForwardDeps = {
  paths: Paths;
  /** The server process's own working directory, and `--cwd` when given. */
  cwd: string;
  cwdFlag?: string;
  fetch?: FetchLike;
  keychain?: Keychain | null;
  /** In-process tests only: a shorter deadline, and a redaction that does not settle. */
  timeoutMs?: number;
  redact?: (text: string, ctx: TextContext) => { text: string; hits: { unsettled?: number } };
};

/** The tool arguments that name repository paths. */
const PATH_ARGS: { readonly [N in ToolName]?: string } = {
  get_context: "paths",
  list_open_questions: "paths",
  record_decision: "scope_paths",
};

const fail = (text: string): McpResult => ({ content: [{ type: "text", text }], isError: true });

export class Unredactable extends Error {
  override readonly name = "Unredactable";
}

/** Every string inside `value` through `redact`; objects keep their keys (the schemas fix them), arrays their order. */
export function redactStrings(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v, redact)]));
  return value;
}

function textContext(paths: Paths, target: Target): TextContext {
  if (target.local) return redactionContext(paths, target.local);
  const domains = readConfig(paths).orgs[target.orgId]?.email_domains;
  const host = hostname();
  let user: string | null = null;
  try {
    user = userInfo().username;
  } catch {
    user = null;
  }
  return {
    orgDomains: domains && domains.length > 0 ? domains : null,
    hostnames: [...new Set([host, host.split(".")[0] ?? ""].filter((h) => h.length >= 2))],
    usernames: user && user.length >= 2 ? [user] : [],
  };
}

/** The message for a failed request: a fixed line per code, never the server's text. */
export function errorMessage(e: unknown): { text: string; code: string } {
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError") return { text: copy.mcp.timeout, code: "timeout" };
  if (name === "NetworkError") return { text: copy.mcp.offline, code: "offline" };
  if (e instanceof ApiError) {
    const code = /^[a-z_]{1,40}$/.test(e.code) ? e.code : "unknown";
    if (e.status === 401) return { text: copy.mcp.signedOut, code };
    if (code === "rate_limited")
      return { text: copy.mcp.rateLimited(e.retryAfterMs === null ? null : Math.ceil(e.retryAfterMs / 1000)), code };
    if (code === "timeout") return { text: copy.mcp.timeout, code };
    if (code === "not_opted_in") return { text: copy.mcp.notOptedIn, code };
    if (code === "entry_not_found") return { text: copy.mcp.entryNotFound, code };
    if (code === "invalid_request") {
      const d = e.details;
      const fields = [d.first_field_id, d.second_field_id, d.third_field_id].filter(
        (f): f is string => typeof f === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(f),
      );
      return { text: copy.mcp.invalid(fields), code };
    }
    if (e.status === 403) return { text: copy.mcp.forbidden, code };
    if (e.status >= 500) return { text: copy.mcp.serverError, code };
    return { text: copy.mcp.refused(code), code };
  }
  return { text: copy.mcp.serverError, code: "protocol" };
}

/** Every string inside `value` with control and invisible characters removed (keys too). */
function stripDeep(value: unknown): unknown {
  if (typeof value === "string") return stripControl(value);
  if (Array.isArray(value)) return value.map(stripDeep);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [stripControl(k), stripDeep(v)]));
  return value;
}

/** What the server answered, as MCP: control characters out (text and structure), `structured` as `structuredContent`. */
export function toMcp(r: ToolResult): McpResult {
  const content = r.content.map((c) => ({ type: "text" as const, text: stripControl(c.text) }));
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    ...(r.structured ? { structuredContent: stripDeep(r.structured) as Record<string, unknown> } : {}),
    ...(r.is_error ? { isError: true } : {}),
  };
}

export async function forwardCall(
  name: ToolName,
  rawArgs: Record<string, unknown>,
  deps: ForwardDeps,
): Promise<McpResult> {
  const deadline = Date.now() + (deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS);
  const write = WRITES.has(name);
  // `repo_path` (get_context) finds the repository here; `forwardableArgs` drops it, so it never leaves the laptop.
  const repo_path = name === "get_context" ? rawArgs.repo_path : undefined;
  const args = forwardableArgs(name, rawArgs);
  const target = await resolveTarget({
    paths: deps.paths,
    keychain: deps.keychain,
    // The writes only where the agent runs: a model steered by planted text cannot aim them at another repository.
    dirs: write
      ? [deps.cwd, deps.cwdFlag]
      : [deps.cwd, deps.cwdFlag, typeof repo_path === "string" ? repo_path : undefined],
    argRepo: !write && typeof args.repo === "string" ? args.repo : undefined,
  });
  if (target === "no_repo" || target === "unknown_repo")
    return logged(deps, name, target, fail(write ? copy.mcp.writeNeedsRepo : copy.mcp.noRepo));
  if (target === "opted_out") return logged(deps, name, "opted_out", fail(copy.mcp.notOptedIn));
  if (target === "signed_out") return logged(deps, name, "signed_out", fail(copy.mcp.signedOut));
  if (write && !target.local) return logged(deps, name, "no_repo", fail(copy.mcp.writeNeedsRepo));
  const ctx = textContext(deps.paths, target);
  const redactFn = deps.redact ?? redactText;
  const redact = (s: string) => {
    const r = redactFn(s, ctx);
    if (r.hits.unsettled) throw new Unredactable("unsettled");
    return r.text;
  };
  let body: Record<string, unknown>;
  try {
    const local = target.local;
    const deny = local
      ? [...readDenyFile(join(local.root, ".aligndeny")).globs, ...readDenyFile(deps.paths.deny(local.root)).globs]
      : [];
    const sent = { ...args };
    // The model's paths: deny globs and the path shape first (as the hint), then redaction, then the shape again.
    const pathArg = PATH_ARGS[name];
    if (pathArg && Array.isArray(sent[pathArg]))
      sent[pathArg] = cleanHint(
        (sent[pathArg] as unknown[]).filter((p): p is string => typeof p === "string"),
        deny,
      )
        .map(redact)
        .filter(isHintPath);
    let hint: string[] | undefined;
    if (local && HINTED.has(name) && args.paths === undefined) {
      const raw = await pathsHint({
        root: local.root,
        cwdRel: cwdRel(local.root, deps.cwdFlag ?? deps.cwd),
        defaultBranch: local.entry.default_branch,
        denyGlobs: deny,
        timeoutMs: Math.max(1, Math.min(HINT_MAX_MS, deadline - Date.now() - 1000)),
      });
      hint = cleanHint(raw.map(redact).filter(isHintPath), []);
    }
    const branch = local?.facts.branch ? redact(local.facts.branch) : undefined;
    body = {
      // What the laptop resolved, never the model's bare name, when it resolved anything.
      ...(local ? { repo: requestRepo(local.entry) } : target.named ? { repo: requestRepo(target.named) } : {}),
      ...(branch ? { branch } : {}),
      ...(hint && hint.length > 0 ? { paths: hint } : {}),
      args: redactStrings(sent, redact),
    };
  } catch (e) {
    if (e instanceof Unredactable) return logged(deps, name, "unredactable", fail(copy.mcp.unredactable));
    throw e;
  }
  const left = deadline - Date.now();
  if (left < 50) return logged(deps, name, "timeout", fail(copy.mcp.timeout));
  try {
    const { data } = await new ApiClient({ server: target.server, token: target.token, fetch: deps.fetch }).request(
      "POST",
      `/tools/${name}`,
      ToolResult,
      body,
      { timeoutMs: left, ...(write ? { idempotencyKey: `mcp-${randomUUID()}` } : {}) },
    );
    return logged(deps, name, data.is_error ? "is_error" : "ok", toMcp(data));
  } catch (e) {
    const m = errorMessage(e);
    return logged(deps, name, m.code, fail(m.text));
  }
}

function logged(deps: ForwardDeps, name: ToolName, code: string, r: McpResult): McpResult {
  logCount(deps.paths.logs, "mcp", `${name}.${code}`);
  return r;
}
