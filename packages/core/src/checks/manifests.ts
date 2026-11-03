/**
 * Manifest parsers for `forbid_dependency` (docs/13 §Deterministic checks): `package.json` (every
 * dependency field; every workspace's own package.json is a manifest of its own), `requirements*.txt`,
 * `pyproject.toml` (PEP 621, PEP 735 dependency groups, Poetry), `go.mod`, `Gemfile`, `Cargo.toml`,
 * `pom.xml`, `build.gradle(.kts)`. Line-based where the format allows, so every declaration has a line.
 * Lock files are not manifests: a check is about what the team declares, not what resolves transitively.
 */
import { DeadlineExceeded, NO_DEADLINE, type OverDeadline } from "./deadline";
import { MAX_LINE_CHARS } from "./imports";
import type { CheckEcosystem } from "./spec";

export type ManifestKind =
  | "package.json"
  | "requirements"
  | "pyproject"
  | "go.mod"
  | "gemfile"
  | "cargo"
  | "pom"
  | "gradle";

export const MANIFEST_ECOSYSTEM: Record<ManifestKind, CheckEcosystem> = {
  "package.json": "npm",
  requirements: "pypi",
  pyproject: "pypi",
  "go.mod": "go",
  gemfile: "rubygems",
  cargo: "cargo",
  pom: "maven",
  gradle: "maven",
};

export interface DeclaredPackage {
  readonly name: string;
  /** 1-based line of the declaration. */
  readonly line: number;
  readonly rule: string;
}

export interface ParsedManifest {
  readonly packages: readonly DeclaredPackage[];
  /** The file is not valid in its format (only `package.json` can tell). */
  readonly invalid?: true;
}

export function manifestKind(path: string): ManifestKind | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "package.json") return "package.json";
  if (/^requirements[^/]*\.txt$/.test(base)) return "requirements";
  if (base === "pyproject.toml") return "pyproject";
  if (base === "go.mod") return "go.mod";
  if (base === "Gemfile") return "gemfile";
  if (base === "Cargo.toml") return "cargo";
  if (base === "pom.xml") return "pom";
  if (base === "build.gradle" || base === "build.gradle.kts") return "gradle";
  return null;
}

const normalisePypi = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const normaliseCargo = (name: string) => name.toLowerCase().replaceAll("_", "-");

/** Whether a declared package is the forbidden one, by each ecosystem's own naming rules. */
export function packageMatches(ecosystem: CheckEcosystem, declared: string, wanted: string): boolean {
  switch (ecosystem) {
    case "npm":
      return declared === wanted;
    case "pypi":
      return normalisePypi(declared) === normalisePypi(wanted);
    case "go":
      return declared === wanted || declared.startsWith(`${wanted}/`);
    case "rubygems":
      return declared.toLowerCase() === wanted.toLowerCase();
    case "cargo":
      return normaliseCargo(declared) === normaliseCargo(wanted);
    case "maven": {
      if (wanted.includes(":")) return declared === wanted;
      const [group, artifact] = declared.split(":");
      return artifact === wanted || group === wanted;
    }
  }
}

/** Declared packages of one manifest. Throws DeadlineExceeded when `overDeadline` turns true mid-file. */
export function parseManifest(
  kind: ManifestKind,
  text: string,
  overDeadline: OverDeadline = NO_DEADLINE,
): ParsedManifest {
  switch (kind) {
    case "package.json":
      return packageJson(text, overDeadline);
    case "requirements":
      return { packages: requirements(text, overDeadline) };
    case "pyproject":
      return { packages: pyproject(text, overDeadline) };
    case "go.mod":
      return { packages: goMod(text, overDeadline) };
    case "gemfile":
      return { packages: gemfile(text, overDeadline) };
    case "cargo":
      return { packages: cargo(text, overDeadline) };
    case "pom":
      return { packages: pom(text, overDeadline) };
    case "gradle":
      return { packages: gradle(text, overDeadline) };
  }
}

/**
 * Calls `fn` for each line (its first 1,000 characters, as for imports and patterns), checking the deadline
 * before every line, so no single parser regex sees a long line and a slow file stops in time.
 */
