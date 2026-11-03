/**
 * `runCheck`: one deterministic check over a file tree, the same in the worker (sparse clone) and the CLI
 * (working tree). Pure: files come from the caller's adapter as an async iterator; nothing here touches the
 * file system or the network.
 *
 * Limits (docs/13 §Safety; callers may lower them, never raise them): files over 1 MiB are skipped, at most
 * 5,000 files are read, at most 10 s per check, at most 100 matches kept (the first 100 in path and line
 * order, so every adapter gets the same list). Running out of time or files, or a failing read, is `error`,
 * never `fail` or `pass`; when a candidate file was skipped and nothing was found, the result is `skipped`
 * (D138). Results carry paths, line numbers and rule names only, never file content.
 */
import { DeadlineExceeded, type OverDeadline } from "./deadline";
import { ancestors, classifyPath, globMatcher, inGitDirectory, inSkippedDirectory, type PathMatcher } from "./glob";
import { findImports, importMatches, languageOf, MAX_LINE_CHARS } from "./imports";
import { MANIFEST_ECOSYSTEM, manifestKind, packageMatches, parseManifest } from "./manifests";
import { compilePattern } from "./regex";
import { validateSpec } from "./safety";
import {
  type CheckDefinition,
  type CheckFile,
  type CheckLimits,
  type CheckMatch,
  type CheckOutcome,
  type CheckReason,
  DEFAULT_CHECK_LIMITS,
} from "./spec";

export type CheckFiles = AsyncIterable<CheckFile> | Iterable<CheckFile>;

const TIMEOUT = Symbol("timeout");

/** The effective limits: each at most its default. */
export function effectiveLimits(limits: Partial<CheckLimits> = {}): CheckLimits {
  const pick = (key: keyof CheckLimits) => {
    const value = limits[key];
    const ceiling = DEFAULT_CHECK_LIMITS[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, ceiling) : ceiling;
  };
  return {
    maxFileBytes: pick("maxFileBytes"),
    maxFiles: pick("maxFiles"),
    timeoutMs: pick("timeoutMs"),
    maxMatches: Math.max(1, pick("maxMatches")),
  };
}

