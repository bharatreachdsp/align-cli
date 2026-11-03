/**
 * Import recognisers (docs/13 §Deterministic checks): regular expressions, line by line, with comments
 * skipped where that is cheap (whole-line and block comments, Python docstrings, Ruby `=begin` blocks).
 * They find the module names a file imports; `importMatches` decides whether one is the forbidden module
 * (exact, or a sub-path in that language's separator).
 */
import { DeadlineExceeded, NO_DEADLINE, type OverDeadline } from "./deadline";
import type { CheckLanguage } from "./spec";

export interface ImportHit {
  /** 1-based line number of the module name. */
  readonly line: number;
  /** Module names this line imports (for `from a import b`: `a` and `a.b`). */
  readonly names: readonly string[];
  readonly rule: string;
}

/** Only the first 1,000 characters of a line are looked at (the same cap as pattern checks). */
export const MAX_LINE_CHARS = 1000;

const EXTENSIONS: ReadonlyArray<readonly [CheckLanguage, readonly string[]]> = [
  ["javascript", [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]],
  ["python", [".py", ".pyi"]],
  ["go", [".go"]],
  ["ruby", [".rb", ".rake"]],
  ["java", [".java"]],
  ["kotlin", [".kt", ".kts"]],
  ["rust", [".rs"]],
];

export function languageOf(path: string): CheckLanguage | null {
  const lower = path.toLowerCase();
  for (const [language, extensions] of EXTENSIONS) {
    if (extensions.some((extension) => lower.endsWith(extension))) return language;
  }
  return null;
}

const SEPARATOR: Record<CheckLanguage, string> = {
  javascript: "/",
  python: ".",
  go: "/",
  ruby: "/",
  java: ".",
  kotlin: ".",
  rust: "::",
};

/** `name` is `module` or a sub-path of it (`ioredis/built`, `redis.client`, `tokio::sync`). */
export function importMatches(language: CheckLanguage, name: string, module: string): boolean {
  let n = name;
  let m = module;
  if (language === "javascript") {
    n = n.replace(/^node:/, "");
    m = m.replace(/^node:/, "");
  }
  if (language === "rust") m = m.replaceAll("-", "_");
  if (language === "java" || language === "kotlin") m = m.replace(/\.\*$/, "");
  const separator = SEPARATOR[language];
  return n === m || n.startsWith(m + separator);
}

