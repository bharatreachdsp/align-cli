/**
 * Merging ALIGN's hook entries into a harness's JSON hooks file, and taking them out again (docs/15 §Hook entries
 * written, §Guarantees 6). One implementation for the three files: Claude Code's `<repo>/.claude/settings.local.json`
 * and Codex's `~/.codex/hooks.json` (event → matcher groups → handlers) and Cursor's `~/.cursor/hooks.json`
 * (`"version": 1`, event → handlers).
 *
 * Edits go through `jsonc-parser`, so comments and every other setting stay. ALIGN's entries are recognised by a
 * command that runs `hook <name> --harness <harness>` through an ALIGN shim (`/.align/bin/align`, or this
 * installation's own); nobody else's entries are ever changed. Re-running changes nothing when the entries are
 * there; an ALIGN entry pointing at another shim is updated in place.
 *
 * So `uninstall` can give back the original bytes, the file as it was before ALIGN first changed it is kept in a
 * record under `~/.align` (0600; it never leaves the laptop) with the hash of the file as ALIGN wrote it. While the
 * file still has that hash, uninstall restores those bytes (or deletes a file ALIGN created); edited since, only
 * ALIGN's entries (and containers left empty) are removed, so the person's edits are never undone (D219). A
 * symbolic link is never written through.
 */
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import {
  applyEdits,
  type FormattingOptions,
  type Node as JsonNode,
  modify,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser";
import { readJsonFile, writeJsonAtomic, writeUserFileAtomic } from "../fsx";
import type { Harness, HookName } from "./hooks";

export const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

export type HookSpecEntry = { hook: HookName; event: string; timeout: number };

export type HooksFileSpec = {
  harness: Harness;
  /** `grouped`: event → [{matcher?, hooks: [{type, command, timeout}]}]; `flat`: event → [{command, timeout}]. */
  shape: "grouped" | "flat";
  entries: readonly HookSpecEntry[];
  /** Extra keys of ALIGN's matcher group (Codex: `matcher: ""`). */
  groupExtra?: Record<string, unknown>;
  /** Top-level keys the file must have (Cursor: `version: 1`); added only when absent. */
  ensureTop?: Record<string, unknown>;
  /** When true for the file's text, no copy of it is kept under `~/.align` (Claude Code: `env` values, D223). */
  noCopy?: (text: string) => boolean;
};

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The shim path as a shell word (quoted only when it needs to be). */
export const shellWord = (s: string) => (/^[A-Za-z0-9_./+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export const hookCommand = (shim: string, hook: HookName, harness: Harness) =>
  `${shellWord(shim)} hook ${hook} --harness ${harness}`;

function handler(spec: HooksFileSpec, shim: string, e: HookSpecEntry): Rec {
  const command = hookCommand(shim, e.hook, spec.harness);
  return spec.shape === "grouped" ? { type: "command", command, timeout: e.timeout } : { command, timeout: e.timeout };
}

export function entryFor(spec: HooksFileSpec, shim: string, e: HookSpecEntry): Rec {
  return spec.shape === "grouped"
    ? { ...(spec.groupExtra ?? {}), hooks: [handler(spec, shim, e)] }
    : handler(spec, shim, e);
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a hook command relates to ALIGN for this harness: `exact` is ALIGN's own command as `init` writes it (any
 * installation of the shim, quoted or not) — the only kind ALIGN rewrites or removes; `wrapper` is a person's
 * command that calls it among other things (`<shim> hook stop --harness cursor; ./audit.sh`) — left alone by
 * install and uninstall (docs/15 §Guarantees 6) and counted as installed; anything else is null.
 */
export function alignCommandKind(
  command: unknown,
  shim: string,
  harness: Harness,
  hook?: HookName,
): "exact" | "wrapper" | null {
  if (typeof command !== "string") return null;
  const ours = command.includes(`/.${CLI_BIN}/bin/${CLI_BIN}`) || command.includes(shellWord(shim));
  if (!ours) return null;
  const name = hook ? escapeRe(hook) : "[a-z-]+";
  // A plain path (no shell syntax that could run something else first: quotes, `;&|()`, backticks, `$`, `\\`, `<>`,
  // an assignment's `=`, brace expansion's `{}`),
  // a single-quoted path, `$HOME/…` or `~/…`, or this installation's own shim.
  const plain = "[^\\s'\";&|()`$\\\\<>={}]*";
  const shimWord = `(?:'[^']*/\\.${CLI_BIN}/bin/${CLI_BIN}'|(?:\\$HOME|~)?${plain}/\\.${CLI_BIN}/bin/${CLI_BIN}|${escapeRe(shellWord(shim))})`;
  const tail = ` hook ${name} --harness ${escapeRe(harness)}`;
  if (new RegExp(`^\\s*${shimWord}${tail}\\s*$`).test(command)) return "exact";
  return new RegExp(`${tail}(?=$|[\\s;&|)"'\`<>])`).test(command) ? "wrapper" : null;
}

/** ALIGN's own command (exact), the kind install updates and uninstall removes. */
export const isAlignCommand = (command: unknown, shim: string, harness: Harness, hook?: HookName) =>
  alignCommandKind(command, shim, harness, hook) === "exact";

export class SettingsParseError extends Error {
  override readonly name = "SettingsParseError";
}

export class SettingsShapeError extends Error {
  override readonly name = "SettingsShapeError";
}

export function parseSettings(text: string): Rec {
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || (v !== undefined && !isRecord(v))) throw new SettingsParseError("unparseable settings");
  // A duplicated `hooks` key (or a duplicated event inside it) means the file says two things; the harness reads one
  // of them, so ALIGN refuses rather than edit the wrong one.
  const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  const dupes = (node: JsonNode | undefined) => {
    const names = (node?.children ?? []).map((p) => p.children?.[0]?.value);
    return names.length !== new Set(names).size;
  };
  const hooksProps = (tree?.children ?? []).filter((p) => p.children?.[0]?.value === "hooks");
  if (hooksProps.length > 1 || dupes(hooksProps[0]?.children?.[1])) throw new SettingsShapeError("duplicate keys");
  return (v as Rec | undefined) ?? {};
}

const eventList = (text: string, event: string): unknown[] | undefined => {
  const hooks = parseSettings(text).hooks;
  return isRecord(hooks) && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : undefined;
};

/** Where ALIGN's command sits in an event's list: a path below the event, or null. */
function findOurs(spec: HooksFileSpec, list: unknown[], shim: string, hook: HookName): (string | number)[] | null {
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (spec.shape === "flat") {
      if (isRecord(g) && isAlignCommand(g.command, shim, spec.harness, hook)) return [i];
      continue;
    }
    if (!isRecord(g) || !Array.isArray(g.hooks)) continue;
    const j = g.hooks.findIndex((h) => isRecord(h) && isAlignCommand(h.command, shim, spec.harness, hook));
    if (j >= 0) return [i, "hooks", j];
  }
  return null;
}

/** Whether an event's list holds a person's wrapper around ALIGN's command. */
function hasWrapper(spec: HooksFileSpec, list: unknown[], shim: string, hook: HookName): boolean {
  const kind = (c: unknown) => alignCommandKind(c, shim, spec.harness, hook) === "wrapper";
  return list.some((g) =>
    spec.shape === "flat"
      ? isRecord(g) && kind(g.command)
      : isRecord(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isRecord(h) && kind(h.command)),
  );
}

/** How many of ALIGN's commands are only present inside a person's wrapper (left in place by uninstall). */
export function wrappersLeft(spec: HooksFileSpec, text: string, shim: string): number {
  try {
    return spec.entries.filter((e) => {
      const list = eventList(text, e.event);
      return list ? hasWrapper(spec, list, shim, e.hook) : false;
    }).length;
  } catch {
    return 0;
  }
}

/** Adds or updates ALIGN's entries; returns the new text (the same string when nothing changed). */
export function mergeHooks(spec: HooksFileSpec, text: string, shim: string): string {
  let out = text.trim() === "" ? "{}\n" : text;
  for (const [k, v] of Object.entries(spec.ensureTop ?? {})) {
    if (!(k in parseSettings(out))) out = applyEdits(out, modify(out, [k], v, { formattingOptions: FORMAT }));
  }
  for (const e of spec.entries) {
    // A `hooks` or `hooks.<Event>` value of another type is the person's: never overwritten, the install refuses.
    const settings = parseSettings(out);
    if (settings.hooks !== undefined && !isRecord(settings.hooks)) throw new SettingsShapeError("hooks");
    if (isRecord(settings.hooks) && settings.hooks[e.event] !== undefined && !Array.isArray(settings.hooks[e.event]))
      throw new SettingsShapeError(e.event);
    const list = eventList(out, e.event);
    if (list) {
      const at = findOurs(spec, list, shim, e.hook);
      if (at) {
        // Only ALIGN's own handler is rewritten; anything else in its group stays as it is.
        const want = handler(spec, shim, e);
        const current = at.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)?.[key], list);
        if (JSON.stringify(current) === JSON.stringify(want)) continue;
        out = applyEdits(out, modify(out, ["hooks", e.event, ...at], want, { formattingOptions: FORMAT }));
      } else if (hasWrapper(spec, list, shim, e.hook)) {
      } else {
        out = applyEdits(
          out,
          modify(out, ["hooks", e.event, list.length], entryFor(spec, shim, e), {
            formattingOptions: FORMAT,
            isArrayInsertion: true,
          }),
        );
      }
    } else {
      out = applyEdits(out, modify(out, ["hooks", e.event], [entryFor(spec, shim, e)], { formattingOptions: FORMAT }));
    }
  }
  return text.trim() === "" || out !== text ? out : text;
}

