import {
  mkdirSync as mkdirS,
  mkdirSync,
  mkdtempSync,
  readdirSync as readdirS,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUuidv7 } from "@align/core/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptFileError, readJson, withLock, writeFileAtomic, writeUserFileAtomic } from "./fsx";
import { alignHome, alignPaths } from "./paths";
import { lookupRepo, type RepoEntry, readRegistry, removeRepo, setOptedIn, upsertRepo } from "./registry";
import { findSession, sessionFor, setSessionId } from "./sessions";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "align-store-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id: string): RepoEntry => ({
  repo_id: id,
  org_id: "o",
  remote_norm: `github.com/acme/${id}`,
  root_commit: "a".repeat(40),
  default_branch: "main",
  opted_in: true,
  harnesses: [],
  installed_at: "2026-10-22T00:00:00.000Z",
});

describe("writeUserFileAtomic (L16 review)", () => {
  it("leaves no temporary file behind when the rename fails", () => {
    const d = mkdtempSync(join(tmpdir(), "align-wufa-"));
    try {
      mkdirS(join(d, "target"));
      expect(() => writeUserFileAtomic(join(d, "target"), "x", 0o600)).toThrow();
      expect(readdirS(d)).toEqual(["target"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("paths", () => {
  it("honours ALIGN_HOME, else $HOME/.align", () => {
    expect(alignHome({ ALIGN_HOME: "/x/y" })).toBe("/x/y");
    expect(alignHome({ HOME: "/h" })).toBe("/h/.align");
  });
});

describe("fsx", () => {
  it("writes atomically with the requested mode and reads corrupt JSON as undefined", () => {
    const p = join(dir, "a", "f.json");
    writeFileAtomic(p, "{}");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
    writeFileSync(p, "{");
    expect(readJson(p)).toBeUndefined();
  });

  it("holds the lock, takes over a stale one and gives up on a busy one", () => {
    const lock = join(dir, "l.lock");
    expect(withLock(lock, () => withLock(`${lock}2`, () => 7))).toBe(7);
    writeFileSync(lock, "999999 0\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withLock(lock, () => "took over")).toBe("took over");
    writeFileSync(lock, "busy\n");
    expect(() => withLock(lock, () => 1, { waitMs: 50 })).toThrow(/lock busy/);
  });

  it("releases only its own lock: a holder whose lock was taken over leaves the new one", () => {
    const lock = join(dir, "own.lock");
    withLock(lock, () => {
      // another process takes the lock over meanwhile
      writeFileSync(lock, "4242 other\n");
    });
    expect(readFileSync(lock, "utf8")).toBe("4242 other\n");
  });
});

describe("registry", () => {
  it("matches only the exact repository root: a nested clone never inherits its parent's opt-in", () => {
    const paths = alignPaths(join(dir, ".align"));
    const outer = join(dir, "src", "mono");
    const inner = join(outer, "vendor", "lib");
    mkdirSync(join(inner, "deep"), { recursive: true });
    upsertRepo(paths, outer, entry("outer"));
    const r = readRegistry(paths);
    expect(lookupRepo(r, outer)?.entry.repo_id).toBe("outer");
    expect(lookupRepo(r, inner)).toBeNull();
    expect(lookupRepo(r, join(outer, "vendor"))).toBeNull();
    upsertRepo(paths, inner, entry("inner"));
    expect(lookupRepo(readRegistry(paths), inner)?.entry.repo_id).toBe("inner");
    symlinkSync(inner, join(dir, "link"));
    expect(lookupRepo(readRegistry(paths), join(dir, "link"))?.entry.repo_id).toBe("inner");
    expect(statSync(paths.repos).mode & 0o777).toBe(0o600);
  });

  it("a corrupt registry reads as empty and is never overwritten", () => {
    const paths = alignPaths(join(dir, ".align"));
    upsertRepo(paths, "/r", entry("r"));
    writeFileSync(paths.repos, "{corrupt");
    expect(readRegistry(paths).repos).toEqual({});
    expect(() => upsertRepo(paths, "/s", entry("s"))).toThrow(CorruptFileError);
    expect(readFileSync(paths.repos, "utf8")).toBe("{corrupt");
  });

  it("updates opt-in and removes entries", () => {
    const paths = alignPaths(join(dir, ".align"));
    upsertRepo(paths, "/r", entry("r"));
    expect(setOptedIn(paths, "/r", false)).toBe(true);
    expect(readRegistry(paths).repos["/r"]?.opted_in).toBe(false);
    expect(setOptedIn(paths, "/nope", true)).toBe(false);
    expect(removeRepo(paths, "/r")).toBe(true);
    expect(readRegistry(paths).repos).toEqual({});
  });
});

describe("session index", () => {
  it("mints an id once per harness session and never again", () => {
    const paths = alignPaths(join(dir, ".align"));
    const a = sessionFor(paths, "claude-code", "abc");
    expect(isUuidv7(a)).toBe(true);
    expect(sessionFor(paths, "claude-code", "abc")).toBe(a);
    expect(sessionFor(paths, "cursor", "abc")).not.toBe(a);
    expect(findSession(paths, "claude-code", "abc")).toBe(a);
    expect(findSession(paths, "codex", "abc")).toBeNull();
    setSessionId(paths, "claude-code", "abc", "server-id");
    expect(sessionFor(paths, "claude-code", "abc")).toBe("server-id");
    expect(() => sessionFor(paths, "", "x")).toThrow();
  });

  it("a corrupt index is never replaced, so no session gets a second id", () => {
    const paths = alignPaths(join(dir, ".align"));
    sessionFor(paths, "claude-code", "abc");
    writeFileSync(paths.sessionsIndex, '{"version":1,"sessions":');
    expect(() => sessionFor(paths, "claude-code", "abc")).toThrow(CorruptFileError);
    expect(() => findSession(paths, "claude-code", "abc")).toThrow(CorruptFileError);
    expect(readFileSync(paths.sessionsIndex, "utf8")).toBe('{"version":1,"sessions":');
  });
});
