# @align-agent/cli

## 0.1.1

### Patch Changes

- The first published release. Runs on Node 22: the credential-name stop in the secret rules no longer uses an
  inline `(?i:…)` group, which Node 22 rejects (0.1.0 was tagged but never published to npm for this reason).

## 0.1.0

### Minor Changes

- ee5bf8f: First release of the `align` command, for the private beta. `init` signs you in with a device code, connects the
  repository, asks before anything is captured, installs the Claude Code, Cursor and Codex hooks and the local MCP
  server, and backfills your recent sessions. Also: `confirm`, `decide`, `ask`, `verify`, `backfill`, `pack`,
  `sessions`, `export`, `status`, `doctor`, `on`, `off`, `login`, `logout` and `uninstall`.