/** The text without ALIGN's entries; a group, an event or a `hooks` object left empty by that goes too. */
export function removeHooks(spec: HooksFileSpec, text: string, shim: string): string {
  let out = text;
  for (const e of spec.entries) {
    for (;;) {
      const list = eventList(out, e.event);
      if (!list) break;
      const at = findOurs(spec, list, shim, e.hook);
      if (!at) break;
      let edit: (string | number)[] = ["hooks", e.event, ...at];
      if (spec.shape === "grouped") {
        const g = list[at[0] as number] as Rec;
        const onlyOurs =
          (g.hooks as unknown[]).length === 1 && Object.keys(g).every((k) => k === "hooks" || k === "matcher");
        if (onlyOurs) edit = ["hooks", e.event, at[0] as number];
      }
      out = applyEdits(out, modify(out, edit, undefined, { formattingOptions: FORMAT }));
    }
    const list = eventList(out, e.event);
    if (list && list.length === 0)
      out = applyEdits(out, modify(out, ["hooks", e.event], undefined, { formattingOptions: FORMAT }));
  }
  const hooks = parseSettings(out).hooks;
  if (isRecord(hooks) && Object.keys(hooks).length === 0)
    out = applyEdits(out, modify(out, ["hooks"], undefined, { formattingOptions: FORMAT }));
  return out;
}

