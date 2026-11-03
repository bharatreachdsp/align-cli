import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore, defaultKeychain, keychainAccount, securityKeychain } from "./credentials";
import { alignPaths } from "./paths";

const token = (n: number) => ["aln", "test", `${"k".repeat(20)}${n}`].join("_");
const meta = (orgId: string, server = "https://staging.example") => ({
  org: { id: orgId, slug: orgId, name: `Org ${orgId}`, prefix: "AL" },
  user: { id: "u1", display_name: "Riya Example" },
  expires_at: "2027-01-01T00:00:00.000Z",
  server,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "align-cred-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake macOS `security`: `-i` reads commands from stdin; argv and the store go to files. */
function fakeSecurity(): { bin: string; argvLog: string; store: string } {
  const bin = join(dir, "security");
  const argvLog = join(dir, "argv.log");
  const store = join(dir, "keychain.json");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const store = ${JSON.stringify(store)};
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const db = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {};
const save = () => fs.writeFileSync(store, JSON.stringify(db));
const opt = (args, f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };
function exec(args) {
  const k = opt(args, "-s") + "/" + opt(args, "-a");
  if (args[0] === "add-generic-password") { db[k] = opt(args, "-w"); save(); return 0; }
  if (args[0] === "find-generic-password") { if (!(k in db)) return 44; process.stdout.write(db[k] + "\\n"); return 0; }
  if (args[0] === "delete-generic-password") { delete db[k]; save(); return 0; }
  return 1;
}
const argv = process.argv.slice(2);
if (argv[0] === "-i") {
  const lines = fs.readFileSync(0, "utf8").split("\\n").filter(Boolean);
  let code = 0;
  for (const l of lines) code = exec((l.match(/"[^"]*"|\\S+/g) || []).map((t) => t.replace(/^"|"$/g, ""))) || code;
  process.exit(code);
}
process.exit(exec(argv));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, argvLog, store };
}

describe("credentials.json store", () => {
  it("keeps tokens per organisation in a 0600 file inside a 0700 directory", () => {
    const paths = alignPaths(join(dir, ".align"));
    const s = new CredentialStore(paths, null);
    s.put(meta("org-a"), token(1));
    s.put(meta("org-b"), token(2));
    expect(statSync(paths.credentials).mode & 0o777).toBe(0o600);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(s.tokenFor("org-a", "https://staging.example")).toBe(token(1));
    expect(s.tokenFor("org-b", "https://staging.example")).toBe(token(2));
    expect(
      s
        .list()
        .map((m) => m.org.id)
        .sort(),
    ).toEqual(["org-a", "org-b"]);
    expect(JSON.stringify(s.list())).not.toContain(token(1));
    s.remove("org-a");
    expect(s.tokenFor("org-a", "https://staging.example")).toBeNull();
  });

  it("gives a token only to the server that issued it", () => {
    const s = new CredentialStore(alignPaths(join(dir, ".align")), null);
    s.put(meta("org-a", "https://staging.example"), token(1));
    expect(s.tokenFor("org-a", "https://evil.example")).toBeNull();
  });

  it("survives a corrupt file: reads as empty, and the next sign-in moves it aside (kept 0600)", () => {
    const paths = alignPaths(join(dir, ".align"));
    const s = new CredentialStore(paths, null);
    s.put(meta("org-a"), token(1));
    writeFileSync(paths.credentials, "{not json", { mode: 0o600 });
    expect(s.list()).toEqual([]);
    s.put(meta("org-b"), token(2));
    expect(s.tokenFor("org-b", "https://staging.example")).toBe(token(2));
    const aside = readdirSync(paths.home).filter((f) => f.startsWith("credentials.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(statSync(join(paths.home, aside[0] as string)).mode & 0o777).toBe(0o600);
  });
});

describe("Keychain store (fake security binary)", () => {
  it("stores the token in the Keychain, never on the command line or in the file", () => {
    const fake = fakeSecurity();
    const paths = alignPaths(join(dir, ".align"));
    const s = new CredentialStore(paths, securityKeychain(fake.bin));
    const m = s.put(meta("0192f0a0-0000-7000-8000-000000000001"), token(7));
    expect(m.store).toBe("keychain");
    expect(readFileSync(paths.credentials, "utf8")).not.toContain(token(7));
    expect(readFileSync(fake.argvLog, "utf8")).not.toContain(token(7));
    expect(JSON.parse(readFileSync(fake.store, "utf8"))).toEqual({
      [`align-cli/${keychainAccount("0192f0a0-0000-7000-8000-000000000001", "https://staging.example")}`]: token(7),
    });
    expect(s.tokenFor("0192f0a0-0000-7000-8000-000000000001", "https://staging.example")).toBe(token(7));
    s.remove("0192f0a0-0000-7000-8000-000000000001");
    expect(JSON.parse(readFileSync(fake.store, "utf8"))).toEqual({});
  });

  it("a token stored in the file removes a stale Keychain item for that organisation", () => {
    const fake = fakeSecurity();
    const paths = alignPaths(join(dir, ".align"));
    const kc = securityKeychain(fake.bin);
    const account = keychainAccount("org-a", "https://staging.example");
    kc.set(account, token(1));
    const refusing = { ...kc, set: () => false };
    new CredentialStore(paths, refusing).put(meta("org-a"), token(2));
    expect(kc.get(account)).toBeNull();
    expect(new CredentialStore(paths, refusing).stores()).toEqual(["file"]);
  });

  it("a planted record naming another server finds no Keychain item: the token never leaves for it (L16 S1)", () => {
    const fake = fakeSecurity();
    const real = alignPaths(join(dir, ".align"));
    const kc = securityKeychain(fake.bin);
    new CredentialStore(real, kc).put(meta("org-a"), token(4));
    // A repository's environment points ALIGN_HOME at a home it wrote, with the same organisation and its own server.
    const planted = alignPaths(join(dir, "evil", ".align"));
    mkdirSync(planted.home, { recursive: true });
    writeFileSync(
      planted.credentials,
      JSON.stringify({
        version: 1,
        orgs: { "org-a": { ...meta("org-a"), server: "https://evil.example", store: "keychain" } },
      }),
    );
    expect(new CredentialStore(planted, kc).tokenFor("org-a", "https://evil.example")).toBeNull();
    expect(new CredentialStore(real, kc).tokenFor("org-a", "https://staging.example")).toBe(token(4));
  });

  it("a sign-in and a sign-out also remove the legacy item kept under the bare organisation id (never read)", () => {
    const fake = fakeSecurity();
    const paths = alignPaths(join(dir, ".align"));
    const kc = securityKeychain(fake.bin);
    kc.set("org-a", token(5));
    const s = new CredentialStore(paths, kc);
    s.put(meta("org-a"), token(6));
    expect(kc.get("org-a")).toBeNull();
    expect(s.tokenFor("org-a", "https://staging.example")).toBe(token(6));
    kc.set("org-a", token(5));
    s.remove("org-a");
    expect(kc.get("org-a")).toBeNull();
    expect(JSON.parse(readFileSync(fake.store, "utf8"))).toEqual({});
  });

  it("falls back to the file when the Keychain refuses", () => {
    const paths = alignPaths(join(dir, ".align"));
    const broken = join(dir, "broken");
    writeFileSync(broken, "#!/bin/sh\nexit 1\n");
    chmodSync(broken, 0o755);
    const s = new CredentialStore(paths, securityKeychain(broken));
    expect(s.put(meta("org-a"), token(3)).store).toBe("file");
    expect(s.tokenFor("org-a", "https://staging.example")).toBe(token(3));
  });

  it("refuses ids and tokens that could break out of the quoted command", () => {
    const fake = fakeSecurity();
    const k = securityKeychain(fake.bin);
    expect(k.set('a" -w "x', token(1))).toBe(false);
    expect(k.set("org", 'x" ; delete')).toBe(false);
  });

  it("is used only on macOS and can be turned off", () => {
    expect(defaultKeychain({}, "linux")).toBeNull();
    expect(defaultKeychain({ ALIGN_CREDENTIAL_STORE: "file" }, "darwin")).toBeNull();
  });
});
