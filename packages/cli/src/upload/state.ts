/**
 * `~/.align/upload.json`: what the uploader knows that commands and hooks show (docs/15 §The uploader): the time of
 * the last accepted batch, and the organisations whose token was refused with 401 ("login required": `status` says
 * so and the next session-start line asks for `align login`). `align login` and the next accepted batch clear the
 * flag. Ids and times only; never a token.
 */
import { isNumber, isRecord, recordOf, versionOk } from "../check";
import { readJsonFile, withLock, writeJsonAtomic } from "../fsx";
import type { Paths } from "../paths";

export type UploadState = {
  version: 1;
  last_upload: number | null;
  /** organisation id → when its token was refused. */
  login_required: Record<string, number>;
};

const empty = (): UploadState => ({ version: 1, last_upload: null, login_required: {} });

const parse = (v: unknown): UploadState | null => {
  if (!isRecord(v) || !versionOk(v)) return null;
  const login = recordOf(v.login_required, (x) => (isNumber(x) ? x : null));
  if (!login) return null;
  return { version: 1, last_upload: isNumber(v.last_upload) ? v.last_upload : null, login_required: login };
};

/** The state; a missing or unreadable file reads as empty (it only ever holds hints). */
export function readUploadState(paths: Paths): UploadState {
  try {
    return readJsonFile(paths.uploadState, parse, empty);
  } catch {
    return empty();
  }
}

export function updateUploadState(paths: Paths, change: (s: UploadState) => void): void {
  try {
    withLock(paths.uploadStateLock, () => {
      const s = readUploadState(paths);
      change(s);
      writeJsonAtomic(paths.uploadState, s);
    });
  } catch {
    // a hint only: a busy or unwritable file is retried on the next batch
  }
}

export function loginRequired(paths: Paths, orgId: string): boolean {
  return orgId in readUploadState(paths).login_required;
}

export function setLoginRequired(paths: Paths, orgId: string, now: number): void {
  updateUploadState(paths, (s) => {
    s.login_required[orgId] = now;
  });
}

export function clearLoginRequired(paths: Paths, orgId: string): void {
  if (!loginRequired(paths, orgId)) return;
  updateUploadState(paths, (s) => {
    delete s.login_required[orgId];
  });
}
