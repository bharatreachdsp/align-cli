/**
 * The `align` command tree (docs/15 §Commands) on commander. `run(argv, io, deps)` is the whole CLI as a
 * function so tests drive it in-process. Exit codes: 0 ok, 1 a failure explained to the person, 2 usage.
 * Hidden internal entry points (`hook`, `git-hook`, `upload`, `flush`) are dispatched before commander
 * (internal.ts); they always exit 0 and print only the documented hook JSON (docs/15 §Guarantees 1).
 */
import { CLI_BIN } from "@align/core/brand";
import { Command, CommanderError } from "commander";
import { ApiError, isOffline, ProtocolError } from "./api";
import { login, logout, setCapture, uninstall } from "./commands/account";
import { backfill } from "./commands/backfill";
import { bench } from "./commands/bench";
import { confirm } from "./commands/confirm";
import { ask, decide } from "./commands/decide";
import { doctor } from "./commands/doctor";
import { exportLedger } from "./commands/export";
import { init } from "./commands/init";
import { sessions } from "./commands/sessions";
import { status } from "./commands/status";
import { verify } from "./commands/verify";
import { Ctx, type Deps, type Io, UserError } from "./context";
import { copy } from "./copy";
import { CorruptFileError } from "./fsx";
import { MAX_STDIN_BYTES } from "./hook/run";
import { INTERNAL_COMMANDS, readProcessStdin, runInternal } from "./internal";
import { apiErrorLine } from "./ledger/errors";
import { VERSION } from "./version";

export type { Deps, Io };

function program(ctx: Ctx, setCode: (n: number) => void): Command {
  const p = new Command(CLI_BIN)
    .version(VERSION, "-v, --version")
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.io.out(s), writeErr: (s) => ctx.io.err(s) });

  const act =
    <A extends unknown[]>(fn: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      setCode(await fn(...args));
    };

  p.command("init")
    .description("connect this repository: sign in, claim it and opt in")
    .option("--harness <list>", "harnesses to configure (claude-code,cursor,codex)")
    .option("-y, --yes", "accept the defaults without asking")
    .option("--no-backfill", "skip reading recent sessions")
    .option("--days <n>", "how many days of history to read")
    .option("--server <url>", "the server to use")
    .option("--org <slug>", "the organisation to use")
    .option("--remote <name>", "the git remote that identifies this repository")
    .option("--accept-pilot-terms", "accept a beta organisation's pilot data terms (with --yes)")
    .action(act((o) => init(ctx, o)));

  p.command("login")
    .description("sign in with a device code")
    .option("--org <slug>", "the organisation to sign in to")
    .option("--server <url>", "the server to use")
    .action(
      act((o: { org?: string; server?: string }) => {
        if (o.server) ctx.setServerOverride(o.server);
        return login(ctx, o);
      }),
    );
  p.command("logout")
    .description("sign out and revoke the token")
    .option("--all", "every organisation")
    .action(act((o) => logout(ctx, o)));
  p.command("status")
    .description("what is captured here, and where it goes")
    .option("--json", "machine-readable output")
    .action(act((o) => status(ctx, o)));
  p.command("doctor")
    .description("check the installation, with a fix line for each failure")
    .option("--json", "machine-readable output")
    .option("--bench", "time 200 synthetic hook runs per event (p50 and p95)")
    .action(act((o: { json?: boolean; bench?: boolean }) => (o.bench ? bench(ctx, o) : doctor(ctx, o))));
  p.command("confirm")
    .description("review the proposals from your sessions: confirm, reject, edit or share each")
    .argument("[keys...]", "confirm these proposals without the interactive view")
    .option("--list", "print the waiting proposals")
    .option("--reject <reason>", "reject the given keys with this reason instead")
    .action(
      act((keys: string[], o: { list?: boolean; reject?: string }) =>
        confirm(ctx, keys, o, ctx.deps.confirmTerm, ctx.deps.ttyAsk),
      ),
    );
  p.command("decide")
    .description("record a decision you made (confirmed; you are its author)")
    .argument("<statement>", "the decision, 12 to 280 characters")
    .option("--why <text>", "the reason")
    .option("--rejected <alternative>", "an alternative you rejected (repeatable)", (v: string, a: string[] = []) => [
      ...a,
      v,
    ])
    .option("--paths <list>", "repository paths it applies to, comma-separated")
    .option("--commitment", "a commitment rather than a decision")
    .option("--owner <email>", "who owns the commitment")
    .option("--due <date>", "when the commitment is due (YYYY-MM-DD)")
    .action(act((statement: string, o) => decide(ctx, statement, o, ctx.deps.ttyAsk)));
  p.command("sessions")
    .description("what was kept from your sessions here; delete one with rm")
    .argument("[action]", "list, show or rm")
    .argument("[id]", "the session id (show, rm)")
    .action(
      act((action: string | undefined, id: string | undefined) => sessions(ctx, action, id, {}, ctx.deps.ttyAsk)),
    );
  p.command("export")
    .description("export this repository's ledger (Markdown or JSON)")
    .option("--format <format>", "md or json", "md")
    .option("--layout <layout>", "single or adr", "single")
    .option("--out <dir>", "write the files into this directory")
    .option("--include-private", "also your own proposals nobody else sees yet")
    .option("--force", "replace files in --out that are not an earlier export")
    .action(
      act((o: { format?: string; layout?: string; out?: string; includePrivate?: boolean; force?: boolean }) =>
        exportLedger(ctx, o),
      ),
    );
  p.command("ask")
    .description("open a question for the repository")
    .argument("<question>", "the question, 12 to 280 characters")
    .option("--owner <email>", "who should answer it")
    .action(act((question: string, o: { owner?: string }) => ask(ctx, question, o, ctx.deps.ttyAsk)));
  p.command("verify")
    .description("run this repository's checks on your working tree; only paths and line numbers are sent")
    .option("--json", "print the results as JSON")
    .action(act((o: { json?: boolean }) => verify(ctx, o)));
  p.command("backfill")
    .description("read your recent agent sessions here again and find decisions you already made")
    .option("--days <n>", "how many days of history to read")
    .option("--harness <list>", "only these harnesses (claude-code,cursor,codex)")
    .option("-y, --yes", "read and upload without asking")
    .action(act((o: { days?: string; harness?: string; yes?: boolean }) => backfill(ctx, o)));
  // Dispatched before commander (internal.ts, L16 review S1); listed here for the help text only.
  p.command("pack")
    .description("print the team decisions that apply here (the pack your agent gets)")
    .option("--format <format>", "md or json", "md")
    .option("--paths <paths...>", "ask for these repository paths instead of the ones you are working on");
  // Dispatched before commander as well (internal.ts, D416); listed here for the help text only.
  p.command("mcp")
    .description("run the MCP server on stdio (your agent starts it; init registers it)")
    .option("--cwd <dir>", "the repository to answer for")
    .option("--print-config <agent>", "print the snippet for gemini, hermes, openclaw or generic");
  p.command("on")
    .description("opt this repository in")
    .action(act(() => setCapture(ctx, true)));
  p.command("off")
    .description("opt this repository out; capture stops immediately")
    .action(act(() => setCapture(ctx, false)));
  p.command("uninstall")
    .description("remove what was added for this repository")
    .option("--purge", "also delete everything kept on this laptop")
    .option("-y, --yes", "do not ask")
    .action(act((o) => uninstall(ctx, o)));

  return p;
}

