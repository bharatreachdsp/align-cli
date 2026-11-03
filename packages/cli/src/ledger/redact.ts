/**
 * Text a person types into `decide`, `ask` or `confirm` is redacted here before it leaves the laptop (docs/17,
 * ticket L17: "every string argument through redactText"); the server redacts again. Text whose redaction did not
 * settle is never sent (as for held events, D243).
 */

import { hostname, userInfo } from "node:os";
import { redactText } from "@align/core/redact";
import { readConfig } from "../config";
import { UserError } from "../context";
import { copy } from "../copy";
import type { Paths } from "../paths";

export function laptopRedactor(paths: Paths, orgId: string): (text: string) => string {
  const domains = readConfig(paths).orgs[orgId]?.email_domains;
  const host = hostname();
  let user: string | null = null;
  try {
    user = userInfo().username;
  } catch {
    user = null;
  }
  const ctx = {
    orgDomains: domains && domains.length > 0 ? domains : null,
    hostnames: [...new Set([host, host.split(".")[0] ?? ""].filter((h) => h.length >= 2))],
    usernames: user && user.length >= 2 ? [user] : [],
  };
  return (text: string) => {
    const r = redactText(text, ctx);
    if ((r.hits.unsettled ?? 0) > 0) throw new UserError(copy.redactionUnsettled);
    return r.text;
  };
}
