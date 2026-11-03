/**
 * zod helpers shared by every package. `formatIssues` turns a validation failure into the short feedback
 * v0 sent back to the model in its one repair attempt (`path: message; …`, at most 1,600 characters).
 * zod 4's built-in messages name the rule and the expected shape, not the received value.
 */
import type { z } from "zod";

export const ISSUE_FEEDBACK_LIMIT = 1600;

export function formatIssues(issues: readonly z.core.$ZodIssue[], limit = ISSUE_FEEDBACK_LIMIT): string {
  return issues
    .map((issue) => `${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`)
    .join("; ")
    .slice(0, limit);
}
