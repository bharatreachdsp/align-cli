/**
 * Event redaction (docs/10 §Envelope, §Kinds and payloads, §Paths, §Code blocks). The output is built from an
 * allow-list: only the fields `schemas/trace_event.schema.json` contracts survive, each checked for its type
 * and shape; anything else (`input`, `output`, `thinking`, `author_email`, `transcript_path`, a hostname, an
 * extra key) is dropped and counted (`field_dropped`), never passed through. An unknown kind is dropped
 * whole (`event_dropped`).
 *
 * Every free-text field is normalised, code-stripped and redacted (`redactProse`; all text fields, not only
 * transcript lines: D202). `harness.session_id` and `repo.remote_norm` are kept as written (usernames
 * included, the server matches on them) and dropped only when a secret rule matches (docs/17, D75).
 * Every path is made repository-relative to the root, run through the text rules (an email or a token in a
 * file name), and dropped and counted when outside (`path_outside`) or denied (`path_denied`; `cwd_rel` too). A `commit` is
 * dropped only when every one of its files is removed; a transcript chunk is never dropped. The result
 * carries `redaction: {version, hits}`. Redacting the output again changes nothing (property-tested).
 *
 * Two entry points share the allow-list: `redactEvent` on the laptop (with the repository root and deny
 * globs; stamps `REDACTION_VERSION`) and `redactServerEvent` on ingest (no root: absolute and `..` paths are
 * dropped, the default deny globs applied; keeps the client's `redaction.version`, which L21 checks on the
 * raw event). Structural on purpose until L21 adds the zod `TraceEvent` (`packages/core/src/events.ts`).
 */

import { PACK_MARKER_RE } from "../brand";
import { normalizeText } from "./normalize";
import {
  DEFAULT_DENY_GLOBS,
  EVENT_MATCH_STEPS,
  effectiveDenyGlobs,
  invalidDenyGlobs,
  isDenied,
  MAX_PATH_CHARS,
  type MatchBudget,
  toRepoRelative,
  toSafeRelative,
} from "./paths";
import { hostname, ipv4, ipv6, knownHostnames } from "./rules/identity";
import { containsSecret, type RedactionContext, redactProse, redactServer, redactText } from "./text";
import { REDACTION_VERSION, type RedactionHits } from "./version";

export interface RedactableEvent {
  kind: string;
  cwd_rel?: string | null;
  payload: Record<string, unknown>;
  redaction?: { version: number; hits?: Record<string, number> };
}

