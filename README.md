# @align-agent/cli

The `align` command: captures the decisions made in your Claude Code, Cursor and Codex sessions, in the
repositories you opt in, keeps a receipt for every one, and serves your team's confirmed decisions back to your
agents.

This repository is the public source of the npm package. It is published from here by its own workflow with
npm's trusted publishing, so every release from `0.1.0` on carries a provenance statement linking it to the
commit and workflow run it was built from. (`0.0.0` is an empty placeholder that only reserved the name; it is
deprecated.)

## Install

```sh
npx @align-agent/cli init
```

Releases go out on npm's `latest` dist-tag; prereleases, when there are any, on `next`.

`init` signs you in with a device code, connects the repository you are in, shows exactly what is captured and
asks before anything is. Requires Node 22.14 or later on macOS or Linux (Windows through WSL).

## Commands

`align init`, `align confirm`, `align decide`, `align ask`, `align verify`, `align backfill`, `align pack`,
`align sessions`, `align export`, `align mcp`, `align status`, `align doctor`, `align on`, `align off`,
`align login`, `align logout` and `align uninstall`. Run `align <command> --help` for each one's options.

## What leaves your machine

- Your prompts and the agent's replies in opted-in repositories, with secrets removed and fenced code blocks
  replaced **on your laptop**, before anything is sent. Text you paste without a code fence is sent after secret
  redaction.
- The repository paths the agent touched (never file contents), your commit messages and the decisions you
  confirm.
- For `align verify`: the paths and line numbers where a team check matched, for the commit you share with your
  remote, never the file contents.

Never sent: file contents, tool outputs, the commands your tools ran, diffs, `.env` files and paths you deny
(`.aligndeny`), and anything from a repository you have not opted in. Your OS username and your machine's hostname
are removed from what is sent.

`align status` shows what is captured and where; `align off` stops it at once; `align sessions rm <id>`
deletes a session.

## Uninstall

```sh
align uninstall          # removes what was added for this repository (hooks restored, local files left alone)
align uninstall --purge --yes   # also deletes everything kept on this laptop
```

## Six promises

1. **Neutral.** Every harness, never our own agent. Your harness's memory is one of our sources.
2. **Receipts.** No ledger entry without evidence. The database refuses one.
3. **Verified.** Checked against what shipped, or marked unverified or stale.
4. **Yours.** Export everything, any time, in open formats (the console's export, or `align export`).
5. **Permanent ids.** Decision ids (`AL-12`) live in your commits and outlive any tool.
6. **Quiet.** One comment per PR, batched alerts, no per-developer metrics, ever.

## Building and testing from this repository

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # the CLI's unit tests (the hook-latency suite: pnpm --filter @align-agent/cli test): synthetic fixtures, temporary home folders, local servers on 127.0.0.1 only
pnpm build       # packages/cli/dist/align.mjs
```

The release workflow runs the same steps on macOS and Linux with Node 22 and 24 before it builds, packs and smoke-tests
the tarball it publishes. The tests and their fixtures are here so you can run them too; none of them is in the npm
package, which holds only the bundle, this README and the licence.

## Licence

MIT, see [LICENSE](LICENSE). It covers everything in this repository, including `packages/core/`: the parts of
ALIGN's shared library the CLI is built from, which the published package bundles.