/** Lines of `text` with comments blanked, for each comment style. */
function* codeLines(
  text: string,
  style: "c" | "python" | "ruby",
  overDeadline: OverDeadline,
): Generator<[number, string]> {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (overDeadline()) throw new DeadlineExceeded();
    let line = (lines[index] as string).slice(0, MAX_LINE_CHARS);
    const trimmed = line.trimStart();
    if (style === "c") {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlock = false;
      }
      const t = line.trimStart();
      if (t.startsWith("//")) continue;
      if (t.startsWith("/*")) {
        const end = t.indexOf("*/", 2);
        if (end === -1) {
          inBlock = true;
          continue;
        }
        line = t.slice(end + 2);
      }
    } else if (style === "python") {
      const quotes = (line.match(/"""|'''/g) ?? []).length;
      if (inBlock) {
        if (quotes % 2 === 1) inBlock = false;
        continue;
      }
      if (trimmed.startsWith("#")) continue;
      if (quotes % 2 === 1 && /^[rRbBuUfF]{0,2}("""|''')/.test(trimmed)) {
        inBlock = true;
        continue;
      }
    } else if (style === "ruby") {
      if (inBlock) {
        if (line.startsWith("=end")) inBlock = false;
        continue;
      }
      if (line.startsWith("=begin")) {
        inBlock = true;
        continue;
      }
      if (trimmed.startsWith("#")) continue;
    }
    yield [index + 1, line];
  }
}

const JS_FROM = /^\s*(?:import|export)\b[^'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/;
const JS_SIDE_EFFECT = /^\s*import\s*(['"])([^'"\n]+)\1/;
const JS_STATEMENT_START = /^\s*(?:import|export)\b/;
const JS_FROM_ANYWHERE = /\bfrom\s*(['"])([^'"\n]+)\1/;
const JS_REQUIRE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const JS_DYNAMIC = /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g;

function javascript(text: string, overDeadline: OverDeadline): ImportHit[] {
  const hits: ImportHit[] = [];
  let pending = 0; // lines left in a multi-line `import { … } from` statement
  for (const [line, code] of codeLines(text, "c", overDeadline)) {
    const from = JS_FROM.exec(code) ?? JS_SIDE_EFFECT.exec(code);
    if (from) {
      hits.push({ line, names: [from[2] as string], rule: "js.import" });
      pending = 0;
    } else if (pending > 0) {
      const tail = JS_FROM_ANYWHERE.exec(code);
      if (tail) {
        hits.push({ line, names: [tail[2] as string], rule: "js.import" });
        pending = 0;
      } else pending = code.includes(";") ? 0 : pending - 1;
    } else if (JS_STATEMENT_START.test(code) && code.includes("{") && !code.includes("}")) {
      pending = 200;
    }
    for (const match of code.matchAll(JS_REQUIRE)) hits.push({ line, names: [match[2] as string], rule: "js.require" });
    for (const match of code.matchAll(JS_DYNAMIC)) {
      hits.push({ line, names: [match[2] as string], rule: "js.dynamic_import" });
    }
  }
  return hits;
}

const PY_IMPORT = /^\s*import\s+([^#;]+)/;
const PY_FROM = /^\s*from\s+([\w.]+)\s+import\s+([^#;]*)/;
const PY_NAME = /^[A-Za-z_][\w.]*$/;

function python(text: string, overDeadline: OverDeadline): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const [line, code] of codeLines(text, "python", overDeadline)) {
    const from = PY_FROM.exec(code);
    if (from) {
      const base = from[1] as string;
      if (base.startsWith(".")) continue; // relative import: this repository's own module
      const names = [base];
      for (const part of (from[2] as string).replace(/[()\\]/g, "").split(",")) {
        const name =
          part
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim() ?? "";
        if (PY_NAME.test(name)) names.push(`${base}.${name}`);
      }
      hits.push({ line, names, rule: "py.from" });
      continue;
    }
    const plain = PY_IMPORT.exec(code);
    if (plain) {
      const names = (plain[1] as string)
        .split(",")
        .map(
          (part) =>
            part
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? "",
        )
        .filter((name) => PY_NAME.test(name));
      if (names.length > 0) hits.push({ line, names, rule: "py.import" });
    }
  }
  return hits;
}

const GO_SINGLE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/;
const GO_BLOCK_START = /^\s*import\s*\(/;
const GO_SPEC = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;

function go(text: string, overDeadline: OverDeadline): ImportHit[] {
  const hits: ImportHit[] = [];
  let inBlock = false;
  for (const [line, code] of codeLines(text, "c", overDeadline)) {
    if (inBlock) {
      if (/^\s*\)/.test(code)) {
        inBlock = false;
        continue;
      }
      const spec = GO_SPEC.exec(code);
      if (spec) hits.push({ line, names: [spec[1] as string], rule: "go.import" });
      continue;
    }
    const single = GO_SINGLE.exec(code);
    if (single) {
      hits.push({ line, names: [single[1] as string], rule: "go.import" });
      continue;
    }
    if (GO_BLOCK_START.test(code)) {
      const rest = code.slice(code.indexOf("(") + 1);
      const close = rest.indexOf(")");
      for (const match of (close === -1 ? rest : rest.slice(0, close)).matchAll(/"([^"]+)"/g)) {
        hits.push({ line, names: [match[1] as string], rule: "go.import" });
      }
      inBlock = close === -1;
    }
  }
  return hits;
}

const RB_REQUIRE = /(?:^|;)\s*require\s*\(?\s*(['"])([^'"\n]+)\1/g;

function ruby(text: string, overDeadline: OverDeadline): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const [line, code] of codeLines(text, "ruby", overDeadline)) {
    for (const match of code.matchAll(RB_REQUIRE)) hits.push({ line, names: [match[2] as string], rule: "rb.require" });
  }
  return hits;
}

const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;/;
const KOTLIN_IMPORT = /^\s*import\s+([\w.`]+?)(?:\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/;

function jvm(text: string, language: "java" | "kotlin", overDeadline: OverDeadline): ImportHit[] {
  const hits: ImportHit[] = [];
  const pattern = language === "java" ? JAVA_IMPORT : KOTLIN_IMPORT;
  const rule = language === "java" ? "java.import" : "kt.import";
  for (const [line, code] of codeLines(text, "c", overDeadline)) {
    const match = pattern.exec(code);
    if (match) hits.push({ line, names: [(match[1] as string).replaceAll("`", "")], rule });
  }
  return hits;
}

const RS_USE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+)/;
const RS_EXTERN = /^\s*(?:pub\s+)?extern\s+crate\s+(\w+)/;

function rustPathNames(path: string): string[] {
  const clean = path.trim().replace(/^::/, "");
  const brace = clean.indexOf("{");
  if (brace === -1) {
    const name =
      clean
        .split(/\s+as\s+/)[0]
        ?.trim()
        .replace(/::\*$/, "") ?? "";
    return name ? [name] : [];
  }
  const prefix = clean
    .slice(0, brace)
    .replace(/::\s*$/, "")
    .trim();
  const inner = clean.slice(brace + 1).replace(/}.*$/, "");
  const names = prefix ? [prefix] : [];
  for (const part of inner.split(",")) {
    const item =
      part
        .split(/\s+as\s+/)[0]
        ?.trim()
        .replace(/::\*$/, "") ?? "";
    if (!item || item.includes("{")) continue;
    names.push(item === "self" ? prefix : prefix ? `${prefix}::${item}` : item);
  }
  return names;
}

function rust(text: string, overDeadline: OverDeadline): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const [line, code] of codeLines(text, "c", overDeadline)) {
    const extern = RS_EXTERN.exec(code);
    if (extern) {
      hits.push({ line, names: [extern[1] as string], rule: "rs.extern_crate" });
      continue;
    }
    const use = RS_USE.exec(code);
    if (use) {
      const names = rustPathNames(use[1] as string);
      if (names.length > 0) hits.push({ line, names, rule: "rs.use" });
    }
  }
  return hits;
}

/** Every import in `text`, a file in `language`. */
export function findImports(
  language: CheckLanguage,
  text: string,
  overDeadline: OverDeadline = NO_DEADLINE,
): ImportHit[] {
  switch (language) {
    case "javascript":
      return javascript(text, overDeadline);
    case "python":
      return python(text, overDeadline);
    case "go":
      return go(text, overDeadline);
    case "ruby":
      return ruby(text, overDeadline);
    case "java":
    case "kotlin":
      return jvm(text, language, overDeadline);
    case "rust":
      return rust(text, overDeadline);
  }
}
