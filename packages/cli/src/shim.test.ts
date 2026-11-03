import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitBinary, gitEnv, HOOK_GIT_CONFIG, hookGit } from "./hook/home";
import { INTERNAL_COMMANDS } from "./internal";
import { alignPaths } from "./paths";
import {
  INTERNAL_ENTRY_POINTS,
  installedBundle,
  installShim,
  isBundlePath,
  SHIM_ENV_ALLOW,
  shimScript,
  shQuote,
} from "./shim";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "align shim 'q' $x-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bundle(name: string, body: string): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  const p = join(dir, "dist", name);
  writeFileSync(p, body);
  return p;
}

const echoArgs = "console.log(JSON.stringify(process.argv.slice(2)));\n";

describe("self-install", () => {
  it("copies the bundle, links align.mjs to it and writes a 0755 shim that runs it", () => {
    const paths = alignPaths(join(dir, "home", ".align"));
    const r = installShim(paths, {
      bundleSource: bundle("align.mjs", echoArgs),
      nodePath: process.execPath,
      version: "1.2.3",
    });
    expect(r.copied).toBe(true);
    expect(statSync(paths.shim).mode & 0o777).toBe(0o755);
    for (const d of [paths.home, paths.bin, paths.lib]) expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(readlinkSync(paths.current)).toBe("align-1.2.3.mjs");
    expect(installedBundle(paths)).toBe(paths.bundle("1.2.3"));
    // the shim works from a path with spaces, quotes and $ in it, and passes arguments through untouched
    const out = execFileSync(paths.shim, ["hook", "a b", "$HOME", "it's"], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(["hook", "a b", "$HOME", "it's"]);
  });

  it("falls back to node on PATH when the recorded node is gone, and is idempotent", () => {
    const paths = alignPaths(join(dir, "home", ".align"));
    const src = bundle("align.mjs", echoArgs);
    installShim(paths, { bundleSource: src, nodePath: join(dir, "no-such-node"), version: "1.2.3" });
    expect(JSON.parse(execFileSync(paths.shim, ["x"], { encoding: "utf8" }))).toEqual(["x"]);
    const again = installShim(paths, { bundleSource: src, nodePath: process.execPath, version: "1.2.3" });
    expect(again.copied).toBe(false);
    // running from the installed copy itself copies nothing
    expect(
      installShim(paths, { bundleSource: paths.current, nodePath: process.execPath, version: "1.2.3" }).copied,
    ).toBe(false);
  });

  it("switches align.mjs to a new version without touching the shim path", () => {
    const paths = alignPaths(join(dir, "home", ".align"));
    installShim(paths, { bundleSource: bundle("align.mjs", echoArgs), nodePath: process.execPath, version: "1.0.0" });
    installShim(paths, {
      bundleSource: bundle("align-2.0.0.mjs", "console.log('two');\n"),
      nodePath: process.execPath,
      version: "2.0.0",
    });
    expect(readlinkSync(paths.current)).toBe("align-2.0.0.mjs");
    expect(execFileSync(paths.shim, [], { encoding: "utf8" }).trim()).toBe("two");
  });

  it("recognises bundles and quotes for sh", () => {
    expect(isBundlePath(bundle("align.mjs", ""))).toBe(true);
    expect(isBundlePath(join(dir, "src", "main.ts"))).toBe(false);
    expect(isBundlePath(null)).toBe(false);
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("the shim's cleared environment (L16 review round 3)", () => {
  it("starts every internal entry point from an empty environment plus the allow-list", () => {
    expect([...INTERNAL_ENTRY_POINTS].sort()).toEqual([...INTERNAL_COMMANDS].sort());
    const text = shimScript("/usr/bin/node", "/h/.align/lib/align.mjs");
    expect(text).toContain(`  ${INTERNAL_ENTRY_POINTS.join("|")})`);
    expect(text).toContain("exec /usr/bin/env -i ");
    for (const k of [
      "HTTPS_PROXY",
      "NODE_USE_ENV_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "SSL_CERT_FILE",
      "ALIGN_HOME",
    ])
      expect(text).not.toContain(k);
  });
});

describe("git's configuration never comes from the harness's environment (L16 review round 4, D276)", () => {
  it("keeps HOME and XDG_CONFIG_HOME out of the allow-list and unsets a compile cache it did not choose", () => {
    expect(SHIM_ENV_ALLOW).not.toContain("HOME");
    expect(SHIM_ENV_ALLOW).not.toContain("XDG_CONFIG_HOME");
    const text = shimScript("/usr/bin/node", "/h/.align/lib/align.mjs");
    expect(text).not.toMatch(/\bHOME=/);
    expect(text).toContain("unset NODE_COMPILE_CACHE");
    const cached = shimScript("/usr/bin/node", "/h/.align/lib/align.mjs", "/h/.align/cache/v8");
    expect(cached).not.toContain("unset NODE_COMPILE_CACHE");
    expect(cached).toContain("NODE_COMPILE_CACHE='/h/.align/cache/v8'");
  });

  it("gives git the account's home, no XDG directory and no GIT_* variable; hook calls switch fsmonitor and hooks off", () => {
    const env = gitEnv(
      { PATH: "/usr/bin", HOME: "/repo/evil", XDG_CONFIG_HOME: "/repo/xdg", XDG_CONFIG_DIRS: "/repo", GIT_DIR: "/x" },
      "/home/bob",
    );
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/bob", GIT_TERMINAL_PROMPT: "0" });
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.XDG_CONFIG_DIRS).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    // No password-database entry: no home at all, never the environment's.
    expect(gitEnv({ HOME: "/repo/evil" }, null).HOME).toBeUndefined();
    expect(gitEnv({ HOME: "/repo/evil" }).HOME).toBe(userInfo().homedir);
    expect(HOOK_GIT_CONFIG.join(" ")).toBe(
      "-c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false",
    );
  });
});

describe("the hook's git never comes from PATH (L16 final round, D276)", () => {
  it("ALIGN_GIT, else /usr/bin/git, else none", () => {
    expect(gitBinary({ ALIGN_GIT: "/usr/bin/git" }, ["/nope/git"])).toBe("/usr/bin/git");
    expect(gitBinary({ ALIGN_GIT: "relative/git" }, ["/nope/git"])).toBeNull();
    expect(gitBinary({}, ["/nope/git"])).toBeNull();
    expect(gitBinary({ PATH: "/usr/bin" }, ["/nope/git"])).toBeNull();
  });

  it("a git planted first on PATH never runs when ALIGN_GIT is not set", async () => {
    // A directory without quotes in its name (the shared one has some, on purpose).
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "align-planted-git-")));
    const bin = join(plain, "bin");
    mkdirSync(bin);
    const marker = join(plain, "planted-git-ran");
    writeFileSync(join(bin, "git"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const saved = { PATH: process.env.PATH, ALIGN_GIT: process.env.ALIGN_GIT };
    process.env.PATH = `${bin}:${saved.PATH}`;
    delete process.env.ALIGN_GIT;
    try {
      await hookGit(["--version"], dir);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.ALIGN_GIT !== undefined) process.env.ALIGN_GIT = saved.ALIGN_GIT;
    }
    const ran = existsSync(marker);
    rmSync(plain, { recursive: true, force: true });
    expect(ran).toBe(false);
  });
});