export interface EventRedactionResult<E> {
  /** The redacted copy, or null when the event is dropped (an unknown kind, or a commit whose every file was removed). */
  event: E | null;
  hits: RedactionHits;
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The prefix of the pack Claude Code is given at session start (docs/10 §Transcript readers), in any case and spacing. */
const PACK_MARKER = PACK_MARKER_RE;
const HARNESSES = ["claude-code", "cursor", "codex", "gemini", "git", "cli", "console", "mcp", "other"];
const KINDS = [
  "session.start",
  "session.stop",
  "session.end",
  "transcript.chunk",
  "commit",
  "decision.record",
  "question.ask",
];

/** How one side (laptop or server) treats text and paths. */
interface Policy {
  text: (value: string) => { text: string; hits: RedactionHits; blocks: number };
  /** Text rules without code stripping (ids, branch names, file names). */
  plain: (value: string) => { text: string; hits: RedactionHits };
  /** Repository-relative path, or null when outside. */
  path: (value: string) => string | null;
  /** cwd_rel: `""` for the root, null when outside. */
  cwd: (value: string) => string | null;
  deny: readonly string[];
  /** Whether a hostname or IP rule would change an identifier. */
  identity: (value: string) => boolean;
  /** The `redaction.version` the output carries, given the input's (the server keeps the client's: L21 checks it). */
  version: (earlier: unknown) => number;
}

function sanitize<E extends RedactableEvent>(input: E, policy: Policy): EventRedactionResult<E> {
  const hits: RedactionHits = {};
  const count = (key: string, n = 1) => {
    if (n > 0) hits[key] = (hits[key] ?? 0) + n;
  };
  const add = (from: RedactionHits) => {
    for (const [k, v] of Object.entries(from)) count(k, v);
  };

  const text = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const r = policy.text(v);
    add(r.hits);
    count("code", r.blocks);
    return r.text;
  };
  const plain = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const r = policy.plain(v);
    add(r.hits);
    return r.text;
  };
  const textList = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out: string[] = [];
    for (const x of v) {
      if (typeof x === "string") out.push(text(x) ?? "");
      else count("field_dropped");
    }
    return out;
  };
  const oneOf =
    (values: readonly string[]) =>
    (v: unknown): string | undefined =>
      typeof v === "string" && values.includes(v) ? v : undefined;
  const matching =
    (re: RegExp, max = 300) =>
    (v: unknown): string | undefined =>
      typeof v === "string" && v.length <= max && re.test(v) ? v : undefined;
  const nullable =
    <T>(f: (v: unknown) => T | undefined) =>
    (v: unknown): T | null | undefined =>
      v === null ? null : f(v);
  const int =
    (min: number) =>
    (v: unknown): number | undefined =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : undefined;
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

  /** A path through the policy, then the text rules on what is left; null (counted) when outside. */
  const relPath = (p: unknown): string | null => {
    if (typeof p !== "string") {
      count("field_dropped");
      return null;
    }
    const rel = policy.path(p);
    if (rel === null) {
      count("path_outside");
      return null;
    }
    return plain(rel) ?? null;
  };
  /** Inside the repository and not denied (checked before and after the text rules). */
  let deniedInLast = 0;
  // Each path is matched within its own budget, and every path of this event within one shared budget: an adversarial
  // deny file cannot make an event slow, and an honest commit never loses a file to the budget (D94, D228).
  const matchBudget: MatchBudget = { steps: EVENT_MATCH_STEPS };
  const keptPaths = (v: unknown): string[] => {
    const list = Array.isArray(v) ? v : [];
    if (!Array.isArray(v) && v !== undefined) count("field_dropped");
    const kept: string[] = [];
    deniedInLast = 0;
    for (const p of list) {
      // A path longer than any real one (1,024 characters) is dropped before any rule runs on it.
      if (typeof p === "string" && p.length > MAX_PATH_CHARS) {
        count("field_dropped");
        continue;
      }
      const raw = typeof p === "string" ? policy.path(p) : null;
      const rel = relPath(p);
      if (rel === null) continue;
      if ((raw !== null && isDenied(raw, policy.deny, matchBudget)) || isDenied(rel, policy.deny, matchBudget)) {
        count("path_denied");
        deniedInLast++;
        continue;
      }
      kept.push(rel);
    }
    return kept;
  };
  /** An identifier-like field (a version, a session id, a remote) is dropped when a secret rule would change it. */
  const secretFree =
    (re: RegExp, max: number) =>
    (v: unknown): string | undefined => {
      if (typeof v !== "string" || v.length > max || !re.test(v) || containsSecret(v)) return undefined;
      return v;
    };

  /** Copies the allowed keys of `from` through their checks; every other key, and every failed check, is counted and dropped. */
  type Spec = Record<string, (v: unknown) => unknown>;
  const pick = (from: unknown, spec: Spec): Rec => {
    const out: Rec = {};
    if (!isRecord(from)) {
      if (from !== undefined) count("field_dropped");
      return out;
    }
    for (const [key, value] of Object.entries(from)) {
      const check = spec[key];
      if (!check) {
        count("field_dropped");
        continue;
      }
      const v = check(value);
      if (v === undefined) {
        if (value !== undefined) count("field_dropped");
        continue;
      }
      out[key] = v;
    }
    return out;
  };

  const raw: unknown = input;
  if (!isRecord(raw)) return { event: null, hits: { event_dropped: 1 } };
  const kind = typeof raw.kind === "string" && KINDS.includes(raw.kind) ? raw.kind : null;
  if (kind === null) return { event: null, hits: { event_dropped: 1 } };

  let drop = false;
  const payloadSpec: Record<string, Spec> = {
    "session.start": {
      source: oneOf(["startup", "resume", "clear", "compact", "fork", "unknown"]),
      transcript_mode: oneOf(["jsonl", "hooks"]),
    },
    "session.stop": {},
    "session.end": { reason: text },
    "transcript.chunk": {
      mode: oneOf(["jsonl", "hooks"]),
      truncated: bool,
      lines: (v) => {
        if (!Array.isArray(v)) return undefined;
        const out: Rec[] = [];
        for (const line of v) {
          if (!isRecord(line)) {
            count("field_dropped");
            continue;
          }
          // docs/10: a line carrying the pack marker is the pack itself, never a transcript line.
          if (typeof line.text === "string" && PACK_MARKER.test(normalizeText(line.text))) {
            count("pack_dropped");
            continue;
          }
          const kept = pick(line, {
            n: int(1),
            src: matching(/^(?:jsonl|hooks):\d{1,12}$/, 20),
            role: oneOf(["user", "assistant", "tool"]),
            text,
            ts: matching(ISO_TS, 40),
            tool: (t) =>
              isRecord(t) ? pick(t, { name: secretFree(TOOL_NAME, 128), bytes: int(0), paths: keptPaths }) : undefined,
          });
          // A tool line's text is rebuilt from its tool, so a harness that put output there cannot leak it.
          // Whenever a tool is present, whatever the role; a line whose role is not exactly user, assistant or
          // tool keeps no text at all.
          if (kept.role === "tool" || isRecord(kept.tool) || isRecord(line.tool)) {
            const tool = isRecord(kept.tool) ? kept.tool : {};
            const name = typeof tool.name === "string" ? tool.name : "unknown";
            const bytes = typeof tool.bytes === "number" ? tool.bytes : 0;
            kept.text = `‹tool: ${name}, ${bytes} bytes›`;
          } else if (kept.role === undefined && "text" in kept) {
            delete kept.text;
            count("field_dropped");
          }
          out.push(kept);
        }
        return out;
      },
    },
    commit: {
      sha: matching(HEX_SHA),
      message: text,
      files: (v) => {
        const before = Array.isArray(v) ? v.length : 0;
        const kept = keptPaths(v);
        // docs/10: dropped only when every file is denied; files removed for other reasons are only counted.
        drop = before > 0 && deniedInLast === before;
        return kept;
      },
      trailers: (v) => {
        if (!isRecord(v)) return undefined;
        const out: Rec = {};
        for (const [k, val] of Object.entries(v)) {
          if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k)) {
            count("field_dropped");
            continue;
          }
          const list = typeof val === "string" ? [text(val) ?? ""] : textList(val);
          if (list === undefined) count("field_dropped");
          else out[k] = list;
        }
        return out;
      },
    },
    "decision.record": {
      statement: text,
      rationale: text,
      alternatives_rejected: textList,
      // Scope paths are repository paths like any other: outside or denied ones are removed and counted.
      scope_paths: (v) => (Array.isArray(v) ? keptPaths(v) : undefined),
      kind: oneOf(["decision", "commitment"]),
      owner_hint: text,
      due_date: matching(DATE, 10),
      via: oneOf(["cli", "console", "mcp"]),
    },
    "question.ask": { text, owner_hint: text, via: oneOf(["cli", "console", "mcp"]) },
  };

  const previousHits = (v: unknown): RedactionHits => {
    const out: RedactionHits = {};
    if (!isRecord(v)) return out;
    for (const [k, n] of Object.entries(v)) {
      if (/^[a-z_]{1,32}$/.test(k) && typeof n === "number" && Number.isSafeInteger(n) && n >= 0) out[k] = n;
    }
    return out;
  };
  const { redaction: earlierRedaction, ...envelope } = raw;
  const earlier = isRecord(earlierRedaction) ? previousHits(earlierRedaction.hits) : {};

  const event = pick(envelope, {
    schema_version: int(1),
    event_id: matching(UUID, 36),
    ts: matching(ISO_TS, 40),
    kind: () => kind,
    harness: (v) =>
      isRecord(v)
        ? pick(v, {
            name: oneOf(HARNESSES),
            version: secretFree(/^[\w.+-]{1,64}$/, 64),
            // Kept as the harness wrote it (the server matches sessions on it), dropped only when a secret rule
            // matches; a username inside it stays (docs/17 §Redaction, exceptions).
            session_id: nullable((v) => {
              const id = secretFree(/^[\w.:-]{1,200}$/, 200)(v);
              // Dropped when it carries a hostname or an IP address (usernames stay: docs/17, D75).
              return id === undefined || policy.identity(id) ? undefined : id;
            }),
            hook_event: nullable(matching(/^[A-Za-z]{1,64}$/, 64)),
          })
        : undefined,
    session: (v) => (isRecord(v) ? pick(v, { id: nullable(matching(UUID, 36)) }) : undefined),
    repo: (v) =>
      isRecord(v)
        ? pick(v, {
            remote_norm: secretFree(/^[a-z0-9.-]+(?::[0-9]+)?\/[^\s@]+$/, 300),
            root_commit: matching(HEX_SHA),
            branch: nullable((b) => (typeof b === "string" && b.length <= 255 ? plain(b) : undefined)),
            head: nullable(matching(HEX_SHA)),
          })
        : undefined,
    cwd_rel: nullable((v) => {
      if (typeof v !== "string") return undefined;
      const c = policy.cwd(v);
      if (c === null) {
        count("path_outside");
        return null;
      }
      const out = plain(c) ?? null;
      // A working directory is a path like any other: a denied one (or one under a denied folder) is not sent.
      if (
        c !== "" &&
        (isDenied(c, policy.deny, matchBudget) || (out !== null && isDenied(out, policy.deny, matchBudget)))
      ) {
        count("path_denied");
        return null;
      }
      return out;
    }),
    machine_id: nullable(matching(/^sha256:[0-9a-f]{64}$/, 71)),
    capture: oneOf(["live", "backfill"]),
    payload: (v) => pick(v, payloadSpec[kind] ?? {}),
  });
  if (!("payload" in event)) event.payload = {};

  const merged: RedactionHits = { ...earlier };
  for (const [k, n] of Object.entries(hits)) merged[k] = (merged[k] ?? 0) + n;
  event.redaction = {
    version: policy.version(isRecord(earlierRedaction) ? earlierRedaction.version : undefined),
    hits: merged,
  };
  return { event: drop ? null : (event as unknown as E), hits };
}

