/**
 * Glob matching (linear-time, regex.ts; picomatch's syntax with `dot: true` and no extglobs, D150) and the
 * directories content checks never look into. Paths are repository-relative with `/` separators
 * (`isRepositoryPath`).
 */
import { compileGlobs } from "./regex";

export type PathMatcher = (path: string) => boolean;

/**
 * One matcher for a list of globs (any of them); `.github/**` and `**\/.env*` work as written. With
 * `literalDirectory`, a glob without wildcards also covers everything under it (content checks' `paths`).
 */
export function globMatcher(globs: readonly string[], literalDirectory = false): PathMatcher {
  return compileGlobs(globs, literalDirectory);
}

/** Every directory above `path` (`a/b/c.ts` → `a`, `a/b`). */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) out.push(path.slice(0, at));
  return out;
}

/** Longest path a check accepts from an adapter (Linux's PATH_MAX); anything longer is a broken adapter. */
export const MAX_PATH_LENGTH = 4096;

/**
 * How a path handed over by an adapter is treated (D98). `ok`: a repository-relative POSIX path. `unusual`:
 * well-formed, but its name holds a backslash or a control character, which a repository may legitimately
 * contain; that one file is skipped (so the check cannot `pass` on it). `invalid`: empty, longer than 4,096
 * characters, absolute, or with an empty, `.` or `..` segment: the adapter is broken or hostile, and the
 * whole check is `error` (`read_failed`). Nothing is normalised.
 */
export function classifyPath(path: string): "ok" | "unusual" | "invalid" {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.startsWith("/")) return "invalid";
  if (!path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")) return "invalid";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this looks for
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return "unusual";
  return "ok";
}

/** True for a plain repository-relative path (`classifyPath(path) === "ok"`). */
export function isRepositoryPath(path: string): boolean {
  return classifyPath(path) === "ok";
}

/** Dependency and vendored directories: skipped by the content checks and the manifest scan (docs/13). */
export const SKIPPED_DIRECTORIES: readonly string[] = Object.freeze([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "third_party",
  "third-party",
  ".git",
  ".venv",
  "venv",
  "site-packages",
  "__pypackages__",
]);
const SKIPPED = new Set(SKIPPED_DIRECTORIES);

/** True when any directory segment of `path` is a dependency or vendored directory. */
export function inSkippedDirectory(path: string): boolean {
  const segments = path.split("/");
  segments.pop();
  return segments.some((segment) => SKIPPED.has(segment));
}

/** Path checks see vendored directories (a decision may be "no vendor/ directory") but never `.git/`. */
export function inGitDirectory(path: string): boolean {
  return path === ".git" || path.startsWith(".git/") || path.includes("/.git/");
}
