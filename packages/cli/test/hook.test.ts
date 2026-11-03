/**
 * The hook fast path in-process (docs/15 §The hook fast path, §Guarantees 1, 5): a temporary HOME, a registry
 * entry written directly, the synthetic 2.1.307 payloads. Never the real home.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alignPaths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";

const FIX = join(import.meta.dirname, "..", "src", "harness", "claude-code", "__fixtures__", "claude-code-2.1.307");
const ROOT_COMMIT_RE = /^[0-9a-f]{40}$/;

let sb: Sandbox;
afterEach(() => sb?.cleanup());

type Payloads = Record<"SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd", Record<string, unknown>>;

function payloads(cwd: string, over: Record<string, unknown> = {}): Payloads {
  const p = JSON.parse(readFileSync(join(FIX, "payloads.json"), "utf8").replaceAll("__ROOT__", cwd)) as Payloads;
  for (const k of Object.keys(p) as (keyof Payloads)[]) Object.assign(p[k], over);
  return p;
}

function register(optedIn = true, root = sb.repo) {
  upsertRepo(alignPaths(sb.alignHome), root, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(root, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: optedIn,
    harnesses: ["claude-code"],
    installed_at: new Date().toISOString(),
  });
}

let clock = Date.parse("2026-10-22T09:00:00Z");
async function hook(event: string, payload: unknown, env: Record<string, string> = {}, spawns: string[] = []) {
  clock += 5000;
  const stdin = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  return cli(["hook", event, "--harness", "claude-code"], sb, {
    internalHome: sb.alignHome,
    readStdin: async () => stdin,
    spawnUploader: () => spawns.push(event),
    now: () => clock,
    env,
  });
}

const upload = () => cli(["upload"], sb, { internalHome: sb.alignHome, now: () => clock });

type Spooled = { kind: string; payload: Record<string, unknown>; session: { id: string }; [k: string]: unknown };
function spooled(): Spooled[] {
  const dir = join(sb.alignHome, "spool");
  if (!existsSync(dir)) return [];
  const out: Spooled[] = [];
  for (const sub of readdirSync(dir).sort()) {
    if (!/^[0-9a-f]{16}$/.test(sub)) continue;
    for (const f of readdirSync(join(dir, sub)).sort())
      out.push(...JSON.parse(readFileSync(join(dir, sub, f), "utf8")).events);
  }
  return out;
}
const lines = () =>
  spooled()
    .filter((e) => e.kind === "transcript.chunk")
    .flatMap(
      (e) => e.payload.lines as { n: number; src: string; role: string; text: string; tool?: { paths: string[] } }[],
    );

describe("align hook --harness claude-code", () => {
  it("writes nothing at all outside a registered, opted-in repository", async () => {
    sb = sandbox();
    const p = payloads(sb.repo, { transcript_path: null });
    for (const [event, key] of [
      ["session-start", "SessionStart"],
      ["prompt", "UserPromptSubmit"],
      ["stop", "Stop"],
      ["session-end", "SessionEnd"],
    ] as const) {
      expect(await hook(event, p[key])).toEqual({ code: 0, out: "", err: "" });
    }
    register(false);
    expect(await hook("session-start", p.SessionStart)).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(join(sb.alignHome, "spool"))).toBe(false);
    expect(existsSync(join(sb.alignHome, "sessions"))).toBe(false);
  });

  it("never uses a parent repository's opt-in for a nested clone", async () => {
    sb = sandbox();
    register();
    const nested = join(sb.repo, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    gitIn(nested, "init", "-q", "-b", "main");
    expect((await hook("session-start", payloads(nested).SessionStart)).out).toBe("");
    expect(spooled()).toEqual([]);
  });

  it("exits at once when Cursor runs the Claude Code hooks (CURSOR_VERSION)", async () => {
    sb = sandbox();
    register();
    const r = await hook("session-start", payloads(sb.repo).SessionStart, { CURSOR_VERSION: "x" });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(spooled()).toEqual([]);
  });

  it("session-start mints a session, spools session.start, and stays quiet with no pack to serve", async () => {
    sb = sandbox();
    register();
    const spawns: string[] = [];
    const p = payloads(sb.repo);
    const r = await hook("session-start", p.SessionStart, {}, spawns);
    // Not signed in and nothing cached: no pack, and nothing applies, so nothing is printed (docs/19 budgets, D250).
    expect(r).toEqual({ code: 0, out: "", err: "" });
    const [e] = spooled();
    expect(e).toMatchObject({
      schema_version: 2,
      kind: "session.start",
      harness: { name: "claude-code", session_id: p.SessionStart.session_id, hook_event: "SessionStart" },
      repo: { remote_norm: "github.com/acme/checkout", branch: "main" },
      cwd_rel: "",
      capture: "live",
      payload: { source: "startup", transcript_mode: "jsonl" },
      redaction: { version: expect.any(Number) },
    });
    expect((e?.repo as { root_commit: string } | undefined)?.root_commit).toMatch(ROOT_COMMIT_RE);
    expect(e?.machine_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e?.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawns).toEqual(["session-start"]);
    // A later SessionStart of the same session (compact, resume) prints nothing.
    const again = await hook("session-start", { ...p.SessionStart, source: "compact" });
    expect(again.out).toBe("");
    expect(spooled().map((x) => x.session.id)).toEqual([e?.session.id, e?.session.id]);
  });

  it("de-duplicates the same payload fired twice within the bucket", async () => {
    sb = sandbox();
    register();
    const p = payloads(sb.repo);
    await hook("stop", p.Stop);
    clock -= 5000; // the same 2-second bucket
    await hook("stop", p.Stop);
    expect(spooled().filter((e) => e.kind === "session.stop")).toHaveLength(1);
  });

  it("ignores a malformed payload, another event's payload and an oversized one", async () => {
    sb = sandbox();
    register();
    expect(await hook("stop", "not json")).toEqual({ code: 0, out: "", err: "" });
    expect(await hook("stop", payloads(sb.repo).SessionStart)).toEqual({ code: 0, out: "", err: "" });
    expect(await hook("stop", { cwd: sb.repo })).toEqual({ code: 0, out: "", err: "" });
    expect(await hook("frobnicate", payloads(sb.repo).Stop)).toEqual({ code: 0, out: "", err: "" });
    expect(spooled()).toEqual([]);
    const log = readFileSync(join(sb.alignHome, "logs", "align.log"), "utf8");
    expect(log).toMatch(/hook bad_stdin/);
    expect(log).toMatch(/hook shape_event_mismatch/);
    expect(log).not.toContain(sb.repo);
  });

  it("hooks mode: prompt and reply become numbered one-line chunks, code replaced, secrets redacted", async () => {
    sb = sandbox();
    register();
    const p = payloads(sb.repo, { transcript_path: null });
    // A fake secret assembled at run time (AGENTS.md rule 12).
    const fake = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    await hook("session-start", p.SessionStart);
    await hook("prompt", {
      ...p.UserPromptSubmit,
      prompt: `Deploy with token ${fake}\n\`\`\`sh\nrm -rf build\n\`\`\``,
    });
    await hook("stop", p.Stop);
    const start = spooled()[0];
    expect(start?.payload).toEqual({ source: "startup", transcript_mode: "hooks" });
    expect(lines().map(({ n, src, role }) => ({ n, src, role }))).toEqual([
      { n: 1, src: "hooks:1", role: "user" },
      { n: 2, src: "hooks:2", role: "assistant" },
    ]);
    const all = JSON.stringify(spooled());
    expect(all).not.toContain(fake);
    expect(all).not.toContain("rm -rf");
    expect(lines()[0]?.text).toContain("‹code: 1 lines›");
    expect(lines()[1]?.text).toBe("I switched the checkout to a Redis lock.");
  });

  it("hooks mode: a 1.6 MB prompt is spooled in events of at most 192 KB (round 4, finding 5)", async () => {
    sb = sandbox();
    register();
    const p = payloads(sb.repo, { transcript_path: null });
    await hook("session-start", p.SessionStart);
    // Under the 2 MB per-session text cap (a longer one marks the session truncated and keeps no line).
    const prompt = Array.from({ length: 40_000 }, (_, i) => `log line ${i} lorem ipsum dolor sit amet`).join("\n");
    expect(prompt.length).toBeGreaterThan(1.5 * 1024 * 1024);
    await hook("prompt", { ...p.UserPromptSubmit, prompt });
    const chunks = spooled().filter((e) => e.kind === "transcript.chunk");
    expect(chunks.length).toBeGreaterThan(0);
    for (const e of chunks) expect(Buffer.byteLength(JSON.stringify(e), "utf8")).toBeLessThanOrEqual(192 * 1024);
    expect(lines().map(({ n, src, role }) => ({ n, src, role }))).toEqual([{ n: 1, src: "hooks:1", role: "user" }]);
    expect(lines()[0]?.text.endsWith("[truncated]")).toBe(true);
    expect(chunks[0]?.harness).toMatchObject({ hook_event: "UserPromptSubmit" });
  });

  it("jsonl mode: stop marks the session, the reader spools new lines with a continuing n, never tool contents", async () => {
    sb = sandbox();
    register();
    const transcript = join(sb.dir, "projects", "session.jsonl");
    mkdirSync(join(sb.dir, "projects"), { recursive: true });
    const fixture = (name: string) => readFileSync(join(FIX, name), "utf8").replaceAll("__ROOT__", sb.repo);
    writeFileSync(transcript, fixture("normal.jsonl"));
    const p = payloads(sb.repo, { transcript_path: transcript });
    await hook("session-start", p.SessionStart);
    await hook("prompt", p.UserPromptSubmit); // jsonl mode: the prompt hook spools nothing
    await hook("stop", p.Stop);
    expect(lines()).toEqual([]);
    await upload();
    expect(lines().map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
    expect(lines()[2]?.tool?.paths).toEqual(["lib/cart/lock.ts"]);
    const all = JSON.stringify(spooled());
    expect(all).not.toMatch(/synthetic/i);
    expect(all).not.toContain(sb.repo);

    // The file grows, one line still being written: only complete lines are read.
    const more = fixture("resumed.jsonl").split("\n");
    appendFileSync(transcript, `${more.slice(0, 2).join("\n")}\n${more[2]?.slice(0, 10)}`);
    await hook("stop", { ...p.Stop, last_assistant_message: "second turn" });
    await upload();
    expect(lines().map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Nothing new: a second read sends nothing again.
    await hook("stop", { ...p.Stop, last_assistant_message: "third turn" });
    await upload();
    expect(lines()).toHaveLength(7);

    // The transcript is replaced by a shorter file: the session switches to hooks mode, n carries on.
    writeFileSync(transcript, "{}\n");
    await hook("stop", { ...p.Stop, last_assistant_message: "fourth turn" });
    await upload();
    await hook("prompt", { ...p.UserPromptSubmit, prompt: "after the switch" });
    const last = lines().at(-1);
    expect(last).toMatchObject({ n: 8, src: "hooks:8", role: "user", text: "after the switch" });
    await hook("session-end", p.SessionEnd);
    expect(spooled().at(-1)).toMatchObject({ kind: "session.end", payload: { reason: "other" } });
  });

  it("stop prints a due notice once, at most twice per session and never within 10 minutes", async () => {
    sb = sandbox();
    register();
    const p = payloads(sb.repo, { transcript_path: null });
    await hook("session-start", p.SessionStart);
    const id = spooled()[0]?.session.id as string;
    const paths = alignPaths(sb.alignHome);
    const notice = (nid: string) =>
      writeFileSync(paths.sessionNotice(id), JSON.stringify({ id: nid, text: "ALIGN · 1 new proposal\u001b[31m" }));
    notice("n1");
    expect((await hook("stop", p.Stop)).out).toBe('{"systemMessage":"ALIGN · 1 new proposal[31m"}\n');
    notice("n2");
    expect((await hook("stop", { ...p.Stop, last_assistant_message: "b" })).out).toBe("");
    clock += 11 * 60 * 1000;
    expect((await hook("stop", { ...p.Stop, last_assistant_message: "c" })).out).toContain("systemMessage");
    notice("n3");
    clock += 11 * 60 * 1000;
    expect((await hook("stop", { ...p.Stop, last_assistant_message: "d" })).out).toBe("");
  });

  it("a corrupt session index stops capture and is never rewritten", async () => {
    sb = sandbox();
    register();
    const index = join(sb.alignHome, "sessions", "index.json");
    mkdirSync(join(sb.alignHome, "sessions"), { recursive: true });
    writeFileSync(index, "{corrupt");
    expect(await hook("session-start", payloads(sb.repo).SessionStart)).toEqual({ code: 0, out: "", err: "" });
    expect(spooled()).toEqual([]);
    expect(readFileSync(index, "utf8")).toBe("{corrupt");
  });

  it("the session's transcript is read only while the repository stays opted in", async () => {
    sb = sandbox();
    register();
    const transcript = join(sb.dir, "t.jsonl");
    copyFileSync(join(FIX, "resumed.jsonl"), transcript);
    writeFileSync(transcript, readFileSync(transcript, "utf8").replaceAll("__ROOT__", sb.repo));
    const p = payloads(sb.repo, { transcript_path: transcript });
    await hook("stop", p.Stop);
    register(false);
    await upload();
    expect(lines()).toEqual([]);
  });

  it("one ALIGN session never spans two repositories", async () => {
    sb = sandbox();
    register();
    const other = join(sb.dir, "work", "other");
    mkdirSync(other, { recursive: true });
    gitIn(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "x"), "x\n");
    gitIn(other, "add", ".");
    gitIn(other, "commit", "-q", "-m", "x");
    register(true, other);
    const p = payloads(sb.repo, { transcript_path: null });
    await hook("session-start", p.SessionStart);
    const before = spooled().length;
    await hook("prompt", { ...p.UserPromptSubmit, cwd: other, prompt: "typed in the other repository" });
    expect(spooled()).toHaveLength(before);
  });

  describe("L12 security review round 2", () => {
    it("reads .aligndeny only as a small regular file; a symbolic link or an oversized file denies every path", async () => {
      sb = sandbox();
      register();
      const transcript = join(sb.dir, "t.jsonl");
      writeFileSync(transcript, readFileSync(join(FIX, "normal.jsonl"), "utf8").replaceAll("__ROOT__", sb.repo));
      const target = join(sb.dir, "deny-elsewhere");
      writeFileSync(target, "lib/**\n");
      symlinkSync(target, join(sb.repo, ".aligndeny"));
      const p = payloads(sb.repo, { transcript_path: transcript });
      await hook("stop", p.Stop);
      await upload();
      // Fails closed: the symlinked deny file is never read, and every path is denied.
      expect(lines().find((l) => l.role === "tool")?.tool?.paths).toEqual([]);
      expect(readFileSync(target, "utf8")).toBe("lib/**\n");
    });

    it("a busy session lock leaves a mark: the Stop is spooled, and the reader still reads the session", async () => {
      sb = sandbox();
      register();
      const transcript = join(sb.dir, "t.jsonl");
      writeFileSync(transcript, readFileSync(join(FIX, "resumed.jsonl"), "utf8").replaceAll("__ROOT__", sb.repo));
      const p = payloads(sb.repo, { transcript_path: transcript });
      await hook("session-start", p.SessionStart);
      const id = spooled()[0]?.session.id as string;
      const paths = alignPaths(sb.alignHome);
      writeFileSync(paths.sessionStateLock(id), "held by another process\n");
      await hook("stop", p.Stop);
      expect(spooled().map((e) => e.kind)).toEqual(["session.start", "session.stop"]);
      expect(readdirSync(paths.sessionMarks(id))).toHaveLength(1);
      rmSync(paths.sessionStateLock(id));
      await upload();
      expect(lines()).toHaveLength(4);
      expect(existsSync(paths.sessionMarks(id)) ? readdirSync(paths.sessionMarks(id)) : []).toEqual([]);
    });

    it("a tool path through a symlink inside the repository is denied when its target is (round 4, finding 8)", async () => {
      const toolPathsFor = async (setup: (repo: string) => string, cwdSub = "") => {
        sb?.cleanup();
        sb = sandbox();
        register();
        const filePath = setup(sb.repo);
        const transcript = join(sb.dir, "t.jsonl");
        const cwd = cwdSub ? join(sb.repo, cwdSub) : sb.repo;
        const text = readFileSync(join(FIX, "normal.jsonl"), "utf8")
          .replace('"file_path": "__ROOT__/lib/cart/lock.ts"', `"file_path": ${JSON.stringify(filePath)}`)
          .replaceAll('"cwd": "__ROOT__"', `"cwd": ${JSON.stringify(cwd)}`)
          .replaceAll("__ROOT__", sb.repo);
        writeFileSync(transcript, text);
        const p = payloads(sb.repo, { transcript_path: transcript });
        await hook("session-start", p.SessionStart);
        await hook("stop", p.Stop);
        await upload();
        const tool = spooled()
          .filter((e) => e.kind === "transcript.chunk")
          .find((e) => (e.payload.lines as { role: string }[]).some((l) => l.role === "tool"));
        if (!tool) throw new Error("no tool line spooled");
        const line = (tool.payload.lines as { role: string; tool?: { paths: string[] } }[]).find(
          (l) => l.role === "tool",
        );
        return { paths: line?.tool?.paths, hits: (tool.redaction as { hits: Record<string, number> }).hits };
      };
      // An innocent file name linked to a denied file.
      let r = await toolPathsFor((repo) => {
        writeFileSync(join(repo, ".env.production"), "SYNTHETIC=1\n");
        symlinkSync(join(repo, ".env.production"), join(repo, "notes.txt"));
        return join(repo, "notes.txt");
      });
      expect(r.paths).toEqual([]);
      expect(r.hits.path_denied).toBe(1);
      // The same through a `..` spelling.
      r = await toolPathsFor((repo) => {
        writeFileSync(join(repo, ".env.production"), "SYNTHETIC=1\n");
        symlinkSync(join(repo, ".env.production"), join(repo, "notes.txt"));
        return `${repo}/lib/../notes.txt`;
      });
      expect(r.paths).toEqual([]);
      // Relative spellings, resolved against the entry's cwd (round 5): at the root, and from a folder below it.
      r = await toolPathsFor((repo) => {
        writeFileSync(join(repo, ".env.production"), "SYNTHETIC=1\n");
        symlinkSync(join(repo, ".env.production"), join(repo, "notes.txt"));
        return "notes.txt";
      });
      expect(r.paths).toEqual([]);
      r = await toolPathsFor((repo) => {
        mkdirSync(join(repo, "lib"), { recursive: true });
        writeFileSync(join(repo, ".env.production"), "SYNTHETIC=1\n");
        symlinkSync(join(repo, ".env.production"), join(repo, "notes.txt"));
        return "../notes.txt";
      }, "lib");
      expect(r.paths).toEqual([]);
      r = await toolPathsFor((repo) => {
        mkdirSync(join(repo, "lib"), { recursive: true });
        writeFileSync(join(repo, "lib", "real.ts"), "x\n");
        return "real.ts";
      }, "lib");
      expect(r.paths).toEqual(["lib/real.ts"]);
      // A linked folder whose target is denied, and a file not yet written under it.
      r = await toolPathsFor((repo) => {
        mkdirSync(join(repo, "deploy", "secrets"), { recursive: true });
        symlinkSync(join(repo, "deploy", "secrets"), join(repo, "cfg"));
        return join(repo, "cfg", "new-file.yaml");
      });
      expect(r.paths).toEqual([]);
      // A denied link name stays denied whatever its target.
      r = await toolPathsFor((repo) => {
        writeFileSync(join(repo, "dev.txt"), "x\n");
        symlinkSync(join(repo, "dev.txt"), join(repo, ".env"));
        return join(repo, ".env");
      });
      expect(r.paths).toEqual([]);
      // A link that leaves the repository is outside it.
      r = await toolPathsFor((repo) => {
        mkdirSync(join(sb.dir, "elsewhere"), { recursive: true });
        writeFileSync(join(sb.dir, "elsewhere", "creds.txt"), "x\n");
        symlinkSync(join(sb.dir, "elsewhere", "creds.txt"), join(repo, "creds.txt"));
        return join(repo, "creds.txt");
      });
      expect(r.paths).toEqual([]);
      expect(r.hits.path_outside).toBe(1);
      // An ordinary link inside the repository keeps the name the agent used.
      r = await toolPathsFor((repo) => {
        mkdirSync(join(repo, "lib"), { recursive: true });
        writeFileSync(join(repo, "lib", "real.ts"), "x\n");
        symlinkSync(join(repo, "lib", "real.ts"), join(repo, "lib", "alias.ts"));
        return join(repo, "lib", "alias.ts");
      });
      expect(r.paths).toEqual(["lib/alias.ts"]);
    });

    it("a symlinked spelling of the repository keeps its tool paths and its cwd", async () => {
      sb = sandbox();
      register();
      const link = join(sb.dir, "link-to-checkout");
      symlinkSync(sb.repo, link);
      const transcript = join(sb.dir, "t.jsonl");
      writeFileSync(transcript, readFileSync(join(FIX, "normal.jsonl"), "utf8").replaceAll("__ROOT__", link));
      const p = payloads(link, { transcript_path: transcript });
      await hook("session-start", p.SessionStart);
      await hook("stop", p.Stop);
      await upload();
      expect(spooled()[0]?.cwd_rel).toBe("");
      expect(lines().find((l) => l.role === "tool")?.tool?.paths).toEqual(["lib/cart/lock.ts"]);
      expect(spooled().find((e) => e.kind === "transcript.chunk")?.cwd_rel).toBeNull();
    });
  });
});
