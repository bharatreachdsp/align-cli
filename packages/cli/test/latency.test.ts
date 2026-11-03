/**
 * The built bundle as Claude Code runs it: through the installed shim, a payload on stdin, in a temporary HOME.
 * Proves the fast-path budget (docs/15 §Guarantees 2: p95 < 200 ms over 200 runs; G1) and that the hook's home is
 * the installed bundle's own, whatever `ALIGN_HOME`, `HOME` or `ALIGN_SERVER` the environment carries.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeOfBundle } from "../src/hook/home";
import { writePackCache } from "../src/pack/cache";
import { alignPaths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { findGit, installShim } from "../src/shim";
import { BUDGET_MS, budgetScore, runReference, writeReference } from "./calibrate";
import { gitIn, type Sandbox, sandbox } from "./helpers";
import { testCredentials, testPack } from "./pack-fixture";

const cliRoot = join(dirname(new URL(import.meta.url).pathname), "..");
let sb: Sandbox;
let out: string;
let shim: string;
let reference: { module: string; cache: string };

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "align-latency-build-"));
  const build = spawnSync("pnpm", ["exec", "tsup", "--out-dir", out], { cwd: cliRoot, encoding: "utf8" });
  if (build.status !== 0) throw new Error("bundle build failed");
  sb = sandbox();
  // The machine-speed reference (calibrate.ts), its compile cache warmed like an installed hook's.
  reference = writeReference(join(out, "reference"));
  runReference(reference);
  const paths = alignPaths(sb.alignHome);
  shim = installShim(paths, {
    bundleSource: join(out, "align.mjs"),
    nodePath: process.execPath,
    version: "0.0.0",
    gitPath: findGit(process.env.PATH),
  }).shim;
  upsertRepo(paths, sb.repo, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses: ["claude-code"],
    installed_at: new Date().toISOString(),
  });
  // A live uploader "holds" the lock, so the hooks do not spawn one during the measurement.
  mkdirSync(join(sb.alignHome, "spool"), { recursive: true });
  writeFileSync(paths.uploadLock, `${process.pid} ${Date.now()}\n`);
}, 120_000);

afterAll(async () => {
  // A daemon spawned by the jsonl measurement exits after 10 s idle; wait for it before removing its home.
  const lock = join(sb.alignHome, "spool", "upload.lock");
  for (let i = 0; i < 300 && existsSync(lock); i++) await new Promise((r) => setTimeout(r, 100));
  sb?.cleanup();
  if (out) rmSync(out, { recursive: true, force: true });
}, 40_000);

/** Three windows of 200 runs at up to about 400 ms each under heavy load, plus the build: well inside this. */
const WINDOWS_TIMEOUT = 600_000;

/** One reference run (calibrate.ts) every this many hook runs, interleaved so both see the same machine. */
const REFERENCE_EVERY = 4;

/**
 * `runs` hook runs with a reference run after every fourth, so the speed factor is taken under the same load.
 * Returns the sorted hook times and the reference times.
 */
function measured(runs: number, one: (i: number) => number): { times: number[]; refs: number[] } {
  const times: number[] = [];
  const refs: number[] = [];
  for (let i = 0; i < runs; i++) {
    times.push(one(i));
    if (i % REFERENCE_EVERY === REFERENCE_EVERY - 1) refs.push(runReference(reference));
  }
  times.sort((a, b) => a - b);
  return { times, refs };
}

/**
 * Up to three windows of `runs` runs: a shared machine can be busy for a moment, and the budget must hold in one
 * window (the best score is returned, measuring stops at the first window within budget). A window over 300 ms is
 * logged as a warning, not failed: the verdict is the best window's score (L12 review round 4). The score is the
 * raw p95 off CI and the p95 in build-VM milliseconds on CI (calibrate.ts, D1239).
 */
