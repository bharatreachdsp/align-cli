/** Deterministic check matchers (docs/13 §Deterministic checks), shared by the worker and the CLI. */

export { DeadlineExceeded } from "./deadline";
export {
  ancestors,
  classifyPath,
  inSkippedDirectory,
  isRepositoryPath,
  MAX_PATH_LENGTH,
  SKIPPED_DIRECTORIES,
} from "./glob";
export { findImports, type ImportHit, importMatches, languageOf, MAX_LINE_CHARS } from "./imports";
export {
  type DeclaredPackage,
  MANIFEST_ECOSYSTEM,
  type ManifestKind,
  manifestKind,
  packageMatches,
  parseManifest,
} from "./manifests";
export { compileGlobs, compilePattern, globToRegex } from "./regex";
export { type CheckFiles, effectiveLimits, runCheck } from "./run";
export {
  BRACKETS_IN_BRACES_MESSAGE,
  globIssue,
  MAX_COUNTED_REPETITION,
  MAX_VARIABLE_PARTS,
  patternIssue,
  type SafetyIssue,
  type SpecIssue,
  type ValidateSpecResult,
  validateSpec,
} from "./safety";
export * from "./spec";
