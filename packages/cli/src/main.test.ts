import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ctx, stripControl } from "./context";
import { run } from "./main";
import { VERSION } from "./version";

async function capture(argv: string[]) {
  let out = "";
  let err = "";
  const home = mkdtempSync(join(tmpdir(), "align-main-test-"));
  try {
    const code = await run(
      argv,
      { out: (t) => (out += t), err: (t) => (err += t) },
      {
        env: { HOME: "/nonexistent" },
        internalHome: join(home, ".align"),
        readStdin: async () => Buffer.alloc(0),
        sleep: async () => {},
        spawnUploader: () => {},
      },
    );
    return { code, out, err };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("align", () => {
  it("prints the package version", async () => {
    expect(await capture(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  it("prints help with no arguments and with --help", async () => {
    for (const argv of [[], ["--help"]]) {
      const r = await capture(argv);
      expect(r.code).toBe(0);
      for (const c of ["init", "login", "logout", "status", "doctor", "on", "off", "uninstall"])
        expect(r.out).toContain(c);
      expect(r.out).not.toMatch(/\bhook\b|git-hook|upload|flush/);
    }
  });

  it("rejects unknown commands and options with exit code 2", async () => {
    const r = await capture(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command");
    expect((await capture(["status", "--nope"])).code).toBe(2);
  });

  it("internal entry points exit 0 and print nothing (flush: one line), whatever they are given", async () => {
    for (const argv of [
      ["hook", "session-start", "--harness", "claude-code"],
      ["hook"],
      ["git-hook", "prepare-commit-msg", "/tmp/x", "message"],
      ["upload", "--daemon"],
    ]) {
      expect(await capture(argv)).toEqual({ code: 0, out: "", err: "" });
    }
    // `flush` is run by a person: it says what it did (L14).
    expect(await capture(["flush", "--weird", "arg"])).toEqual({ code: 0, out: "Nothing to upload.\n", err: "" });
  });

  it("strips terminal control characters from what it prints", () => {
    expect(stripControl("a\u001b[31mb\u0007c\rd")).toBe("a[31mbcd");
    let out = "";
    new Ctx({ out: (t) => (out += t), err: () => {} }, { env: { HOME: "/nonexistent" } }).line("x\u009by");
    expect(out).toBe("xy\n");
  });
});
