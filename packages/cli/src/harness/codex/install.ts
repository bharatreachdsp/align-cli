/**
 * Codex's hook entries (docs/10 §Hooks installed per harness, docs/15 §Hook entries written): merged into the
 * user-level `~/.codex/hooks.json` (`$CODEX_HOME`), top-level `hooks` only (Codex allows `description` and `hooks`),
 * one matcher group per event with `matcher: ""`. Timeouts: SessionStart 3 s, UserPromptSubmit and Stop 5 s,
 * SessionEnd 3 s (Codex's maximum). They never change: Codex trusts a hook by the hash of its definition, and a
 * changed hook must be trusted again with `/hooks`. Merge and exact restore: `../hooks-file.ts`; the record is
 * `~/.align/harness/codex.json`. Trust is read back best-effort from `config.toml` (`[hooks.state."<file>:<event>:<group>:<handler>"]`).
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Paths } from "../../paths";
import {
  type FileInstallResult,
  type FileUninstallResult,
  type HooksFileSpec,
  hooksInstalled,
  installHooksFile,
  isAlignCommand,
  parseSettings,
  readRecord,
  uninstallHooksFile,
} from "../hooks-file";

export const CODEX_SPEC: HooksFileSpec = {
  harness: "codex",
  shape: "grouped",
  groupExtra: { matcher: "" },
  entries: [
    { hook: "session-start", event: "SessionStart", timeout: 3 },
    { hook: "prompt", event: "UserPromptSubmit", timeout: 5 },
    { hook: "stop", event: "Stop", timeout: 5 },
    { hook: "session-end", event: "SessionEnd", timeout: 3 },
  ],
};

/** Codex's own snake-case labels in hook state keys (codex-rs/hooks `hook_event_key_label`). */
const STATE_LABEL: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  SessionEnd: "session_end",
};

/** `$CODEX_HOME` when it is an absolute path, else `~/.codex` (a relative one would resolve inside some repository). */
export const codexDir = (env: NodeJS.ProcessEnv, home: string) =>
  env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex");
export const codexHooksFile = (dir: string) => join(dir, "hooks.json");

export function installCodex(paths: Paths, dir: string, shim: string, now?: number): FileInstallResult {
  return installHooksFile(CODEX_SPEC, {
    file: codexHooksFile(dir),
    recordFile: paths.harnessRecord("codex"),
    shim,
    guard: [dir],
    backup: true,
    now,
  });
}

export function uninstallCodex(paths: Paths, dir: string, shim: string): FileUninstallResult {
  // The file ALIGN wrote to, as recorded (CODEX_HOME may differ now), else the one this environment names.
  const recorded = readRecord(paths.harnessRecord("codex"))?.file;
  const file = recorded && isAbsolute(recorded) ? recorded : codexHooksFile(dir);
  return uninstallHooksFile(CODEX_SPEC, {
    file,
    recordFile: paths.harnessRecord("codex"),
    shim,
    guard: [dirname(file)],
  });
}

export function codexInstalled(dir: string, shim: string): boolean {
  try {
    return hooksInstalled(CODEX_SPEC, readFileSync(codexHooksFile(dir), "utf8"), shim);
  } catch {
    return false;
  }
}

/**
 * Best-effort trust state: every ALIGN handler has a `trusted_hash` under its state key in `config.toml`. (The hash
 * itself is not recomputed; a handler changed since it was trusted would still read as trusted here, which is why
 * the definitions never change.) Null when it cannot be told.
 */
export function codexTrusted(dir: string, shim: string): boolean | null {
  let hooksText: string;
  let toml: string;
  try {
    hooksText = readFileSync(codexHooksFile(dir), "utf8");
    toml = readFileSync(join(dir, "config.toml"), "utf8");
  } catch {
    return null;
  }
  let hooks: Record<string, unknown>;
  try {
    const h = parseSettings(hooksText).hooks;
    if (typeof h !== "object" || h === null) return false;
    hooks = h as Record<string, unknown>;
  } catch {
    return null;
  }
  const trusted = trustedKeys(toml);
  const file = codexHooksFile(dir);
  return CODEX_SPEC.entries.every((e) => {
    const list = Array.isArray(hooks[e.event]) ? (hooks[e.event] as unknown[]) : [];
    for (let g = 0; g < list.length; g++) {
      const group = list[g] as { hooks?: unknown[] };
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
      for (let h = 0; h < handlers.length; h++) {
        const cmd = (handlers[h] as { command?: unknown })?.command;
        if (isAlignCommand(cmd, shim, "codex", e.hook)) return trusted.has(`${file}:${STATE_LABEL[e.event]}:${g}:${h}`);
      }
    }
    return false;
  });
}

/** Keys of `[hooks.state."<key>"]` tables that set a `trusted_hash` (a small, tolerant scan, not a TOML parser). */
export function trustedKeys(toml: string): Set<string> {
  const out = new Set<string>();
  let current: string | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const header = /^\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]$/.exec(line);
    if (header) {
      current = (header[1] ?? header[2] ?? "").replace(/\\(.)/g, "$1");
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (current !== null && /^trusted_hash\s*=\s*["']sha256:[0-9a-f]{64}["']/.test(line)) out.add(current);
  }
  return out;
}