function identityChanges(v: string, hostnames: readonly string[]): boolean {
  return (
    hostname(v).count > 0 ||
    ipv4(v).count > 0 ||
    ipv6(v).count > 0 ||
    (hostnames.length > 0 && knownHostnames(v, hostnames).count > 0)
  );
}

/** Laptop-side event redaction with the repository root and deny globs. */
export function redactEvent<E extends RedactableEvent>(input: E, ctx: RedactionContext): EventRedactionResult<E> {
  const deny = effectiveDenyGlobs(ctx.denyGlobs);
  const result = sanitize(input, {
    text: (v) => redactProse(v, ctx),
    plain: (v) => redactText(v, ctx),
    path: (p) => toRepoRelative(p, ctx.repoRoot, null),
    cwd: (c) => {
      if (c === "") return "";
      const rel = toRepoRelative(c, ctx.repoRoot, null);
      return rel === "." ? "" : rel;
    },
    deny,
    version: () => REDACTION_VERSION,
    identity: (v) => identityChanges(v, ctx.hostnames ?? []),
  });
  const invalid = invalidDenyGlobs(ctx.denyGlobs).length;
  if (invalid > 0) result.hits.deny_invalid = invalid;
  return result;
}

/**
 * Server-side event redaction for ingest (L21): the same allow-list, `redactServer` on every string, code
 * blocks stripped, paths that are absolute or contain `..` dropped, the default deny globs applied. Needs
 * no repository root.
 */
export function redactServerEvent<E extends RedactableEvent>(
  input: E,
  opts: { orgDomains?: string[] | null } = {},
): EventRedactionResult<E> {
  const orgDomains = opts.orgDomains ?? null;
  return sanitize(input, {
    text: (v) => redactProse(v, { orgDomains }),
    plain: (v) => redactServer(v, { orgDomains }),
    path: toSafeRelative,
    cwd: (c) => {
      if (c === "") return "";
      const rel = toSafeRelative(c);
      return rel === "." ? "" : rel;
    },
    deny: DEFAULT_DENY_GLOBS,
    // The client's version is kept, never overwritten: L21 rejects below `MIN_REDACTION_VERSION` on the raw
    // event, and the stored event says which client rules ran.
    identity: (v) => identityChanges(v, []),
    version: (earlier) => (typeof earlier === "number" && Number.isSafeInteger(earlier) && earlier >= 0 ? earlier : 0),
  });
}
