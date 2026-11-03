/**
 * The bundle's entry point. The internal entry points (hooks, git hooks, the uploader) load only what they use:
 * esbuild turns the dynamic imports below into lazily initialised modules inside the one bundle file, so a hook
 * never evaluates commander, the prompts or the API client (docs/15 §Guarantees 2: fast path p95 < 200 ms).
 */
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const bundlePath = fileURLToPath(import.meta.url);

/**
 * Hard deadlines: a hook gives up after 1.4 s (docs/15: session-start answers within 1.5 s; a harness is never kept
 * waiting) and the git hooks' part after 2 s (the wrapper then runs the original hook, whose exit code is the
 * commit's). Files are written by rename, so stopping mid-way leaves nothing half-written.
 */
const DEADLINE_MS: Record<string, number> = { hook: 1400, "git-hook": 2000 };

if (["hook", "git-hook", "upload", "flush", "pack", "mcp"].includes(argv[0] ?? "")) {
  // A harness's `env` setting (a repository's `.claude/settings.json`) can set HOME; every program these entry points
  // start (git, the uploader, the Keychain's `security`) gets the account's own home instead, also when an older
  // shim passed HOME through or none was used (L16 review round 4, D276).
  let home: string | undefined;
  try {
    home = userInfo().homedir;
  } catch {
    home = undefined;
  }
  if (home && isAbsolute(home)) process.env.HOME = home;
  else delete process.env.HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_DIRS;
  const deadline = DEADLINE_MS[argv[0] ?? ""];
  if (deadline) setTimeout(() => process.exit(0), deadline).unref();
  const { readProcessStdin, runInternal } = await import("./internal");
  process.exitCode = await runInternal(argv, {
    env: process.env,
    cwd: process.cwd(),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    readStdin: () => readProcessStdin(4 * 1024 * 1024),
    bundlePath,
  });
} else {
  const { run } = await import("./main");
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  process.exitCode = await run(
    argv,
    {
      out: (t) => process.stdout.write(t),
      err: (t) => process.stderr.write(t),
      isTTY: tty,
      ask: tty
        ? async (q) => {
            const { createInterface } = await import("node:readline/promises");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return await rl.question(q);
            } finally {
              rl.close();
            }
          }
        : undefined,
    },
    { bundlePath },
  );
}
