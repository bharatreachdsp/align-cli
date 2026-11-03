/**
 * One line per API error code (docs/19 §CLI: errors from the ledger, docs/25 §Conventions). Unknown codes get the
 * generic "refused" line with the code; nothing from the server's message is ever printed (it may carry content).
 */
import { copy } from "../copy";

export function apiErrorLine(code: string): string {
  const lines = copy.apiError as Record<string, string>;
  return Object.hasOwn(lines, code)
    ? (lines[code] as string)
    : copy.serverError(code.replace(/[^a-z_]/g, "").slice(0, 40));
}