function eachLine(text: string, overDeadline: OverDeadline, fn: (raw: string, index: number) => void): void {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (overDeadline()) throw new DeadlineExceeded();
    fn((lines[index] as string).slice(0, MAX_LINE_CHARS), index);
  }
}

const NPM_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const NPM_BUNDLED = ["bundleDependencies", "bundledDependencies"] as const;

/**
 * Line of every entry one level inside a top-level field (`{"dependencies": {"a": …}}` → `dependencies`/`a`;
 * array strings too, for `bundleDependencies`), from one linear pass over the text. Keys are decoded, so
 * `"\u0061"` is `a`, and a field name inside some nested object is never taken for the top-level one.
 */
function topLevelEntryLines(text: string, overDeadline: OverDeadline): Map<string, number> {
  const lines = new Map<string, number>();
  const stack: string[] = [];
  let topKey: string | null = null;
  let line = 1;
  let nextCheck = 0;
  const nextNonSpace = (from: number) => {
    let j = from;
    while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j += 1;
    return text[j];
  };
  for (let i = 0; i < text.length; i += 1) {
    // Every 64 KiB of text, however `i` moves: it jumps over strings, so `i % n === 0` could skip every check.
    if (i >= nextCheck) {
      if (overDeadline()) throw new DeadlineExceeded();
      nextCheck = i + 0x10000;
    }
    const c = text[i];
    if (c === "\n") line += 1;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      let value: string;
      try {
        value = JSON.parse(text.slice(i, j + 1)) as string;
      } catch {
        value = "";
      }
      const isKey = nextNonSpace(j + 1) === ":";
      if (stack.length === 1 && isKey) topKey = value;
      else if (stack.length === 2 && topKey !== null && (stack[1] === "[" || isKey)) {
        const key = `${topKey}\u0000${value}`;
        if (!lines.has(key)) lines.set(key, line);
      }
      i = j;
    }
  }
  return lines;
}

function packageJson(text: string, overDeadline: OverDeadline): ParsedManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { packages: [], invalid: true };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { packages: [], invalid: true };
  const record = json as Record<string, unknown>;
  const entryLines = topLevelEntryLines(text, overDeadline);
  const lineOf = (field: string, name: string) => entryLines.get(`${field}\u0000${name}`) ?? 1;
  const packages: DeclaredPackage[] = [];
  for (const field of NPM_FIELDS) {
    const deps = record[field];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const line = lineOf(field, name);
      packages.push({ name, line, rule: `npm.${field}` });
      // An alias ("redis-client": "npm:ioredis@5") declares the real package too.
      const alias = typeof spec === "string" ? /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(spec) : null;
      if (alias) packages.push({ name: alias[1] as string, line, rule: `npm.${field}` });
    }
  }
  for (const field of NPM_BUNDLED) {
    const deps = record[field];
    if (!Array.isArray(deps)) continue;
    for (const name of deps) {
      if (typeof name === "string") packages.push({ name, line: lineOf(field, name), rule: `npm.${field}` });
    }
  }
  return { packages };
}

const PEP508_NAME = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

function requirements(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  eachLine(text, overDeadline, (raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) return;
    const name = PEP508_NAME.exec(line);
    if (name) packages.push({ name: name[1] as string, line: index + 1, rule: "pypi.requirements" });
  });
  return packages;
}

/** The table name of a TOML header line (`[a.b]`, `[[a]]`), or null. No regex: a header-like line with no `]` must stay linear. */
function tomlHeader(raw: string): string | null {
  const line = raw.trim();
  if (!line.startsWith("[")) return null;
  const inner = line.slice(line.startsWith("[[") ? 2 : 1);
  const close = inner.indexOf("]");
  if (close === -1) return null;
  const name = inner.slice(0, close).trim();
  return name || null;
}
const TOML_KEY = /^\s*(["']?)([A-Za-z0-9_.-]+)\1\s*=/;
/**
 * The quoted strings of one line (`"…"` with backslash escapes, `'…'` literal) and the text outside them, in
 * one left-to-right pass (round 3: the regex it replaces rescanned the line from every unclosed quote). An
 * unclosed quote ends the line's strings; what follows it is neither a string nor outside text.
 */
export function quotedStrings(line: string): { strings: string[]; rest: string } {
  const strings: string[] = [];
  let rest = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c !== '"' && c !== "'") {
      rest += c;
      i += 1;
      continue;
    }
    let j = i + 1;
    let value = "";
    while (j < line.length && line[j] !== c) {
      if (c === '"' && line[j] === "\\" && j + 1 < line.length) {
        value += line.slice(j, j + 2);
        j += 2;
      } else {
        value += line[j];
        j += 1;
      }
    }
    if (j >= line.length) break; // unclosed
    strings.push(value);
    i = j + 1;
  }
  return { strings, rest };
}

