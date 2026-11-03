/** The fast path for Cursor and Codex (docs/15 §The hook fast path): temporary HOME, synthetic payloads. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACK_MARKER_RE, PACK_MARKER_WORD } from "@align/core/brand";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCursorProject } from "../src/harness/cursor/transcript";
import { alignPaths } from "../src/paths";
import { upsertRepo } from "../src/registry";
import { cli, gitIn, type Sandbox, sandbox } from "./helpers";

const SRC = join(import.meta.dirname, "..", "src", "harness");
const CURSOR = join(SRC, "cursor", "__fixtures__", "cursor-2026.10.19");
const CODEX = join(SRC, "codex", "__fixtures__", "codex-0.163.0");

let sb: Sandbox;
afterEach(() => sb?.cleanup());

const load = (dir: string, root: string) =>
  JSON.parse(readFileSync(join(dir, "payloads.json"), "utf8").replaceAll("__ROOT__", root)) as Record<
    string,
    Record<string, unknown>
  >;

function register(harnesses: string[]) {
  upsertRepo(alignPaths(sb.alignHome), sb.repo, {
    repo_id: "repo_1",
    org_id: "org_1",
    remote_norm: "github.com/acme/checkout",
    root_commit: gitIn(sb.repo, "rev-list", "--max-parents=0", "HEAD"),
    default_branch: "main",
    opted_in: true,
    harnesses,
    installed_at: new Date().toISOString(),
  });
}

let clock = Date.parse("2026-10-22T09:00:00Z");
const hook = (harness: string, event: string, payload: unknown, env: Record<string, string> = {}) => {
  clock += 5000;
  const stdin = Buffer.from(JSON.stringify(payload));
  return cli(["hook", event, "--harness", harness], sb, {
    internalHome: sb.alignHome,
    readStdin: async () => stdin,
    spawnUploader: () => {},
    now: () => clock,
    env,
  });
};
const upload = () => cli(["upload"], sb, { internalHome: sb.alignHome, now: () => clock });

type Ev = { kind: string; harness: Record<string, unknown>; payload: Record<string, unknown> };
function spooled(): Ev[] {
  const dir = join(sb.alignHome, "spool");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^[0-9a-f]{16}$/.test(d))
    .flatMap((d) =>
      readdirSync(join(dir, d))
        .sort()
        .flatMap((f) => JSON.parse(readFileSync(join(dir, d, f), "utf8")).events as Ev[]),
    );
}
const lines = () =>
  spooled()
    .filter((e) => e.kind === "transcript.chunk")
    .flatMap((e) => e.payload.lines as { n: number; role: string; text: string; tool?: { paths: string[] } }[]);

describe("align hook --harness cursor", () => {
  it("captures in hooks mode: prompt and reply numbered in order; prints nothing; never the email", async () => {
    sb = sandbox();
    register(["cursor"]);
    const p = load(CURSOR, sb.repo);
    for (const [event, key] of [
      ["session-start", "sessionStart"],
      ["prompt", "beforeSubmitPrompt"],
      ["response", "afterAgentResponse"],
      ["stop", "stop"],
      ["session-end", "sessionEnd"],
    ] as const) {
      expect(await hook("cursor", event, p[key])).toEqual({ code: 0, out: "", err: "" });
    }
    expect(spooled().map((e) => e.kind)).toEqual([
      "session.start",
      "transcript.chunk",
      "transcript.chunk",
      "session.stop",
      "session.end",
    ]);
    expect(spooled()[0]?.payload).toEqual({ source: "startup", transcript_mode: "hooks" });
    expect(spooled()[0]?.harness).toMatchObject({ name: "cursor", hook_event: "sessionStart", version: "2026.10.19" });
    expect(lines().map((l) => `${l.n} ${l.role}: ${l.text}`)).toEqual([
      "1 user: Use a Redis lock for the cart checkout.",
      "2 assistant: I switched the checkout to a Redis lock.",
    ]);
    expect(JSON.stringify(spooled())).not.toMatch(/SYNTHETIC|example\.invalid/);
  });

  it("a user-level hook firing in a directory that is not opted in spools nothing", async () => {
    sb = sandbox();
    const p = load(CURSOR, sb.repo);
    await hook("cursor", "prompt", p.beforeSubmitPrompt);
    const elsewhere = join(sb.dir, "not-a-repo");
    mkdirSync(elsewhere);
    register(["cursor"]);
    await hook("cursor", "prompt", { ...p.beforeSubmitPrompt, workspace_roots: [elsewhere] });
    expect(spooled()).toEqual([]);
    expect(existsSync(join(sb.alignHome, "sessions"))).toBe(false);
  });

  it("the Claude Code hooks Cursor imports stay silent inside Cursor", async () => {
    sb = sandbox();
    register(["claude-code", "cursor"]);
    const p = load(CURSOR, sb.repo);
    await hook(
      "claude-code",
      "prompt",
      { ...p.beforeSubmitPrompt, session_id: "x", cwd: sb.repo },
      { CURSOR_VERSION: "2026.10.19" },
    );
    expect(spooled()).toEqual([]);
  });
});

describe("align hook --harness cursor: print mode (agent -p), D519", () => {
  const ID = "7d3e1f20-8b4a-4c55-a1e2-3f9b6c0d2a44";
  const transcriptAt = (root: string, text = readFileSync(join(CURSOR, "print-mode.jsonl"), "utf8")) => {
    const dir = join(sb.home, ".cursor", "projects", encodeCursorProject(root), "agent-transcripts", ID);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, text);
    return file;
  };
  const stateFile = () => {
    const dir = alignPaths(sb.alignHome).sessions;
    const f = readdirSync(dir).find((n) => /^[0-9a-f-]{36}\.json$/.test(n));
    if (!f) throw new Error("no session");
    return join(dir, f);
  };
  const state = () => JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
  // What agent CLI 2026.10.19 fires in print mode: sessionStart (no transcript path), sessionEnd (with it); no
  // beforeSubmitPrompt, afterAgentResponse or stop.
  const printRun = async (
    sessionEnd: Record<string, unknown>,
    o: { root?: string; afterStart?: () => void; beforeUpload?: () => void } = {},
  ) => {
    const p = load(CURSOR, sb.repo);
    const roots = { workspace_roots: [o.root ?? sb.repo] };
    await hook("cursor", "session-start", { ...p.sessionStart, ...roots, transcript_path: null });
    o.afterStart?.();
    expect(await hook("cursor", "session-end", { ...p.sessionEnd, ...roots, ...sessionEnd })).toEqual({
      code: 0,
      out: "",
      err: "",
    });
    o.beforeUpload?.();
    await upload();
  };

  it("reads the person's prompt from the conversation's own transcript at sessionEnd; the reply stays out", async () => {
    sb = sandbox();
    register(["cursor"]);
    await printRun({ transcript_path: transcriptAt(sb.repo) });
    expect(lines().map((l) => `${l.n} ${l.role}: ${l.text}`)).toEqual([
      "1 user: Keep the cart lock TTL at 30 seconds.",
    ]);
    expect(JSON.stringify(spooled())).not.toMatch(/SYNTHETIC|example\.invalid/);
    // The reader's chunk is spooled in the same millisecond as session.end here; the server orders by line, not file.
    expect(
      spooled()
        .map((e) => e.kind)
        .sort(),
    ).toEqual(["session.end", "session.start", "transcript.chunk"]);
  });

  it("ignores a transcript path that is not this conversation's file under ~/.cursor/projects/<root>", async () => {
    sb = sandbox();
    register(["cursor"]);
    const real = transcriptAt(sb.repo);
    const elsewhere = join(sb.dir, `${ID}.jsonl`);
    writeFileSync(elsewhere, readFileSync(real, "utf8"));
    await printRun({ transcript_path: elsewhere });
    const other = real.replaceAll(ID, "00000000-0000-4000-8000-000000000000");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, readFileSync(real, "utf8"));
    await printRun({ transcript_path: other });
    expect(lines()).toEqual([]);
  });

  it("never reads a transcript reached through a link", async () => {
    sb = sandbox();
    register(["cursor"]);
    const real = transcriptAt(sb.repo);
    const target = join(sb.dir, "target.jsonl");
    renameSync(real, target);
    symlinkSync(target, real);
    await printRun({ transcript_path: real });
    expect(lines()).toEqual([]);
  });

  it("a file swapped in after sessionEnd is refused as replaced (the inode seen at sessionEnd)", async () => {
    sb = sandbox();
    register(["cursor"]);
    const file = transcriptAt(sb.repo);
    await printRun(
      { transcript_path: file },
      {
        beforeUpload: () => {
          const swap = join(sb.dir, "swap.jsonl");
          writeFileSync(swap, readFileSync(file, "utf8"));
          renameSync(swap, file);
        },
      },
    );
    expect(lines()).toEqual([]);
    expect(state()).toMatchObject({ mode: "hooks", mode_reason: "replaced" });
  });

  it("a link swapped in after sessionEnd is never followed by the uploader, even to the same file", async () => {
    sb = sandbox();
    register(["cursor"]);
    const file = transcriptAt(sb.repo);
    await printRun(
      { transcript_path: file },
      {
        beforeUpload: () => {
          const moved = join(sb.dir, "moved.jsonl");
          renameSync(file, moved); // same inode
          symlinkSync(moved, file);
        },
      },
    );
    expect(lines()).toEqual([]);
    expect(state()).toMatchObject({ mode: "hooks", mode_reason: "not_file" });
  });

  it("a transcript folder reached through a linked folder is refused", async () => {
    sb = sandbox();
    register(["cursor"]);
    const outside = join(sb.dir, "outside", ID);
    mkdirSync(outside, { recursive: true });
    const file = join(outside, `${ID}.jsonl`);
    writeFileSync(file, readFileSync(join(CURSOR, "print-mode.jsonl"), "utf8"));
    const transcripts = join(sb.home, ".cursor", "projects", encodeCursorProject(sb.repo), "agent-transcripts");
    mkdirSync(transcripts, { recursive: true });
    symlinkSync(outside, join(transcripts, ID));
    await printRun({ transcript_path: join(transcripts, ID, `${ID}.jsonl`) });
    expect(lines()).toEqual([]);
    expect(state()).toMatchObject({ mode: "hooks", transcript_path: null });
  });

  it("a tool row becomes a placeholder with its path; its input never leaves", async () => {
    sb = sandbox();
    register(["cursor"]);
    const tool = JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "SYNTHETIC REPLY" },
          {
            type: "tool_use",
            name: "Edit",
            input: {
              target_file: `${sb.repo}/lib/cart/lock.ts`,
              old_string: "SYNTHETIC OLD",
              new_string: "SYNTHETIC NEW",
            },
          },
        ],
      },
    });
    const [user, ...rest] = readFileSync(join(CURSOR, "print-mode.jsonl"), "utf8").split("\n");
    await printRun({ transcript_path: transcriptAt(sb.repo, [user, tool, ...rest].join("\n")) });
    expect(lines().map((l) => l.role)).toEqual(["user", "tool"]);
    expect(lines()[1]?.text).toMatch(/^‹tool: Edit, \d+ bytes›$/);
    expect(lines()[1]?.tool?.paths).toEqual(["lib/cart/lock.ts"]);
    expect(JSON.stringify(spooled())).not.toMatch(/SYNTHETIC/);
  });

  it("a workspace root that is a folder of the repository finds the transcript under that folder's name", async () => {
    sb = sandbox();
    register(["cursor"]);
    const sub = join(sb.repo, "packages", "web");
    mkdirSync(sub, { recursive: true });
    await printRun({ transcript_path: transcriptAt(sub) }, { root: sub });
    expect(lines().map((l) => `${l.n} ${l.role}: ${l.text}`)).toEqual([
      "1 user: Keep the cart lock TTL at 30 seconds.",
    ]);
  });

  it("a truncated session (no line, over the text cap) does not switch", async () => {
    sb = sandbox();
    register(["cursor"]);
    await printRun(
      { transcript_path: transcriptAt(sb.repo) },
      { afterStart: () => writeFileSync(stateFile(), JSON.stringify({ ...state(), truncated: true })) },
    );
    expect(lines()).toEqual([]);
    expect(state()).toMatchObject({ mode: "hooks", transcript_path: null });
  });

  it("an interactive session (hooks in Cursor's real order) keeps its hook lines and never re-reads the file", async () => {
    sb = sandbox();
    register(["cursor"]);
    const p = load(CURSOR, sb.repo);
    const file = transcriptAt(sb.repo);
    // agent CLI 2026.10.19 interactive: beforeSubmitPrompt before sessionStart, stop before afterAgentResponse.
    await hook("cursor", "prompt", p.beforeSubmitPrompt);
    await hook("cursor", "session-start", { ...p.sessionStart, transcript_path: null });
    await hook("cursor", "stop", p.stop);
    await hook("cursor", "response", p.afterAgentResponse);
    await hook("cursor", "session-end", { ...p.sessionEnd, transcript_path: file });
    await upload();
    expect(lines().map((l) => `${l.n} ${l.role}: ${l.text}`)).toEqual([
      "1 user: Use a Redis lock for the cart checkout.",
      "2 assistant: I switched the checkout to a Redis lock.",
    ]);
  });

  it("a wrapper-only interactive session read from its transcript sends no wrapper or pack text (D519)", async () => {
    sb = sandbox();
    register(["cursor"]);
    const p = load(CURSOR, sb.repo);
    // Assembled at runtime: the pack's marker and a wrapper the person never typed.
    const pack = `<!-- ${PACK_MARKER_WORD} -->\nSYNTHETIC PACK DECISION`;
    const wrapper = "<cursor_commands>SYNTHETIC WRAPPER</cursor_commands>";
    const user = (...texts: string[]) =>
      JSON.stringify({ role: "user", message: { content: texts.map((text) => ({ type: "text", text })) } });
    const file = transcriptAt(
      sb.repo,
      [
        user(wrapper), // a wrapper row: no <user_query>
        user(pack, "<user_query>\nSYNTHETIC QUERY BESIDE THE PACK\n</user_query>"), // the pack in an earlier block
        user(`<user_query>\n${pack}\n</user_query>`), // the pack inside the query itself
        user(
          `<attached_files>${wrapper}</attached_files>`,
          "<user_query>\nKeep the cart lock TTL at 30 seconds.\n</user_query>",
        ),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: `SYNTHETIC REPLY ${pack}` }] },
        }),
        JSON.stringify({ type: "turn_ended", status: "completed" }),
        "",
      ].join("\n"),
    );
    // Interactive order; every hook line is dropped (a wrapper prompt, a pack-carrying reply), so next_n stays 1.
    await hook("cursor", "prompt", { ...p.beforeSubmitPrompt, prompt: wrapper });
    await hook("cursor", "session-start", { ...p.sessionStart, transcript_path: null });
    await hook("cursor", "stop", p.stop);
    await hook("cursor", "response", { ...p.afterAgentResponse, text: pack });
    expect(lines()).toEqual([]);
    await hook("cursor", "session-end", { ...p.sessionEnd, transcript_path: file });
    await upload();
    expect(lines().map((l) => `${l.n} ${l.role}: ${l.text}`)).toEqual([
      "1 user: Keep the cart lock TTL at 30 seconds.",
    ]);
    const sent = JSON.stringify(spooled());
    expect(sent).not.toMatch(/SYNTHETIC|cursor_commands|attached_files|user_query/);
    expect(sent).not.toMatch(PACK_MARKER_RE);
  });
});

describe("align hook --harness codex", () => {
  it("jsonl mode: the rollout is read after Stop, with FileChange paths and no response items", async () => {
    sb = sandbox();
    register(["codex"]);
    const rollout = join(sb.dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(join(CODEX, "paginated.jsonl"), "utf8").replaceAll("__ROOT__", sb.repo));
    const p = load(CODEX, sb.repo);
    for (const k of Object.keys(p)) p[k] = { ...p[k], transcript_path: rollout };
    const start = await hook("codex", "session-start", p.SessionStart);
    expect(start.out).toBe("");
    await hook("codex", "prompt", p.UserPromptSubmit);
    expect((await hook("codex", "stop", p.Stop)).out).toBe("");
    await upload();
    expect(lines().map((l) => l.role)).toEqual(["user", "tool", "tool", "tool", "assistant"]);
    expect(lines()[2]?.tool?.paths).toEqual(["lib/cart/lock.ts", "lib/cart/new.ts"]);
    expect(JSON.stringify(spooled())).not.toMatch(/synthetic/i);
    expect(spooled().find((e) => e.kind === "transcript.chunk")?.harness).toMatchObject({
      name: "codex",
      version: "0.163.0",
    });
  });

  it("hooks mode for a non-local store (null transcript path); a subagent's prompt is never the person's line", async () => {
    sb = sandbox();
    register(["codex"]);
    const p = load(CODEX, sb.repo);
    for (const k of Object.keys(p)) p[k] = { ...p[k], transcript_path: null };
    await hook("codex", "session-start", p.SessionStart);
    await hook("codex", "prompt", p.UserPromptSubmit);
    await hook("codex", "prompt", p.UserPromptSubmitSubagent);
    await hook("codex", "stop", p.Stop);
    expect(spooled()[0]?.payload).toEqual({ source: "startup", transcript_mode: "hooks" });
    expect(lines().map((l) => `${l.n} ${l.role}: ${l.text}`)).toEqual([
      "1 user: Use a Redis lock for the cart checkout.",
      "2 assistant: I switched the checkout to a Redis lock.",
    ]);
  });
});

describe("L13 security review", () => {
  it("Cursor and Codex print nothing at Stop, even with a due notice", async () => {
    sb = sandbox();
    register(["cursor", "codex"]);
    const c = load(CURSOR, sb.repo);
    const x = load(CODEX, sb.repo);
    await hook("cursor", "session-start", c.sessionStart);
    await hook("codex", "session-start", { ...x.SessionStart, transcript_path: null });
    const paths = alignPaths(sb.alignHome);
    for (const f of readdirSync(paths.sessions).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)))
      writeFileSync(paths.sessionNotice(f.slice(0, 36)), JSON.stringify({ id: "n1", text: "ALIGN · 1 new proposal" }));
    expect((await hook("cursor", "stop", c.stop)).out).toBe("");
    expect((await hook("codex", "stop", { ...x.Stop, transcript_path: null })).out).toBe("");
  });

  it("a multi-root Cursor workspace is not captured", async () => {
    sb = sandbox();
    register(["cursor"]);
    const c = load(CURSOR, sb.repo);
    await hook("cursor", "prompt", { ...c.beforeSubmitPrompt, workspace_roots: [sb.repo, join(sb.dir, "other")] });
    expect(spooled()).toEqual([]);
  });

  it("a Codex subagent's Stop text is never captured", async () => {
    sb = sandbox();
    register(["codex"]);
    const x = load(CODEX, sb.repo);
    await hook("codex", "stop", {
      ...x.Stop,
      transcript_path: null,
      agent_id: "agent-1",
      last_assistant_message: "SUBAGENT REPLY",
    });
    expect(JSON.stringify(spooled())).not.toContain("SUBAGENT");
  });

  it("a repository that did not choose Cursor or Codex is not captured by their user-level hooks", async () => {
    sb = sandbox();
    register(["claude-code"]);
    const c = load(CURSOR, sb.repo);
    const x = load(CODEX, sb.repo);
    expect(await hook("cursor", "session-start", c.sessionStart)).toEqual({ code: 0, out: "", err: "" });
    await hook("cursor", "prompt", c.beforeSubmitPrompt);
    await hook("codex", "session-start", { ...x.SessionStart, transcript_path: null });
    expect(spooled()).toEqual([]);
    expect(existsSync(join(sb.alignHome, "sessions"))).toBe(false);
  });
});
