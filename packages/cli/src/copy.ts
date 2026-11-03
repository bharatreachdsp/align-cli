/**
 * Every word the CLI prints (docs/19 §CLI; change the wording there first). Plain, short, calm; no
 * exclamation marks, no emoji. The only file in the CLI allowed to carry the product name.
 */
import { CLI_BIN, CLI_PACKAGE, PRODUCT_NAME } from "@align/core/brand";
import { CONSENT, CONSENT_PASTE_NOTE } from "@align/core/consent";
import { VERSION } from "./version";

const B = CLI_BIN;
/**
 * How to upgrade (D515): there is no `align update`; re-running `init` from npm installs the newest bundle into
 * `~/.align/lib` and keeps the hooks, which name the shim, without a second backfill. The exact version when it is
 * known (so npm's cache cannot hand back an older one), else the build's own channel (`next` for a pre-release).
 */
export const upgradeCommand = (latest?: string | null) =>
  `npx ${CLI_PACKAGE}@${latest && /^[0-9A-Za-z.+-]{1,64}$/.test(latest) ? latest : VERSION.includes("-") ? "next" : "latest"} init --no-backfill`;
export const UPGRADE = upgradeCommand();
const pad = (label: string) => label.padEnd(12);

export const copy = {
  // align init (docs/19 §CLI: align init)
  initHeader: (version: string) => `${PRODUCT_NAME} · decision ledger for teams that build with agents · v${version}\n`,
  repository: (remoteNorm: string, branch: string | null) =>
    `${pad("Repository")} ${remoteNorm}${branch ? `  (${branch})` : ""}`,
  signInOpen: (uri: string, code: string) => `${pad("Sign in")} open ${uri} and enter ${code}`,
  signedIn: (name: string) => `${pad("")} ✓ ${name}`,
  organisation: (name: string, first: boolean) =>
    `${pad("Organisation")} ${name}${first ? "  (you are the first on this repository)" : ""}`,
  otherOrg: (repo: string, org: string) => `  ${repo} is connected to ${org}'s ${PRODUCT_NAME}.`,
  otherOrgJoin: (url: string) =>
    `  You collaborate on it on GitHub, so you can join: open ${url} and choose Join. Then run ${B} init again.`,
  noAccessYet: (repo: string, org: string) =>
    `  ${repo} is connected to ${org}, but you do not have access to it yet. Ask an admin of ${org} to give you access. Nothing was installed.`,
  otherOrgAsk: (url: string | null) =>
    `  Ask an admin of that organisation to invite you${url ? ` (${url})` : ""}. Nothing was installed.`,
  consent: (beta: { url: string } | null) =>
    [
      "",
      ...CONSENT.flatMap((section) => [
        section.title,
        ...section.items.map((item) => `  ${section.mark} ${item}`),
        ...(section.mark === "×" ? [`  ${CONSENT_PASTE_NOTE}`] : []),
      ]),
      ...(beta ? [`Opting in accepts the pilot data terms: ${beta.url}`] : []),
      "",
    ].join("\n"),
  optedIn: (remoteNorm: string) => `${pad("Opted in")} ${remoteNorm}`,
  notOptedIn: `Not opted in. Nothing is captured. Run ${B} init again when you want to.`,
  captureStoppedHere: (remoteNorm: string) => `Capture is off for ${remoteNorm} on this laptop.`,
  foreignSignInUrl: "The server sent a sign-in address on another site; nothing was opened.",
  purgeRefused: (path: string) => `${path} does not look like ${PRODUCT_NAME}'s own directory; nothing was deleted.`,
  corruptFile: (file: string) => `${file} is unreadable. Move it away and run ${B} init again.`,
  optinConsole: {
    open: (url: string, terms: boolean) =>
      `${pad("Confirm")} open ${url} and confirm there${terms ? " (confirming accepts the pilot data terms)" : ""}. Waiting…`,
    agent: (harness: string) =>
      `This looks like ${harness}'s agent running the command: only you can opt in, in your browser.`,
    expired: `The confirmation expired, so nothing was opted in. Run ${B} init again.`,
  },

  initDone: (seconds: number, o: { proposals?: boolean; console?: string } = {}) =>
    [
      "",
      `Done in ${seconds} s. Nothing is confirmed yet; ${PRODUCT_NAME} never confirms a decision for you.`,
      ...(o.proposals
        ? [
            `  Next: ${B} confirm   review the proposals (about two minutes)`,
            `        ${B} status    what is captured, where, and how to turn it off`,
          ]
        : [`  Next: ${B} status    what is captured, where, and how to turn it off`]),
      ...(o.console ? [`        ${o.console}`] : []),
      "",
    ].join("\n"),

  // align init, steps 6–7 (docs/19 §CLI: align init, "Installing")
  harnessName: { "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex" } as Record<string, string>,
  configureHarness: (name: string) => `? Capture ${name} sessions in this repository? [Y/n] `,
  installing: "\nInstalling",
  installedClaudeCode: `  ✓ ${"Claude Code".padEnd(22)} hooks in .claude/settings.local.json (merged)`,
  installedClaudeCommand: `  ✓ ${"Claude Code".padEnd(22)} /${B} command in ~/.claude/commands/${B}.md`,
  claudeCodePlugin: `  ✓ ${"Claude Code".padEnd(22)} hooks, MCP server and /${B}:${B} come with the ${PRODUCT_NAME} plugin (nothing added)`,
  claudeCommandSkipped: `  × ${"Claude Code".padEnd(22)} ~/.claude/commands/${B}.md is someone else's file; it was left alone (/${B} is not installed)`,
  installedCursorRule: `  ✓ ${"Cursor".padEnd(22)} rule file .cursor/rules/${B}.mdc (always applied; refreshed with the pack)`,
  cursorRuleSkipped: `  × ${"Cursor".padEnd(22)} .cursor/rules/${B}.mdc is a symbolic link, committed, or someone else's file; nothing was changed`,
  claudeCodeSkipped: (why: "symlink" | "unparseable" | "tracked" | "shape") =>
    `  × ${"Claude Code".padEnd(22)} .claude/settings.local.json ${
      why === "symlink"
        ? "is a symbolic link"
        : why === "tracked"
          ? "is committed to the repository"
          : why === "shape"
            ? "has a hooks setting that is not a list"
            : "is not valid JSON"
    }; nothing was changed`,
  installedCursor: `  ✓ ${"Cursor".padEnd(22)} hooks in ~/.cursor/hooks.json (merged; inactive outside opted-in repositories)`,
  installedCodex: (file: string) =>
    `  ✓ ${"Codex".padEnd(22)} hooks in ${file} (merged)   → run /hooks once in Codex and trust the ${PRODUCT_NAME} hooks`,
  userHooksSkipped: (harness: "cursor" | "codex", file: string, why: "symlink" | "unparseable" | "shape") =>
    `  × ${(harness === "cursor" ? "Cursor" : "Codex").padEnd(22)} ${file} ${
      why === "symlink"
        ? "is a symbolic link"
        : why === "shape"
          ? "has a hooks setting that is not a list"
          : "is not valid JSON"
    }; nothing was changed`,
  installedGitHooks: `  ✓ ${"git hooks".padEnd(22)} prepare-commit-msg (Align-Session trailer) · post-commit`,
  gitHooksSkipped: (names: string[]) =>
    `  × ${"git hooks".padEnd(22)} ${names.join(", ")}: a saved original (.pre-align) is already there; nothing was changed`,
  gitHooksPath: (path: string, lines: string[]) =>
    [
      `  · ${"git hooks".padEnd(22)} core.hooksPath is set (${path}); ${PRODUCT_NAME} left it alone. Add to your hook manager:`,
      ...lines.map((l) => `      ${l}`),
    ].join("\n"),
  installedExclude: `  ✓ ${"local ignore".padEnd(22)} .git/info/exclude updated — your git status stays clean`,

  // in-session lines (docs/19 §In-session lines); the session-start line itself comes with the pack (`notice_line`)
  captureOn: `${PRODUCT_NAME} · capture on`,
  /** Session start while the uploader's token was refused (401): capture continues into the spool. */
  captureOnLoginRequired: `${PRODUCT_NAME} · capture on, uploads paused: your sign-in expired. Run ${B} login.`,
  /** The Stop-hook notice the uploader writes (docs/19 §In-session lines). */
  candidateNotice: (n: number, first: string) => {
    const one = first.replace(/\s+/g, " ").trim();
    const short = one.length > 80 ? `${one.slice(0, 79)}…` : one;
    return `${PRODUCT_NAME} · ${n} new proposal${n === 1 ? "" : "s"} from this session: "${short}"${n > 1 ? ` and ${n - 1} more` : ""}. Confirm with ${B} confirm, or in your PR.`;
  },

  // the pack (docs/19 §The pack, §CLI: align pack; L16)
  pack: {
    /** Put right after the marker line of a pack served from a cache older than its ten minutes. */
    stale: (age: string) =>
      `${PRODUCT_NAME} · This pack may be out of date: the server did not answer, so this is the one fetched ${age} ago.`,
    /** The Cursor rule file's description and its closing instruction. */
    ruleDescription: `Team decisions for this repository from ${PRODUCT_NAME}`,
    /** The `/align` command's description in Claude Code (docs/14 §Delivery). */
    commandDescription: "Show the team decisions that apply here",
    rulePending: "Team decisions appear here from the next session start.",
    ruleTools: `For the receipt behind an entry (who decided it, where, the exact quote) or anything not listed here, use the ${B} MCP tools.`,
    notConnected: `This repository is not connected. Run ${B} init.`,
    notSignedIn: `Not signed in to this repository's organisation. Run ${B} login.`,
    refused: `The server gives no pack for this repository to you. Run ${B} login, or ask an admin of the organisation for access.`,
    unavailable: `The pack could not be fetched and none is cached here. Check the network and try again.`,
    badFormat: "--format is md or json.",
    help: [
      `Usage: ${B} pack [--format md|json] [--paths <path…>]`,
      "",
      "Print the team decisions that apply here (the pack your agent gets at session start).",
      "",
      "Options:",
      "  --format <format>  md (default) or json",
      "  --paths <path…>    ask for these repository paths instead of the ones you are working on",
    ].join("\n"),
  },

  // align mcp: the tool results an agent reads, and registration (docs/19 §CLI: align mcp; L18)
  mcp: {
    noRepo: `${PRODUCT_NAME} could not tell which repository this is about. Pass repo_path (the repository's absolute path on this machine), or ask the user to run ${B} init in it.`,
    writeNeedsRepo: `${PRODUCT_NAME} records decisions and questions only for the repository this agent runs in, and this one is not connected or not known here. Ask the user to start the agent in the repository (or run ${B} init there).`,
    signedOut: `The user is not signed in to this repository's organisation. Ask them to run ${B} login.`,
    forbidden: `The server refused this request: the user may not read this repository. Ask them to run ${B} login, or an admin of the organisation for access.`,
    notOptedIn: `The user has not opted in to ${PRODUCT_NAME} in this repository (or turned it off with ${B} off). Nothing was sent. They can run ${B} on.`,
    entryNotFound: "No entry with that key in this repository.",
    timeout: `${PRODUCT_NAME} did not answer in time. Nothing is retried automatically; try again if the user wants.`,
    offline: `The ${PRODUCT_NAME} server could not be reached. Check the network and try again.`,
    rateLimited: (seconds: number | null) =>
      `Too many ${PRODUCT_NAME} tool calls just now; try again in ${
        !seconds || seconds <= 0
          ? "a minute"
          : seconds < 120
            ? `${seconds} s`
            : seconds < 7200
              ? `${Math.ceil(seconds / 60)} minutes`
              : `${Math.ceil(seconds / 3600)} hours`
      }. Do not retry before then.`,
    invalid: (fields: string[]) => `The arguments are not valid${fields.length > 0 ? ` (${fields.join(", ")})` : ""}.`,
    serverError: `The ${PRODUCT_NAME} server had a problem; nothing was changed. Try again later.`,
    refused: (code: string) => `The ${PRODUCT_NAME} server refused the request (${code}).`,
    unredactable: "An argument could not be redacted safely on this machine, so nothing was sent.",
    usage: `Usage: ${B} mcp [--cwd <dir>] | ${B} mcp --print-config gemini|hermes|openclaw|generic`,
    printConfigUnknown: "--print-config takes gemini, hermes, openclaw or generic.",
    help: [
      `Usage: ${B} mcp [--cwd <dir>]`,
      `       ${B} mcp --print-config gemini|hermes|openclaw|generic`,
      "",
      `Run the ${PRODUCT_NAME} MCP server on stdio (your agent starts it; ${B} init registers it).`,
      "",
      "Options:",
      "  --cwd <dir>             the repository to answer for when the agent starts the server elsewhere",
      "  --print-config <agent>  print the configuration snippet for another agent",
    ].join("\n"),
    installed: (harness: string, where: string) => `  ✓ ${harness.padEnd(22)} MCP server ${B} (${where})`,
    printed: (harness: string, command: string) =>
      `  · ${harness.padEnd(22)} MCP server: ${harness === "Claude Code" ? "claude" : "codex"} is not on PATH; run this to add it: ${command}`,
    plugin: `  · ${"Claude Code".padEnd(22)} MCP server comes with the ${PRODUCT_NAME} plugin (nothing added)`,
    foreignRepo: (harness: string, where: string) =>
      `  × ${harness.padEnd(22)} this repository defines its own MCP server named ${B} in ${where}, which is not ${PRODUCT_NAME}'s; nothing was added`,
    foreign: (harness: string, where: string) =>
      `  × ${harness.padEnd(22)} ${where} already has an MCP server named ${B} that is not ${PRODUCT_NAME}'s; it was left alone`,
    failed: (harness: string, where: string) =>
      `  × ${harness.padEnd(22)} the MCP server could not be added to ${where}; nothing was changed`,
    cursorAllowed: `  ✓ ${"Cursor".padEnd(22)} Cursor's agent may call ${B}'s read-only tools without asking (.cursor/cli.json)`,
    cursorAllowSkipped: (rules: string[]) =>
      `  · ${"Cursor".padEnd(22)} .cursor/cli.json is committed or could not be changed, so Cursor's agent asks before each ${B} tool (print mode refuses them); to allow the read-only ones, add to its permissions.allow: ${rules.join(", ")}`,
    removePrinted: (command: string) => `To remove ${PRODUCT_NAME}'s MCP server there, run: ${command}`,
    left: (file: string) =>
      `${file} is a symbolic link or could not be read, so ${PRODUCT_NAME}'s MCP server "${B}" may still be in it: remove it by hand, then run ${B} uninstall again.`,
  },

  // align confirm (docs/19 §CLI: align confirm; L17)
  confirm: {
    header: (n: number) =>
      `${n} proposal${n === 1 ? "" : "s"} from your sessions, most consequential first. Confirm only what is true; skipping is fine.`,
    footer: "Progress is saved. Everything here enters your team's ledger only after you press c.",
    nothing: "Nothing waiting. New proposals appear after your sessions.",
    position: (i: number, n: number) => `${i} of ${n}`,
    badgeContradicted: "CONTRADICTED",
    badgeSupersedes: (key: string) => `SUPERSEDES ${key}`,
    origin: (origin: string) =>
      ({
        compile: "from a session",
        cli: "recorded in the terminal",
        console: "recorded in the console",
        pr: "from a pull request",
        slack: "from Slack",
        linear: "from Linear",
        mcp: "recorded by an agent",
        trailer: "from a commit",
      })[origin] ?? origin,
    onlyYou: "only you can see it",
    label: {
      why: "why",
      rejected: "rejected",
      receipt: "receipt",
      conflict: "conflict",
      checks: "checks",
      edited: "edited",
    },
    editedNote: "your wording; it is sent when you press c",
    noReceipt: "none you can read",
    willCheck: (what: string) => `${PRODUCT_NAME} will check: ${what}`,
    accepted: "(accepted)",
    keys: (key: string, supersedes: string | null, checks: boolean) =>
      [
        `[c] confirm as ${key}`,
        supersedes ? `[s] supersede ${supersedes}` : "[s] superseded by …",
        "[r] reject",
        "[k] skip",
        "[e] edit wording",
        ...(checks ? ["[a] accept checks"] : []),
        "[h] share",
        "[q] quit",
      ].join("  "),
    askReason: "Why is this not a decision? (Enter on an empty line cancels) ",
    askTarget: "Which entry does this one replace? Its key, e.g. AL-12: ",
    askSupersedeReason: (key: string) => `Why does ${key} no longer hold? `,
    askWording: "New wording (one line, 12 to 280 characters): ",
    editHelp: "# Edit the statement above (12 to 280 characters). Lines starting with # are ignored.",
    cancelled: "Nothing was changed.",
    badLength: "A statement is 12 to 280 characters; nothing was changed.",
    badKey: (key: string) => `${key} is not an entry key (like AL-12).`,
    noChecks: "This proposal has no proposed checks.",
    reasonNeeded: "--reject needs a reason.",
    confirmed: (key: string) => `Confirmed ${key}.`,
    rejected: (key: string) => `Rejected ${key}.`,
    superseded: (old: string, next: string) => `${next} now supersedes ${old}.`,
    shared: (key: string) => `Shared ${key} with the repository; it is still a proposal.`,
    offline: "The server could not be reached; nothing was changed. Try again.",
    noTerminal: `${B} confirm needs your own terminal. Run it there; ${B} confirm --list shows what is waiting.`,
    reasonTooLong: "A reason is at most 500 characters.",
    listLine: (key: string, kind: string, statement: string, contradicted: boolean) =>
      `${key.padEnd(8)} ${kind.padEnd(10)} ${contradicted ? "CONTRADICTED  " : ""}“${statement}”`,
    summary: (r: { confirmed: number; rejected: number; superseded: number; shared: number; skipped: number }) =>
      `Confirmed ${r.confirmed} · rejected ${r.rejected} · superseded ${r.superseded} · shared ${r.shared} · skipped ${r.skipped}.`,
  },

  // who may confirm (D404)
  person: {
    agent: (harness: string) =>
      `This looks like ${harness}'s agent running the command. Only you can confirm, reject or record decisions: run it in your own terminal.`,
    noTty: "This needs your own terminal (it asks you to type y there). Run it in a terminal window.",
    askConfirm: (keys: string[]) =>
      `Confirm ${keys.join(", ")} as your team's decision${keys.length === 1 ? "" : "s"}? Type y to confirm: [y/N] `,
    askReject: (keys: string[]) => `Reject ${keys.join(", ")}? Type y to reject: [y/N] `,
    askRecord: (statement: string) => `Record “${statement}” as a decision you made? Type y to record: [y/N] `,
    askQuestion: (question: string) => `Ask the team “${question}”? Type y to ask: [y/N] `,
    askDelete: (id: string) => `Delete session ${id}? Type y to delete: [y/N] `,
  },

  // align decide / align ask (docs/19 §CLI: decide and ask; L17)
  decide: {
    recorded: (key: string) => `Recorded ${key}.`,
    asked: (key: string) => `Asked ${key}. It is visible to the repository.`,
    badLength: "A statement is 12 to 280 characters.",
    badOwner: "--owner takes an email address.",
    ownerNeedsCommitment: "--owner and --due go with --commitment.",
    badDue: "--due takes a date like 2026-11-15.",
    badPaths: "--paths takes up to 50 repository paths separated by commas (no leading /, no ..).",
    badRejected: "--rejected takes up to 10 alternatives of at most 280 characters each.",
    badWhy: "--why is at most 2,000 characters.",
    badControl: "The text has control or invisible characters in it. Type it again without them.",
  },
  // align sessions (docs/19 §CLI: sessions and export; L17)
  sessions: {
    none: "No sessions from you yet. Your captured sessions appear here, visible only to you.",
    line: (
      id: string,
      harness: string,
      source: string,
      started: string,
      lines: number,
      proposed: number,
      cited: number,
    ) =>
      `${id}  ${harness.padEnd(11)} ${source.padEnd(8)} ${started}  ${lines} lines · ${proposed} proposed · ${cited} cited`,
    detail: (branch: string | null, state: string, ended: string) =>
      `  branch ${branch ?? "—"} · compile ${state} · ended ${ended}`,
    badId: `Give the session's id as ${B} sessions list shows it.`,
    usage: `Use ${B} sessions list, ${B} sessions show ID or ${B} sessions rm ID.`,
    ask: (id: string) =>
      `Delete session ${id}? Its lines and every proposal and receipt that came only from it are deleted; confirmed decisions stay. [y/N] `,
    kept: "Nothing was deleted.",
    deleted: (withdrawn: number, scrubbed: number, kept: number, purged: number) =>
      `Deleted. ${withdrawn} proposal${withdrawn === 1 ? "" : "s"} withdrawn, ${scrubbed} ${scrubbed === 1 ? "entry's" : "entries'"} wording erased, ${kept} confirmed decision${kept === 1 ? "" : "s"} kept${purged > 0 ? `; ${purged} event${purged === 1 ? "" : "s"} not yet uploaded deleted from this laptop` : ""}.`,
  },

  // align export
  exportCmd: {
    badFormat: "--format is md or json.",
    badLayout: "--layout is single or adr.",
    adrNeedsOut: "--layout adr writes one file per decision: give a directory with --out.",
    badPath: "The export named a file outside the --out directory; nothing more was written.",
    symlink: (path: string) => `${path} is a symbolic link or not a directory; nothing was written there.`,
    wouldOverwrite: (path: string) => `${path} exists and is not an earlier export; add --force to replace it.`,
    written: (files: number, dir: string, entries: number) =>
      `Exported ${entries} entr${entries === 1 ? "y" : "ies"} into ${files} file${files === 1 ? "" : "s"} in ${dir}.`,
  },

  redactionUnsettled:
    "This text could not be redacted reliably on this laptop, so it was not sent. Shorten or reword it.",

  // one line per API error code (docs/19 §CLI: API errors; docs/25 §Conventions)
  apiError: {
    unauthorized: `Your sign-in expired. Run ${B} login.`,
    token_expired: `Your sign-in expired. Run ${B} login.`,
    forbidden: "You do not have access to that here.",
    not_opted_in: `This repository is not opted in. Run ${B} on.`,
    terms_required: `This organisation's pilot data terms need accepting first: run ${B} init.`,
    repo_not_connected: `This repository is not connected. Run ${B} init.`,
    repo_other_org: "This repository belongs to another organisation.",
    entry_not_found: "No such entry, or you cannot see it.",
    session_conflict: "That session belongs to someone else.",
    identity_conflict: "That account is linked to someone else.",
    invalid_request: `The server did not accept that request; check the arguments (${B} help).`,
    invalid_transition:
      "That entry is not in a state that allows this (it may have been confirmed or rejected already).",
    quote_mismatch: "Its receipt no longer matches the source, so it cannot be confirmed.",
    redaction_outdated: `This version's redaction is out of date: run ${UPGRADE} in this repository.`,
    payload_too_large: "That is too large to send.",
    rate_limited: "Too many requests just now; try again in a minute.",
    plan_limit: "Your organisation's plan does not allow this.",
    spend_cap: "Your organisation has reached its spending cap for today.",
    internal: "The server had a problem; nothing was changed. Try again later.",
  } as Record<string, string>,

  // backfill: align init step 8 and align backfill (docs/19 §CLI: align init)
  backfill: {
    /** Counts for the harnesses chosen for the repository only, in a fixed order. */
    counts: (c: { "claude-code": number; cursor: number; codex: number }, chosen: readonly string[]) =>
      `${(
        [
          ["claude-code", "Claude Code"],
          ["cursor", "Cursor"],
          ["codex", "Codex"],
        ] as const
      )
        .filter(([h]) => chosen.includes(h))
        .map(([h, name]) => `${name} ${c[h]}`)
        .join(" · ")} sessions`,
    found: (counts: string, days: number) => `${pad("Found")} ${counts} from the last ${days} days`,
    nothing: (days: number) => `${pad("Backfill")} no earlier sessions of this repository in the last ${days} days.`,
    question: (days: number) =>
      [
        "? Read your recent agent sessions for this repository to find decisions you already made? [Y/n]",
        `  (Claude Code keeps 30 days of history by default; Codex and Cursor keep theirs until deleted. ${PRODUCT_NAME} reads up to ${days} days.) `,
      ].join("\n"),
    declined: `Nothing was uploaded. Run ${B} backfill when you want to.`,
    needsTerminal: `There is no terminal to ask you on, so nothing was uploaded. Run ${B} backfill in your own terminal.`,
    agent: (harness: string) =>
      `This looks like ${harness}'s agent running the command. Only you can agree to upload your past sessions: run ${B} backfill in your own terminal.`,
    busy: "A backfill is already running for this repository.",
    uploading: (bar: string, done: number, total: number) => `${pad("Uploading")} ${bar}  ${done}/${total} sessions`,
    uploaded: (counts: string, size: string) => `${pad("Backfill")} ${counts} · redacted locally · ${size} uploaded`,
    compiling: (bar: string, compiled: number, total: number) => `${pad("Compiling")} ${bar}  ${compiled}/${total}`,
    summary: (proposals: number, contradicted: number, questions: number | undefined) =>
      `${pad("")} ${proposals} proposal${proposals === 1 ? "" : "s"} · ${contradicted} look${contradicted === 1 ? "s" : ""} contradicted by the current code${questions === undefined ? "" : ` · ${questions} open question${questions === 1 ? "" : "s"}`}`,
    background: `Older sessions are still compiling in the background; \`${B} confirm\` shows them as they arrive.`,
    paused: `Compiling is paused for now; ${B} confirm shows proposals as they arrive.`,
    waiting: (n: number) =>
      `${n} session${n === 1 ? "" : "s"} wait to upload; run ${B} backfill again to compile them.`,
    refused: (n: number) =>
      `${n} session${n === 1 ? " was" : "s were"} refused by the server (kept in ~/.align/spool/rejected); ${n === 1 ? "it is" : "they are"} not compiled.`,
    notReady: `Your sessions are uploaded; the server does not compile them yet. Run ${B} backfill again later.`,
    badDays: "--days must be a whole number of days from 1 to 90.",
  },
  /** A progress bar of `width` cells. */
  bar: (done: number, total: number, width = 24) => {
    const filled = total > 0 ? Math.min(width, Math.round((done / total) * width)) : width;
    return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  },
  /** Sizes for the backfill line: 812 KB, 3.4 MB. */
  size: (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`,

  // align verify and the local checks after backfill (docs/19 §CLI: align verify)
  verify: {
    header: (n: number, sha: string) =>
      `${pad("Verify")} ${n} check${n === 1 ? "" : "s"} on commit ${sha.slice(0, 12)} (tracked files as committed; only paths and line numbers are sent)`,
    worktree: (result: string) => ` · with your uncommitted changes: ${result} (shown here only, never sent)`,
    worktreeWord: { pass: "holds", fail: "contradicted", error: "could not run", skipped: "skipped" } as Record<
      string,
      string
    >,
    none: "No checks for this repository yet.",
    noShared: (n: number) =>
      `${pad("Verify")} ${n} check${n === 1 ? "" : "s"} on your working tree only: this branch shares no commit with a remote yet, so nothing is reported (push it first)`,
    unpushed: (base: string) =>
      `${pad("")} later commits are not on a remote yet: reported at ${base.slice(0, 12)}, your newer work is in the "uncommitted changes" notes only`,
    pass: (key: string, kind: string) => `  ✓ ${key.padEnd(8)} ${kind.padEnd(18)} holds`,
    fail: (key: string, kind: string, where: string, more: number) =>
      `  × ${key.padEnd(8)} ${kind.padEnd(18)} contradicted · ${where}${more > 0 ? ` (+${more} more)` : ""}`,
    error: (key: string, kind: string, reason: string) =>
      `  ! ${key.padEnd(8)} ${kind.padEnd(18)} could not run (${reason})`,
    skipped: (key: string, kind: string) =>
      `  – ${key.padEnd(8)} ${kind.padEnd(18)} skipped (the files it needs are over 1 MB or denied)`,
    summary: (decisions: number, contradicted: number) =>
      `${pad("")} ${decisions} decision${decisions === 1 ? "" : "s"} checked · ${contradicted} look${contradicted === 1 ? "s" : ""} contradicted by the current code`,
    conflicts: (opened: number, resolved: number) =>
      `${pad("")} local conflicts: ${opened} opened · ${resolved} resolved (advisory)`,
    noCommit: "This repository has no commits yet, so there is nothing to check against.",
    unreachable: `The checks ran here, but the server could not be told; run ${B} verify again later.`,
    partial: (sent: number, total: number) =>
      `Only ${sent} of ${total} results reached the server; run ${B} verify again later.`,
  },
  /** The console's address for the init summary. */
  consoleUrl: (server: string) => `${server}/app`,

  // align flush (docs/19 §CLI: align flush)
  flush: {
    progress: (sent: number, total: number) => `Uploading · ${sent} of ${total} events`,
    done: (sent: number, refused: number, held: number) =>
      `Uploaded ${sent} event${sent === 1 ? "" : "s"}.${refused ? ` ${refused} refused by the server (kept in ~/.align/spool/rejected).` : ""}${held ? ` ${held} held back on this laptop (their redaction did not settle).` : ""}`,
    nothing: "Nothing to upload.",
    busy: "An upload is already running; it sends the spool by itself.",
    offline: (n: number) =>
      `${n} event${n === 1 ? "" : "s"} wait in the spool: the server could not be reached. They upload when the network returns.`,
    waiting: (n: number) => `${n} event${n === 1 ? "" : "s"} wait in the spool; the uploader tries again later.`,
    corruptIndex: `~/.align/sessions/index.json is unreadable, so nothing was uploaded. Run ${B} doctor.`,
    corruptDeleted: `The list of deleted sessions was unreadable, so this upload stopped; it was set aside and rebuilt. Run ${B} flush again.`,
  },

  // preflight errors
  windows: `${PRODUCT_NAME} runs on macOS and Linux. On Windows, use WSL.`,
  nodeTooOld: (have: string, need: string) => `Node ${need} or later is needed (this is ${have}).`,
  notGitRepo: `This is not a git repository. Run ${B} init inside the repository you want to connect.`,
  noRemote: `This repository has no remote. Add one (git remote add origin <url>) and run ${B} init again.`,
  ambiguousRemote: (remotes: string[]) =>
    `This repository has several remotes (${remotes.join(", ")}) and none is called origin. Choose one with ${B} init --remote <name>.`,
  unrecognisedRemote: (name: string) => `The remote ${name} is not a hosted git URL ${PRODUCT_NAME} can identify.`,
  noCommits: `This repository has no commits yet. Make the first commit and run ${B} init again.`,
  badServer: `The server URL must start with https:// (http:// is accepted only for localhost).`,

  // sign-in (align login)
  codeExpired: `The sign-in code expired. Run ${B} login again.`,
  accessDenied: "Sign-in was cancelled in the browser.",
  chooseOrg: (slugs: string[]) =>
    `You are signed in to several organisations (${slugs.join(", ")}). Choose one with --org.`,
  orgQuestion: (slugs: string[]) => `? Organisation (${slugs.join(", ")}): `,
  unknownOrg: (slug: string) => `You are not signed in to ${slug}. Run ${B} login --org ${slug}.`,
  loggedIn: (org: string) => `Signed in to ${org}.`,
  loggedOut: (org: string) => `Signed out of ${org}.`,
  loggedOutLocalOnly: (org: string) =>
    `Signed out of ${org} on this laptop; the server could not be reached to revoke the token.`,
  notLoggedIn: `Not signed in. Run ${B} login.`,
  loginRequired: `Your sign-in expired. Run ${B} login.`,

  // align on / off
  notRegistered: `This repository is not connected. Run ${B} init.`,
  onDone: (remoteNorm: string) => `Capture is on for ${remoteNorm}.`,
  offDone: (remoteNorm: string) => `Capture is off for ${remoteNorm}. Nothing more is captured here.`,
  offServerPending: `The server could not be told yet; capture stopped on this laptop already. Run ${B} off again later.`,
  termsRequired: `This organisation's pilot data terms need accepting first: run ${B} init.`,

  // align uninstall
  uninstalled: (remoteNorm: string) => `Removed ${remoteNorm} from ${PRODUCT_NAME} on this laptop.`,
  uninstallSkipped: (file: string, why: "symlink" | "unreadable" = "unreadable") =>
    `${file} ${why === "symlink" ? "is a symbolic link" : "could not be read"}, so ${PRODUCT_NAME}'s entries are still in it: remove the lines with "${B} hook" or the wrapper by hand, then run ${B} uninstall again.`,
  uninstallWrapperLeft: (file: string) =>
    `${file}: your own hook command that calls ${PRODUCT_NAME} ("${B} hook …") was left as it is; remove it yourself if you no longer want it.`,
  uninstallLeftovers: `Removed what was left from an earlier uninstall.`,
  uninstallNothing: `This repository was not connected. Nothing to remove.`,
  purged: (home: string) => `Deleted ${home}.`,
  purgeNeedsYes: `This deletes everything ${PRODUCT_NAME} keeps on this laptop. Run ${B} uninstall --purge --yes.`,

  // status
  status: {
    repository: (v: string) => `${pad("Repository")} ${v}`,
    organisation: (v: string) => `${pad("Organisation")} ${v}`,
    optIn: (v: boolean | null) => `${pad("Opt-in")} ${v === null ? "not connected" : v ? "on" : "off"}`,
    harnesses: (list: string[]) => `${pad("Harnesses")} ${list.length ? list.join(", ") : "none configured"}`,
    lastUpload: (v: string | null) => `${pad("Last upload")} ${v ?? "never"}`,
    spool: (files: number, bytes: number, refused = 0, held = 0) =>
      `${pad("Spool")} ${files} file${files === 1 ? "" : "s"} · ${bytes} bytes${refused ? ` · ${refused} refused` : ""}${held ? ` · ${held} held back` : ""}`,
    loginRequired: `sign-in expired: run ${B} login`,
    serverOk: (url: string) => `${pad("Server")} ${url} · reachable`,
    serverOffline: (url: string) =>
      `${pad("Server")} ${url} · unreachable. Capture keeps working on this laptop and uploads when the network returns.`,
    version: (current: string, latest: string | null) =>
      `${pad("Version")} ${current}${latest ? ` · ${latest} is available: ${upgradeCommand(latest)}` : ""}`,
    notConnected: "not connected here",
    signedOut: "not signed in",
  },

  // update line (docs/19 §In-session lines)
  updateAvailable: (latest: string, current: string) =>
    `${PRODUCT_NAME} · version ${latest} is available (you have ${current}): ${upgradeCommand(latest)}`,
  upgradeRequired: (current: string) =>
    `${PRODUCT_NAME} · version ${current} is no longer supported by the server: run ${UPGRADE} in this repository.`,

  // doctor
  doctor: {
    ok: (label: string) => `  ✓ ${label}`,
    fail: (label: string, fix: string) => `  × ${label}\n      fix: ${fix}`,
    summaryOk: "All checks passed.",
    summaryFail: (n: number) => `${n} check${n === 1 ? "" : "s"} failed.`,
    node: (v: string) => `Node ${v}`,
    nodeFix: (need: string) => `install Node ${need} or later`,
    shim: "shim and bundle installed",
    shimFix: `run ${B} init`,
    bundle: (v: string) => `bundle matches version ${v}`,
    bundleFix: `run ${B} init again to reinstall the bundle`,
    token: (org: string) => `signed in to ${org}`,
    tokenNone: "signed in",
    storeKeychain: "tokens in the macOS Keychain",
    storeFile: "tokens in ~/.align/credentials.json (plain text, 0600)",
    storeFileFix: "chmod 600 ~/.align/credentials.json",
    files: "local files readable",
    filesFix: (file: string) => `move ${file} away and run ${B} init again`,
    deletedList: "deleted-session list readable",
    links: "the file system holding ~/.align makes hard links (the uploader's lock)",
    linksFix: `move ~/.align to a local disk (APFS, ext4) and run ${B} init again; until then two uploaders can start at the same moment`,
    deletedListFix: `the next upload sets it aside and keeps the session ids it can read: run ${B} flush`,
    tokenFix: `run ${B} login`,
    server: (url: string) => `server ${url} reachable`,
    serverFix: "check the network or the server URL (--server)",
    clock: "clock within 2 minutes of the server",
    clockFix: "set the system clock to update automatically",
    repo: "repository registered and opted in",
    repoFix: `run ${B} init (or ${B} on) in this repository`,
    claudeHooks: "Claude Code hooks point at the shim",
    claudeCommand: `Claude Code /${B} command in ~/.claude/commands/${B}.md`,
    cursorRule: `Cursor rule file .cursor/rules/${B}.mdc`,
    claudeHooksFix: `run ${B} init again in this repository`,
    claudePlugin: `Claude Code hooks, MCP server and /${B}:${B} come from the ${PRODUCT_NAME} plugin`,
    claudeDuplicate: `no hooks in .claude/settings.local.json next to the ${PRODUCT_NAME} plugin`,
    claudeDuplicateFix: `run ${B} doctor on a terminal to remove them (a backup is kept); the plugin's hooks capture meanwhile`,
    claudeDuplicateAsk: `? Remove the hooks ${PRODUCT_NAME} added to .claude/settings.local.json before the plugin? A backup is kept. [Y/n] `,
    claudeDuplicateRemoved: (backup: string | null) =>
      `Removed ${PRODUCT_NAME}'s hooks from .claude/settings.local.json${backup ? ` (backup: ${backup})` : ""}.`,
    claudeDuplicateLeft: `.claude/settings.local.json could not be changed (a symbolic link, or not valid JSON); nothing was removed.`,
    transcript: (kept: number, dropped: number) =>
      `Claude Code transcripts readable (newest: ${kept} lines kept, ${dropped} entries dropped)`,
    transcriptFix: `the transcript format changed: run ${UPGRADE} in this repository (capture continues in hooks mode)`,
    parserOutdated: "Claude Code transcript reader up to date",
    cursorHooks: "Cursor hooks in ~/.cursor/hooks.json point at the shim",
    codexHooks: (file: string) => `Codex hooks in ${file} point at the shim`,
    harnessHooksFix: `run ${B} init again in this repository`,
    cursorTranscript: (kept: number) => `Cursor transcripts readable (newest: ${kept} lines kept)`,
    cursorTranscriptFix: "the Cursor transcript format changed; live capture continues from Cursor's hooks",
    codexTrust: (dir: string) => `Codex trusts the ${PRODUCT_NAME} hooks (best effort, from ${dir}/config.toml)`,
    codexTrustNotFound: (dir: string) =>
      `Codex trust for the ${PRODUCT_NAME} hooks not found in ${dir}/config.toml (best effort; if Codex skips them, run /hooks once in Codex and trust them)`,
    codexTrustUnknown: "Codex hook trust could not be read (best effort)",
    codexTrustFix: `run /hooks once in Codex and trust the ${PRODUCT_NAME} hooks`,
    codexParser: "Codex rollout reader up to date",
    gitHooks: "git hooks installed (prepare-commit-msg, post-commit)",
    denyFile: (file: string, usable: boolean, inexact: number) =>
      usable
        ? `${file}: ${inexact} glob${inexact === 1 ? " is" : "s are"} too long, too complex or not valid, so every path starting with ${inexact === 1 ? "its" : "their"} fixed text is left out (in any folder for a glob without a slash)`
        : `${file} cannot be used (a link, or over 64 KB, 500 globs or 8 KB of globs), so every path is left out`,
    denyFold: (file: string) => `${file}: a glob with ß matches ß only, not ss (write both spellings)`,
    denyFileFix:
      "fix the deny file (plain globs of at most 256 characters and 8 wildcards; [a-z] sets, no [[:class:]]); case is simple lower case, so write ß and ss both, and İ only as i",
    gitHooksFix: `run ${B} init again in this repository`,
    gitHooksPath: (path: string) => `git hooks managed by core.hooksPath (${path}); add the ${B} lines there`,
    spool: (files: number, bytes: number, oldest: string | null) =>
      `spool: ${files} file${files === 1 ? "" : "s"}, ${bytes} bytes${oldest ? ` (oldest ${oldest})` : ""}`,
    spoolFix: `run ${B} flush to see why the spool does not drain`,
    lastUpload: (when: string | null) => `last upload: ${when ?? "never"}`,
    uploadSignIn: "uploads signed in",
    uploadSignInFix: `the server refused the token: run ${B} login`,
    rejected: (n: number) => `${n} event${n === 1 ? "" : "s"} refused by the server (kept in ~/.align/spool/rejected)`,
    held: (n: number) => `${n} event${n === 1 ? "" : "s"} held back on this laptop (their redaction did not settle)`,
    // align doctor --bench
    benchSource: `--bench measures the installed bundle: run ${B} init first`,
    benchLine: (event: string, p50: number, p95: number, runs: number) =>
      `  ${event.padEnd(14)} p50 ${p50.toFixed(0)} ms · p95 ${p95.toFixed(0)} ms (${runs} runs)`,
    benchBroken: (failed: number, spooled: number, runs: number) =>
      `    ${failed} of ${runs} runs failed; ${spooled} of ${runs} wrote their spool file`,
    benchOk: "Hook fast path within budget (p95 under 200 ms; session start under 1.5 s).",
    benchFail: "Hook fast path over budget (p95 must stay under 200 ms; session start under 1.5 s).",
  },
  /** Ages for status and doctor: "just now", "5 min ago", "3 h ago", "2 days ago". */
  ago: (ms: number) =>
    ms < 60_000
      ? "just now"
      : ms < 3_600_000
        ? `${Math.floor(ms / 60_000)} min ago`
        : ms < 172_800_000
          ? `${Math.floor(ms / 3_600_000)} h ago`
          : `${Math.floor(ms / 86_400_000)} days ago`,

  // generic
  offline: (url: string) => `Could not reach ${url}. Check the network and try again.`,
  serverError: (code: string) => `The server refused the request (${code}).`,
  unexpected: (name: string) => `Something went wrong (${name}). Run ${B} doctor for details.`,
  protocolError: `The server's answer was not understood. Run ${UPGRADE}, or check the server URL.`,
};
