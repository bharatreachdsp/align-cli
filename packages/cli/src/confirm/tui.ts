/**
 * The `align confirm` TUI (docs/15 §Confirm TUI, board 3). One card at a time from `GET /inbox`, keys
 * `c` confirm · `s` supersede · `r` reject · `k` skip · `e` edit wording · `a` accept proposed checks · `h` share with
 * the repository · `q` quit.
 *
 * People confirm (hard rule 3): nothing is confirmed, rejected or shared unless the person presses that key on that
 * card. A burst of keys arriving together (a paste, a key held down) acts on its first key only, and keys typed while
 * a request is running are dropped, so "cccc" can never confirm four cards. Every write is the person's own call
 * with their token; the server's RPC records them as the actor. Text the person types (wording, reasons) is redacted
 * on this laptop before it is sent. State lives on the server, so quitting loses nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { ApiError, isOffline } from "../api";
import { UserError } from "../context";
import { hasControl } from "../control";
import { copy } from "../copy";
import { ENTRY_KEY, type Entry, REASON_MAX, STATEMENT_MAX, STATEMENT_MIN } from "../ledger/api";
import type { LedgerClient } from "../ledger/client";
import { apiErrorLine } from "../ledger/errors";
import { type CardState, flat, renderCard, supersedesTarget } from "./card";
import { CLEAR, HIDE_CURSOR, PASTE_END, PASTE_START, type Term } from "./term";

export type Key = string;
export const CTRL_C = "ctrl-c";

/** Input arriving sooner than this after a card is drawn is ignored: nobody reads a card that fast (D274). */
export const ARM_MS = 300;
/** The same key again within this of the previous input is a held key repeating, not a decision (D274). */
export const REPEAT_MS = 150;

/**
 * Single keys from raw input (D266, D274): the first key of a chunk; nothing while no key is awaited (a request is
 * running); nothing within `ARM_MS` of the card being drawn; nothing that repeats the previous input within
 * `REPEAT_MS` (a held key); nothing inside a bracketed paste (`ESC[200~ … ESC[201~`, across chunks). Ctrl-C is
 * remembered and always wins.
 */
export class KeyReader {
  private waiter: ((k: Key) => void) | null = null;
  private interrupted = false;
  private pasting = false;
  private armedAt = 0;
  private last: { key: string; at: number } | null = null;
  private readonly off: () => void;

  constructor(
    term: Term,
    private readonly now: () => number = Date.now,
  ) {
    this.off = term.onData((chunk) => this.feed(chunk));
  }

  private feed(raw: string): void {
    let chunk = raw;
    // A paste, possibly split over chunks: everything between its markers is dropped.
    for (;;) {
      if (this.pasting) {
        const end = chunk.indexOf(PASTE_END);
        if (end < 0) return;
        this.pasting = false;
        chunk = chunk.slice(end + PASTE_END.length);
        continue;
      }
      const start = chunk.indexOf(PASTE_START);
      if (start < 0) break;
      const end = chunk.indexOf(PASTE_END, start);
      if (end < 0) {
        this.pasting = true;
        chunk = chunk.slice(0, start);
        break;
      }
      chunk = chunk.slice(0, start) + chunk.slice(end + PASTE_END.length);
    }
    if (chunk.includes("\u0003")) this.interrupted = true;
    const t = this.now();
    const key = (chunk[0] ?? "").toLowerCase();
    const repeat = this.last !== null && this.last.key === key && t - this.last.at < REPEAT_MS;
    if (key) this.last = { key, at: t };
    const w = this.waiter;
    if (!w) return;
    if (this.interrupted) {
      this.waiter = null;
      w(CTRL_C);
      return;
    }
    if (!key || chunk.startsWith("\u001b") || repeat || t < this.armedAt) return;
    this.waiter = null;
    w(key);
  }

  /** The next key; input before `ARM_MS` from now is ignored. */
  next(): Promise<Key> {
    if (this.interrupted) return Promise.resolve(CTRL_C);
    this.armedAt = this.now() + ARM_MS;
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.off();
    this.waiter = null;
  }
}

export type TuiDeps = {
  term: Term;
  ledger: LedgerClient;
  /** Redacts text the person typed before it leaves the laptop (throws `UserError` when it cannot). */
  redact: (text: string) => string;
  /** The clock the key timing uses (tests give a virtual one). */
  now?: () => number;
};

export type TuiResult = {
  code: number;
  confirmed: number;
  rejected: number;
  superseded: number;
  shared: number;
  skipped: number;
};

