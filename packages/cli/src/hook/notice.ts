/**
 * The Stop-hook notice (docs/15 §The hook fast path step 5, docs/19 §Quiet-by-default budgets). The uploader
 * (L14) fetches `GET /sessions/:id/notice` and writes `~/.align/sessions/<id>.notice.json` as `{id, text}`; the
 * Stop hook prints it once as `{"systemMessage": …}` when the budget allows: at most twice per session and never
 * within 10 minutes of the previous one. The server applies the same budget; this is the laptop's guard.
 */
import { readFileSync, rmSync } from "node:fs";
import { stripControl } from "../control";
import type { Paths } from "../paths";
import type { SessionState } from "./state";

export const MAX_NOTICES_PER_SESSION = 2;
export const NOTICE_GAP_MS = 10 * 60 * 1000;
/** Claude Code caps a hook's `systemMessage`; ours are one line. */
export const MAX_NOTICE_CHARS = 500;

/** `keys`: the proposals the notice names (absent in files written before L16). */
export type Notice = { id: string; text: string; keys?: string[] };

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function readNotice(paths: Paths, sessionId: string): Notice | null {
  try {
    const v = JSON.parse(readFileSync(paths.sessionNotice(sessionId), "utf8")) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { id, text, keys } = v as Record<string, unknown>;
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id) || typeof text !== "string") return null;
    if (
      keys !== undefined &&
      !(Array.isArray(keys) && keys.length <= 100 && keys.every((k) => typeof k === "string" && KEY.test(k)))
    )
      return null;
    const line = stripControl(text.replace(/\s+/g, " ")).trim().slice(0, MAX_NOTICE_CHARS);
    if (!line) return null;
    return keys === undefined ? { id, text: line } : { id, text: line, keys: keys as string[] };
  } catch {
    return null;
  }
}

/** The proposal keys the session's notices already named. */
export const shownKeys = (state: SessionState): Set<string> =>
  new Set(state.notices_shown.flatMap((s) => s.keys ?? []));

/** Whether a notice may be shown now under the per-session budget: new proposals only, ≤ 2, ≥ 10 minutes apart. */
export function noticeDue(state: SessionState, notice: Notice, now: number): boolean {
  if (state.notices_shown.some((s) => s.id === notice.id)) return false;
  if (notice.keys) {
    const seen = shownKeys(state);
    if (notice.keys.length === 0 || notice.keys.every((k) => seen.has(k))) return false;
  }
  if (state.notices_shown.length >= MAX_NOTICES_PER_SESSION) return false;
  const last = state.notices_shown.reduce((m, s) => Math.max(m, s.at), 0);
  return last === 0 || now - last >= NOTICE_GAP_MS;
}

export function clearNotice(paths: Paths, sessionId: string): void {
  rmSync(paths.sessionNotice(sessionId), { force: true });
}
