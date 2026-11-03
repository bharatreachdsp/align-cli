/**
 * The hidden internal entry points (docs/15 §Commands): `hook`, `git-hook`, `upload`, `flush`. They are
 * dispatched before commander (the hook fast path must stay fast). `hook`, `git-hook` and `upload` always exit 0
 * and print nothing except the documented JSON of session-start and stop (docs/15 §Guarantees 1); `flush` is run
 * by a person and prints its progress, exiting 1 when something is left to send. Their home directory is the installed
 * bundle's own (hook/home.ts), never `ALIGN_HOME`/`HOME` from the environment.
 */
import type { FetchLike } from "./api";
import type { Keychain } from "./credentials";
import { postCommit, prepareCommitMsg } from "./git/run";
import { internalHome } from "./hook/home";
import { logCount } from "./hook/log";
import { runHook } from "./hook/run";
import { alignPaths } from "./paths";
import { spawnUploader } from "./upload/lock";

/**
 * `pack` (what `/align` runs) and `mcp` (the MCP server a harness starts) are public but dispatched here, so the
 * session's environment cannot redirect them (S1, D416).
 */
export const INTERNAL_COMMANDS = ["hook", "git-hook", "upload", "flush", "pack", "mcp"] as const;
/** align.ts ends a hook process this long after it started (docs/15 §The hook fast path step 7). */
export const HOOK_DEADLINE_MS = 1400;

export type InternalDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (text: string) => void;
  /** `pack` only: its one-line failures. */
  err?: (text: string) => void;
  readStdin: () => Promise<Buffer>;
  bundlePath: string | null;
  nodePath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In-process tests only: the home to use instead of the installed bundle's. */
  home?: string;
  /** In-process tests only: replaces the detached uploader spawn. */
  spawnUploader?: () => void;
  /** In-process tests only: the server's fetch and the Keychain stand-in the uploader uses. */
  fetch?: FetchLike;
  keychain?: Keychain | null;
};

export async function runInternal(argv: readonly string[], deps: InternalDeps): Promise<number> {
  // Safety net for the test suite: a test that forgot its temporary home never reaches the real one.
  if (!deps.home && deps.env.VITEST && !deps.bundlePath) return 0;
  const paths = alignPaths(internalHome(deps.bundlePath, deps.home));
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "hook": {
        const stdin = await deps.readStdin();
        await runHook(args, {
          paths,
          env: deps.env,
          stdin,
          now: deps.now,
          out: deps.out,
          spawnUploader:
            deps.spawnUploader ?? (() => spawnUploader(paths, deps.bundlePath, deps.nodePath ?? process.execPath)),
          fetch: deps.fetch,
          keychain: deps.keychain,
          // The installed bundle exits 1.4 s after it started (align.ts); keep 100 ms to print the answer.
          remainingMs: deps.bundlePath ? () => HOOK_DEADLINE_MS - 100 - performance.now() : undefined,
        });
        return 0;
      }
      case "git-hook": {
        const [name, ...rest] = args;
        if (name === "prepare-commit-msg")
          await prepareCommitMsg(rest, {
            paths,
            cwd: deps.cwd,
            now: deps.now,
            env: deps.env,
            // From the bundle the clock starts with node, as the wrapper's 2 s does.
            elapsed: deps.bundlePath ? () => process.uptime() * 1000 : undefined,
          });
        else if (name === "post-commit") {
          await postCommit({ paths, cwd: deps.cwd, now: deps.now, env: deps.env });
          (deps.spawnUploader ?? (() => spawnUploader(paths, deps.bundlePath, deps.nodePath ?? process.execPath)))();
        }
        return 0;
      }
      case "upload": {
        // Loaded only here: the sending half (zod schemas, the API client) never weighs on a hook (D218).
        const { upload } = await import("./upload/daemon");
        return await upload(paths, {
          daemon: args.includes("--daemon"),
          now: deps.now,
          sleep: deps.sleep,
          fetch: deps.fetch,
          keychain: deps.keychain,
        });
      }
      case "pack": {
        const { packCommand } = await import("./pack/command");
        return await packCommand(args, {
          paths,
          cwd: deps.cwd,
          now: (deps.now ?? Date.now)(),
          out: deps.out,
          err: deps.err ?? deps.out,
          fetch: deps.fetch,
          keychain: deps.keychain,
        });
      }
      case "mcp": {
        const { mcpCommand } = await import("./mcp/server");
        return await mcpCommand(args, {
          paths,
          cwd: deps.cwd,
          out: deps.out,
          err: deps.err ?? deps.out,
          fetch: deps.fetch,
          keychain: deps.keychain,
        });
      }
      case "flush": {
        // Foreground: progress lines on stdout; exit 1 when something is left in the spool.
        const { flush } = await import("./upload/daemon");
        return await flush(paths, {
          daemon: false,
          now: deps.now,
          sleep: deps.sleep,
          fetch: deps.fetch,
          keychain: deps.keychain,
          out: deps.out,
        });
      }
      default:
        return 0;
    }
  } catch (e) {
    logCount(paths.logs, command && /^[a-z-]+$/.test(command) ? command : "internal", "error");
    void e;
    return 0;
  }
}

/** Reads stdin up to `max` bytes (more → empty: the hook treats it as unreadable); a terminal gives nothing. */
export function readProcessStdin(max: number, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve(Buffer.alloc(0));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (b: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.destroy();
      resolve(b);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks)), timeoutMs);
    stdin.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) return finish(Buffer.alloc(0));
      chunks.push(c);
    });
    stdin.on("end", () => finish(Buffer.concat(chunks)));
    stdin.on("error", () => finish(Buffer.alloc(0)));
  });
}
