/**
 * Text redaction: the rule groups of docs/17 §Redaction in order (secrets, environment, personal data,
 * identity). Code-block stripping and path handling are separate (`stripCodeBlocks`, `redactEvent`) because
 * they apply to transcript text and event paths, not to every string the server sees.
 *
 * Every input first goes through `prepare` (the same on the laptop and the server, and inside
 * `stripCodeBlocks`): compatibility normalisation, Unicode spaces to plain spaces, invisible characters
 * removed, long lines cut. No rule changes the inside of a marker (`MARKER_PATTERN` in `./rules/rule`). Every pass is repeated until the text stops changing (at most `MAX_PASSES`),
 * so a replacement that brings two fragments together can never leave a match behind:
 * `redactText(redactText(x).text).text` equals `redactText(x).text` for every input (property-tested).
 */

import { stripCodeBlocks } from "./code";
import { normalizeText } from "./normalize";
import { envAssignment } from "./rules/env";
import { homePrefix, hostname, ipv4, ipv6, knownHostnames, knownUsernames } from "./rules/identity";
import { email, phone } from "./rules/personal";
import type { RuleResult } from "./rules/rule";
import { awsPairedGlued, GLUED_SECRET_RULES, SECRET_RULES } from "./rules/secrets";
import { addHits, type RedactionHits } from "./version";

export { normalizeText };

/** What the laptop knows when it redacts (docs/17). `orgDomains: null` means not known yet: every email is redacted. */
export interface RedactionContext {
  orgDomains: string[] | null;
  /** The repository's `.aligndeny` and the personal deny globs; the defaults are always added. */
  denyGlobs: string[];
  /** Absolute path of the repository root. */
  repoRoot: string;
  /** The per-installation salt for `machineId`. */
  salt: string;
  /** This machine's hostnames (`os.hostname()`), removed as whole tokens (D200). */
  hostnames?: string[];
  /** This machine's OS usernames (`os.userInfo().username`), removed as whole tokens (D200). */
  usernames?: string[];
}

/** The part of the context text redaction uses. */
export type TextContext = Pick<RedactionContext, "orgDomains" | "hostnames" | "usernames">;

export interface RedactionResult {
  text: string;
  hits: RedactionHits;
  /** Passes run; the last one changed nothing unless `hits.unsettled` is set (never seen; property-tested). */
  passes: number;
}

/**
 * Passes before a text counts as unsettled. Six, not four: a replacement can give the next rule new context several
 * times over (a home prefix joins tokens, the sweep then joins a quoted value; CI seed -647910419 needs four passes,
 * the last confirming), and the cap must stay above what honest cascades need (L10b, D284).
 */
export const MAX_PASSES = 6;

type Step = { group: string; apply: (text: string) => RuleResult };

const GLUED_STEPS: readonly Step[] = GLUED_SECRET_RULES.map((r) => ({ group: r.group, apply: r.apply }));

function steps(ctx: TextContext): Step[] {
  const out: Step[] = SECRET_RULES.map((r) => ({ group: r.group, apply: r.apply }));
  out.push({ group: "env", apply: envAssignment });
  out.push({ group: "email", apply: (t) => email(t, ctx.orgDomains) });
  out.push({ group: "phone", apply: phone });
  out.push({ group: "home", apply: homePrefix });
  out.push({ group: "host", apply: hostname });
  if (ctx.usernames?.length) {
    const users = ctx.usernames;
    out.push({ group: "user", apply: (t) => knownUsernames(t, users) });
  }
  if (ctx.hostnames?.length) {
    const hosts = ctx.hostnames;
    out.push({ group: "host", apply: (t) => knownHostnames(t, hosts) });
  }
  out.push({ group: "ip", apply: ipv4 });
  out.push({ group: "ip", apply: ipv6 });
  return out;
}

function runPass(text: string, list: readonly Step[], hits: RedactionHits): string {
  let t = text;
  for (const step of list) {
    const r = step.apply(t);
    if (r.count > 0) {
      hits[step.group] = (hits[step.group] ?? 0) + r.count;
      t = r.text;
    }
  }
  return t;
}

/** docs/10: a line longer than this is truncated with `TRUNCATED_MARKER`. */
export const MAX_LINE_CHARS = 8000;
export const TRUNCATED_MARKER = "…[truncated]";

