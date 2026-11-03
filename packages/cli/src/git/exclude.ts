/**
 * `.git/info/exclude` entries for the files `init` writes inside the repository (docs/15 §Files: nothing is
 * committed, `git status` stays clean). A line is added only when it is not there already (idempotent); the lines
 * ALIGN added are recorded so `uninstall` removes exactly those and nothing a person wrote.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeUserFileAtomic } from "../fsx";
import { git, INTERACTIVE_GIT_TIMEOUT_MS } from "../git";

export async function excludeFile(root: string): Promise<string | null> {
  const p = await git(["rev-parse", "--git-path", "info/exclude"], root, INTERACTIVE_GIT_TIMEOUT_MS);
  if (!p) return null;
  return isAbsolute(p) ? p : join(root, p);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** What adding changed: the lines added, the file before (null when ALIGN created it) and the hash after. */
export type ExcludeChange = { added: string[]; before: string | null; after_sha256: string };

/** Adds the missing patterns; returns what changed (null when nothing did). */
export function addExcludes(file: string, patterns: string[]): ExcludeChange | null {
  const existed = existsSync(file);
  const text = read(file);
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !have.has(p));
  if (missing.length === 0) return null;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  const mode = existed ? statSync(file).mode & 0o777 : 0o644;
  const next = `${text}${sep}${missing.join("\n")}\n`;
  writeUserFileAtomic(file, next, mode);
  return { added: missing, before: existed ? text : null, after_sha256: sha256(next) };
}

/**
 * Takes ALIGN's lines out again. Untouched since ALIGN wrote it (same hash): the file goes back to its exact earlier
 * bytes, or is deleted when ALIGN created it. Edited since: only ALIGN's lines are removed.
 */
export function restoreExcludes(file: string, change: ExcludeChange): void {
  if (!existsSync(file)) return;
  if (sha256(read(file)) === change.after_sha256) {
    if (change.before === null) rmSync(file, { force: true });
    else writeUserFileAtomic(file, change.before, statSync(file).mode & 0o777);
    return;
  }
  removeExcludes(file, change.added);
}

/** Removes the given patterns (one occurrence each, whole lines only); returns the ones removed. */
export function removeExcludes(file: string, patterns: string[]): string[] {
  if (!existsSync(file) || patterns.length === 0) return [];
  const text = read(file);
  const lines = text.split("\n");
  const removed: string[] = [];
  for (const p of patterns) {
    const i = lines.lastIndexOf(p);
    if (i >= 0) {
      lines.splice(i, 1);
      removed.push(p);
    }
  }
  if (removed.length > 0) writeUserFileAtomic(file, lines.join("\n"), statSync(file).mode & 0o777);
  return removed;
}
