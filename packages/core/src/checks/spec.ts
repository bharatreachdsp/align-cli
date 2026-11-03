/**
 * Deterministic check specs (docs/13 §Deterministic checks): the six kinds `checks.kind` allows, with the
 * shape of `checks.spec` for each. These schemas check shape only; `validateSpec` (safety.ts) adds the
 * pattern and glob safety rules, and `runCheck` re-validates before it runs anything.
 */
import { z } from "zod";

export const CHECK_KINDS = [
  "forbid_import",
  "forbid_dependency",
  "forbid_pattern",
  "require_pattern",
  "path_exists",
  "path_absent",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** Languages with an import recogniser (imports.ts). `javascript` covers TypeScript too. */
export const CHECK_LANGUAGES = ["javascript", "python", "go", "ruby", "java", "kotlin", "rust"] as const;
export type CheckLanguage = (typeof CHECK_LANGUAGES)[number];

/** Package ecosystems with a manifest parser (manifests.ts). `maven` covers pom.xml and Gradle. */
export const CHECK_ECOSYSTEMS = ["npm", "pypi", "go", "rubygems", "cargo", "maven"] as const;
export type CheckEcosystem = (typeof CHECK_ECOSYSTEMS)[number];

/** Patterns and globs are at most 200 characters (docs/13 §Safety). */
export const MAX_PATTERN_LENGTH = 200;
/** Enough globs for any one decision's scope; keeps a spec well under the 4 KB `checks.spec` limit. */
export const MAX_GLOBS = 20;

const text = (max: number) => z.string().min(1).max(max);
const globs = z.array(text(MAX_PATTERN_LENGTH)).min(1).max(MAX_GLOBS);

export const ForbidImportSpec = z.strictObject({
  module: text(MAX_PATTERN_LENGTH),
  paths: globs,
  languages: z.array(z.enum(CHECK_LANGUAGES)).min(1).max(CHECK_LANGUAGES.length).optional(),
});
export const ForbidDependencySpec = z.strictObject({
  package: text(MAX_PATTERN_LENGTH),
  ecosystems: z.array(z.enum(CHECK_ECOSYSTEMS)).min(1).max(CHECK_ECOSYSTEMS.length).optional(),
});
export const PatternSpec = z.strictObject({
  pattern: text(MAX_PATTERN_LENGTH),
  paths: globs,
  description: text(280),
});
export const PathSpec = z.strictObject({ glob: text(MAX_PATTERN_LENGTH) });

/** A check as the matchers take it: the row's `kind` with its `spec`. */
export const CheckDefinition = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("forbid_import"), spec: ForbidImportSpec }),
  z.strictObject({ kind: z.literal("forbid_dependency"), spec: ForbidDependencySpec }),
  z.strictObject({ kind: z.literal("forbid_pattern"), spec: PatternSpec }),
  z.strictObject({ kind: z.literal("require_pattern"), spec: PatternSpec }),
  z.strictObject({ kind: z.literal("path_exists"), spec: PathSpec }),
  z.strictObject({ kind: z.literal("path_absent"), spec: PathSpec }),
]);
export type CheckDefinition = z.infer<typeof CheckDefinition>;

/**
 * One file of the tree a check runs over: a repository-relative POSIX path, a reader, and its size in bytes
 * when the adapter knows it (so an over-limit file is skipped without being read).
 */
export interface CheckFile {
  readonly path: string;
  readonly size?: number;
  read(): Promise<string>;
}

export interface CheckLimits {
  /** Files larger than this are skipped (bytes). Default 1 MiB. */
  readonly maxFileBytes: number;
  /** At most this many files are read per check; more → `error`. Default 5,000. */
  readonly maxFiles: number;
  /** Wall-clock budget per check; running out → `error`, never `fail`. Default 10 s. */
  readonly timeoutMs: number;
  /** Matches kept per result; a forbid check stops (as `fail`) once it has this many. Default 100. */
  readonly maxMatches: number;
}

export const DEFAULT_CHECK_LIMITS: CheckLimits = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxFiles: 5000,
  timeoutMs: 10_000,
  maxMatches: 100,
});

export const CHECK_RESULTS = ["pass", "fail", "error", "skipped"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

/** Where a check matched: paths, line numbers (1-based; 0 for a whole path) and the rule that fired. */
export interface CheckMatch {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
}

/** Why a result is `error` or `skipped`. Codes only, never content. */
export type CheckReason = "invalid_spec" | "timeout" | "too_many_files" | "files_skipped" | "read_failed";

export interface CheckOutcome {
  readonly result: CheckResult;
  readonly matches: readonly CheckMatch[];
  readonly reason?: CheckReason;
}
