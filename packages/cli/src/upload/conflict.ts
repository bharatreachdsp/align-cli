/**
 * `session_conflict` (docs/15 §The uploader, D86): the server already knows this harness session under another
 * ALIGN id (it answers with that id), or the id this laptop minted is taken (no id: mint a new one). The id to re-spool
 * under is decided here, and the session's state file (cursor, mode, notices), marks and notice move with it.
 *
 * - With the server's id: the index is pointed at it (the server holds the session's events under it).
 * - Without one: if the index already names a different id than the refused event's (an earlier pass, or another
 *   event of this pass, moved it), that id is used and nothing new is minted; otherwise a new id is written only if
 *   the index still names the refused one (compare and set), so a late event under the old id never splits the
 *   session in two.
 *
 * A corrupt index throws (`CorruptFileError`): uploads stop rather than mint ids twice (L11).
 */
import { renameSync, rmSync } from "node:fs";
import { uuidv7 } from "@align/core/ids";
import { withLock } from "../fsx";
import { readState, updateState } from "../hook/state";
import type { Paths } from "../paths";
import { findSession, replaceSessionIdIf, setSessionId } from "../sessions";

function moveState(paths: Paths, oldId: string, newId: string): void {
  if (oldId === newId) return;
  try {
    withLock(paths.sessionStateLock(oldId), () => {
      const st = readState(paths, oldId);
      if (!st) return;
      updateState(paths, newId, () => ({ ...st, id: newId }));
      rmSync(paths.sessionState(oldId), { force: true });
    });
  } catch {
    // busy: the hooks follow the index from now on; the old state ages out
  }
  for (const [from, to] of [
    [paths.sessionMarks(oldId), paths.sessionMarks(newId)],
    [paths.sessionNotice(oldId), paths.sessionNotice(newId)],
  ] as const) {
    try {
      renameSync(from, to);
    } catch {
      // none, or already there
    }
  }
}

/** The id to re-spool a conflicting event under (see above). `minted` caches the pass's own new ids. */
export function resolveConflict(
  paths: Paths,
  o: { harness: string; harnessSessionId: string; oldId: string; serverId: string | null; now: number },
  minted: Map<string, string>,
): string {
  let id: string;
  if (o.serverId) {
    setSessionId(paths, o.harness, o.harnessSessionId, o.serverId);
    id = o.serverId;
  } else {
    const current = findSession(paths, o.harness, o.harnessSessionId);
    if (current && current !== o.oldId) id = current;
    else {
      id = replaceSessionIdIf(paths, o.harness, o.harnessSessionId, o.oldId, minted.get(o.oldId) ?? uuidv7(o.now));
      minted.set(o.oldId, id);
    }
  }
  moveState(paths, o.oldId, id);
  return id;
}
