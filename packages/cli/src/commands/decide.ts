/**
 * `align decide "<statement>" [--why …] [--rejected …]… [--paths a,b] [--commitment --owner EMAIL --due DATE]` and
 * `align ask "<question>" [--owner EMAIL]` (docs/15 §Commands). The person records what they decided: a confirmed
 * entry whose receipt is the `decision.record` event, with the person as the actor (hard rule 3). Every string
 * argument passes `redactText` on this laptop before anything is sent (the server redacts again); the email given as
 * `--owner` is an address the person typed to name someone, sent only as `owner_email`, never redacted away.
 */

import { flat } from "../confirm/card";
import { agentHarness, askTty } from "../confirm/person";
import type { Ctx } from "../context";
import { UserError } from "../context";
import { hasControl } from "../control";
import { copy } from "../copy";
import { STATEMENT_MAX, STATEMENT_MIN } from "../ledger/api";
import { laptopRedactor } from "../ledger/redact";
import { isHintPath } from "../pack/check";
import { ledgerHere, requirePerson, typedYes } from "./confirm";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DecideOptions = {
  why?: string;
  rejected?: string[];
  paths?: string;
  commitment?: boolean;
  owner?: string;
  due?: string;
};

/** Text with an escape sequence, a bidirectional override or a zero-width character is refused, never sent (R4). */
function noControl(...texts: (string | undefined)[]): void {
  if (texts.some((t) => t !== undefined && hasControl(t))) throw new UserError(copy.decide.badControl, 2);
}

function statementOf(raw: string, redact: (s: string) => string): string {
  noControl(raw);
  const s = redact(raw.replace(/\s+/g, " ").trim());
  if (s.length < STATEMENT_MIN || s.length > STATEMENT_MAX) throw new UserError(copy.decide.badLength, 2);
  return s;
}

function owner(o: { owner?: string }): string | undefined {
  if (o.owner === undefined) return undefined;
  const e = o.owner.trim();
  if (!EMAIL.test(e)) throw new UserError(copy.decide.badOwner, 2);
  return e;
}

export async function decide(
  ctx: Ctx,
  statement: string,
  o: DecideOptions,
  ttyAsk: (q: string) => Promise<string | null> = askTty,
): Promise<number> {
  requirePerson(ctx.env);
  noControl(statement, o.why, ...(o.rejected ?? []), o.paths, o.owner);
  if (!o.commitment && (o.owner !== undefined || o.due !== undefined))
    throw new UserError(copy.decide.ownerNeedsCommitment, 2);
  if (o.due !== undefined && (!DATE.test(o.due) || Number.isNaN(Date.parse(o.due))))
    throw new UserError(copy.decide.badDue, 2);
  const paths = (o.paths ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  const badPath = paths.find((p) => !isHintPath(p));
  if (badPath !== undefined || paths.length > 50) throw new UserError(copy.decide.badPaths, 2);
  const rawRejected = (o.rejected ?? []).map((r) => r.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (rawRejected.length > 10) throw new UserError(copy.decide.badRejected, 2);

  const { ledger, orgId } = await ledgerHere(ctx);
  const redact = laptopRedactor(ctx.paths, orgId);
  // Paths are strings the person typed too: one that redaction would change is refused rather than sent garbled.
  if (paths.some((p) => redact(p) !== p)) throw new UserError(copy.decide.badPaths, 2);
  // Lengths are checked on what is sent, after redaction; nothing is cut silently.
  const why = o.why?.trim() ? redact(o.why.trim()) : undefined;
  if (why && why.length > 2000) throw new UserError(copy.decide.badWhy, 2);
  const rejected = rawRejected.map((x) => redact(x));
  if (rejected.some((r) => r.length > 280)) throw new UserError(copy.decide.badRejected, 2);
  const text = statementOf(statement, redact);
  await typedYes(ttyAsk, copy.person.askRecord(flat(text)));
  const r = await ledger.record({
    kind: o.commitment ? "commitment" : "decision",
    statement: text,
    ...(why ? { rationale: why } : {}),
    alternatives_rejected: rejected,
    scope_paths: paths,
    ...(o.due ? { due_date: o.due } : {}),
    ...(owner(o) ? { owner_email: owner(o) } : {}),
  });
  ctx.line(copy.decide.recorded(flat(r.key).slice(0, 40)));
  return 0;
}

export async function ask(
  ctx: Ctx,
  question: string,
  o: { owner?: string },
  ttyAsk: (q: string) => Promise<string | null> = askTty,
): Promise<number> {
  noControl(question, o.owner);
  const { ledger, orgId } = await ledgerHere(ctx);
  const redact = laptopRedactor(ctx.paths, orgId);
  // Run by a coding agent (its markers, or no terminal): stored as an agent's question, which reaches no other
  // person's agent until a person acts on it (L43, F9, D514).
  const byAgent = agentHarness(ctx.env) !== null || !ctx.io.isTTY;
  // A person's question (no agent markers, a terminal) is typed `y` on the terminal itself, so an agent that hides its
  // markers inside a pty cannot pass its own question off as the person's (L43 review).
  if (!byAgent) await typedYes(ttyAsk, copy.person.askQuestion(flat(statementOf(question, redact))));
  const r = await ledger.ask({
    text: statementOf(question, redact),
    ...(owner(o) ? { owner_email: owner(o) } : {}),
    via: byAgent ? "agent" : "person",
  });
  ctx.line(copy.decide.asked(flat(r.key).slice(0, 40)));
  return 0;
}