/** Strings of a TOML line, and whether the line closes the array it is in. */
function arrayStrings(line: string): { strings: string[]; closes: boolean } {
  const { strings, rest } = quotedStrings(line);
  return { strings, closes: rest.replace(/#.*$/, "").includes("]") };
}

function pyproject(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  let table = "";
  let array: string | null = null; // rule of the dependency array being read
  eachLine(text, overDeadline, (raw, index) => {
    const line = index + 1;
    if (array) {
      const { strings, closes } = arrayStrings(raw);
      for (const value of strings) {
        const name = PEP508_NAME.exec(value);
        if (name) packages.push({ name: name[1] as string, line, rule: array });
      }
      if (closes) array = null;
      return;
    }
    const header = tomlHeader(raw);
    if (header) {
      table = header.replace(/["'\s]/g, "");
      const poetryTable = /^tool\.poetry\.(?:(?:dev-)?dependencies|group\.[^.]+\.dependencies)\.([^.]+)$/.exec(table);
      if (poetryTable && poetryTable[1] !== "python") {
        packages.push({ name: poetryTable[1] as string, line, rule: "pypi.poetry" });
      }
      return;
    }
    const key = TOML_KEY.exec(raw);
    if (!key) return;
    const name = (key[2] as string).split(".")[0] as string; // a dotted key (`requests.version = …`) names its first part
    const pep621 =
      (table === "project" && name === "dependencies") ||
      table === "project.optional-dependencies" ||
      table === "dependency-groups";
    if (pep621 && /=\s*\[/.test(raw)) {
      const after = raw.slice(raw.indexOf("[") + 1);
      const { strings, closes } = arrayStrings(after);
      for (const value of strings) {
        const dep = PEP508_NAME.exec(value);
        if (dep) packages.push({ name: dep[1] as string, line, rule: "pypi.pep621" });
      }
      if (!closes) array = "pypi.pep621";
      return;
    }
    if (/^tool\.poetry\.(?:(?:dev-)?dependencies|group\.[^.]+\.dependencies)$/.test(table) && name !== "python") {
      packages.push({ name, line, rule: "pypi.poetry" });
    }
  });
  return packages;
}

function goMod(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  let inBlock = false;
  eachLine(text, overDeadline, (raw, index) => {
    const line = raw.replace(/\/\/.*$/, "");
    if (inBlock) {
      if (/^\s*\)/.test(line)) inBlock = false;
      else {
        const module = /^\s*(\S+)\s+\S+/.exec(line);
        if (module) packages.push({ name: module[1] as string, line: index + 1, rule: "go.require" });
      }
      return;
    }
    if (/^\s*require\s*\(\s*$/.test(line)) {
      inBlock = true;
      return;
    }
    const single = /^\s*require\s+(\S+)\s+\S+/.exec(line);
    if (single) packages.push({ name: single[1] as string, line: index + 1, rule: "go.require" });
  });
  return packages;
}

function gemfile(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  eachLine(text, overDeadline, (raw, index) => {
    const gem = /^\s*gem\s*\(?\s*(['"])([^'"]+)\1/.exec(raw);
    if (gem) packages.push({ name: gem[2] as string, line: index + 1, rule: "rubygems.gem" });
  });
  return packages;
}

const CARGO_TABLE = /(?:^|\.)(?:dev-|build-)?dependencies$/;
const CARGO_SUBTABLE = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/;
const CARGO_PACKAGE = /\bpackage\s*=\s*"([^"]+)"/;

function cargo(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  let table = "";
  let subtable = false;
  eachLine(text, overDeadline, (raw, index) => {
    const line = index + 1;
    const header = tomlHeader(raw);
    if (header) {
      table = header.replace(/\s/g, "");
      const sub = CARGO_SUBTABLE.exec(table.replace(/"/g, ""));
      subtable = sub !== null;
      if (sub) packages.push({ name: sub[1] as string, line, rule: "cargo.dependencies" });
      return;
    }
    if (subtable) {
      const renamed = /^\s*package\s*=\s*"([^"]+)"/.exec(raw);
      if (renamed) packages.push({ name: renamed[1] as string, line, rule: "cargo.dependencies" });
      return;
    }
    if (!CARGO_TABLE.test(table)) return;
    const key = TOML_KEY.exec(raw);
    if (!key) return;
    // `serde.workspace = true` is a dotted key for `serde`.
    packages.push({ name: (key[2] as string).split(".")[0] as string, line, rule: "cargo.dependencies" });
    const renamed = CARGO_PACKAGE.exec(raw);
    if (renamed) packages.push({ name: renamed[1] as string, line, rule: "cargo.dependencies" });
  });
  return packages;
}

/** `text` with every span from `open` to `close` blanked, newlines kept (linear: indexOf, no regex). */
function blank(text: string, open: string, close: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const from = text.indexOf(open, at);
    if (from === -1) return out + text.slice(at);
    const to = text.indexOf(close, from + open.length);
    const stop = to === -1 ? text.length : to + close.length;
    out += text.slice(at, from) + text.slice(from, stop).replace(/[^\n]/g, " ");
    at = stop;
  }
}

function pom(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  // Blank XML comments but keep their newlines, so line numbers stay true.
  const xml = blank(text, "<!--", "-->");
  const packages: DeclaredPackage[] = [];
  const OPEN = "<dependency>";
  const CLOSE = "</dependency>";
  let line = 1;
  let counted = 0; // offset up to which newlines are counted into `line`
  let at = 0;
  for (;;) {
    const from = xml.indexOf(OPEN, at);
    if (from === -1) break;
    const to = xml.indexOf(CLOSE, from + OPEN.length);
    if (to === -1) break;
    if (overDeadline()) throw new DeadlineExceeded();
    at = to + CLOSE.length;
    const body = xml.slice(from + OPEN.length, to);
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(body);
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(body);
    if (!group || !artifact) continue;
    const offset = from + OPEN.length + artifact.index;
    for (let i = counted; i < offset; i += 1) if (xml.charCodeAt(i) === 10) line += 1;
    counted = offset;
    packages.push({ name: `${group[1]}:${artifact[1]}`, line, rule: "maven.pom" });
  }
  return packages;
}

const GRADLE_NOT_CONFIGURATIONS = new Set(["id", "apply", "include", "includeBuild", "plugins", "url", "maven"]);
const GRADLE_COORDINATE = /^([\w.-]+):([\w.-]+)(?::[^:]*)?(?::[^:]*)?$/;

function gradle(text: string, overDeadline: OverDeadline): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  let inBlock = false;
  eachLine(text, overDeadline, (raw, index) => {
    let code = raw;
    if (inBlock) {
      const end = code.indexOf("*/");
      if (end === -1) return;
      code = code.slice(end + 2);
      inBlock = false;
    }
    const trimmed = code.trimStart();
    if (trimmed.startsWith("//")) return;
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlock = true;
      return;
    }
    const configuration = /^\s*([A-Za-z]\w*)\s*[( ]/.exec(code);
    if (!configuration || GRADLE_NOT_CONFIGURATIONS.has(configuration[1] as string)) return;
    const map = /\bgroup\s*[:=]\s*(['"])([^'"]+)\1\s*,\s*name\s*[:=]\s*(['"])([^'"]+)\3/.exec(code);
    if (map) {
      packages.push({ name: `${map[2]}:${map[4]}`, line: index + 1, rule: "maven.gradle" });
      return;
    }
    for (const value of quotedStrings(code).strings) {
      const coordinate = GRADLE_COORDINATE.exec(value);
      if (coordinate) {
        packages.push({ name: `${coordinate[1]}:${coordinate[2]}`, line: index + 1, rule: "maven.gradle" });
      }
    }
  });
  return packages;
}