function bestOfThree(label: string, runs: number, one: (window: number, i: number) => number): number {
  let best = Number.POSITIVE_INFINITY;
  let bestRaw = Number.POSITIVE_INFINITY;
  const p95At = Math.ceil(runs * 0.95) - 1;
  for (let w = 0; w < 3 && best >= BUDGET_MS; w++) {
    const { times, refs } = measured(runs, (i) => one(w, i));
    const p50 = times[Math.floor(runs / 2) - 1] ?? 0;
    const p95 = times[p95At] ?? 0;
    console.log(`${label} over ${runs} runs (window ${w + 1}): p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    if (p95 >= 300) console.warn(`${label}: window ${w + 1} p95 ${p95.toFixed(1)} ms is over 300 ms (machine busy?)`);
    best = Math.min(best, budgetScore(`${label} (window ${w + 1})`, p95, refs));
    bestRaw = Math.min(bestRaw, p95);
  }
  // One noisy window is a warning; every window over 300 ms raw is a failure of its own, whatever the verdict.
  if (bestRaw >= 300) throw new Error(`${label}: every window's p95 was over 300 ms (best ${bestRaw.toFixed(1)} ms)`);
  return best;
}

const payload = (event: string, i: number) =>
  JSON.stringify({
    session_id: "5f0c2a8e-1d4b-4c7a-9e21-7b3f6a0d9c11",
    transcript_path: null,
    cwd: sb.repo,
    hook_event_name: event === "prompt" ? "UserPromptSubmit" : "Stop",
    prompt: `prompt number ${i}`,
    last_assistant_message: `reply number ${i}`,
    stop_hook_active: false,
  });

describe("hook fast path, built bundle", () => {
  it("finds its home from the installed bundle, never from the environment", () => {
    expect(homeOfBundle(join(sb.alignHome, "lib", "align.mjs"))).toBe(realpathSync(sb.alignHome));
    expect(homeOfBundle(join(out, "align.mjs"))).toBeNull();
    const evil = join(sb.dir, "evil");
    mkdirSync(evil);
    const r = spawnSync(shim, ["hook", "session-start", "--harness", "claude-code"], {
      input: JSON.stringify({ session_id: "s-env", cwd: sb.repo, hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: evil,
        ALIGN_HOME: join(evil, ".align"),
        ALIGN_SERVER: "https://evil.example",
      },
    });
    expect(r.status).toBe(0);
    // Nothing cached and not signed in: no pack, so nothing is printed (D250).
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readdirSync(evil)).toEqual([]);
    expect(existsSync(join(sb.alignHome, "sessions", "index.json"))).toBe(true);
  });

  it(
    "p95 under 200 ms over 200 runs (prompt and stop, hooks mode)",
    () => {
      let spooledTotal = 0;
      const best = bestOfThree("hook fast path", 200, (w, i) => {
        const event = i % 2 ? "stop" : "prompt";
        const t0 = performance.now();
        const r = spawnSync(shim, ["hook", event, "--harness", "claude-code"], {
          input: payload(event, w * 1000 + i),
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: sb.home },
        });
        const ms = performance.now() - t0;
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
        spooledTotal++;
        return ms;
      });
      expect(best).toBeLessThan(BUDGET_MS);
      // Every run spooled: 100 prompts and 100 stops per window (a stop is a session.stop and a reply line).
      const dir = join(sb.alignHome, "spool");
      const files = readdirSync(dir)
        .filter((d) => /^[0-9a-f]{16}$/.test(d))
        .flatMap((d) => readdirSync(join(dir, d)).map((f) => join(dir, d, f)));
      const events = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).events);
      expect(events.filter((e: { kind: string }) => e.kind === "transcript.chunk")).toHaveLength(spooledTotal);
    },
    WINDOWS_TIMEOUT,
  );

  it(
    "p95 under 200 ms for the jsonl Stop path, spawning the uploader (50 runs)",
    () => {
      rmSync(join(sb.alignHome, "spool", "upload.lock"), { force: true });
      const transcript = join(sb.dir, "t.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "user", cwd: sb.repo, message: { role: "user", content: "hello" } })}\n`,
      );
      const best = bestOfThree("jsonl Stop with uploader spawn", 50, (w, i) => {
        const t0 = performance.now();
        const r = spawnSync(shim, ["hook", "stop", "--harness", "claude-code"], {
          input: JSON.stringify({
            session_id: "jsonl-session",
            transcript_path: transcript,
            cwd: sb.repo,
            hook_event_name: "Stop",
            last_assistant_message: `reply ${w}-${i}`,
          }),
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: sb.home },
        });
        const ms = performance.now() - t0;
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("");
        return ms;
      });
      expect(best).toBeLessThan(BUDGET_MS);
    },
    WINDOWS_TIMEOUT,
  );

  it(
    "session-start with a fresh pack cached (a new session each run, pack and line printed) stays under 200 ms at p95 (50 runs)",
    () => {
      const paths = alignPaths(sb.alignHome);
      // The pack is read only with a credential record for its organisation and server (D402).
      writeFileSync(paths.credentials, testCredentials("https://staging.example"), { mode: 0o600 });
      const key = {
        root: sb.repo,
        repoId: "repo_1",
        orgId: "org_1",
        server: "https://staging.example",
        branch: "main",
      };
      writePackCache(paths, key, testPack(), Date.now());
      let best = Number.POSITIVE_INFINITY;
      try {
        // Up to three windows, as for the other budgets: the budget must hold in one (D1242; a single window failed at
        // random when a busy stretch of a shared machine fell on the hook runs and not on the reference runs).
        best = bestOfThree("session-start (fresh cache)", 50, (w, i) => {
          const t0 = performance.now();
          const r = spawnSync(shim, ["hook", "session-start", "--harness", "claude-code"], {
            input: JSON.stringify({
              session_id: `start-${w}-${i}`,
              transcript_path: null,
              cwd: sb.repo,
              hook_event_name: "SessionStart",
              source: "startup",
            }),
            encoding: "utf8",
            env: { PATH: process.env.PATH, HOME: sb.home },
          });
          const ms = performance.now() - t0;
          // Every run, in every window: the pack and the line are printed (functional, never retried away).
          const o = JSON.parse(r.stdout);
          expect(o.hookSpecificOutput.additionalContext).toBe(testPack().markdown);
          expect(o.systemMessage).toBe(testPack().notice_line);
          return ms;
        });
      } finally {
        rmSync(paths.packCache(sb.repo, "main"), { force: true });
        rmSync(paths.credentials, { force: true });
      }
      // A fresh cache never loads zod or the API client: the fast path's budget, not session start's 1.5 s (a best
      // window's raw p95 over 300 ms fails in bestOfThree).
      expect(best).toBeLessThan(BUDGET_MS);
    },
    WINDOWS_TIMEOUT,
  );

  it("a server that never answers: the stale cache is served within the session-start budget", async () => {
    const paths = alignPaths(sb.alignHome);
    // Accepts connections and never answers.
    const sockets: Socket[] = [];
    const server = createServer((s) => {
      sockets.push(s);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    writeFileSync(paths.credentials, testCredentials(`http://127.0.0.1:${port}`), { mode: 0o600 });
    writePackCache(
      paths,
      { root: sb.repo, repoId: "repo_1", orgId: "org_1", server: `http://127.0.0.1:${port}`, branch: "main" },
      testPack(),
      Date.now() - 30 * 60 * 1000,
    );
    try {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const r = await new Promise<{ stdout: string }>((resolve) => {
          const child = spawn(shim, ["hook", "session-start", "--harness", "claude-code"], {
            env: { PATH: process.env.PATH, HOME: sb.home },
          });
          let stdout = "";
          child.stdout.on("data", (d) => {
            stdout += d;
          });
          child.on("close", () => resolve({ stdout }));
          child.stdin.end(
            JSON.stringify({
              session_id: `stale-${i}`,
              transcript_path: null,
              cwd: sb.repo,
              hook_event_name: "SessionStart",
              source: "startup",
            }),
          );
        });
        times.push(performance.now() - t0);
        const o = JSON.parse(r.stdout);
        const lines = (o.hookSpecificOutput.additionalContext as string).split("\n");
        expect(lines[0]).toBe("<!-- align-pack v1 -->");
        expect(lines[1]).toBe(
          "ALIGN · This pack may be out of date: the server did not answer, so this is the one fetched 30 minutes ago.",
        );
        expect(o.systemMessage).toBeUndefined();
      }
      console.log(`session-start against a silent server: max ${Math.max(...times).toFixed(0)} ms over 5 runs`);
      expect(Math.max(...times)).toBeLessThan(1500);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
      rmSync(paths.credentials, { force: true });
      rmSync(paths.packCache(sb.repo, "main"), { force: true });
    }
  }, 60_000);

  it("the shim clears the harness environment for internal commands: no proxy, no extra CA, no TLS opt-out (L16 round 3)", async () => {
    const paths = alignPaths(sb.alignHome);
    const http = await import("node:http");
    const https = await import("node:https");
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "align-tls-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    // A certificate nobody trusts; the environment offers it as an extra CA and switches verification off.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const tlsHits: string[] = [];
    const tls = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      tlsHits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(testPack()));
    });
    const proxyHits: string[] = [];
    const proxy = http.createServer((req, res) => {
      proxyHits.push(`${req.method} ${req.url}`);
      res.end();
    });
    proxy.on("connect", (req, socket) => {
      proxyHits.push(`CONNECT ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const tlsUrl = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    writeFileSync(paths.credentials, testCredentials(tlsUrl), { mode: 0o600 });
    const hostile = {
      PATH: process.env.PATH,
      HOME: sb.home,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
      NO_PROXY: "",
      NODE_EXTRA_CA_CERTS: cert,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SSL_CERT_FILE: cert,
      SSL_CERT_DIR: dir,
    };
    const runIt = (cmd: string, args: string[], input: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const c = spawn(cmd, args, { cwd: sb.repo, env: hostile, timeout: 15_000 });
        let out = "";
        c.stdout.on("data", (d) => {
          out += d;
        });
        c.on("close", (code) => resolve({ code, out }));
        c.stdin.end(input);
      });
    const start = (i: number) =>
      JSON.stringify({
        session_id: `proxy-${i}`,
        transcript_path: null,
        cwd: sb.repo,
        hook_event_name: "SessionStart",
        source: "startup",
      });
    try {
      // Control: the same bundle started without the shim does go through the proxy (the attack is real).
      // (the installed bundle, so its home is the test's own, never the real ~/.align)
      const ctl = await runIt(
        process.execPath,
        [join(sb.alignHome, "lib", "align.mjs"), "hook", "session-start", "--harness", "claude-code"],
        start(0),
      );
      expect(ctl.code).toBe(0);
      const control = proxyHits.length + tlsHits.length;
      proxyHits.length = 0;
      tlsHits.length = 0;
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
      const hook = await runIt(shim, ["hook", "session-start", "--harness", "claude-code"], start(1));
      const pack = await runIt(shim, ["pack", "--format", "md"], "");
      expect(control).toBeGreaterThan(0);
      expect(hook.code).toBe(0);
      expect(hook.out).toBe("");
      expect(pack.code).toBe(1);
      expect(proxyHits).toEqual([]);
      // The untrusted certificate is refused: no request ever completed at the TLS server.
      expect(tlsHits).toEqual([]);
    } finally {
      tls.close();
      proxy.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(paths.credentials, { force: true });
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
    }
  }, 60_000);

  it("align pack (what /align runs) ignores a hostile session environment, through the real bundle (L16 S1)", async () => {
    const paths = alignPaths(sb.alignHome);
    // The real record names a server that refuses connections at once, so the cached pack stands in.
    writeFileSync(paths.credentials, testCredentials("http://127.0.0.1:9"), { mode: 0o600 });
    const key = { root: sb.repo, repoId: "repo_1", orgId: "org_1", server: "http://127.0.0.1:9", branch: "main" };
    writePackCache(paths, key, testPack(), Date.now() - 20 * 60 * 1000);
    // What a cloned repository could set through `.claude/settings.json` `env`: a home of its own whose record sends the
    // same organisation to its own server, and git pointed at another repository.
    const hits: string[] = [];
    const evil = (await import("node:http")).createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("{}");
    });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
    const evilUrl = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
    const evilHome = join(sb.dir, "evil-home");
    mkdirSync(join(evilHome, ".align"), { recursive: true });
    writeFileSync(join(evilHome, ".align", "credentials.json"), testCredentials(evilUrl), { mode: 0o600 });
    const other = sandbox("git@github.com:evil/other.git");
    try {
      const r = spawnSync(shim, ["pack", "--format", "md"], {
        cwd: sb.repo,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: evilHome,
          ALIGN_HOME: join(evilHome, ".align"),
          ALIGN_SERVER: evilUrl,
          ALIGN_CREDENTIAL_STORE: "file",
          GIT_DIR: join(other.repo, ".git"),
          GIT_WORK_TREE: other.repo,
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("AL-12");
      expect(r.stdout).toContain("may be out of date");
      expect(hits).toEqual([]);
    } finally {
      other.cleanup();
      evil.close();
      rmSync(paths.credentials, { force: true });
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
    }
  }, 30_000);

  it("git never reads a configuration the session's environment points at: no fsmonitor runs (L16 round 4)", async () => {
    const paths = alignPaths(sb.alignHome);
    // A server that answers every pack request, so session-start and `align pack` both reach `git status` (pack/hint.ts).
    const hits: string[] = [];
    const server = (await import("node:http")).createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(testPack()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(paths.credentials, testCredentials(url), { mode: 0o600 });
    // What a cloned repository could ship and point `.claude/settings.json` `env` at: a HOME (and an XDG config
    // directory) whose git configuration names an fsmonitor script, which `git status` would run as the user.
    const evil = join(sb.dir, "evil-git");
    const marker = join(sb.dir, "fsmonitor-ran");
    const script = join(evil, "fsmonitor.sh");
    mkdirSync(join(evil, "xdg", "git"), { recursive: true });
    writeFileSync(script, `#!/bin/sh\necho "$0" >> '${marker}'\n`, { mode: 0o755 });
    const fsmonitor = `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${evil}\n`;
    writeFileSync(join(evil, ".gitconfig"), fsmonitor);
    writeFileSync(join(evil, "xdg", "git", "config"), fsmonitor);
    const hostile = {
      PATH: process.env.PATH,
      HOME: evil,
      XDG_CONFIG_HOME: join(evil, "xdg"),
      NODE_COMPILE_CACHE: join(evil, "cache"),
    };
    const start = (i: number) =>
      JSON.stringify({ session_id: `fsm-${i}`, cwd: sb.repo, hook_event_name: "SessionStart", source: "startup" });
    // Async: the pack server answers from this process, so the children must not block its event loop.
    const runIt = (cmd: string, args: string[], env: NodeJS.ProcessEnv, input = "") =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const c = spawn(cmd, args, { cwd: sb.repo, env, timeout: 15_000 });
        let stdout = "";
        let stderr = "";
        c.stdout.on("data", (d) => {
          stdout += d;
        });
        c.stderr.on("data", (d) => {
          stderr += d;
        });
        c.on("close", (status) => resolve({ status, stdout, stderr }));
        c.stdin.end(input);
      });
    const runAll = async (env: NodeJS.ProcessEnv, i: number) => {
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
      const hook = await runIt(shim, ["hook", "session-start", "--harness", "claude-code"], env, start(i));
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
      const pack = await runIt(shim, ["pack", "--format", "md"], env);
      // The shim unsets a compile cache it did not choose (a direct start reads it before any code of ours runs).
      const cacheUsed = existsSync(join(evil, "cache"));
      // The same bundle started directly (an old shim, or none): the bundle's own defence must hold too.
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
      const direct = await runIt(
        process.execPath,
        [join(sb.alignHome, "lib", "align.mjs"), "hook", "session-start", "--harness", "claude-code"],
        env,
        start(i + 1),
      );
      return { hook, pack, direct, cacheUsed };
    };
    try {
      // Control: plain git with this environment does run the script (the attack is real on this git).
      spawnSync("git", ["status", "--porcelain"], { cwd: sb.repo, env: hostile });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const r = await runAll(hostile, 0);
      expect(r.hook.status).toBe(0);
      expect(r.pack.status).toBe(0);
      expect(r.pack.stdout).toContain("AL-12");
      expect(r.direct.status).toBe(0);
      // The fetch path ran (so `git status` ran) three times, and no script did.
      expect(hits.length).toBeGreaterThanOrEqual(3);
      expect(existsSync(marker)).toBe(false);
      expect(r.cacheUsed).toBe(false);

      // A repository's own .git/config (a crafted repository opened from an archive) is blocked as well (D276).
      gitIn(sb.repo, "config", "core.fsmonitor", script);
      spawnSync("git", ["status", "--porcelain"], { cwd: sb.repo, env: { PATH: process.env.PATH, HOME: sb.home } });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      const local = await runAll({ PATH: process.env.PATH, HOME: sb.home }, 10);
      expect(local.hook.status).toBe(0);
      expect(local.pack.stdout).toContain("AL-12");
      expect(existsSync(marker)).toBe(false);
    } finally {
      spawnSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: sb.repo });
      server.close();
      rmSync(paths.credentials, { force: true });
      rmSync(paths.packCacheDir(sb.repo), { recursive: true, force: true });
    }
  }, 60_000);

  it("hook latency is unchanged with a 10,000-file spool (the hook never lists the spool)", () => {
    const paths = alignPaths(sb.alignHome);
    writeFileSync(paths.uploadLock, `${process.pid} ${Date.now() + 3_600_000}\n`);
    let n = 0;
    const measure = () => {
      const { times, refs } = measured(60, () => {
        const t0 = performance.now();
        spawnSync(shim, ["hook", "prompt", "--harness", "claude-code"], {
          input: payload("prompt", 50_000 + n++ * 7),
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: sb.home },
        });
        return performance.now() - t0;
      });
      return { p50: times[29] ?? 0, p95: times[56] ?? 0, refs };
    };
    const dir = join(sb.alignHome, "spool", "ffffffffffffffff");
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ version: 1, root: "/nowhere", repo_id: "x", events: [] });
    // A loaded build VM moves single measurements; up to three rounds, each comparing the two spools back to back.
    let ok = false;
    for (let round = 0; round < 3 && !ok; round++) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const before = measure();
      for (let i = 0; i < 10_000; i++)
        writeFileSync(join(dir, `${String(i).padStart(14, "0")}-${"0".repeat(12)}.json`), body);
      const after = measure();
      console.log(
        `prompt hook, 60 runs (round ${round + 1}): empty spool p50 ${before.p50.toFixed(1)} / p95 ${before.p95.toFixed(1)} ms; 10,000 files p50 ${after.p50.toFixed(1)} / p95 ${after.p95.toFixed(1)} ms`,
      );
      // Same distribution within noise: the median moves by less than 15 ms (or 20 % under load); and the fast-path
      // budget still holds with the full spool (raw under 300 ms, and in budget: calibrate.ts on CI).
      const inBudget =
        after.p95 < 300 &&
        budgetScore(`prompt hook, 10,000 files (round ${round + 1})`, after.p95, after.refs) < BUDGET_MS;
      ok = inBudget && after.p50 - before.p50 < Math.max(15, before.p50 * 0.2);
    }
    expect(ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    rmSync(paths.uploadLock, { force: true });
  }, 120_000);

  it("two uploaders started at the same moment: one runs, the other exits at once", async () => {
    const paths = alignPaths(sb.alignHome);
    rmSync(paths.uploadLock, { force: true });
    const log = join(sb.alignHome, "logs", "align.log");
    const starts = () =>
      existsSync(log) ? (readFileSync(log, "utf8").match(/ upload daemon_start/g)?.length ?? 0) : 0;
    const before = starts();
    const { spawn } = await import("node:child_process");
    const run = () =>
      new Promise<number>((resolve) => {
        const t0 = performance.now();
        const c = spawn(shim, ["upload", "--daemon"], {
          stdio: "ignore",
          env: { PATH: process.env.PATH, HOME: sb.home },
        });
        c.on("exit", () => resolve(performance.now() - t0));
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(starts() - before).toBe(1);
    // The one that ran idled 10 s; the other found the lock taken and left straight away.
    expect(Math.min(a, b)).toBeLessThan(2000);
    expect(Math.max(a, b)).toBeGreaterThan(9000);
    expect(existsSync(paths.uploadLock)).toBe(false);
  }, 60_000);

  it("align doctor --bench measures every Claude Code hook event through a temporary install", async () => {
    const { runBench } = await import("../src/commands/bench");
    const results = runBench(join(out, "align.mjs"), 20);
    console.log(results.map((r) => `${r.event} p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)}`).join("; "));
    expect(results.map((r) => r.event)).toEqual(["session-start", "prompt", "stop", "session-end"]);
    for (const r of results) {
      expect(r.runs).toBe(20);
      expect(r.p50).toBeGreaterThan(0);
      expect(r.p95).toBeGreaterThanOrEqual(r.p50);
    }
    expect(results.every((r) => r.failed === 0 && r.spooled === 20)).toBe(true);
    // A broken bundle that exits at once is fast, and must not pass.
    const broken = join(sb.dir, "broken", "align-9.9.9.mjs");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "process.exit(0);\n");
    const bad = runBench(broken, 5);
    expect(bad.every((r) => !r.ok && r.spooled === 0)).toBe(true);
    // It ran in its own temporary home: nothing of it is left in the sandbox's.
    expect(readdirSync(sb.alignHome)).not.toContain("bench");
  }, 120_000);

  it("the shim keeps NODE_OPTIONS out and names the git found at install", () => {
    const body = readFileSync(shim, "utf8");
    expect(body).toContain("unset NODE_OPTIONS NODE_PATH");
    expect(body).toMatch(/ALIGN_GIT='\/[^']+\/git'/);
  });
});
