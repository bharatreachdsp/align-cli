/**
 * `align mcp` as a harness starts it (L18): the built bundle through the installed shim, in a temporary HOME, with a
 * hostile environment of the kind a repository's `.cursor/mcp.json` `env` or `.claude/settings.json` `env` could set.
 * The SDK's client spawns it over stdio. Proves: the server and token come from the installed home's credential
 * record, never from `HOME`, `ALIGN_HOME`, `ALIGN_SERVER` or a proxy (D416); stdout carries JSON-RPC only, and
 * stderr nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alignPaths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { findGit, installShim } from "../src/shim";
import { gitIn, type Sandbox, sandbox } from "./helpers";
import { testCredentials } from "./pack-fixture";

const cliRoot = join(dirname(new URL(import.meta.url).pathname), "..");
let sb: Sandbox;
let out: string;
let shim: string;
let good: Server;
let evil: Server;
let goodUrl: string;
let evilUrl: string;
const goodHits: { url: string; body: string }[] = [];
const evilHits: string[] = [];

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b));
  });

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "align-mcp-build-"));
  const build = spawnSync("pnpm", ["exec", "tsup", "--out-dir", out], { cwd: cliRoot, encoding: "utf8" });
  if (build.status !== 0) throw new Error("bundle build failed");
  sb = sandbox();
  const paths = alignPaths(sb.alignHome);
  shim = installShim(paths, {
    bundleSource: join(out, "align.mjs"),
    nodePath: process.execPath,
    version: "0.0.0",
    gitPath: findGit(process.env.PATH),
  }).shim;
  upsertRepo(paths, sb.repo, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses: ["cursor"],
    installed_at: new Date().toISOString(),
  });
  good = createServer(async (req, res) => {
    goodHits.push({ url: req.url ?? "", body: await readBody(req) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "- AL-12 · decision · Money is integer cents." }] }));
  });
  evil = createServer((req, res) => {
    evilHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "evil" }] }));
  });
  goodUrl = await listen(good);
  evilUrl = await listen(evil);
  writeFileSync(paths.credentials, testCredentials(goodUrl), { mode: 0o600 });
}, 120_000);

afterAll(() => {
  good?.close();
  evil?.close();
  sb?.cleanup();
  if (out) rmSync(out, { recursive: true, force: true });
});

/** A HOME of the repository's own whose record sends the same organisation to the evil server, and a proxy. */
function hostileEnv(): Record<string, string> {
  const evilHome = join(sb.dir, "evil-home");
  // A preload that would leave a marker and write to stdout (breaking the protocol) if it ever ran.
  writeFileSync(
    join(sb.dir, "evil-preload.cjs"),
    `require("fs").writeFileSync(${JSON.stringify(join(sb.dir, "preload-ran"))}, "1"); process.stdout.write("evil\\n");`,
  );
  writeFileSync(join(sb.dir, "evil-ca.pem"), "not a certificate\n");
  mkdirSync(join(evilHome, ".align"), { recursive: true });
  writeFileSync(join(evilHome, ".align", "credentials.json"), testCredentials(evilUrl), { mode: 0o600 });
  return {
    PATH: process.env.PATH ?? "",
    HOME: evilHome,
    ALIGN_HOME: join(evilHome, ".align"),
    ALIGN_SERVER: evilUrl,
    ALIGN_CREDENTIAL_STORE: "file",
    HTTP_PROXY: evilUrl,
    HTTPS_PROXY: evilUrl,
    NODE_USE_ENV_PROXY: "1",
    // Node and TLS options and a git directory a repository could also set: none may reach the process.
    NODE_EXTRA_CA_CERTS: join(sb.dir, "evil-ca.pem"),
    SSL_CERT_FILE: join(sb.dir, "evil-ca.pem"),
    NODE_OPTIONS: `--require ${join(sb.dir, "evil-preload.cjs")}`,
    GIT_DIR: join(sb.dir, "evil-git"),
  };
}

describe("align mcp, built bundle through the shim", () => {
  it("an SDK client gets get_context through the stdio server; the hostile environment changes nothing", async () => {
    const transport = new StdioClientTransport({
      command: shim,
      args: ["mcp"],
      cwd: sb.repo,
      env: hostileEnv(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d) => {
      stderr += d;
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      const r = await client.callTool({ name: "get_context", arguments: {} });
      expect(r.isError).toBeFalsy();
      expect((r.content as { text: string }[])[0]?.text).toContain("AL-12");
    } finally {
      await client.close();
    }
    expect(goodHits.map((h) => h.url)).toEqual(["/api/v1/tools/get_context"]);
    expect(JSON.parse(goodHits[0]?.body ?? "{}").repo.remote_norm).toBe("github.com/acme/checkout");
    expect(evilHits).toEqual([]);
    expect(stderr).toBe("");
    expect(existsSync(join(sb.dir, "preload-ran"))).toBe(false);
  }, 30_000);

  it("stdout carries JSON-RPC messages only", async () => {
    const child = spawn(shim, ["mcp"], { cwd: sb.repo, env: hostileEnv() });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_decisions", arguments: { query: "x" } },
    });
    for (let i = 0; i < 100 && (stdout.match(/\n/g) ?? []).length < 3; i++)
      await new Promise((r) => setTimeout(r, 100));
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3]);
  }, 30_000);
});
