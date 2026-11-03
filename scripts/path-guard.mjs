#!/usr/bin/env node
/**
 * The personal-path guard for the public CLI mirror (docs/20 §Pipelines, L19). Fails when any file under the
 * given directories contains a macOS home path (the `Users` folder at the root), a Linux home path whose folder is not one of the
 * synthetic names fixtures use (`/home/someone/`), or the name of the account running the guard (its user
 * name or its home folder's name, when that is not a generic build account), or a build machine's own paths:
 * root's home folder and Cloud Build's workspace and home folders. The only exemption is
 * `REDACTION_RULE_LINES`: exact comment lines of the redaction rules, by file. Prints `file:line kind` only,
 * never the matching text. Copied into the mirror as `scripts/path-guard.mjs`, so the mirror's workflow runs
 * the same check. Node built-ins only.
 *
 * Usage: node path-guard.mjs <dir> [<dir> ...]   exit 0 clean, 1 findings, 2 usage
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Home folder names that are synthetic or belong to generic build accounts, never a person. */
export const SYNTHETIC_HOMES = new Set([
  "someone",
  "user",
  "username",
  "me",
  "you",
  "alice",
  "bob",
  "example",
  "runner",
  "node",
  "builder",
  "root",
]);

/** Assembled at run time, so this file never trips its own check. */
const MAC_HOME = ["", "Users", ""].join("/");

/**
 * The only lines allowed to name the macOS home folder: comments in `@align/core`'s redaction rules, which
 * describe the home paths they remove (docs/17 §Redaction rule 5; `packages/core/src/redact/paths.ts` and
 * `rules/identity.ts`). Each entry is one file (relative to the scanned directory) and one exact line, with
 * `{MAC}` standing for the folder (assembled at run time, so this file passes its own check). Only the macOS
 * check is waived for that line; every other check still runs, and any other line, any edit to one of these
 * lines or the same text in another file is a finding (D298).
 */
export const REDACTION_RULE_LINES = Object.freeze(
  [
    [
      "packages/core/src/redact/paths.ts",
      "/** Replaces a leading home directory (`{MAC}<name>`, `/home/<name>`, `/var/home/<name>`, `/root`, `/mnt/c{MAC}<name>`, `C:\\Users\\<name>`, also as a `file://` URL) with `~`. */",
    ],
    [
      "packages/core/src/redact/paths.ts",
      "/** The home directory a path lives under (`{MAC}riya` for `{MAC}riya/code`), or null. */",
    ],
    [
      "packages/core/src/redact/paths.ts",
      " * another person's home (`{MAC}bob/…` beside a root under `{MAC}riya`) is outside; `~` expands to the",
    ],
    [
      "packages/core/src/redact/rules/identity.ts",
      " * docs/17 §Redaction rule 5, identity: home-directory prefixes (`{MAC}<name>/` → `~/`), IP addresses,",
    ],
    [
      "packages/core/src/redact/rules/identity.ts",
      " * Home prefixes anywhere in text: `{MAC}<name>`, `/home/<name>`, `/var/home/<name>`, `/root`,",
    ],
    [
      "packages/core/src/redact/rules/identity.ts",
      " * `/mnt/<drive>{MAC}<name>` (WSL), `C:\\Users\\<name>` (also with `/` or `\\\\`), and the same after `file://`.",
    ],
  ].map(([file, line]) => Object.freeze({ file: String(file), line: String(line).replaceAll("{MAC}", MAC_HOME) })),
);

/** The allowed lines of one file (by its path relative to the scanned directory), as a set. */
export function allowedLines(file) {
  return new Set(REDACTION_RULE_LINES.filter((a) => a.file === file).map((a) => a.line));
}

/** A build machine's paths, at the start of a path (not inside a longer word); assembled so this file passes. */
const BUILDER_HOME = ["", "builder", "home"].join("/");
const BUILD_PATHS = new RegExp(
  `(?:^|[^A-Za-z0-9_.~-])/(?:${["root", "workspace"].join("|")})/|${BUILDER_HOME}(?:/|$|[^A-Za-z0-9_.-])`,
);

const GENERIC_ACCOUNTS = new Set(["root", "node", "runner", "builder", "home", "ubuntu", "user"]);
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** Names of the running account worth refusing in a public tree (lower case, at least 3 characters). */
export function accountNames() {
  const names = new Set();
  const add = (n) => {
    const v = (n ?? "").trim().toLowerCase();
    if (v.length >= 3 && !GENERIC_ACCOUNTS.has(v)) names.add(v);
  };
  try {
    add(userInfo().username);
  } catch {
    // no passwd entry (containers): nothing to add
  }
  add(basename(homedir()));
  return [...names];
}

/** Findings for one text: `[{ line, kind }]`. `allowed`: exact lines exempt from the macOS check only. */
export function scanText(text, names = accountNames(), allowed = new Set()) {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(MAC_HOME) && !allowed.has(line)) findings.push({ line: i + 1, kind: "macOS home path" });
    for (const m of line.matchAll(/\/home\/([A-Za-z0-9._-]+)/g)) {
      if (!SYNTHETIC_HOMES.has((m[1] ?? "").toLowerCase())) {
        findings.push({ line: i + 1, kind: "Linux home path" });
        break;
      }
    }
    if (BUILD_PATHS.test(line)) findings.push({ line: i + 1, kind: "build machine path" });
    const lower = line.toLowerCase();
    if (names.some((n) => lower.includes(n))) findings.push({ line: i + 1, kind: "account name" });
  }
  return findings;
}

/** Every finding under `dir`: `[{ file, line, kind }]`, file relative to `dir`. Binary files are skipped. */
export function scanDir(dir, names = accountNames()) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue;
      const rel = relative(dir, p);
      if (names.some((n) => rel.toLowerCase().includes(n))) {
        out.push({ file: rel, line: 0, kind: "personal name in a file name" });
      }
      const allowed = allowedLines(rel.split(sep).join("/"));
      for (const f of scanText(buf.toString("utf8"), names, allowed)) out.push({ file: rel, ...f });
    }
  };
  walk(dir);
  return out;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0 || dirs.some((d) => !statSync(d, { throwIfNoEntry: false })?.isDirectory())) {
    console.error("usage: path-guard.mjs <dir> [<dir> ...]");
    process.exit(2);
  }
  const findings = dirs.flatMap((d) => scanDir(d).map((f) => ({ ...f, file: join(d, f.file) })));
  for (const f of findings) console.error(`path-guard: ${f.file}:${f.line} ${f.kind}`);
  if (findings.length > 0) {
    console.error(`path-guard: ${findings.length} personal path(s); the tree must not be published`);
    process.exit(1);
  }
  console.log("path-guard: no personal paths");
}