/** For doctor: every entry present and pointing at this shim. */
export function hooksInstalled(spec: HooksFileSpec, text: string, shim: string): boolean {
  try {
    return spec.entries.every((e) => {
      const list = eventList(text, e.event);
      if (!list) return false;
      const want = hookCommand(shim, e.hook, spec.harness);
      const exact = list.some((g) =>
        spec.shape === "flat"
          ? isRecord(g) && g.command === want
          : isRecord(g) && Array.isArray(g.hooks) && g.hooks.some((x) => isRecord(x) && x.command === want),
      );
      return exact || hasWrapper(spec, list, shim, e.hook);
    });
  } catch {
    return false;
  }
}

/** What ALIGN remembers about a hooks file it changed. */
export type FileRecord = {
  existed: boolean;
  before: string | null;
  after_sha256: string;
  /** ALIGN created the file's directory; uninstall removes it again when it is empty. */
  created_dir?: boolean;
  /** The one backup of a user-level file, taken before ALIGN's first change (docs/15 `init` step 7). */
  backup?: string;
  /** The file this record is about (user-level files can move with `CODEX_HOME`): uninstall works on this one. */
  file?: string;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function readRecord(recordFile: string): FileRecord | null {
  try {
    return readJsonFile<FileRecord | null>(
      recordFile,
      (v) =>
        isRecord(v) &&
        typeof v.existed === "boolean" &&
        typeof v.after_sha256 === "string" &&
        (typeof v.before === "string" || v.before === null)
          ? (v as FileRecord)
          : null,
      () => null,
    );
  } catch {
    return null;
  }
}

export function writeRecord(recordFile: string, r: FileRecord | null): void {
  if (r === null) rmSync(recordFile, { force: true });
  else writeJsonAtomic(recordFile, r);
}

const hasBackup = (file: string) => {
  try {
    const base = basename(file);
    return readdirSync(dirname(file)).some((n) => n.startsWith(`${base}.align-backup-`));
  } catch {
    return false;
  }
};

export const isSymlink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export type FileInstallResult = { changed: boolean; skipped?: "symlink" | "unparseable" | "shape" };

/** Drops a kept original whose file no longer has the hash ALIGN wrote (it would restore stale bytes). */
export function pruneStale(recordFile: string, file: string): boolean {
  const r = readRecord(recordFile);
  if (!r) return false;
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  if (text !== null && sha256(text) === r.after_sha256) return false;
  writeRecord(recordFile, null);
  return true;
}

export function installHooksFile(
  spec: HooksFileSpec,
  o: { file: string; recordFile: string; shim: string; guard?: string[]; backup?: boolean; now?: number },
): FileInstallResult {
  const { file } = o;
  if ([file, ...(o.guard ?? [])].some(isSymlink)) return { changed: false, skipped: "symlink" };
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  let merged: string;
  try {
    merged = mergeHooks(spec, before, o.shim);
  } catch (e) {
    if (e instanceof SettingsParseError) return { changed: false, skipped: "unparseable" };
    if (e instanceof SettingsShapeError) return { changed: false, skipped: "shape" };
    throw e;
  }
  if (existed && merged === before) return { changed: false };
  const prior = readRecord(o.recordFile);
  const hadOurs = existed && spec.entries.some((e) => before.includes(`hook ${e.hook} --harness ${spec.harness}`));
  // The original is kept only from before ALIGN's first change, and only while the file is still exactly as ALIGN
  // left it; edited since, the exact restore is given up (uninstall then removes only ALIGN's entries).
  const untouched = !!prior?.after_sha256 && prior.after_sha256 === sha256(before);
  // One backup per file, ever: an existing `<file>.align-backup-*` (from an earlier install) is enough.
  let backup = prior?.backup;
  if (o.backup && existed && !backup && !hasBackup(file)) {
    backup = `${file}.align-backup-${o.now ?? Date.now()}`;
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
  }
  // Without an exact restore (no copy kept, or the file was edited since ALIGN wrote it) the record still names the
  // file and its backup, with an empty hash, so uninstall removes ALIGN's entries from the right file.
  const noRestore: FileRecord = { existed: true, before: null, after_sha256: "", file, ...(backup ? { backup } : {}) };
  const record: FileRecord = spec.noCopy?.(before)
    ? noRestore
    : hadOurs
      ? untouched && prior
        ? { ...prior, after_sha256: sha256(merged), file, ...(backup ? { backup } : {}) }
        : noRestore
      : {
          existed,
          before: existed ? before : null,
          after_sha256: sha256(merged),
          created_dir: !existed && !existsSync(dirname(file)),
          file,
          ...(backup ? { backup } : {}),
        };
  const mode = existed ? statSync(file).mode & 0o777 : 0o644;
  if (!existed) mkdirSync(dirname(file), { recursive: true });
  writeUserFileAtomic(file, merged, mode);
  writeRecord(o.recordFile, record);
  return { changed: true };
}

export type FileUninstallResult = {
  changed: boolean;
  deleted: boolean;
  skipped?: "unparseable" | "symlink";
  /** ALIGN commands left inside a person's own wrapper commands (named to them). */
  wrappers?: number;
};

export function uninstallHooksFile(
  spec: HooksFileSpec,
  o: { file: string; recordFile: string; shim: string; guard?: string[] },
): FileUninstallResult {
  const { file } = o;
  const record = readRecord(o.recordFile);
  if ([file, ...(o.guard ?? [])].some(isSymlink)) return { changed: false, deleted: false, skipped: "symlink" };
  if (!existsSync(file)) {
    writeRecord(o.recordFile, null);
    return { changed: false, deleted: false };
  }
  const text = readFileSync(file, "utf8");
  const mode = statSync(file).mode & 0o777;
  let result: FileUninstallResult;
  if (record && record.after_sha256 === sha256(text)) {
    if (record.existed && record.before !== null) {
      writeUserFileAtomic(file, record.before, mode);
      result = { changed: true, deleted: false };
    } else {
      rmSync(file, { force: true });
      result = { changed: true, deleted: true };
    }
  } else {
    let next: string;
    try {
      next = removeHooks(spec, text, o.shim);
    } catch (e) {
      // A file someone left unparseable is not touched; the caller says so (and capture stops regardless).
      if (e instanceof SettingsParseError || e instanceof SettingsShapeError)
        return { changed: false, deleted: false, skipped: "unparseable" };
      throw e;
    }
    // Top-level keys ALIGN added to a file it created go when nothing else is left (Cursor's `version`).
    if (record && !record.existed) {
      const rest = parseSettings(next);
      const added = Object.keys(spec.ensureTop ?? {});
      if (Object.keys(rest).every((k) => added.includes(k))) next = "{}";
    }
    if (next === text) result = { changed: false, deleted: false };
    else if (record && !record.existed && Object.keys(parseSettings(next)).length === 0) {
      rmSync(file, { force: true });
      result = { changed: true, deleted: true };
    } else {
      writeUserFileAtomic(file, next, mode);
      result = { changed: true, deleted: false };
    }
  }
  if (result.deleted && record?.created_dir) {
    try {
      if (readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
    } catch {
      // not empty or gone
    }
  }
  writeRecord(o.recordFile, null);
  if (!result.deleted) {
    try {
      const left = wrappersLeft(spec, readFileSync(file, "utf8"), o.shim);
      if (left > 0) result.wrappers = left;
    } catch {
      // gone
    }
  }
  return result;
}
