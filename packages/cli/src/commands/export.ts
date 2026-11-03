/**
 * `align export [--format md|json] [--layout single|adr] [--out DIR] [--include-private]` (docs/15 §Commands,
 * docs/11 §Export): the open export of this repository's ledger. JSON is the server's `GET /export` answer as it is;
 * Markdown is rendered here by the shared renderer (`@align/core/export`, the same as the console's), in one file or
 * the ADR layout. Without `--out`, JSON and the single file go to stdout; the ADR layout needs `--out`. Files are
 * written only under `--out`: a rendered path that is absolute or climbs out is refused.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type LedgerExport, renderMarkdown } from "@align/core/export";
import { z } from "zod";
import { agentHarness } from "../confirm/person";
import type { Ctx } from "../context";
import { repoHere, UserError } from "../context";
import { stripControl } from "../control";
import { copy } from "../copy";

/** The parts of the export the CLI relies on; the rest is passed through untouched (`schemas/export.schema.json`). */
const ExportShape = z
  .object({
    format_version: z.literal(1),
    exported_at: z.string(),
    org: z.object({ name: z.string(), prefix: z.string() }),
    repo: z.object({ remote: z.string(), default_branch: z.string().nullable().optional() }),
    entries: z.array(z.record(z.string(), z.unknown())),
    questions: z.array(z.record(z.string(), z.unknown())),
  })
  .loose();

export type ExportOptions = {
  format?: string;
  layout?: string;
  out?: string;
  includePrivate?: boolean;
  force?: boolean;
};

export async function exportLedger(ctx: Ctx, o: ExportOptions): Promise<number> {
  const format = o.format ?? "md";
  const layout = o.layout ?? "single";
  if (format !== "md" && format !== "json") throw new UserError(copy.exportCmd.badFormat, 2);
  if (layout !== "single" && layout !== "adr") throw new UserError(copy.exportCmd.badLayout, 2);
  if (format === "md" && layout === "adr" && !o.out) throw new UserError(copy.exportCmd.adrNeedsOut, 2);
  const found = await repoHere(ctx);
  if (!found) throw new UserError(copy.notRegistered);
  const api = ctx.clientFor(found.entry.org_id);
  if (!api) throw new UserError(copy.loginRequired);
  // In an agent's shell or without a terminal, the export is an agent's read (L43, D514).
  const forAgent = agentHarness(ctx.env) !== null || !ctx.io.isTTY;
  const q = `repo_id=${encodeURIComponent(found.entry.repo_id)}${o.includePrivate ? "&include_private=true" : ""}${forAgent ? "&for=agent" : ""}`;
  const { data } = await api.request("GET", `/export?${q}`, ExportShape, undefined, { timeoutMs: 60_000 });
  const ledger = data as unknown as LedgerExport;

  const files =
    format === "json"
      ? [{ path: "ledger.json", content: `${JSON.stringify(ledger, null, 2)}\n` }]
      : renderMarkdown(ledger, layout as "single" | "adr");
  if (!o.out) {
    // To a terminal, no control character from the ledger's text may act on it.
    const text = files[0]?.content ?? "";
    ctx.io.out(ctx.io.isTTY ? stripControlKeepTabs(text) : text);
    return 0;
  }
  const root = isAbsolute(o.out) ? resolve(o.out) : realDirs(ctx.cwd, o.out);
  // Your own author-only proposals are in the files with --include-private: user-only permissions then.
  const mode = o.includePrivate ? 0o600 : 0o644;
  for (const f of files) writeUnder(root, f.path, f.content, mode, o.force === true);
  ctx.line(copy.exportCmd.written(files.length, o.out, ledger.entries.length));
  return 0;
}

/** Tabs are layout in a ledger's text; every other control character goes before it reaches a terminal. */
const stripControlKeepTabs = (text: string) => text.split("\t").map(stripControl).join("\t");

/**
 * A relative `--out` is the person's directory inside the tree they stand in, which a repository can fill with
 * committed symbolic links (`docs -> ~/.ssh`): every directory from the working directory (or from the ancestor a
 * leading `..` climbs to) down to `--out` must be a real directory, created one level at a time when missing (R2).
 * An absolute `--out` is the person's own path, followed as given (the last component is still checked).
 */
export function realDirs(cwd: string, out: string): string {
  const realCwd = realpathSync(cwd);
  const target = resolve(realCwd, out);
  let base = realCwd;
  while (base !== dirname(base) && target !== base && !target.startsWith(`${base}${sep}`)) base = dirname(base);
  let dir = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dir);
    } catch {
      st = null;
    }
    if (st === null) mkdirSync(dir);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError(copy.exportCmd.symlink(dir));
  }
  return target;
}

/** What an earlier export of the same file starts with: the same first two lines (title, or front matter and key). */
const firstLine = (text: string) => text.split("\n", 2).join("\n");

/**
 * Writes `rel` under `root` without ever leaving it (L17 review B3): every directory on the way must be a real
 * directory (a symbolic link anywhere refuses), the file is written to a temporary name opened with
 * `O_CREAT | O_EXCL | O_NOFOLLOW` and renamed into place after checking the directory still resolves under the root,
 * and an existing file that is not an earlier export (its first two lines differ) is kept unless `--force`.
 */
export function writeUnder(root: string, rel: string, content: string, mode: number, force: boolean): void {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new UserError(copy.exportCmd.badPath);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new UserError(copy.exportCmd.symlink(root));
  const realRoot = realpathSync(root);
  const parts = rel.split("/").filter(Boolean);
  const name = parts.pop() as string;
  let dir = realRoot;
  for (const p of parts) {
    dir = join(dir, p);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dir);
    } catch {
      st = null;
    }
    if (st === null) mkdirSync(dir);
    else if (!st.isDirectory() || st.isSymbolicLink())
      throw new UserError(copy.exportCmd.symlink(join(root, ...parts)));
  }
  const target = join(dir, name);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (!existing.isFile()) throw new UserError(copy.exportCmd.symlink(join(root, rel)));
    if (!force && firstLine(readFileSync(target, "utf8")) !== firstLine(content))
      throw new UserError(copy.exportCmd.wouldOverwrite(join(root, rel)));
  }
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    const rp = realpathSync(dir);
    if (rp !== realRoot && !rp.startsWith(`${realRoot}/`)) throw new UserError(copy.exportCmd.badPath);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
