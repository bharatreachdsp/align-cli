import { afterEach, describe, expect, it } from "vitest";
import { type Sandbox, sandbox } from "../test/helpers";
import { type MockServer, startMockServer } from "../test/mock-server";
import { Ctx } from "./context";
import { checkForUpdate, updateNotice } from "./update";
import { VERSION } from "./version";

let sb: Sandbox;
let server: MockServer;
afterEach(async () => {
  await server?.close();
  sb?.cleanup();
});

const ctxAt = (now: number, url: string) =>
  new Ctx(
    { out: () => {}, err: () => {} },
    { env: { HOME: sb.home, ALIGN_SERVER: url }, now: () => now, keychain: null },
  );

describe("update check", () => {
  it("asks the server at most once a day and shows the line once per day", async () => {
    sb = sandbox();
    server = await startMockServer({ latest: "9.0.0" });
    const t0 = Date.parse("2026-10-22T08:00:00Z");
    expect(await checkForUpdate(ctxAt(t0, server.url))).toMatchObject({
      latest: "9.0.0",
      available: true,
      required: false,
    });
    await checkForUpdate(ctxAt(t0 + 60_000, server.url));
    expect(server.requests.filter((r) => r.path === "/client")).toHaveLength(1);
    expect(await updateNotice(ctxAt(t0 + 120_000, server.url))).toBe(
      `ALIGN · version 9.0.0 is available (you have ${VERSION}): npx @align-agent/cli@9.0.0 init --no-backfill`,
    );
    expect(await updateNotice(ctxAt(t0 + 180_000, server.url))).toBeNull();
    const nextDay = t0 + 25 * 60 * 60 * 1000;
    expect(await updateNotice(ctxAt(nextDay, server.url))).not.toBeNull();
    expect(server.requests.filter((r) => r.path === "/client")).toHaveLength(2);
  });

  it("keeps the last answer when offline, and is null with nothing cached", async () => {
    sb = sandbox();
    server = await startMockServer({ latest: "0.0.0" });
    const t0 = Date.parse("2026-10-22T08:00:00Z");
    expect(await checkForUpdate(ctxAt(t0, "http://127.0.0.1:9"))).toBeNull();
    await checkForUpdate(ctxAt(t0, server.url));
    const later = await checkForUpdate(ctxAt(t0 + 2 * 86_400_000, "http://127.0.0.1:9"));
    expect(later).toMatchObject({ latest: "0.0.0", available: false });
    expect(await updateNotice(ctxAt(t0, server.url))).toBeNull();
  });
});
