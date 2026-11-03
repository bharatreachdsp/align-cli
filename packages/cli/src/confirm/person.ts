/**
 * Hard rule 3 on the laptop (D404): only a person confirms, rejects or records a decision. `confirm` (the TUI, keys
 * on the command line, `--reject`), `decide` and `sessions rm` refuse inside an agent's shell, recognised by the
 * variables the harnesses set for the commands their agents run, and the non-interactive forms also need a `y` typed
 * on the controlling terminal (`/dev/tty`), which a piped or redirected stdin cannot supply. The TUI reads its keys
 * from `/dev/tty` too. An agent that drives a pseudo-terminal of its own remains possible; the variable check and the
 * typed `y` are what stand in its way, and the server still records the person, so the act stays theirs.
 */
import { openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";

/**
 * The variables a harness sets for its agent's commands (read from Claude Code's, Cursor agent 2026.10.19's and Codex
 * 0.163's own code, L17 review round 2): Claude Code `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`; Cursor's agent
 * `CURSOR_AGENT` and `CURSOR_CONVERSATION_ID`, and for the long-running commands it starts in its own tmux server
 * (`tmux -L cursor-agent`, whose panes get only PATH, HOME, SHELL, USER, LOGNAME, LANG, TERM, COLORTERM and LC_*) a
 * `TMUX` socket named `cursor-agent`; Codex `CODEX_THREAD_ID`, `CODEX_TOOL_CALL_ID` (every command, full access and
 * pty mode included), `CODEX_CI`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED` and any other `CODEX_*` except
 * `CODEX_HOME`, which people set in their own shell. Cursor's `CURSOR_TRACE_ID` is not on the list: Cursor sets it in
 * the person's own integrated terminal too. A speed bump, not a wall: an agent can unset variables (D404).
 */
export function agentHarness(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (env.CURSOR_AGENT || env.CURSOR_CONVERSATION_ID) return "Cursor";
  const tmuxSocket = (env.TMUX ?? "").split(",")[0] ?? "";
  if (/(?:^|\/)cursor-agent[^/]*$/.test(tmuxSocket)) return "Cursor";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_") && k !== "CODEX_HOME" && env[k])) return "Codex";
  return null;
}

/** The controlling terminal, opened for reading and writing, or null (no terminal: a pipe, cron, a sandbox). */
export function openTty(): { input: ReadStream; output: WriteStream; close(): void } | null {
  try {
    const rfd = openSync("/dev/tty", "r");
    const wfd = openSync("/dev/tty", "w");
    const input = new ReadStream(rfd);
    const output = new WriteStream(wfd);
    return {
      input,
      output,
      close() {
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    return null;
  }
}

/** Asks on the controlling terminal; null when there is none or it was cancelled. */
export async function askTty(question: string): Promise<string | null> {
  const tty = openTty();
  if (!tty) return null;
  const rl = createInterface({ input: tty.input, output: tty.output });
  try {
    return await rl.question(question);
  } catch {
    return null;
  } finally {
    rl.close();
    tty.close();
  }
}

export type PersonCheck = {
  env: NodeJS.ProcessEnv;
  /** Asks the person on `/dev/tty` (tests replace it). */
  ask?: (question: string) => Promise<string | null>;
};
