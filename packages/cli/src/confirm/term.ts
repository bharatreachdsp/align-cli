/**
 * The terminal seam of `align confirm`: raw keys, the width, resize, a line prompt and `$EDITOR`. The real one wraps
 * the process's stdin/stdout; tests use a fake. Whatever happens — a key, Ctrl-C, an error thrown anywhere, the
 * process exiting — raw mode is switched off and the cursor shown again (`restore`), so the shell stays usable.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { openTty } from "./person";

export interface Term {
  columns(): number;
  readonly color: boolean;
  write(text: string): void;
  /** Raw mode for single keys (on) or a cooked line prompt (off). */
  raw(on: boolean): void;
  /** Each chunk of input as it arrives; returns the unsubscribe. */
  onData(cb: (chunk: string) => void): () => void;
  onResize(cb: () => void): () => void;
  /** One line from the person; null on Ctrl-C or end of input. */
  prompt(question: string): Promise<string | null>;
  /** The text after the person edited it in `$EDITOR`, or null (no editor, it failed, or nothing was saved). */
  edit(text: string): Promise<string | null>;
  restore(): void;
  /** The clock key timing uses; the real terminal uses the wall clock (tests give a virtual one). */
  now?(): number;
}

export const CLEAR = "\u001b[2J\u001b[H";
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";
/** Bracketed paste (xterm): the terminal wraps a paste in `ESC[200~ … ESC[201~`. */
export const PASTE_ON = "\u001b[?2004h";
export const PASTE_OFF = "\u001b[?2004l";
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** Opens `$VISUAL`/`$EDITOR` on a 0600 file in a private temporary directory; `#` lines are dropped afterwards. */
export function editInEditor(text: string, env: NodeJS.ProcessEnv, help: string): string | null {
  const editor = (env.VISUAL || env.EDITOR || "").trim();
  if (!editor) return null;
  const dir = mkdtempSync(join(tmpdir(), "align-edit-"));
  const file = join(dir, "statement.txt");
  try {
    writeFileSync(file, `${text}\n\n${help}\n`, { mode: 0o600 });
    // The person's own editor command (it may carry arguments, e.g. `code -w`); the file is passed as "$1".
    // Ctrl-C belongs to the editor while it runs; ALIGN must not die underneath it and leave the terminal raw.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    let r: ReturnType<typeof spawnSync>;
    try {
      // The editor talks to the person's terminal, never to a pipe on stdin.
      let fd: number | null = null;
      try {
        fd = openSync("/dev/tty", "r+");
      } catch {
        fd = null;
      }
      try {
        r = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], {
          stdio: fd === null ? "inherit" : [fd, fd, fd],
        });
      } finally {
        if (fd !== null) closeSync(fd);
      }
    } finally {
      process.off("SIGINT", ignore);
    }
    if (r.status !== 0) return null;
    const out = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n")
      .trim();
    return out || null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The terminal on `/dev/tty`, never stdin and stdout, so piped input can never drive the TUI (D404); null when the
 * process has no controlling terminal. Bracketed paste is switched on, so a paste arrives marked and is ignored.
 * SIGTERM and SIGHUP restore the terminal before leaving, as Ctrl-C and errors do.
 */
export function processTerm(env: NodeJS.ProcessEnv, editHelp: string): Term | null {
  const tty = openTty();
  if (!tty) return null;
  const { input, output } = tty;
  let rawOn = false;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (rawOn) input.setRawMode(false);
    } catch {
      // the terminal went away
    }
    rawOn = false;
    output.write(`${PASTE_OFF}${SHOW_CURSOR}`);
    tty.close();
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    restore();
    process.exit(sig === "SIGHUP" ? 129 : 143);
  };
  process.once("exit", restore);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  output.write(PASTE_ON);
  return {
    color: !env.NO_COLOR,
    columns: () => output.columns || 80,
    write: (t) => output.write(t),
    raw(on) {
      input.setRawMode(on);
      rawOn = on;
      if (on) input.resume();
    },
    onData(cb) {
      const h = (b: Buffer) => cb(b.toString("utf8"));
      input.on("data", h);
      return () => input.off("data", h);
    },
    onResize(cb) {
      output.on("resize", cb);
      return () => output.off("resize", cb);
    },
    async prompt(q) {
      const rl = createInterface({ input, output });
      let cancelled = false;
      rl.on("SIGINT", () => {
        cancelled = true;
        rl.close();
      });
      try {
        const a = await rl.question(q);
        return cancelled ? null : a;
      } catch {
        return null;
      } finally {
        rl.close();
      }
    },
    async edit(text) {
      return editInEditor(text, env, editHelp);
    },
    restore,
  };
}
