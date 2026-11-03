/**
 * The redaction engine (docs/17 §Redaction, ticket L10). Isomorphic: the CLI runs it before anything is
 * spooled, the server runs it again on ingest and on every other free text it stores or sends to a model.
 */
export { stripCodeBlocks } from "./code";
export { type EventRedactionResult, type RedactableEvent, redactEvent, redactServerEvent } from "./event";
export {
  DEFAULT_DENY_GLOBS,
  effectiveDenyGlobs,
  invalidDenyGlobs,
  isDenied,
  MAX_PATH_CHARS,
  machineId,
  normalizeHome,
  parseDenyGlobs,
  toRepoRelative,
  toSafeRelative,
} from "./paths";
export { keepsCredentialValue } from "./rules/credential";
export { ENV_RULES, envAssignment, isSensitiveEnvName } from "./rules/env";
export { homePrefix, hostname, ipv4, ipv6, knownHostnames, knownUsernames } from "./rules/identity";
export { email, isOrgDomain, phone } from "./rules/personal";
export { MARKER_PATTERN, type Rule, type RuleResult } from "./rules/rule";
export * from "./rules/secrets";
export {
  MAX_LINE_CHARS,
  MAX_PASSES,
  normalizeText,
  prepare,
  type RedactionContext,
  type RedactionResult,
  redactProse,
  redactServer,
  redactText,
  type TextContext,
  TRUNCATED_MARKER,
} from "./text";
export {
  addHits,
  codeMarker,
  MARKER,
  MAX_MARKER_LENGTH,
  MIN_REDACTION_VERSION,
  REDACTION_VERSION,
  type RedactionHits,
} from "./version";
