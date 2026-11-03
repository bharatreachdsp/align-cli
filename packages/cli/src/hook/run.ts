/**
 * The hook fast path, `align hook EVENT --harness H` (docs/15 §The hook fast path), shared by all harnesses:
 *
 * 1. stdin (at most 4 MB) parsed; any error → a count in the log, exit 0.
 * 2. `--harness claude-code` with `CURSOR_VERSION` set → exit 0 (Cursor's native hooks own that session).
 * 3. The repository: the payload's `cwd`, its git toplevel (symlinks resolved), registered exactly and opted in;
 *    otherwise exit 0 having written nothing (hard rule 6, D81). One `git rev-parse`, 300 ms.
 * 4. De-duplicate; mint or look up the ALIGN session; map to events; redact; one spool file, atomically.
 * 5. session-start serves the pack (pack/serve.ts: cache, fetch within 1.2 s, stale fallback) as the harness's
 *    session-start JSON, with the line only on a session's first sighting; Claude Code's stop prints a due notice;
 *    hooks mode emits a one-line `transcript.chunk`.
 * 6. The detached uploader is spawned if it is not running.
 * 7. Exit 0. Nothing else is ever printed (docs/15 §Guarantees 1).
 *
 * The home directory comes from the installed bundle's location, never from the environment (hook/home.ts). The
 * one request a hook makes is session-start's pack (`POST /pack`, the credential record's own server, D240).
 */
import { basename, dirname } from "node:path";
import { HOME_DIR_NAME } from "@align/core/brand";
import type { FetchLike } from "../api";
import type { Keychain } from "../credentials";
import { CorruptFileError } from "../fsx";
import { alignPluginEnabled, VIA_PLUGIN } from "../harness/claude-code/plugin";
import type { Line } from "../harness/claude-code/transcript";
import { cursorPrintTranscript } from "../harness/cursor/transcript";
import {
  chooseMode,
  HARNESS_NAMES,
  type Harness,
  HOOK_NAMES,
  type HookName,
  hooksModeText,
  lifecycleEvent,
} from "../harness/hooks";
import { parseFor } from "../harness/parse";
import { servePack, sessionStartJson } from "../pack/serve";
import type { Paths } from "../paths";
import { lookupRepo, readRegistry } from "../registry";
import { findSession, sessionFor } from "../sessions";
import { isWrapper, keepText } from "../transcripts/text";
import { loginRequired } from "../upload/state";
import { dedupeKey, firstSighting } from "./dedupe";
import { envelope, machineIdFor, type Repo, redactAll, redactionContext, spool, type TraceEvent } from "./events";
import { accountHome, repoFacts } from "./home";
import { logCount } from "./log";
import { clearNotice, noticeDue, readNotice } from "./notice";
import { capText, redactedChunks } from "./read";
import { newState, type SessionState, updateState, writeMark } from "./state";

export const MAX_STDIN_BYTES = 4 * 1024 * 1024;
/** How long a hook waits for its session's lock before leaving a mark instead (docs/15: hooks never slow a harness). */
export const HOOK_LOCK_WAIT_MS = 400;

export type HookDeps = {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  stdin: Buffer;
  now?: () => number;
  /** Prints the one documented JSON line. */
  out: (text: string) => void;
  /** Starts the detached uploader (skipped when running from source). */
  spawnUploader?: () => void;
  /** The pack request (session-start): in-process tests give the mock server's fetch and no Keychain. */
  fetch?: FetchLike;
  keychain?: Keychain | null;
  /** What is left of the hook's 1.4 s deadline (the installed bundle measures from its own start). */
  remainingMs?: () => number;
};

/**
 * The person's own home, whose `~/.claude/settings.json` says whether the plugin is enabled: the parent of the ALIGN
 * home this hook runs from (`<home>/.align`, hook/home.ts), else the password database's; never `HOME`.
 */
function userHome(deps: HookDeps): string {
  const p = deps.paths.home;
  return basename(p) === HOME_DIR_NAME ? dirname(p) : (accountHome() ?? dirname(p));
}

export type HookOutcome =
  | "ok"
  | "cursor_guard"
  | "bad_args"
  | "bad_stdin"
  | "unknown_shape"
  | "not_opted_in"
  | "duplicate"
  | "corrupt_index"
  | "other_repo"
  | "plugin_owns"
  | "lock_busy"
  | "error";

/** Runs one hook invocation. Never throws; the process exits 0 whatever this returns. */
export async function runHook(args: readonly string[], deps: HookDeps): Promise<HookOutcome> {
  const log = (code: string) => logCount(deps.paths.logs, "hook", code);
  try {
    const outcome = await fastPath(args, deps);
    if (outcome !== "ok" && outcome !== "not_opted_in" && outcome !== "cursor_guard" && outcome !== "plugin_owns")
      log(outcome);
    return outcome;
  } catch (e) {
    log(e instanceof CorruptFileError ? "corrupt_index" : "error");
    return e instanceof CorruptFileError ? "corrupt_index" : "error";
  }
}

type Args = { hook: HookName; harness: Harness; viaPlugin: boolean };