function race<T>(promise: Promise<T>, deadline: number): Promise<T | typeof TIMEOUT> {
  promise.catch(() => undefined); // a read that fails after the deadline must not become an unhandled rejection
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(TIMEOUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function iteratorOf(files: CheckFiles): AsyncIterator<CheckFile> | Iterator<CheckFile> {
  return Symbol.asyncIterator in files
    ? (files as AsyncIterable<CheckFile>)[Symbol.asyncIterator]()
    : (files as Iterable<CheckFile>)[Symbol.iterator]();
}

function tooLarge(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return true;
  if (text.length * 3 <= maxBytes) return false;
  return new TextEncoder().encode(text).length > maxBytes;
}

/** What a content check does with one file. */
interface ContentRule {
  candidate(path: string): boolean;
  /** Whether `scan` sees only the first 1,000 characters of each line of this file. */
  lineCapped(path: string): boolean;
  /** Matches in `text`, or "invalid" for a manifest that cannot be parsed. Throws DeadlineExceeded. */
  scan(path: string, text: string, overDeadline: OverDeadline): CheckMatch[] | "invalid";
}

function contentRule(check: CheckDefinition): ContentRule | null {
  switch (check.kind) {
    case "forbid_import": {
      const { module, paths, languages } = check.spec;
      const inScope = globMatcher(paths, true);
      return {
        candidate: (path) => {
          const language = languageOf(path);
          return language !== null && (!languages || languages.includes(language)) && inScope(path);
        },
        lineCapped: () => true,
        scan: (path, text, overDeadline) => {
          const language = languageOf(path);
          if (!language) return [];
          return findImports(language, text, overDeadline)
            .filter((hit) => hit.names.some((name) => importMatches(language, name, module)))
            .map((hit) => ({ path, line: hit.line, rule: hit.rule }));
        },
      };
    }
    case "forbid_dependency": {
      const { ecosystems } = check.spec;
      const wanted = check.spec.package;
      return {
        candidate: (path) => {
          const kind = manifestKind(path);
          return kind !== null && (!ecosystems || ecosystems.includes(MANIFEST_ECOSYSTEM[kind]));
        },
        // package.json and pom.xml are parsed whole; the line-based formats see 1,000 characters a line.
        lineCapped: (path) => {
          const kind = manifestKind(path);
          return kind !== "package.json" && kind !== "pom";
        },
        scan: (path, text, overDeadline) => {
          const kind = manifestKind(path);
          if (!kind) return [];
          const parsed = parseManifest(kind, text, overDeadline);
          if (parsed.invalid) return "invalid";
          return parsed.packages
            .filter((declared) => packageMatches(MANIFEST_ECOSYSTEM[kind], declared.name, wanted))
            .map((declared) => ({ path, line: declared.line, rule: declared.rule }));
        },
      };
    }
    case "forbid_pattern":
    case "require_pattern": {
      const matches = compilePattern(check.spec.pattern);
      const inScope = globMatcher(check.spec.paths, true);
      const firstOnly = check.kind === "require_pattern";
      return {
        candidate: inScope,
        lineCapped: () => true,
        scan: (path, text, overDeadline) => {
          const found: CheckMatch[] = [];
          let line = 0;
          for (const raw of text.split(/\r?\n/)) {
            line += 1;
            if (overDeadline()) throw new DeadlineExceeded(); // every line: RE2 bounds one line's cost
            if (matches(raw.slice(0, MAX_LINE_CHARS))) {
              found.push({ path, line, rule: "pattern" });
              if (firstOnly) break;
            }
          }
          return found;
        },
      };
    }
    case "path_exists":
    case "path_absent":
      return null;
  }
}

/** True when some line of `text` is longer than the 1,000 characters the line-based scanners look at. */
function hasLongLine(text: string): boolean {
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    let lineEnd = end === -1 ? text.length : end;
    if (lineEnd > start && text[lineEnd - 1] === "\r") lineEnd -= 1; // a CRLF line's \r is not content
    if (lineEnd - start > MAX_LINE_CHARS) return true;
    if (end === -1) return false;
    start = end + 1;
  }
}

const compareMatches = (a: CheckMatch, b: CheckMatch) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);