/** One command of the reference (`align <command> --help`, structured). */
export type CommandReference = {
  name: string;
  description: string;
  usage: string;
  arguments: { name: string; required: boolean; description: string }[];
  options: { flags: string; description: string; default?: string }[];
  /** Exactly what `<bin> <command> --help` prints. */
  help: string;
};

/**
 * The command tree as data, for the website's CLI reference (L36b, D3111): built from the same `program()` the CLI
 * runs, so the reference is never written by hand. Each `help` is exactly what `<bin> <command> --help` prints.
 */
export function commandReference(): { help: string; commands: CommandReference[] } {
  const quiet: Io = { out: () => {}, err: () => {} };
  const p = program(new Ctx(quiet, { env: {}, cwd: "/" }), () => {});
  // A fixed width, so the text does not depend on the terminal it was generated in (80, as when not a terminal).
  for (const c of [p, ...p.commands]) c.configureHelp({ ...c.configureHelp(), helpWidth: 80 });
  return {
    help: p.helpInformation(),
    commands: p.commands.map((c) => ({
      name: c.name(),
      description: c.description(),
      usage: c.usage(),
      arguments: c.registeredArguments.map((a) => ({
        name: a.name(),
        required: a.required,
        description: a.description,
      })),
      options: c.options.map((o) => ({
        flags: o.flags,
        description: o.description,
        ...(o.defaultValue !== undefined && typeof o.defaultValue !== "boolean"
          ? { default: String(o.defaultValue) }
          : {}),
      })),
      // `pack` and `mcp` run before commander (internal.ts) and print their own help: the reference shows that text.
      help:
        c.name() === "pack" ? `${copy.pack.help}\n` : c.name() === "mcp" ? `${copy.mcp.help}\n` : c.helpInformation(),
    })),
  };
}

/** Runs the CLI and returns the exit code. Never throws. */
export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  // Internal entry points skip commander and the user-facing context (docs/15 §The hook fast path).
  if ((INTERNAL_COMMANDS as readonly string[]).includes(argv[0] ?? "")) {
    return runInternal(argv, {
      env: deps.env ?? process.env,
      cwd: deps.cwd ?? process.cwd(),
      out: io.out,
      err: io.err,
      readStdin: deps.readStdin ?? (() => readProcessStdin(MAX_STDIN_BYTES)),
      bundlePath: deps.bundlePath ?? null,
      nodePath: deps.nodePath,
      now: deps.now,
      sleep: deps.sleep,
      home: deps.internalHome,
      spawnUploader: deps.spawnUploader,
      fetch: deps.fetch,
      keychain: deps.keychain,
    });
  }
  const ctx = new Ctx(io, deps);
  let code = 0;
  const p = program(ctx, (n) => {
    code = n;
  });
  if (argv.length === 0) {
    io.out(p.helpInformation());
    return 0;
  }
  try {
    await p.parseAsync([...argv], { from: "user" });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help")
        return 0;
      return 2;
    }
    if (e instanceof CorruptFileError) {
      ctx.fail(copy.corruptFile(e.path));
      return 1;
    }
    if (e instanceof UserError) {
      ctx.fail(e.message);
      return e.exitCode;
    }
    if (isOffline(e)) {
      ctx.fail(copy.offline(safeServer(ctx)));
      return 1;
    }
    if (e instanceof ApiError) {
      ctx.fail(apiErrorLine(e.code));
      return 1;
    }
    if (e instanceof ProtocolError) {
      ctx.fail(copy.protocolError);
      return 1;
    }
    // Unknown failure: name only, never the message (it may carry content; AGENTS.md rule 9).
    ctx.fail(copy.unexpected((e as { name?: string })?.name ?? "Error"));
    return 1;
  }
}

function safeServer(ctx: Ctx): string {
  try {
    return ctx.server();
  } catch {
    return "the server";
  }
}
