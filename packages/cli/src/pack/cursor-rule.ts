/**
 * Cursor's always-applied rule file, `<repo>/.cursor/rules/align.mdc` (docs/14 §Delivery): front matter
 * `alwaysApply: true`, the pack, and the instruction to use the align tools for receipts. Only `init` creates it (an
 * untracked path, then listed in `.git/info/exclude` and recorded in `installed.json`). The session-start hook and
 * `align pack` only rewrite it (`refreshRule`): when that record lists the path and the file is still ALIGN's own; they
 * never create it, and a refused or expired pack resets it to the pending text (D402).
 *
 * The repository is untrusted: the file is written only when `.cursor` and `.cursor/rules` are real directories (never
 * through a symbolic link a repository could commit) and the file is absent or is ALIGN's own regular file (its exact
 * front matter), so a person's or a committed rule is never overwritten. Writes are tmp + rename.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLI_BIN, PACK_MARKER_WORD } from "@align/core/brand";
import { copy } from "../copy";
import { writeUserFileAtomic } from "../fsx";
import { GIT_TIMEOUT_MS } from "../git";
import { gitBinary, gitEnv, HOOK_GIT_CONFIG } from "../hook/home";
import type { Paths } from "../paths";

export const RULE_DIR_REL = ".cursor/rules";
export const RULE_REL = `${RULE_DIR_REL}/${CLI_BIN}.mdc`;
const HEADER = `---\ndescription: ${copy.pack.ruleDescription}\nalwaysApply: true\n---\n`;
/** The body before the first pack arrives; it carries the marker, like every pack. */
const PENDING = `<!-- ${PACK_MARKER_WORD} v1 -->\n${copy.pack.rulePending}\n`;

export const ruleText = (markdown: string | null) =>
  `${HEADER}${(markdown ?? PENDING).replace(/\n*$/, "\n")}\n${copy.pack.ruleTools}\n`;

type Kind = "dir" | "file" | "other" | "absent";
function kindOf(p: string): Kind {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "other" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return "absent";
  }
}

/** Whether the rule file is ALIGN's own (a regular file starting with ALIGN's front matter). */
export function ruleIsOurs(root: string): boolean {
  const p = join(root, RULE_REL);
  if (kindOf(p) !== "file") return false;
  try {
    return readFileSync(p, "utf8").startsWith(HEADER);
  } catch {
    return false;
  }
}

/** Where writing the rule is safe: both directories real (or, with `create`, absent), the file absent or ours. */
export function ruleWritable(root: string, create: boolean): boolean {
  for (const d of [".cursor", RULE_DIR_REL]) {
    const k = kindOf(join(root, d));
    if (k === "dir") continue;
    if (k === "absent" && create) continue;
    return false;
  }
  const f = kindOf(join(root, RULE_REL));
  return f === "absent" || (f === "file" && ruleIsOurs(root));
}

/**
 * Writes the rule; `create` (init only) may create the directories. Returns the directories it created (for an exact
 * uninstall), or null when it wrote nothing.
 */
export function writeRule(root: string, markdown: string | null, create = false): string[] | null {
  if (!ruleWritable(root, create)) return null;
  const created = [".cursor", RULE_DIR_REL].filter((d) => kindOf(join(root, d)) === "absent");
  try {
    writeUserFileAtomic(join(root, RULE_REL), ruleText(markdown), 0o600);
  } catch {
    return null;
  }
  return created;
}

/** Whether `init` wrote the rule here: `installed.json` lists it among the exclude lines it added (read without zod). */
export function ruleRecorded(paths: Paths, root: string): boolean {
  try {
    const v = JSON.parse(readFileSync(paths.installed(root), "utf8")) as unknown;
    if (typeof v !== "object" || v === null) return false;
    // `cursor_rule: true` is init's own record (it holds in a second worktree, or when the exclude line was already
    // there); the exclude line ALIGN added counts as well.
    if ((v as { cursor_rule?: unknown }).cursor_rule === true) return true;
    const added = (v as { exclude_added?: unknown }).exclude_added;
    return Array.isArray(added) && added.includes(`/${RULE_REL}`);
  } catch {
    return false;
  }
}

/**
 * The hook's and `align pack`'s only write: the pack (or, with null, the pending text) into a rule file `init` wrote
 * and recorded, that exists and is still ALIGN's, through real directories. Never creates the file.
 */
export function refreshRule(paths: Paths, root: string, markdown: string | null): boolean {
  if (!ruleRecorded(paths, root) || kindOf(join(root, RULE_REL)) !== "file" || !ruleWritable(root, false)) return false;
  // A rule committed since init (or tracked in another worktree's history) is the repository's, never rewritten.
  if (!ruleUntracked(root)) return false;
  return writeRule(root, markdown, false) !== null;
}

/** `git ls-files --error-unmatch` answers 1 for an untracked path; anything else (tracked, a timeout) is not written. */
function ruleUntracked(root: string): boolean {
  const git = gitBinary();
  if (!git) return false;
  const r = spawnSync(git, [...HOOK_GIT_CONFIG, "ls-files", "--error-unmatch", "--", RULE_REL], {
    cwd: root,
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
    stdio: "ignore",
  });
  return r.status === 1;
}

/** Removes ALIGN's rule file (and the directories ALIGN created, when they are empty). */
export function removeRule(root: string, createdDirs: readonly string[] = []): void {
  if (ruleIsOurs(root)) rmSync(join(root, RULE_REL), { force: true });
  for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
    const p = join(root, d);
    if (kindOf(p) !== "dir") continue;
    try {
      rmdirSync(p);
    } catch {
      // not empty: the person put something there
    }
  }
}
