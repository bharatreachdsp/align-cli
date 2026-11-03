/**
 * `align mcp` (docs/14 §Local MCP server; L18): a stdio MCP server (`@modelcontextprotocol/server` v2) that lists the
 * seven agent tools from `@align/core/tools` and forwards each call to `POST /api/v1/tools/:name` (forward.ts).
 *
 * It is an internal entry point (internal.ts, D416). The shim starts it with `env -i` and the allow-list, and
 * align.ts gives it the account's home from the password database. Its home is the installed bundle's, and the
 * server and token come from the credential record. A harness's `env` (a repository's `.cursor/mcp.json` or
 * `.claude/settings.json`) can therefore never point it at a server, a token, a proxy or a CA of its choosing.
 *
 * Stdout carries the protocol only. `console` is silenced for the life of the process, and errors are counted in
 * `~/.align/logs` (codes, never content). No tool confirms, rejects, supersedes or answers anything (hard rule 3).
 */
import type { Readable, Writable } from "node:stream";
import { TOOL_NAMES, TOOLS } from "@align/core/tools";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { FetchLike } from "../api";
import { copy } from "../copy";
import type { Keychain } from "../credentials";
import { logCount } from "../hook/log";
import type { Paths } from "../paths";
import { VERSION } from "../version";
import { type ForwardDeps, forwardCall } from "./forward";
import { printConfig } from "./snippets";

export type McpDeps = {
  paths: Paths;
  cwd: string;
  out: (t: string) => void;
  err: (t: string) => void;
  fetch?: FetchLike;
  keychain?: Keychain | null;
  /** In-process tests: the streams instead of the process's own stdio. */
  stdin?: Readable;
  stdout?: Writable;
} & Pick<ForwardDeps, "timeoutMs" | "redact">;

/** One server instance with the seven tools (the factory `serveStdio` calls once per connection). */
export function createAlignServer(deps: ForwardDeps) {
  const server = new McpServer({ name: "align", version: VERSION }, { capabilities: { tools: {} } });
  for (const name of TOOL_NAMES) {
    const t = TOOLS[name];
    server.registerTool(
      name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations },
      // The SDK has parsed the arguments with the tool's own strict schema before this runs.
      async (args: unknown) => {
        try {
          return await forwardCall(name, (args ?? {}) as Record<string, unknown>, deps);
        } catch {
          logCount(deps.paths.logs, "mcp", `${name}.internal`);
          return { content: [{ type: "text" as const, text: copy.mcp.serverError }], isError: true };
        }
      },
    );
  }
  return server;
}

/** `--cwd <dir>` and `--print-config <agent>`; null on anything else. */
function parse(args: readonly string[]): { cwd?: string; print?: string } | null {
  const o: { cwd?: string; print?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const next = args[i + 1];
    if (a === "--cwd" && next !== undefined) {
      o.cwd = next;
      i++;
    } else if (a.startsWith("--cwd=")) o.cwd = a.slice(6);
    else if (a === "--print-config" && next !== undefined) {
      o.print = next;
      i++;
    } else if (a.startsWith("--print-config=")) o.print = a.slice(15);
    else return null;
  }
  return o;
}

export async function mcpCommand(args: readonly string[], deps: McpDeps): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    deps.out(`${copy.mcp.help}\n`);
    return 0;
  }
  const o = parse(args);
  if (!o) {
    deps.err(`${copy.mcp.usage}\n`);
    return 2;
  }
  if (o.print !== undefined) {
    const text = printConfig(o.print, deps.paths.shim);
    if (!text) {
      deps.err(`${copy.mcp.printConfigUnknown}\n`);
      return 2;
    }
    deps.out(text);
    return 0;
  }
  // Nothing but protocol messages on stdout, and nothing on stderr either: a dependency's stray log goes nowhere.
  const quiet = () => {};
  for (const k of ["log", "info", "warn", "error", "debug", "trace"] as const) console[k] = quiet;
  return await new Promise<number>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(0);
    };
    const stdin = deps.stdin ?? process.stdin;
    const transport = new StdioServerTransport(stdin, deps.stdout ?? process.stdout);
    serveStdio(() => createAlignServer({ ...deps, cwdFlag: o.cwd }), {
      transport,
      onerror: () => logCount(deps.paths.logs, "mcp", "transport_error"),
    });
    // The client closed its end: the server exits (the MCP stdio binding).
    stdin.once("end", finish);
    stdin.once("close", finish);
  });
}