/** `normalizeText` plus the line cap; counts cut lines in `hits.truncated`. */
export function prepare(text: string, hits: RedactionHits = {}): string {
  const t = normalizeText(text);
  if (t.length <= MAX_LINE_CHARS) return t;
  let truncated = 0;
  const lines = t.split("\n").map((line) => {
    if (line.length <= MAX_LINE_CHARS) return line;
    truncated++;
    const head = line.slice(0, MAX_LINE_CHARS - TRUNCATED_MARKER.length - 1);
    const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\t"));
    return cut > 0 ? `${head.slice(0, cut)} ${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
  });
  if (truncated > 0) hits.truncated = (hits.truncated ?? 0) + truncated;
  return lines.join("\n");
}

/** Redacts one string with the laptop's context (secrets, environment, personal data, identity). Never throws on a string. */
export function redactText(input: string, ctx: TextContext): RedactionResult {
  const hits: RedactionHits = {};
  if (input.length === 0) return { text: input, hits, passes: 0 };
  const text = prepare(input, hits);
  const list = steps(ctx);
  // The base rules to a fixed point first, then the glued vendor rules, which only add; when they change anything,
  // everything again to a fixed point (L10b, D292).
  const settle = (from: string, rules: readonly Step[], budget: number) => {
    let current = from;
    let used = 0;
    while (used < budget) {
      const passHits: RedactionHits = {};
      const next = runPass(current, rules, passHits);
      used++;
      addHits(hits, passHits);
      if (next === current) return { text: current, used, settled: true };
      current = next;
    }
    return { text: current, used, settled: false };
  };
  const base = settle(text, list, MAX_PASSES);
  let passes = base.used;
  let current = base.text;
  let settled = base.settled;
  const gluedSteps: Step[] = [...GLUED_STEPS, { group: "secret", apply: awsPairedGlued(text) }];
  const gluedHits: RedactionHits = {};
  const glued = runPass(current, gluedSteps, gluedHits);
  if (glued !== current) {
    addHits(hits, gluedHits);
    const all = settle(glued, [...gluedSteps, ...list], MAX_PASSES);
    passes += all.used;
    current = all.text;
    settled = settled && all.settled;
  }
  if (!settled) hits.unsettled = 1;
  return { text: current, hits, passes };
}

/** Whether any secret or environment rule would change `text` (one pass, no context needed). */
export function containsSecret(text: string): boolean {
  const t = prepare(text, {});
  if (t !== text) return true;
  return (
    SECRET_RULES.some((r) => r.apply(t).count > 0) ||
    envAssignment(t).count > 0 ||
    GLUED_SECRET_RULES.some((r) => r.apply(t).count > 0)
  );
}

/**
 * Prose (transcript lines, commit messages, decisions): `prepare`, then code blocks stripped, then
 * `redactText`. The order matters: an invisible character cannot hide a fence, and the result is a fixed point
 * of the whole pipeline.
 */
export function redactProse(input: string, ctx: TextContext): RedactionResult & { blocks: number } {
  return redactProseWith(input, ctx, redactText);
}

/**
 * `redactProse` with the text pass given (tests stub it). Stripping and redaction run together until stripping would
 * change nothing more: replacing a secret can turn a mid-line fence into an opener (```` ```export X=‹secret› ````
 * reads as a fence with an info string), so one round is not always a fixed point (CI build 5f81ba7b). A round
 * counts as settled only when the text pass itself settled (its `unsettled` flag is kept) and stripping its output
 * changes nothing; the strip check alone decides whether another round runs. Out of rounds, the result fails
 * closed: `unsettled` is counted and the text is stripped once more, so no fence that would open later stays.
 */
export function redactProseWith(
  input: string,
  ctx: TextContext,
  redact: (text: string, ctx: TextContext) => RedactionResult,
): RedactionResult & { blocks: number } {
  let hits: RedactionHits = {};
  let current = prepare(input, hits);
  let blocks = 0;
  let passes = 0;
  let settled = false;
  for (let round = 0; round < MAX_PASSES; round++) {
    const s = stripCodeBlocks(current);
    const r = redact(s.text, ctx);
    blocks += s.blocks;
    passes += r.passes;
    const { unsettled: innerUnsettled, ...rest } = r.hits;
    hits = addHits(hits, rest);
    current = r.text;
    if (stripCodeBlocks(current).text === current) {
      settled = !innerUnsettled;
      break;
    }
  }
  if (!settled) {
    hits.unsettled = 1;
    const last = stripCodeBlocks(current);
    blocks += last.blocks;
    current = last.text;
  }
  return { text: current, hits, passes, blocks };
}

/**
 * The same rules for server-side use: ingest, the ledger service's free-text fields, MCP tool arguments, PR
 * hunks, Slack and Linear text, before storage or a model call. The server needs none of the laptop's
 * context; pass the organisation's `email_domains` to keep its own addresses, otherwise every email is
 * redacted.
 */
export function redactServer(text: string, opts: { orgDomains?: string[] | null } = {}): RedactionResult {
  return redactText(text, { orgDomains: opts.orgDomains ?? null });
}
