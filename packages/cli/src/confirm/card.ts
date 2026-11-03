/**
 * One proposal as a card (docs/19 §CLI: `align confirm`, board 3): position, badge (CONTRADICTED / SUPERSEDES AL-n),
 * kind, date, where it came from, the statement in quotes, why, rejected alternatives, receipts, the open conflict,
 * the proposed checks, then the keys line. Wrapped to the terminal's width with a 9-column label gutter. Every text
 * from the server passes `stripControl` first (no terminal escape reaches the screen) and is one line before wrapping.
 * Colour only when the terminal takes it (`color`); the snapshots are the plain form.
 */
import { stripControl } from "../control";
import { copy } from "../copy";
import type { CheckView, Entry } from "../ledger/api";

export type CardState = {
  /** The statement after `e`, not yet sent. */
  edited?: string;
  /** `a` pressed: the proposed checks are accepted with the confirmation. */
  acceptChecks?: boolean;
  /** A one-line note under the card (a result, an error). */
  note?: string;
};

export type CardOptions = { index: number; total: number; width: number; color: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function cardDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Server text as one safe line. */
export const flat = (s: string) => stripControl(s).replace(/\s+/g, " ").trim();

const LABEL = 9;

/** Wraps `text` to `width` columns at spaces (a word longer than a line is cut). */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    let rest = word;
    while (rest.length > w) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= w) line += ` ${rest}`;
    else {
      out.push(line);
      line = rest;
    }
  }
  if (line || out.length === 0) out.push(line);
  return out;
}

/** Joins `[x] label` groups two spaces apart, never splitting a group across lines. */
function wrapGroups(groups: string[], width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const g of groups) {
    if (line && line.length + 2 + g.length > width) {
      out.push(line);
      line = g;
    } else line = line ? `${line}  ${g}` : g;
  }
  if (line) out.push(line);
  return out;
}

/** A labelled field: `why      text…`, continuation lines indented under the text. */
function field(label: string, text: string, width: number): string[] {
  const lines = wrap(text, width - LABEL);
  return lines.map((l, i) => `${(i === 0 ? label : "").padEnd(LABEL)}${l}`.trimEnd());
}

/** `forbid_import: module ioredis · paths lib/cart/**` — a check's kind and its spec's values, one line. */
export function describeCheck(c: CheckView): string {
  const parts = Object.entries(c.spec)
    .slice(0, 6)
    .map(([k, v]) => {
      const value = Array.isArray(v) ? v.slice(0, 5).map(String).join(", ") : typeof v === "object" ? "…" : String(v);
      return `${k} ${value}`;
    });
  return flat(`${c.kind}${parts.length ? `: ${parts.join(" · ")}` : ""}`).slice(0, 200);
}

export function badge(e: Entry): string | null {
  if (e.open_conflicts > 0 || e.conflicts.some((c) => c.status === "open")) return copy.confirm.badgeContradicted;
  const sup = e.links.find((l) => l.relation === "supersedes" && l.direction === "out");
  return sup ? copy.confirm.badgeSupersedes(flat(sup.key)) : null;
}

/** The entry this proposal replaces (its SUPERSEDES link), if it names one. */
export const supersedesTarget = (e: Entry) =>
  e.links.find((l) => l.relation === "supersedes" && l.direction === "out")?.key ?? null;

export function renderCard(e: Entry, o: CardOptions, s: CardState = {}): string {
  const W = Math.max(40, o.width);
  const bold = (t: string) => (o.color ? `\u001b[1m${t}\u001b[22m` : t);
  const red = (t: string) => (o.color ? `\u001b[31m${t}\u001b[39m` : t);
  const dim = (t: string) => (o.color ? `\u001b[2m${t}\u001b[22m` : t);
  const out: string[] = [];

  const b = badge(e);
  const head = [
    copy.confirm.position(o.index + 1, o.total),
    ...(b ? [b] : []),
    [flat(e.kind), cardDate(e.created_at), copy.confirm.origin(flat(e.origin)), e.private ? copy.confirm.onlyYou : null]
      .filter(Boolean)
      .join(" · "),
  ].join("  ");
  for (const l of wrap(head, W)) out.push(b && l.includes(b) ? l.replace(b, red(b)) : l);

  const statement = s.edited ?? e.statement;
  for (const l of wrap(`“${flat(statement)}”`, W)) out.push(bold(l));
  if (s.edited !== undefined) out.push(...field(copy.confirm.label.edited, copy.confirm.editedNote, W).map(dim));
  if (e.rationale) out.push(...field(copy.confirm.label.why, flat(e.rationale), W));
  if (e.alternatives_rejected.length > 0)
    out.push(...field(copy.confirm.label.rejected, e.alternatives_rejected.map(flat).join(" · "), W));
  const receipts = e.evidence.slice(0, 3);
  receipts.forEach((r, i) => {
    const text = r.quote ? `${flat(r.locator)}: “${flat(r.quote).slice(0, 240)}”` : flat(r.locator);
    out.push(...field(i === 0 ? copy.confirm.label.receipt : "", text, W));
  });
  if (receipts.length === 0) out.push(...field(copy.confirm.label.receipt, copy.confirm.noReceipt, W));
  for (const c of e.conflicts.filter((x) => x.status === "open").slice(0, 2)) {
    const where = c.pr_number !== null ? ` (PR #${c.pr_number})` : "";
    out.push(...field(copy.confirm.label.conflict, `${flat(c.summary).slice(0, 240)}${where}`, W));
  }
  const proposed = e.checks.filter((c) => c.status === "proposed");
  proposed.slice(0, 3).forEach((c, i) => {
    const text = `${copy.confirm.willCheck(describeCheck(c))}${s.acceptChecks ? ` ${copy.confirm.accepted}` : ""}`;
    out.push(...field(i === 0 ? copy.confirm.label.checks : "", text, W));
  });

  out.push("");
  const keys = copy.confirm.keys(flat(e.key), supersedesTarget(e), proposed.length > 0);
  for (const l of wrapGroups(keys.split("  "), W))
    out.push(o.color ? l.replace(/\[([a-z])\]/g, (_m, k) => `[${bold(k)}]`) : l);
  if (s.note) for (const l of wrap(flat(s.note), W)) out.push(l);
  return `${out.join("\n")}\n`;
}
