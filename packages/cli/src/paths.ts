/** The `~/.align` layout (docs/15 §Files). `ALIGN_HOME` moves the whole tree (tests, e2e). */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_BIN, HOME_DIR_NAME } from "@align/core/brand";

export type Paths = ReturnType<typeof alignPaths>;

export function alignHome(env: NodeJS.ProcessEnv): string {
  if (env.ALIGN_HOME) return env.ALIGN_HOME;
  return join(env.HOME || homedir(), HOME_DIR_NAME);
}

export function alignPaths(home: string) {
  const lib = join(home, "lib");
  return {
    home,
    bin: join(home, "bin"),
    shim: join(home, "bin", CLI_BIN),
    lib,
    /** The current bundle: a symlink to `align-<version>.mjs`. */
    current: join(lib, `${CLI_BIN}.mjs`),
    bundle: (version: string) => join(lib, `${CLI_BIN}-${version}.mjs`),
    credentials: join(home, "credentials.json"),
    credentialsLock: join(home, "credentials.json.lock"),
    config: join(home, "config.json"),
    configLock: join(home, "config.json.lock"),
    repos: join(home, "repos.json"),
    reposLock: join(home, "repos.json.lock"),
    repoDir: (rootPath: string) => join(home, "repos", repoHash(rootPath)),
    sessions: join(home, "sessions"),
    sessionsIndex: join(home, "sessions", "index.json"),
    sessionsLock: join(home, "sessions", "index.json.lock"),
    /** One file per ALIGN session: transcript mode, reader cursor, pending read, notices (L12). */
    sessionState: (id: string) => join(home, "sessions", `${id}.json`),
    sessionStateLock: (id: string) => join(home, "sessions", `${id}.json.lock`),
    /** Flags a hook could not write under a busy lock, applied by the reader. */
    sessionMarks: (id: string) => join(home, "sessions", `${id}.marks`),
    /** A notice the uploader fetched for a session (`GET /sessions/:id/notice`, L14), shown by the Stop hook. */
    sessionNotice: (id: string) => join(home, "sessions", `${id}.notice.json`),
    spool: join(home, "spool"),
    spoolFor: (rootPath: string) => join(home, "spool", repoHash(rootPath)),
    uploadLock: join(home, "spool", "upload.lock"),
    /** Sessions deleted with `align sessions rm`: the uploader never sends or sets aside their events (D278). */
    deletedSessions: join(home, "spool", "deleted.json"),
    deletedSessionsLock: join(home, "spool", "deleted.json.lock"),
    /** Events a server refused with a final code, with the code (never sent again; `doctor` counts them). */
    rejected: join(home, "spool", "rejected"),
    /** Events whose redaction did not settle (`redaction.hits.unsettled`): kept here and never uploaded. */
    held: join(home, "spool", "held"),
    /** The uploader's own record: last accepted upload, organisations whose sign-in expired (L14). */
    uploadState: join(home, "upload.json"),
    uploadStateLock: join(home, "upload.json.lock"),
    /** De-duplication keys of recent hook invocations (docs/10 §Cross-import guard). */
    dedupe: join(home, "hooks", "dedupe"),
    /** The per-installation salt for `machine_id` (docs/10 §Envelope). */
    salt: join(home, "salt"),
    /** What `init` installed for a repository (settings file created, exclude lines, git hooks), for `uninstall`. */
    installed: (rootPath: string) => join(home, "repos", repoHash(rootPath), "installed.json"),
    /** What ALIGN changed in a user-level harness file (`~/.cursor/hooks.json`, `~/.codex/hooks.json`), for uninstall. */
    harnessRecord: (harness: string) => join(home, "harness", `${harness}.json`),
    /**
     * The session trailer prepare-commit-msg just added in this repository (session id, HEAD then, time), consumed by
     * the next post-commit: the only session trailer a commit event keeps (D472).
     */
    trailerPending: (rootPath: string) => join(home, "repos", repoHash(rootPath), "trailer.json"),
    deny: (rootPath: string) => join(home, "repos", repoHash(rootPath), "deny"),
    /** What backfill read, uploaded and handed to the server, per harness session (L15; reruns and resumes). */
    backfill: (rootPath: string) => join(home, "repos", repoHash(rootPath), "backfill.json"),
    backfillLock: (rootPath: string) => join(home, "repos", repoHash(rootPath), "backfill.json.lock"),
    cache: join(home, "cache"),
    compileCache: join(home, "cache", "v8"),
    /** The last pack per repository and branch (docs/14 §Delivery: fresh for 10 minutes, stale up to a day). */
    packCacheDir: (rootPath: string) => join(home, "cache", "packs", repoHash(rootPath)),
    packCache: (rootPath: string, branch: string) =>
      join(
        home,
        "cache",
        "packs",
        repoHash(rootPath),
        `${createHash("sha256").update(branch).digest("hex").slice(0, 16)}.json`,
      ),
    logs: join(home, "logs"),
  };
}

/** A stable short id for a repository root, used for per-repository folders (deny, spool). */
export function repoHash(rootPath: string): string {
  return createHash("sha256").update(rootPath).digest("hex").slice(0, 16);
}
