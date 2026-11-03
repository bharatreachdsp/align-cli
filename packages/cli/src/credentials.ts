/**
 * Tokens per organisation (docs/15 §Files). On macOS the token lives in the Keychain (service
 * `KEYCHAIN_SERVICE`, account = organisation id), written through `security -i` so it travels on stdin and
 * never appears in a process list; elsewhere it lives in `credentials.json` (0600). The file always holds
 * the non-secret metadata (organisation, person, expiry, the server the token belongs to).
 *
 * A token is only ever sent to the server it was issued by (`tokenFor` compares the server).
 * Nothing here prints or logs a token.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { KEYCHAIN_SERVICE } from "@align/core/brand";
import { z } from "zod";
import { CorruptFileError, moveAside, PRIVATE_MODE, readJsonFile, withLock, writeJsonAtomic } from "./fsx";
import type { Paths } from "./paths";

const Meta = z.object({
  org: z.object({ id: z.string(), slug: z.string(), name: z.string(), prefix: z.string() }),
  user: z.object({ id: z.string(), display_name: z.string() }),
  expires_at: z.string(),
  server: z.string(),
  store: z.enum(["file", "keychain"]),
  token: z.string().optional(),
});
export type CredentialMeta = Omit<z.infer<typeof Meta>, "token">;

const FileSchema = z.object({ version: z.literal(1).default(1), orgs: z.record(z.string(), Meta).default({}) });
type CredentialsFile = z.infer<typeof FileSchema>;
const parseFile = (v: unknown): CredentialsFile | null => {
  const r = FileSchema.safeParse(v);
  return r.success ? r.data : null;
};

/** Only ids we issued ourselves reach the `security` command line, quoted. */
const SAFE_ACCOUNT = /^[A-Za-z0-9-]{1,200}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{8,512}$/;

export type Keychain = {
  set(account: string, token: string): boolean;
  get(account: string): string | null;
  remove(account: string): void;
};

/** The macOS Keychain through the `security` binary (a fake one in tests on Linux). */
export function securityKeychain(bin: string): Keychain {
  const run = (args: string[], input?: string) =>
    spawnSync(bin, args, { input, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
  return {
    set(account, token) {
      if (!SAFE_ACCOUNT.test(account) || !SAFE_TOKEN.test(token)) return false;
      const line = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -w "${token}"\n`;
      const r = run(["-i"], line);
      return r.status === 0 && this.get(account) === token;
    },
    get(account) {
      if (!SAFE_ACCOUNT.test(account)) return null;
      const r = run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
      const out = r.status === 0 ? r.stdout.trim() : "";
      return SAFE_TOKEN.test(out) ? out : null;
    },
    remove(account) {
      if (SAFE_ACCOUNT.test(account)) run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
    },
  };
}

/** The Keychain when this is macOS and `security` exists; `ALIGN_CREDENTIAL_STORE=file` opts out. */
export function defaultKeychain(env: NodeJS.ProcessEnv, platform = process.platform): Keychain | null {
  if (env.ALIGN_CREDENTIAL_STORE === "file" || platform !== "darwin") return null;
  return existsSync("/usr/bin/security") ? securityKeychain("/usr/bin/security") : null;
}

/**
 * The Keychain account for a token: the organisation id and a hash of the server that issued it. A record in
 * `credentials.json` that names another server (a planted file, a moved home) therefore finds no Keychain item at all,
 * so a token is only ever read for the server it was issued by (L16 review S1).
 */
export const keychainAccount = (orgId: string, server: string) =>
  `${orgId}-${createHash("sha256").update(server).digest("hex").slice(0, 16)}`;

export class CredentialStore {
  constructor(
    private readonly paths: Paths,
    private readonly keychain: Keychain | null,
  ) {}

  private read(): CredentialsFile {
    try {
      return readJsonFile(this.paths.credentials, parseFile, () => FileSchema.parse({}));
    } catch {
      return FileSchema.parse({});
    }
  }

  /** Read-modify-write under the lock; a corrupt file is moved aside (still 0600) and the person signs in again. */
  private write(change: (f: CredentialsFile) => void): void {
    withLock(this.paths.credentialsLock, () => {
      let f: CredentialsFile;
      try {
        f = readJsonFile(this.paths.credentials, parseFile, () => FileSchema.parse({}));
      } catch (e) {
        if (!(e instanceof CorruptFileError)) throw e;
        moveAside(this.paths.credentials);
        f = FileSchema.parse({});
      }
      change(f);
      writeJsonAtomic(this.paths.credentials, f, PRIVATE_MODE);
    });
  }

  list(): CredentialMeta[] {
    return Object.values(this.read().orgs).map(({ token: _t, ...meta }) => meta);
  }

  /** The token for an organisation, only when it was issued by `server`. */
  tokenFor(orgId: string, server: string): string | null {
    const m = this.read().orgs[orgId];
    if (!m || m.server !== server) return null;
    if (m.store === "keychain") return this.keychain?.get(keychainAccount(orgId, server)) ?? null;
    return m.token && SAFE_TOKEN.test(m.token) ? m.token : null;
  }

  put(meta: Omit<CredentialMeta, "store">, token: string): CredentialMeta {
    const account = keychainAccount(meta.org.id, meta.server);
    const inKeychain = this.keychain?.set(account, token) ?? false;
    // Stored in the file: a Keychain item left from an earlier sign-in is stale and goes.
    if (!inKeychain) this.keychain?.remove(account);
    // A sign-in to another server leaves no item of the earlier one behind.
    const prev = this.read().orgs[meta.org.id];
    if (prev && prev.store === "keychain" && prev.server !== meta.server)
      this.keychain?.remove(keychainAccount(meta.org.id, prev.server));
    // The item a build before L16 round 2 kept under the bare organisation id goes too (it is never read).
    this.keychain?.remove(meta.org.id);
    const record = { ...meta, store: inKeychain ? ("keychain" as const) : ("file" as const) };
    this.write((f) => {
      f.orgs[meta.org.id] = inKeychain ? record : { ...record, token };
    });
    return record;
  }

  /** Where tokens live for `doctor`: the Keychain, or the 0600 file in plain text. */
  stores(): Array<"file" | "keychain"> {
    return [...new Set(Object.values(this.read().orgs).map((m) => m.store))];
  }

  remove(orgId: string): void {
    const m = this.read().orgs[orgId];
    if (m?.store === "keychain") this.keychain?.remove(keychainAccount(orgId, m.server));
    this.keychain?.remove(orgId);
    this.write((f) => {
      delete f.orgs[orgId];
    });
  }
}
