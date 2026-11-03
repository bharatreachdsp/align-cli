import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MeResponse, mockMe } from "@align/core/api";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, ApiError, NetworkError, normalizeServer, ProtocolError, TimeoutError } from "./api";
import { VERSION } from "./version";

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((r) => {
      if (!server) return r();
      server.closeAllConnections();
      server.close(() => r());
    }),
);

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const secret = () => ["aln", "test", "t".repeat(24)].join("_");

describe("normalizeServer", () => {
  it.each([
    ["https://staging.example/", "https://staging.example"],
    ["https://staging.example/base//", "https://staging.example/base"],
    ["http://localhost:3221", "http://localhost:3221"],
    ["http://127.0.0.1:9", "http://127.0.0.1:9"],
    ["http://[::1]:9", "http://[::1]:9"],
  ])("%s → %s", (input, out) => expect(normalizeServer(input)).toBe(out));

  it.each(["http://staging.example", "ftp://x", "https://u:p@x.example", "https://x.example/?a=1", "not a url"])(
    "refuses %s",
    (input) => expect(normalizeServer(input)).toBeNull(),
  );
});

describe("ApiClient", () => {
  it("sends the client header, user agent and bearer token, and parses the schema", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const url = await serve((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json", date: new Date().toUTCString() });
      res.end(JSON.stringify(mockMe()));
    });
    const api = new ApiClient({ server: url, token: secret() });
    const { data, date } = await api.request("GET", "/me", MeResponse);
    expect(data.org.slug).toBe("acme");
    expect(date).toBeInstanceOf(Date);
    expect(seen["x-align-client"]).toBe(VERSION);
    expect(seen["user-agent"]).toBe(`align-cli/${VERSION}`);
    expect(seen.authorization).toBe(`Bearer ${secret()}`);
  });

  it("omits the token when auth is off", async () => {
    let auth: string | undefined = "unset";
    const url = await serve((req, res) => {
      auth = req.headers.authorization;
      res.end(JSON.stringify(mockMe()));
    });
    await new ApiClient({ server: url, token: secret() }).request("GET", "/me", MeResponse, undefined, { auth: false });
    expect(auth).toBeUndefined();
  });

  it("turns an error body into ApiError without echoing the token", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_opted_in", message: "not opted in", details: {} } }));
    });
    const e = await new ApiClient({ server: url, token: secret() }).request("GET", "/me", MeResponse).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 403, code: "not_opted_in" });
    expect(String(e.message) + String(e.stack)).not.toContain(secret());
  });

  it("times out, reports unreachable servers, refuses redirects and off-contract answers", async () => {
    const hang = await serve(() => {});
    await expect(
      new ApiClient({ server: hang, timeoutMs: 50 }).request("GET", "/me", MeResponse),
    ).rejects.toBeInstanceOf(TimeoutError);
    // A deadline left over from a clock reading is fractional; it must still time out, not fail as unreachable.
    await expect(
      new ApiClient({ server: hang }).request("GET", "/me", MeResponse, undefined, { timeoutMs: 50.6 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    await expect(
      new ApiClient({ server: "http://127.0.0.1:9" }).request("GET", "/me", MeResponse),
    ).rejects.toBeInstanceOf(NetworkError);
    server?.closeAllConnections();
    server?.close();
    const redirect = await serve((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
      res.end();
    });
    await expect(new ApiClient({ server: redirect }).request("GET", "/me", MeResponse)).rejects.toBeInstanceOf(
      NetworkError,
    );
    server?.closeAllConnections();
    server?.close();
    const wrong = await serve((_req, res) => res.end(JSON.stringify({ hello: "world" })));
    await expect(new ApiClient({ server: wrong }).request("GET", "/me", MeResponse)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it("reports X-Align-Upgrade: required", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "x-align-upgrade": "required" });
      res.end(JSON.stringify(mockMe()));
    });
    let calls = 0;
    await new ApiClient({ server: url, onUpgradeRequired: () => calls++ }).request("GET", "/me", MeResponse);
    expect(calls).toBe(1);
  });
});
