/**
 * Cursor's agent may call ALIGN's read-only MCP tools without asking (docs/14 §Local MCP server, D534). Cursor's CLI
 * checks every MCP tool call against `permissions.allow`; in print mode (`agent -p`) a call with no matching rule is
 * rejected, so `get_context` never ran there although the server was loaded. `init` merges one rule per read-only
 * tool, `Mcp(align:<tool>)`, into the repository's untracked `.cursor/cli.json` (kept out of `git status` by the
 * caller) and records what it added; `uninstall` gives the exact bytes back while the file is untouched, else removes
 * only those rules. Tools that write (`record_decision`, `ask_owner`) are never allowed: Cursor still asks for them.
 * A committed file, a symbolic link or a file that does not parse is left alone.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { TOOL_NAMES, TOOLS } from "@align/core/tools";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import { readJsonFile, writeJsonAtomic, writeUserFileAtomic } from "../../fsx";
import { FORMAT, isSymlink } from "../hooks-file";

export const CURSOR_CLI_REL = join(".cursor", "cli.json");

/** The rules ALIGN adds: the read-only tools of its own server, by name (never a wildcard). */
export const alignAllowRules = (): string[] =>
  TOOL_NAMES.filter((t) => TOOLS[t].annotations.readOnlyHint).map((t) => `Mcp(${CLI_BIN}:${t})`);

export type PermissionsOutcome = "added" | "present" | "symlink" | "unparseable";

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type PermissionsRecord = {
  file: string;
  existed: boolean;
  /** The file before ALIGN's first change (null when ALIGN created it or the exact restore no longer holds). */
  before: string | null;
  after_sha256: string;
  added: string[];
  /** ALIGN added the empty `permissions.deny` Cursor requires next to `allow`. */
  added_deny?: boolean;
  created_dir?: boolean;
};

function parseJsonc(text: string): Rec | null {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && isRecord(v) ? v : null;
}

