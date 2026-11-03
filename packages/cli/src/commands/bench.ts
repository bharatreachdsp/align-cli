/**
 * `align doctor --bench` (docs/15 §Commands, §Guarantees 2; G1's "hook fast path p95 < 200 ms"): 200 synthetic
 * hook invocations per Claude Code hook event, each a real process through a shim, timed end to end, p50 and p95
 * printed. It runs in a temporary home and a temporary repository with a copy of this bundle installed there, so
 * the person's own `~/.align`, spool and server are never touched; the temporary uploader lock keeps hooks from
 * spawning an uploader during the measurement. Passes when every event's p95 is under 200 ms (session start: 1.5 s).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR_NAME } from "@align/core/brand";
import type { Ctx } from "../context";
import { copy } from "../copy";
import { ensureDir } from "../fsx";
import { alignPaths } from "../paths";
import { upsertRepo } from "../registry";
import { findGit, installShim, isBundlePath } from "../shim";
import { listSpool } from "../upload/spool";
import { VERSION } from "../version";

export const BENCH_RUNS = 200;
export const FAST_PATH_P95_MS = 200;
export const SESSION_START_P95_MS = 1500;
const EVENTS = ["session-start", "prompt", "stop", "session-end"] as const;

export type BenchResult = {
  event: string;
  runs: number;
  p50: number;
  p95: number;
  ok: boolean;
  /** Runs that did not exit 0. */
  failed: number;
  /** Spool files written (one per run when the hook works). */
  spooled: number;
};

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

function payload(event: (typeof EVENTS)[number], i: number, cwd: string): string {
  const base = { transcript_path: null, cwd };
  switch (event) {
    case "session-start":
      return JSON.stringify({
        ...base,
        session_id: `bench-start-${i}`,
        hook_event_name: "SessionStart",
        source: "startup",
      });
    case "prompt":
      return JSON.stringify({
        ...base,
        session_id: "bench-session",
        hook_event_name: "UserPromptSubmit",
        prompt: `synthetic prompt ${i}`,
      });
    case "stop":
      return JSON.stringify({
        ...base,
        session_id: "bench-session",
        hook_event_name: "Stop",
        last_assistant_message: `synthetic reply ${i}`,
        stop_hook_active: false,
      });
    case "session-end":
      return JSON.stringify({ ...base, session_id: `bench-end-${i}`, hook_event_name: "SessionEnd", reason: "other" });
  }
}

/** Runs the measurement against `bundle`; `runs` per event (200 by default). */
export function runBench(bundle: string, runs = BENCH_RUNS, nodePath = process.execPath): BenchResult[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "align-bench-")));
  try {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const gitEnv = {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Bench",
      GIT_AUTHOR_EMAIL: "bench@bench.example",
      GIT_COMMITTER_NAME: "Bench",
      GIT_COMMITTER_EMAIL: "bench@bench.example",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "synthetic\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    const paths = alignPaths(join(home, HOME_DIR_NAME));
    const { shim } = installShim(paths, {
      bundleSource: bundle,
      nodePath,
      version: VERSION,
      gitPath: findGit(process.env.PATH),
    });
    upsertRepo(paths, realpathSync(repo), {
      repo_id: "bench",
      org_id: "bench",
      remote_norm: "example.com/bench/bench",
      root_commit: git("rev-list", "--max-parents=0", "HEAD"),
      default_branch: "main",
      opted_in: true,
      harnesses: ["claude-code"],
      installed_at: new Date().toISOString(),
    });
    // This process "holds" the uploader lock: the measured hooks never spawn an uploader.
    ensureDir(paths.spool);
    writeFileSync(paths.uploadLock, `${process.pid} ${Date.now() + 3_600_000}\n`);
    const results: BenchResult[] = [];
    const spoolFiles = () => listSpool(paths).length;
    for (const event of EVENTS) {
      const times: number[] = [];
      let failed = 0;
      const before = spoolFiles();
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = spawnSync(shim, ["hook", event, "--harness", "claude-code"], {
          input: payload(event, i, repo),
          env: { PATH: process.env.PATH, HOME: home },
          stdio: ["pipe", "ignore", "ignore"],
        });
        times.push(performance.now() - t0);
        if (r.error || r.status !== 0) failed++;
      }
      times.sort((a, b) => a - b);
      const p95 = quantile(times, 0.95);
      const budget = event === "session-start" ? SESSION_START_P95_MS : FAST_PATH_P95_MS;
      // A run counts only if the hook did its whole job: exit 0 and one spool file each (a broken shim that exits at
      // once would otherwise look fast).
      const spooled = spoolFiles() - before;
      results.push({
        event,
        runs,
        p50: quantile(times, 0.5),
        p95,
        ok: p95 < budget && failed === 0 && spooled === runs,
        failed,
        spooled,
      });
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The bundle to measure: the running one, else the one installed in `~/.align/lib`. */
function bundleToBench(ctx: Ctx): string | null {
  if (isBundlePath(ctx.deps.bundlePath ?? null)) return ctx.deps.bundlePath as string;
  return isBundlePath(ctx.paths.current) ? ctx.paths.current : null;
}

export async function bench(ctx: Ctx, opts: { json?: boolean; runs?: number }): Promise<number> {
  const bundle = bundleToBench(ctx);
  if (!bundle) {
    ctx.fail(copy.doctor.benchSource);
    return 1;
  }
  const results = runBench(bundle, opts.runs ?? BENCH_RUNS, ctx.deps.nodePath ?? process.execPath);
  const ok = results.every((r) => r.ok);
  if (opts.json) {
    ctx.line(JSON.stringify({ ok, results }, null, 2));
  } else {
    for (const r of results) {
      ctx.line(copy.doctor.benchLine(r.event, r.p50, r.p95, r.runs));
      if (r.failed > 0 || r.spooled !== r.runs) ctx.line(copy.doctor.benchBroken(r.failed, r.spooled, r.runs));
    }
    ctx.line(ok ? copy.doctor.benchOk : copy.doctor.benchFail);
  }
  return ok ? 0 : 1;
}
