/**
 * docs/17 §Redaction rule 2, environment: `NAME=value` (and `NAME: value` for names with an underscore, as in
 * YAML) where `NAME` looks like an environment variable whose name contains KEY, TOKEN, SECRET, PASSWORD,
 * PASS, PWD, DSN, PRIVATE or CREDENTIAL. The value becomes `‹secret›`; the name stays. References to other
 * variables (`process.env.X`, `$X`, `${X}`, `os.environ[…]`) carry no value and are left.
 */
import { MARKER } from "../version";
import { isReference } from "./credential";
import { isMarker, type Rule, type RuleResult, replaceCounting } from "./rule";

const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|DSN|PRIVATE|CREDENTIAL/;

export function isSensitiveEnvName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && SENSITIVE_NAME.test(name);
}

export function envAssignment(text: string): RuleResult {
  return replaceCounting(
    text,
    /(?<![A-Za-z0-9_.$-])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)(\s*=\s*|:[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
    (m) => {
      const name = m[1] ?? "";
      const sep = m[2] ?? "";
      const raw = m[3] ?? "";
      if (!isSensitiveEnvName(name)) return null;
      if (sep.startsWith(":") && !name.includes("_")) return null;
      const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : "";
      const value = quote ? raw.slice(1, -1) : raw;
      if (value.length === 0 || isMarker(value) || isReference(value)) return null;
      return `${name}${sep}${quote}${MARKER.secret}${quote}`;
    },
  );
}

export const ENV_RULES: readonly Rule[] = [{ name: "envAssignment", group: "env", apply: envAssignment }];
