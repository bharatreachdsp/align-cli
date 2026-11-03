/** Test helpers: a temporary home, a temporary git repository, and the CLI run in-process. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deps, run } from "../src/main";

export type Sandbox = { dir: string; home: string; alignHome: string; repo: string; cleanup(): void };

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@acme.example",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@acme.example",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

/** A temporary HOME with a git repository `repo` (one commit, `origin` set). Never the real home. */
export function sandbox(remote: string | null = "git@github.com:acme/checkout.git"): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "align-cli-test-")));
  const home = join(dir, "home");
  const repo = join(dir, "work", "checkout");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "synthetic\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "first");
  if (remote) gitIn(repo, "remote", "add", "origin", remote);
  return {
    dir,
    home,
    alignHome: join(home, ".align"),
    repo,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A file that looks like a built bundle, for self-install tests. */
export function fakeBundle(dir: string, content = "// fake bundle\n"): string {
  const p = join(dir, "dist", "align.mjs");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/**
 * The test's PATH: the caller's, without any directory holding a real `claude`, `codex`, `cursor` or `cursor-agent`,
 * so `init` never runs the developer's own harness CLIs (L18 registers the MCP server through them). Tests that want
 * one put a fake first.
 */
export function testPath(extra: string[] = []): string {
  const real = ["claude", "codex", "cursor", "cursor-agent"];
  const dirs = (process.env.PATH ?? "").split(":").filter((d) => d && !real.some((b) => existsSync(join(d, b))));
  return [...extra, ...dirs].join(":");
}

export type Result = { code: number; out: string; err: string };

export async function cli(
  argv: string[],
  sb: Sandbox,
  deps: Deps & { tty?: boolean; answers?: string[] } = {},
): Promise<Result> {
  let out = "";
  let err = "";
  const answers = [...(deps.answers ?? [])];
  const code = await run(
    argv,
    {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      isTTY: deps.tty ?? false,
      ask: deps.tty
        ? async (q) => {
            out += q;
            return answers.shift() ?? "";
          }
        : undefined,
    },
    {
      cwd: sb.repo,
      keychain: null,
      sleep: async () => {},
      // Never the real controlling terminal in a test: no terminal unless the test gives answers (D517).
      ttyAsk: async () => null,
      ...deps,
      env: { HOME: sb.home, PATH: testPath(), ...deps.env },
    },
  );
  return { code, out, err };
}