/** `<hook> --harness <h> [--via plugin]`; anything else is refused (exit 0, nothing written). */
function parseArgs(args: readonly string[]): Args | null {
  const hook = args[0] as HookName | undefined;
  const i = args.indexOf("--harness");
  const harness = i >= 0 ? args[i + 1] : undefined;
  if (!hook || !HOOK_NAMES.includes(hook) || !harness || !(HARNESS_NAMES as readonly string[]).includes(harness))
    return null;
  const v = args.indexOf("--via");
  if (v >= 0 && args[v + 1] !== VIA_PLUGIN) return null;
  const viaPlugin = v >= 0;
  // Only Claude Code has a plugin.
  if (viaPlugin && harness !== "claude-code") return null;
  return { hook, harness: harness as Harness, viaPlugin };
}

async function fastPath(args: readonly string[], deps: HookDeps): Promise<HookOutcome> {
  const now = deps.now ?? Date.now;
  const parsed = parseArgs(args);
  if (!parsed) return "bad_args";
  // 2. Cursor imports Claude Code hooks; its own hooks are the source of truth there (docs/10).
  if (parsed.harness === "claude-code" && deps.env.CURSOR_VERSION) return "cursor_guard";

  // 1. stdin
  if (deps.stdin.length === 0 || deps.stdin.length > MAX_STDIN_BYTES) return "bad_stdin";
  let payload: unknown;
  try {
    payload = JSON.parse(deps.stdin.toString("utf8"));
  } catch {
    return "bad_stdin";
  }
  const mapped = parseFor(parsed.harness, parsed.hook, payload, deps.env);
  if (!mapped.ok) {
    logCount(deps.paths.logs, "hook", `shape_${mapped.code}`);
    return "unknown_shape";
  }
  const input = mapped.input;

  // 3. Registered exactly and opted in, or nothing at all.
  const facts = await repoFacts(input.cwd);
  if (!facts) return "not_opted_in";
  const found = lookupRepo(readRegistry(deps.paths), facts.toplevel);
  if (!found?.entry.opted_in) return "not_opted_in";
  // The ALIGN plugin's hooks fire in every repository: they capture only where the person chose Claude Code at init
  // (D1245). A settings-file hook yields to the plugin when it is enabled, so one set of hooks captures (L41).
  if (parsed.viaPlugin && !found.entry.harnesses.includes("claude-code")) return "not_opted_in";
  if (parsed.harness === "claude-code" && !parsed.viaPlugin && alignPluginEnabled(userHome(deps), found.root))
    return "plugin_owns";
  // Cursor's and Codex's hooks are user-level and fire in every repository: they capture only where the person
  // chose that harness at init (Claude Code's entries live in the repository itself).
  if (parsed.harness !== "claude-code" && !found.entry.harnesses.includes(parsed.harness)) return "not_opted_in";
  const repo: Repo = { root: found.root, entry: found.entry, facts };

  // 4. De-duplicate, then the session.
  const t = now();
  const key = dedupeKey(
    { harness: parsed.harness, sessionId: input.sessionId, hookEvent: input.hookEvent, payload: deps.stdin },
    t,
  );
  if (!firstSighting(deps.paths.dedupe, key)) return "duplicate";

  const known = findSession(deps.paths, parsed.harness, input.sessionId);
  const sessionId = known ?? sessionFor(deps.paths, parsed.harness, input.sessionId, t);
  const mode = chooseMode(parsed.harness, input);
  const machineId = await machineIdFor(deps.paths);
  const rctx = redactionContext(deps.paths, repo);
  let created = false;
  let otherRepo = false;
  let notice: string | null = null;

  try {
    updateState(
      deps.paths,
      sessionId,
      () => {
        created = true;
        return newState({
          id: sessionId,
          harness: parsed.harness,
          harness_session_id: input.sessionId,
          root: repo.root,
          mode,
          transcript_path: mode === "jsonl" ? input.transcriptPath : null,
          now: t,
        });
      },
      (prev) => {
        // One ALIGN session never spans two repositories (D88): a hook from another repository is not this session's.
        if (prev.root !== repo.root) {
          otherRepo = true;
          return prev;
        }
        let state: SessionState = { ...prev, last_seen: t };
        if (!state.harness_version && input.version) state.harness_version = input.version;
        // A session continued in another transcript file (resume into a new file): read the new file from its start;
        // the line counter carries on.
        // (A Cursor session reads only the one file it was given at its end, D519.)
        if (
          state.mode === "jsonl" &&
          parsed.harness !== "cursor" &&
          input.transcriptPath &&
          input.transcriptPath !== state.transcript_path
        ) {
          state = {
            ...state,
            transcript_path: input.transcriptPath,
            cursor: { ...state.cursor, byte_offset: 0, line_no: 0, ino: null, dev: null },
            carry: null,
          };
        }
        // Cursor's print mode (`agent -p`) fires no prompt, reply or stop hook: at its end, a session with no line yet
        // is read once from its own transcript (the person's text and tool lines; replies stay out, D519).
        if (
          parsed.harness === "cursor" &&
          input.hook === "session-end" &&
          state.mode === "hooks" &&
          state.cursor.next_n === 1 &&
          !state.truncated
        ) {
          const found = cursorPrintTranscript(
            userHome(deps),
            [repo.root, input.cwd],
            state.harness_session_id,
            input.transcriptPath,
          );
          if (found)
            state = {
              ...state,
              mode: "jsonl",
              transcript_path: found.path,
              // The inode and device seen here: a file swapped in before the uploader reads is refused as `replaced`.
              cursor: { ...state.cursor, byte_offset: 0, line_no: 0, ino: found.ino, dev: found.dev },
              carry: null,
            };
        }
        if (input.hook === "stop" || input.hook === "session-end") state.pending = state.mode === "jsonl";
        if (input.hook === "session-end") state.ended_at = t;
        if (input.hook === "session-start" && state.ended_at !== null) state.ended_at = null;

        const drafts: TraceEvent[] = [];
        const common = {
          harness: {
            name: parsed.harness,
            version: state.harness_version,
            session_id: input.sessionId,
            hook_event: input.hookEvent,
          },
          sessionId,
          repo,
          cwd: input.cwd,
          now: t,
          machineId,
        };
        const life = lifecycleEvent(input, state.mode);
        if (life) drafts.push(envelope(life.kind, life.payload, common));

        // Hooks mode: one line from this hook, numbered from the session's own counter.
        if (state.mode === "hooks" && !state.truncated) {
          const hm = hooksModeText(parsed.harness, input);
          const text = hm && !(hm.role === "user" && isWrapper(hm.text)) ? keepText(hm.text) : null;
          if (hm && text) {
            const n = state.cursor.next_n;
            const line: Line = { n, src: `hooks:${n}`, role: hm.role, text, ts: new Date(t).toISOString() };
            const capped = capText([line], state.text_bytes);
            // Redacted and split as the reader's chunks are, so a long prompt never makes an event over 192 KB.
            for (const e of redactedChunks(
              capped.kept,
              { state, repo, mode: "hooks", truncated: capped.truncated, now: t, machineId },
              rctx,
            ))
              drafts.push({ ...e, harness: common.harness as Record<string, unknown> });
            state = {
              ...state,
              cursor: { ...state.cursor, next_n: n + capped.kept.length },
              text_bytes: capped.bytes,
              truncated: capped.truncated,
            };
          }
        }

        spool(deps.paths, repo, redactAll(drafts, rctx), t);

        // 5. The Stop notice, under the session's budget.
        // Only Claude Code shows a Stop hook's systemMessage; Cursor and Codex print nothing at Stop (docs/15).
        if (input.hook === "stop" && parsed.harness === "claude-code") {
          const n = readNotice(deps.paths, sessionId);
          if (n && noticeDue(state, n, t)) {
            notice = n.text;
            state = {
              ...state,
              notices_shown: [...state.notices_shown, { id: n.id, at: t, ...(n.keys ? { keys: n.keys } : {}) }],
            };
          }
        }
        return state;
      },
      HOOK_LOCK_WAIT_MS,
    );
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "lock busy") throw e;
    // The session is busy (a reader, another hook): the lifecycle event is spooled and the flags are left as a mark
    // the reader applies, so a Stop or SessionEnd is never lost. A hooks-mode line needs the counter and waits for
    // the next hook.
    const life = lifecycleEvent(input, mode);
    if (life)
      spool(
        deps.paths,
        repo,
        redactAll(
          [
            envelope(life.kind, life.payload, {
              harness: { name: parsed.harness, session_id: input.sessionId, hook_event: input.hookEvent },
              sessionId,
              repo,
              cwd: input.cwd,
              now: t,
              machineId,
            }),
          ],
          rctx,
        ),
        t,
      );
    writeMark(deps.paths, sessionId, {
      pending: input.hook === "stop" || input.hook === "session-end",
      ended_at: input.hook === "session-end" ? t : null,
      last_seen: t,
    });
    deps.spawnUploader?.();
    return "lock_busy";
  }

  if (otherRepo) return "other_repo";
  if (input.hook === "session-start") {
    // The uploader first (it is detached), so a slow pack request can never hold capture back.
    deps.spawnUploader?.();
    const served = await servePack(
      { paths: deps.paths, now: t, fetch: deps.fetch, keychain: deps.keychain, remainingMs: deps.remainingMs },
      repo,
      { harness: parsed.harness, sessionId, cwd: input.cwd },
    );
    const json = sessionStartJson(parsed.harness, served, {
      firstSighting: created,
      // The uploader's token was refused (401): capture continues into the spool, and the person is asked to sign in.
      uploadsPaused: loginRequired(deps.paths, repo.entry.org_id),
    });
    if (json) deps.out(json);
    return "ok";
  }
  if (notice !== null) {
    clearNotice(deps.paths, sessionId);
    deps.out(`${JSON.stringify({ systemMessage: notice })}\n`);
  }

  // 6. The uploader reads the transcript and sends the spool.
  deps.spawnUploader?.();
  return "ok";
}
