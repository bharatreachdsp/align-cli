# @align-agent/cli

## 0.1.4

### Patch Changes

- The first release on npm (0.1.3 passed every test, but its publish step gave npm the tarball's path without a
  leading `./`, which npm reads as a GitHub repository; nothing was published). Same code as 0.1.3 plus one fix:
- The git hook no longer adds this laptop's session trailer when rewording or amending a teammate's commit on a machine
  where git finds an email but no name for the committer (it now falls back to the configured `user.email`).

## 0.1.3

### Patch Changes

- Tagged, not published (the publish step's tarball path; see 0.1.4). Same code as 0.1.1; only tests
  changed for GitHub's macOS runners: in-process hook tests use the git `align init` would record (the shim's
  `ALIGN_GIT`) instead of the slow `/usr/bin/git` wrapper, macOS gets 30 s per test and two test files at a time, and the over-1,024-character
  path test is skipped on macOS, where such a path cannot exist.

## 0.1.2

### Patch Changes

- Tagged, not published (both macOS test jobs failed; see 0.1.3). Only tests changed: the git-hook tests set a
  committer name, so they pass on an account with no git identity (GitHub's runner), and a transcript test resolves
  its temporary directory, which is a symlink on macOS.

## 0.1.1

### Patch Changes

- Tagged, not published (the mirror's runner failed a git-hook test; see 0.1.2). Runs on Node 22: the
  credential-name stop in the secret rules no longer uses an inline `(?i:…)` group, which Node 22 rejects (0.1.0 was
  tagged but never published to npm for this reason).

## 0.1.0

### Minor Changes

- ee5bf8f: First release of the `align` command, for the private beta. `init` signs you in with a device code, connects the
  repository, asks before anything is captured, installs the Claude Code, Cursor and Codex hooks and the local MCP
  server, and backfills your recent sessions. Also: `confirm`, `decide`, `ask`, `verify`, `backfill`, `pack`,
  `sessions`, `export`, `status`, `doctor`, `on`, `off`, `login`, `logout` and `uninstall`.