function readRecord(file: string): PermissionsRecord | null {
  try {
    return readJsonFile<PermissionsRecord | null>(
      file,
      (v) =>
        isRecord(v) && typeof v.file === "string" && Array.isArray(v.added) && typeof v.after_sha256 === "string"
          ? (v as PermissionsRecord)
          : null,
      () => null,
    );
  } catch {
    return null;
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The `permissions.allow` list of a parsed file, or null when it has another shape. */
function allowList(parsed: Rec): string[] | null {
  if (parsed.permissions === undefined) return [];
  if (!isRecord(parsed.permissions)) return null;
  const { allow, deny } = parsed.permissions;
  if (deny !== undefined && !strings(deny)) return null;
  if (allow === undefined) return [];
  return strings(allow) ? allow : null;
}

/** Cursor refuses a project `cli.json` whose `permissions` lacks either list (schema validation, 2026.10.22). */
const hasDeny = (parsed: Rec) => isRecord(parsed.permissions) && parsed.permissions.deny !== undefined;

export function installCursorPermissions(o: { file: string; recordFile: string; guard: string[] }): PermissionsOutcome {
  if ([o.file, ...o.guard].some(isSymlink)) return "symlink";
  const existed = existsSync(o.file);
  const before = existed ? readFileSync(o.file, "utf8") : "";
  const parsed = parseJsonc(before);
  const allow = parsed ? allowList(parsed) : null;
  if (!parsed || !allow) return "unparseable";
  const missing = alignAllowRules().filter((r) => !allow.includes(r));
  const addDeny = !hasDeny(parsed);
  if (missing.length === 0 && !addDeny) return "present";
  let text = before.trim() === "" ? "{}\n" : before;
  for (const rule of missing)
    text = applyEdits(text, modify(text, ["permissions", "allow", -1], rule, { formattingOptions: FORMAT }));
  if (addDeny) text = applyEdits(text, modify(text, ["permissions", "deny"], [], { formattingOptions: FORMAT }));
  const prior = readRecord(o.recordFile);
  const untouched = !!prior && prior.after_sha256 === sha256(before);
  // A record from an earlier init counts only while the file is still there; a file the person deleted starts afresh.
  const record: PermissionsRecord =
    prior && existed
      ? {
          ...prior,
          // An edit by the person since ALIGN's last write: from now on only ALIGN's rules are removed.
          before: untouched ? prior.before : null,
          existed: untouched ? prior.existed : true,
          after_sha256: sha256(text),
          added: [...new Set([...prior.added, ...missing])],
          ...(prior.added_deny || addDeny ? { added_deny: true } : {}),
        }
      : {
          file: o.file,
          existed,
          before: existed ? before : null,
          after_sha256: sha256(text),
          added: missing,
          ...(addDeny ? { added_deny: true } : {}),
          ...(!existed && !existsSync(dirname(o.file)) ? { created_dir: true } : {}),
        };
  const mode = existed ? statSync(o.file).mode & 0o777 : 0o644;
  writeUserFileAtomic(o.file, text, mode);
  writeJsonAtomic(o.recordFile, record);
  return "added";
}

/** Whether every rule ALIGN adds is in the file (doctor). */
export function cursorPermissionsPresent(file: string): boolean {
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    const allow = parsed ? allowList(parsed) : null;
    return !!parsed && !!allow && hasDeny(parsed) && alignAllowRules().every((r) => allow.includes(r));
  } catch {
    return false;
  }
}

export function uninstallCursorPermissions(o: { file: string; recordFile: string; guard: string[] }): {
  removed: boolean;
  skipped?: "symlink" | "unparseable";
} {
  const record = readRecord(o.recordFile);
  const done = (r: { removed: boolean; skipped?: "symlink" | "unparseable" }) => {
    rmSync(o.recordFile, { force: true });
    return r;
  };
  if (!record) return done({ removed: false });
  const file = record.file;
  if ([file, ...o.guard].some(isSymlink)) return { removed: false, skipped: "symlink" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return done({ removed: false });
  }
  const mode = statSync(file).mode & 0o777;
  const dropDir = () => {
    if (!record.created_dir) return;
    try {
      if (readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
    } catch {
      // not empty, or gone
    }
  };
  // Untouched since ALIGN's last write: the exact bytes from before (or no file, when ALIGN created it).
  if (record.after_sha256 === sha256(text) && (!record.existed || record.before !== null)) {
    if (record.before !== null) writeUserFileAtomic(file, record.before, mode);
    else {
      rmSync(file, { force: true });
      dropDir();
    }
    return done({ removed: true });
  }
  const parsed = parseJsonc(text);
  const allow = parsed ? allowList(parsed) : null;
  if (!parsed || !allow) return { removed: false, skipped: "unparseable" };
  // Removed from the end, so each index still points at the rule it found.
  const indices = allow
    .map((r, i) => (record.added.includes(r) ? i : -1))
    .filter((i) => i >= 0)
    .reverse();
  let next = text;
  for (const i of indices)
    next = applyEdits(next, modify(next, ["permissions", "allow", i], undefined, { formattingOptions: FORMAT }));
  const rest = parseJsonc(next);
  // The `deny: []` ALIGN added goes too, once nothing else is left in `permissions` (Cursor needs both lists or none).
  const perms = rest && isRecord(rest.permissions) ? rest.permissions : null;
  const emptyList = (v: unknown) => Array.isArray(v) && v.length === 0;
  if (record.added_deny && perms && Object.keys(perms).length === 2 && emptyList(perms.allow) && emptyList(perms.deny))
    next = applyEdits(next, modify(next, ["permissions"], undefined, { formattingOptions: FORMAT }));
  const empty = !!rest && Object.keys(parseJsonc(next) ?? { x: 1 }).length === 0;
  if (!record.existed && empty) {
    rmSync(file, { force: true });
    dropDir();
  } else if (next !== text) writeUserFileAtomic(file, next, mode);
  return done({ removed: indices.length > 0 });
}
