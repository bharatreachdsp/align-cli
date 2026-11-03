/**
 * `align confirm [--list] [KEY …] [--reject REASON]` (docs/15 §Commands, §Confirm TUI). On a terminal with no keys:
 * the TUI. `--list` prints the waiting proposals, one line each. Keys as arguments confirm those proposals (or reject
 * them with `--reject`): the person named each one on the command line, which is their explicit act (hard rule 3);
 * nothing is ever confirmed without a key or a keypress. Without a terminal and without keys, it says how to use
 * `--list` and exits 1.
 */
import { ApiError } from "../api";
import { flat } from "../confirm/card";
import { agentHarness, askTty } from "../confirm/person";
import { processTerm, type Term } from "../confirm/term";
import { runConfirmTui } from "../confirm/tui";
import type { Ctx } from "../context";
import { repoHere, UserError } from "../context";
import { copy } from "../copy";
import { ENTRY_KEY, REASON_MAX } from "../ledger/api";
import { LedgerClient } from "../ledger/client";
import { apiErrorLine } from "../ledger/errors";
import { laptopRedactor } from "../ledger/redact";

export type ConfirmOptions = { list?: boolean; reject?: string };

/** The repository here and a ledger client with its organisation's token, or a printable error. */
export async function ledgerHere(ctx: Ctx): Promise<{ ledger: LedgerClient; orgId: string; root: string }> {
  const found = await repoHere(ctx);
  if (!found) throw new UserError(copy.notRegistered);
  const api = ctx.clientFor(found.entry.org_id);
  if (!api) throw new UserError(copy.loginRequired);
  return { ledger: new LedgerClient(api, found.entry.repo_id), orgId: found.entry.org_id, root: found.root };
}

/**
 * Refuses inside an agent's shell (D404): only a person confirms, rejects, records or deletes. The line names the
 * harness and says to run the command in the person's own terminal.
 */
export function requirePerson(env: NodeJS.ProcessEnv): void {
  const agent = agentHarness(env);
  if (agent) throw new UserError(copy.person.agent(agent));
}

/** A `y` typed on the controlling terminal (`/dev/tty`); a pipe on stdin cannot answer it (D404). */
export async function typedYes(ask: (q: string) => Promise<string | null>, question: string): Promise<void> {
  const a = await ask(question);
  if (a === null) throw new UserError(copy.person.noTty);
  if (!["y", "yes"].includes(a.trim().toLowerCase())) throw new UserError(copy.confirm.cancelled);
}

export async function confirm(
  ctx: Ctx,
  keys: string[],
  o: ConfirmOptions,
  term: () => Term | null = () => processTerm(ctx.env, copy.confirm.editHelp),
  ask: (q: string) => Promise<string | null> = askTty,
): Promise<number> {
  const writes = keys.length > 0 || o.reject !== undefined || !o.list;
  if (writes) requirePerson(ctx.env);
  const { ledger, orgId } = await ledgerHere(ctx);
  const redact = laptopRedactor(ctx.paths, orgId);

  if (o.list) {
    const items = (await ledger.inbox()).items;
    if (items.length === 0) ctx.line(copy.confirm.nothing);
    else {
      ctx.line(copy.confirm.header(items.length));
      for (const e of items)
        ctx.line(copy.confirm.listLine(flat(e.key), flat(e.kind), flat(e.statement), e.open_conflicts > 0));
    }
    return 0;
  }

  if (keys.length > 0) {
    const wanted = keys.map((k) => k.trim().toUpperCase());
    const bad = wanted.find((k) => !ENTRY_KEY.test(k));
    if (bad) throw new UserError(copy.confirm.badKey(flat(bad).slice(0, 40)), 2);
    let reason: string | null = null;
    if (o.reject !== undefined) {
      reason = redact(o.reject.trim());
      if (!reason) throw new UserError(copy.confirm.reasonNeeded, 2);
      if (reason.length > REASON_MAX) throw new UserError(copy.confirm.reasonTooLong, 2);
    }
    // The person types y for exactly these keys, on their own terminal.
    await typedYes(ask, reason ? copy.person.askReject(wanted) : copy.person.askConfirm(wanted));
    let failed = 0;
    for (const k of wanted) {
      try {
        if (reason) {
          await ledger.reject(k, reason);
          ctx.line(copy.confirm.rejected(k));
        } else {
          const done = await ledger.confirm(k, {});
          ctx.line(copy.confirm.confirmed(ENTRY_KEY.test(done.key) ? done.key : k));
        }
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        failed++;
        ctx.fail(`${k}: ${apiErrorLine(e.code)}`);
      }
    }
    return failed > 0 ? 1 : 0;
  }

  const t = term();
  if (!t) throw new UserError(copy.confirm.noTerminal);
  const r = await runConfirmTui({ term: t, ledger, redact });
  return r.code;
}
