/**
 * `align pack [--format md|json] [--paths …]` (docs/15 §Commands), the command `/align` runs inside Claude Code.
 *
 * It runs as an internal entry point (internal.ts), not as an ordinary command: `/align` runs in the session's
 * environment, which a cloned repository can set (`.claude/settings.json` `env`), so this never reads `ALIGN_HOME`,
 * `HOME`, `ALIGN_SERVER`, `ALIGN_CREDENTIAL_STORE` or any `GIT_*` variable (L16 review S1). The home is the installed
 * bundle's own, git runs through `hookGit` (sanitised environment), the token and server come from the credential
 * record (D240) and the Keychain item bound to that server.
 *
 * A fresh cache is printed as it is; otherwise the pack is fetched and cached; when the server does not answer, a
 * cached pack up to a day old is printed with its "may be out of date" line. `--paths` asks for those paths and
 * neither reads nor writes the cache. The Markdown starts with the pack marker, so `/align`'s output never compiles.
 */
import type { FetchLike } from "../api";
import { stripControl } from "../control";
import { copy } from "../copy";
import type { Keychain } from "../credentials";
import { repoFacts } from "../hook/home";
import type { Paths } from "../paths";
import { lookupRepo, readRegistry } from "../registry";
import { packText, resolvePack } from "./serve";

export type PackCommandDeps = {
  paths: Paths;
  cwd: string;
  now: number;
  out: (t: string) => void;
  err: (t: string) => void;
  fetch?: FetchLike;
  keychain?: Keychain | null;
};

/** `--format x`, `--paths a b,c` (values until the next option). Null on anything else. */
function parse(args: readonly string[]): { format: string; paths?: string[] } | null {
  let format = "md";
  let paths: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--format" && args[i + 1] !== undefined) format = args[++i] as string;
    else if (a.startsWith("--format=")) format = a.slice(9);
    else if (a === "--paths") {
      paths = [];
      while (args[i + 1] !== undefined && !(args[i + 1] as string).startsWith("--"))
        paths.push(...(args[++i] as string).split(","));
    } else return null;
  }
  return { format, ...(paths ? { paths: paths.map((p) => p.trim()).filter(Boolean) } : {}) };
}

export async function packCommand(args: readonly string[], deps: PackCommandDeps): Promise<number> {
  const fail = (line: string, code = 1) => {
    deps.err(`${line}\n`);
    return code;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.out(`${copy.pack.help}\n`);
    return 0;
  }
  const o = parse(args);
  if (!o || (o.format !== "md" && o.format !== "json")) return fail(copy.pack.badFormat, 2);
  const facts = await repoFacts(deps.cwd);
  const found = facts ? lookupRepo(readRegistry(deps.paths), facts.toplevel) : null;
  if (!facts || !found) return fail(copy.pack.notConnected);
  const r = await resolvePack(
    { paths: deps.paths, now: deps.now, fetch: deps.fetch, keychain: deps.keychain, remainingMs: () => 5000 },
    { root: found.root, entry: found.entry, facts },
    { harness: "unknown", cwd: deps.cwd, ...(o.paths ? { explicitPaths: o.paths } : {}), interactiveGit: 2000 },
  );
  if (!r.served)
    return fail(
      r.outcome === "signed_out"
        ? copy.pack.notSignedIn
        : r.outcome === "refused"
          ? copy.pack.refused
          : copy.pack.unavailable,
    );
  const markdown = packText(r.served);
  if (o.format === "json") {
    const { notice_line, items, tokens_estimate, generated_at, ttl_seconds } = r.served.pack;
    deps.out(
      `${JSON.stringify({ markdown, items, tokens_estimate, generated_at, ttl_seconds, notice_line: stripControl(notice_line), stale: r.served.stale })}\n`,
    );
  } else deps.out(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return 0;
}