/** Sorted, without duplicates, at most `max`: the same list whatever order the adapter yields files in. */
function settle(matches: CheckMatch[], max: number): CheckMatch[] {
  const out: CheckMatch[] = [];
  for (const match of [...matches].sort(compareMatches)) {
    const previous = out[out.length - 1];
    if (previous && compareMatches(previous, match) === 0) continue;
    out.push(match);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Runs `check` (`{kind, spec}`, validated here again) over `files`. Each file's `path` is repository-relative;
 * `size` (bytes), when given, lets an over-limit file be skipped unread.
 */
export async function runCheck(
  check: unknown,
  files: CheckFiles,
  limits: Partial<CheckLimits> = {},
): Promise<CheckOutcome> {
  const validated = validateSpec(check);
  if (!validated.ok) return { result: "error", matches: [], reason: "invalid_spec" };
  const definition = validated.check;
  const limit = effectiveLimits(limits);
  const deadline = Date.now() + limit.timeoutMs;
  const overDeadline = () => Date.now() >= deadline;
  const iterator = iteratorOf(files);
  const rule = contentRule(definition);
  const pathMatcher: PathMatcher | null =
    definition.kind === "path_exists" || definition.kind === "path_absent" ? globMatcher([definition.spec.glob]) : null;
  const seenDirectories = new Set<string>();

  let matches: CheckMatch[] = [];
  let skipped = 0;
  let reads = 0;
  let finished = false;
  const stop = (result: CheckOutcome["result"], reason?: CheckReason): CheckOutcome => {
    if (!finished) {
      // Let the adapter release what it holds; never wait on it.
      try {
        Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // an adapter whose return() throws has nothing left to release
      }
    }
    const kept = result === "pass" || result === "skipped" ? [] : settle(matches, limit.maxMatches);
    return reason ? { result, matches: kept, reason } : { result, matches: kept };
  };
  const add = (found: readonly CheckMatch[]) => {
    matches.push(...found);
    if (matches.length > 4 * limit.maxMatches) matches = settle(matches, limit.maxMatches);
  };

  for (;;) {
    let step: IteratorResult<CheckFile> | typeof TIMEOUT;
    try {
      step = await race(Promise.resolve(iterator.next()), deadline);
    } catch {
      finished = true; // an iterator that threw is done
      return stop("error", "read_failed");
    }
    if (step === TIMEOUT) return stop("error", "timeout");
    if (step.done) {
      finished = true;
      break;
    }
    const file = step.value;
    if (!file || typeof file.path !== "string") return stop("error", "read_failed");
    const pathKind = classifyPath(file.path);
    if (pathKind === "invalid") return stop("error", "read_failed");
    if (pathKind === "unusual") {
      // A backslash or control character in a file name: that file is skipped, the check goes on (D98).
      skipped += 1;
      continue;
    }
    const path = file.path;

    if (pathMatcher) {
      if (inGitDirectory(path)) continue;
      // A glob may name a directory (`vendor`): every directory above a file exists too (D138).
      const found: CheckMatch[] = [];
      for (const directory of ancestors(path)) {
        if (overDeadline()) return stop("error", "timeout");
        if (seenDirectories.has(directory)) continue;
        seenDirectories.add(directory);
        if (pathMatcher(directory)) found.push({ path: directory, line: 0, rule: "path" });
      }
      if (pathMatcher(path)) found.push({ path, line: 0, rule: "path" });
      if (found.length > 0 && definition.kind === "path_exists") return stop("pass");
      add(found);
      if (overDeadline()) return stop("error", "timeout");
      continue;
    }
    if (!rule || inSkippedDirectory(path) || !rule.candidate(path)) continue;

    if (typeof file.size === "number" && file.size > limit.maxFileBytes) {
      skipped += 1;
      continue;
    }
    if (reads >= limit.maxFiles) return stop("error", "too_many_files");
    reads += 1;
    let text: string | typeof TIMEOUT;
    try {
      text = await race(
        Promise.resolve().then(() => file.read()),
        deadline,
      );
    } catch {
      return stop("error", "read_failed");
    }
    if (text === TIMEOUT) return stop("error", "timeout");
    if (typeof text !== "string") return stop("error", "read_failed");
    if (tooLarge(text, limit.maxFileBytes)) {
      skipped += 1;
      continue;
    }
    let found: CheckMatch[] | "invalid";
    try {
      found = rule.scan(path, text, overDeadline);
    } catch (error) {
      if (error instanceof DeadlineExceeded) return stop("error", "timeout");
      throw error;
    }
    // Nothing found in a file whose long lines were cut: it was not fully read, so it counts as skipped (D98).
    if (found === "invalid" || (found.length === 0 && rule.lineCapped(path) && hasLongLine(text))) {
      skipped += 1;
      continue;
    }
    if (overDeadline()) return stop("error", "timeout");
    if (definition.kind === "require_pattern" && found.length > 0) return stop("pass");
    add(found);
  }

  // A skipped candidate might hold what the check looks for: never `pass` (or `fail` for require_pattern)
  // on that basis (D138).
  switch (definition.kind) {
    case "path_exists":
      return skipped > 0 ? stop("skipped", "files_skipped") : stop("fail");
    case "path_absent":
      if (matches.length > 0) return stop("fail");
      return skipped > 0 ? stop("skipped", "files_skipped") : stop("pass");
    case "require_pattern":
      return skipped > 0 ? stop("skipped", "files_skipped") : stop("fail");
    default:
      if (matches.length > 0) return stop("fail");
      return skipped > 0 ? stop("skipped", "files_skipped") : stop("pass");
  }
}