export async function runConfirmTui(deps: TuiDeps): Promise<TuiResult> {
  const { term, ledger } = deps;
  const result: TuiResult = { code: 0, confirmed: 0, rejected: 0, superseded: 0, shared: 0, skipped: 0 };
  const inbox = (await ledger.inbox()).items;
  if (inbox.length === 0) {
    term.write(`${copy.confirm.nothing}\n`);
    return result;
  }
  const keys = new KeyReader(term, deps.now ?? (term.now ? () => (term.now as () => number)() : Date.now));
  // A manual retry of the same act on the same card (after a lost answer) reuses its Idempotency-Key, so the server
  // replays instead of acting twice; a different act or a different body gets its own key.
  const run = randomBytes(8).toString("hex");
  const idem = (...parts: unknown[]) =>
    `cli-${run}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
  let draw: (() => void) | null = null;
  const offResize = term.onResize(() => draw?.());
  term.raw(true);
  term.write(HIDE_CURSOR);
  /** A line prompt in cooked mode; raw mode again afterwards. */
  const ask = async (q: string) => {
    term.raw(false);
    term.write(`\u001b[?25h`);
    try {
      return await deps.term.prompt(q);
    } finally {
      term.raw(true);
      term.write(HIDE_CURSOR);
    }
  };
  let carried: string | undefined;
  try {
    cards: for (let i = 0; i < inbox.length; i++) {
      const summary = inbox[i];
      if (!summary) continue;
      let entry: Entry;
      try {
        entry = await ledger.entry(summary.key);
      } catch (e) {
        carried = lineFor(e);
        continue;
      }
      const state: CardState = { note: carried };
      carried = undefined;
      for (;;) {
        draw = () =>
          term.write(
            `${CLEAR}${copy.confirm.header(inbox.length)}\n\n${renderCard(
              entry,
              { index: i, total: inbox.length, width: term.columns(), color: term.color },
              state,
            )}\n${copy.confirm.footer}\n`,
          );
        draw();
        const k = await keys.next();
        draw = null;
        state.note = undefined;
        if (k === CTRL_C) {
          result.code = 130;
          break cards;
        }
        if (k === "q") break cards;
        if (k === "k") {
          result.skipped++;
          continue cards;
        }
        try {
          if (k === "c") {
            const accept = state.acceptChecks
              ? entry.checks.filter((c) => c.status === "proposed").map((c) => c.id)
              : [];
            const done = await ledger.confirm(entry.key, {
              statement: state.edited,
              acceptChecks: accept,
              idem: idem(entry.key, "confirm", state.edited ?? null, accept),
            });
            result.confirmed++;
            carried = copy.confirm.confirmed(ENTRY_KEY.test(done.key) ? done.key : entry.key);
            continue cards;
          }
          if (k === "r") {
            const reason = await ask(copy.confirm.askReason);
            if (reason && hasControl(reason)) {
              state.note = copy.decide.badControl;
              continue;
            }
            const clean = reason?.trim() ? deps.redact(reason.trim()) : null;
            if (!clean) {
              state.note = copy.confirm.cancelled;
              continue;
            }
            if (clean.length > REASON_MAX) {
              state.note = copy.confirm.reasonTooLong;
              continue;
            }
            await ledger.reject(entry.key, clean, idem(entry.key, "reject", clean));
            result.rejected++;
            carried = copy.confirm.rejected(entry.key);
            continue cards;
          }
          if (k === "s") {
            const named = supersedesTarget(entry);
            const target = (named ?? (await ask(copy.confirm.askTarget)) ?? "").trim().toUpperCase();
            if (!ENTRY_KEY.test(target)) {
              state.note = target ? copy.confirm.badKey(target) : copy.confirm.cancelled;
              continue;
            }
            const reason = await ask(copy.confirm.askSupersedeReason(target));
            if (reason && hasControl(reason)) {
              state.note = copy.decide.badControl;
              continue;
            }
            const clean = reason?.trim() ? deps.redact(reason.trim()) : null;
            if (!clean) {
              state.note = copy.confirm.cancelled;
              continue;
            }
            if (clean.length > REASON_MAX) {
              state.note = copy.confirm.reasonTooLong;
              continue;
            }
            const r = await ledger.supersede(target, entry.key, clean, idem(entry.key, "supersede", target, clean));
            result.superseded++;
            carried = copy.confirm.superseded(flat(r.old.key), flat(r.new.key));
            continue cards;
          }
          if (k === "e") {
            term.raw(false);
            term.write(`\u001b[?25h`);
            let text: string | null;
            try {
              text = await term.edit(state.edited ?? entry.statement);
            } finally {
              term.raw(true);
              term.write(HIDE_CURSOR);
            }
            if (text === null) text = await ask(copy.confirm.askWording);
            // Checked before redaction, on what the person typed (an editor can leave an escape sequence behind).
            if (text && hasControl(text)) {
              state.note = copy.decide.badControl;
              continue;
            }
            const clean = text?.trim() ? deps.redact(text.replace(/\s+/g, " ").trim()) : null;
            if (!clean) state.note = copy.confirm.cancelled;
            else if (clean.length < STATEMENT_MIN || clean.length > STATEMENT_MAX) state.note = copy.confirm.badLength;
            else state.edited = clean;
            continue;
          }
          if (k === "a") {
            if (entry.checks.some((c) => c.status === "proposed")) state.acceptChecks = !state.acceptChecks;
            else state.note = copy.confirm.noChecks;
            continue;
          }
          if (k === "h") {
            await ledger.share([entry.key], idem(entry.key, "share"));
            result.shared++;
            carried = copy.confirm.shared(entry.key);
            continue cards;
          }
        } catch (e) {
          state.note = lineFor(e);
        }
      }
    }
    // On the terminal while it is still open: restore() closes /dev/tty (final review round).
    term.raw(false);
    term.write(`${copy.confirm.summary(result)}\n`);
  } finally {
    offResize();
    keys.close();
    term.raw(false);
    term.restore();
  }
  return result;
}

function lineFor(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof ApiError) return apiErrorLine(e.code);
  if (isOffline(e)) return copy.confirm.offline;
  throw e;
}
