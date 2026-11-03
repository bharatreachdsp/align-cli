/** What every command gets: output, environment, paths, the server, credentials and an API client. */
import { ApiClient, type FetchLike, normalizeServer } from "./api";
import { readConfig } from "./config";
import { copy } from "./copy";
import { CredentialStore, defaultKeychain, type Keychain } from "./credentials";
import { INTERACTIVE_GIT_TIMEOUT_MS, toplevel } from "./git";
import { alignHome, alignPaths, type Paths } from "./paths";
import { lookupRepo, type RepoEntry, readRegistry } from "./registry";
import { VERSION } from "./version";

export type Io = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads one line from the person, or null when there is no interactive terminal. */
  ask?: (question: string) => Promise<string | null>;
  isTTY?: boolean;
};

export type Deps = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: FetchLike;
  keychain?: Keychain | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The bundle to self-install from (`null` when running from source, e.g. in unit tests). */
  bundlePath?: string | null;
  nodePath?: string;
  openBrowser?: (url: string) => void;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  /** Internal entry points: stdin (the hook payload). */
  readStdin?: () => Promise<Buffer>;
  /** In-process tests only: the home internal entry points use instead of the installed bundle's (hook/home.ts). */
  internalHome?: string;
  /** In-process tests only: replaces the detached uploader spawn. */
  spawnUploader?: () => void;
  /** In-process tests only: the fake terminal `align confirm` draws on. */
  confirmTerm?: () => import("./confirm/term").Term | null;
  /** In-process tests only: the person's answer typed on `/dev/tty`. */
  ttyAsk?: (question: string) => Promise<string | null>;
};

declare const __ALIGN_DEFAULT_SERVER__: string | undefined;
declare const __ALIGN_DEV_SERVER__: string | undefined;

/**
 * The server baked in at build time (`ALIGN_DEFAULT_SERVER`, docs/04). Non-release builds and source runs fall
 * back to the local dev server; a release build defines `__ALIGN_DEV_SERVER__` as empty and folds this away, so
 * no loopback address ships in a published bundle (tsup.config.ts).
 */
export const DEFAULT_SERVER: string =
  typeof __ALIGN_DEFAULT_SERVER__ === "string" && __ALIGN_DEFAULT_SERVER__ !== ""
    ? __ALIGN_DEFAULT_SERVER__
    : typeof __ALIGN_DEV_SERVER__ === "string"
      ? __ALIGN_DEV_SERVER__
      : "http://localhost:3000";

export class Ctx {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly paths: Paths;
  readonly credentials: CredentialStore;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  private api?: ApiClient;
  private serverOverride?: string;
  private upgradeNoted = false;

  constructor(
    readonly io: Io,
    readonly deps: Deps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.cwd = deps.cwd ?? process.cwd();
    this.paths = alignPaths(alignHome(this.env));
    this.credentials = new CredentialStore(
      this.paths,
      deps.keychain === undefined ? defaultKeychain(this.env, deps.platform) : deps.keychain,
    );
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** Prints a line. Control characters are removed: names and URLs from the server reach the terminal. */
  line(text = ""): void {
    this.io.out(`${stripControl(text)}\n`);
  }

  fail(text: string): void {
    this.io.err(`${stripControl(text)}\n`);
  }

  /** `--server` → `ALIGN_SERVER` → config.json → the baked default. Throws a printable error when invalid. */
  setServerOverride(url: string | undefined): void {
    this.serverOverride = url;
    this.api = undefined;
  }

  server(): string {
    const raw = this.serverOverride ?? this.env.ALIGN_SERVER ?? readConfig(this.paths).server ?? DEFAULT_SERVER;
    const s = normalizeServer(raw);
    if (!s) throw new UserError(copy.badServer);
    return s;
  }

  /** An unauthenticated client for this server. */
  client(): ApiClient {
    if (!this.api) {
      this.api = new ApiClient({
        server: this.server(),
        fetch: this.deps.fetch,
        onUpgradeRequired: () => {
          if (this.upgradeNoted) return;
          this.upgradeNoted = true;
          this.fail(copy.upgradeRequired(VERSION));
        },
      });
    }
    return this.api;
  }

  /** A client carrying the organisation's token for this server, or null when there is none. */
  clientFor(orgId: string): ApiClient | null {
    const token = this.credentials.tokenFor(orgId, this.server());
    return token ? this.client().withToken(token) : null;
  }

  async ask(question: string): Promise<string | null> {
    return this.io.ask ? this.io.ask(question) : null;
  }
}

import { stripControl } from "./control";

export { stripControl };

/**
 * The registry entry for the repository the person is in: its git toplevel (realpath), matched exactly (D81).
 * Outside a repository, or in a nested clone that was never registered, null.
 */
export async function repoHere(ctx: Ctx): Promise<{ root: string; entry: RepoEntry } | null> {
  const top = await toplevel(ctx.cwd, INTERACTIVE_GIT_TIMEOUT_MS);
  return top ? lookupRepo(readRegistry(ctx.paths), top) : null;
}

/** An error whose message is meant for the person (already worded in copy.ts). Exit code 1. */
export class UserError extends Error {
  override readonly name = "UserError";
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
